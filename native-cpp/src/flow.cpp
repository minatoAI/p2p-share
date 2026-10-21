#include "flow.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>

#include <nlohmann/json.hpp>

#include "pairing.h"
#include "protocol.h"

namespace p2p {
namespace {

/** 一次分片的载荷。浏览器允许的单条消息上限是 256 KiB，60 KiB 这一档两边都稳。 */
constexpr size_t kChunkPayload = 60 * 1024;
/** 每隔这么多字节回一条确认。浏览器那边在等确认做背压，不回它会卡住。 */
constexpr uint64_t kAckInterval = 256 * 1024;
/**
 * 发送侧的水位。高于高水位就等对方把缓冲抽干，低于低水位再继续。
 *
 * 8 MB 是权衡：太小会让发送停下来等网络（速率掉），太大就起不到限制内存的作用。
 * 任何小于"整个文件"的值都能防止 1 GB 的文件吃掉 1 GB 内存。
 */
constexpr size_t kHighWaterFallbackMb = 8;
constexpr size_t kLowWaterFallbackMb = 1;

/** 和 SCTP 缓冲一样留个环境变量口子，用来在真机上扫水位。正常使用不要设。 */
size_t water_mark(const char* name, size_t fallback_mb) {
    if (const char* text = std::getenv(name)) {
        const long value = std::strtol(text, nullptr, 10);
        if (value > 0) return static_cast<size_t>(value) * 1024 * 1024;
    }
    return fallback_mb * 1024 * 1024;
}

std::string random_b64(size_t len) {
    std::vector<unsigned char> buf(len);
    for (auto& b : buf) b = static_cast<unsigned char>(std::rand() & 0xff);
    return b64url(buf);
}

void send_json(const std::shared_ptr<rtc::DataChannel>& dc, const nlohmann::json& msg) {
    // 通道已经关掉就别写了。libdatachannel 在关闭中的通道上 send 会卡住，
    // 收尾线程如果正好走到这里，join 就再也回不来。
    if (!dc || !dc->isOpen()) return;
    try {
        dc->send(rtc::string(msg.dump()));
    } catch (const std::exception&) {
        // 刚好在这一刻断了，和发出去但没人收到是一个结果
    }
}

/** 文件名净化。对端送来的名字不能当成路径用。 */
std::string sanitize(const std::string& name) {
    const size_t cut = name.find_last_of("/\\");
    std::string base = cut == std::string::npos ? name : name.substr(cut + 1);
    static const std::string bad = "<>:\"|?*";
    for (auto& c : base) {
        if (static_cast<unsigned char>(c) < 0x20 || bad.find(c) != std::string::npos) c = '_';
    }
    while (!base.empty() && (base.front() == '.' || base.front() == ' ')) base.erase(base.begin());
    while (!base.empty() && (base.back() == '.' || base.back() == ' ')) base.pop_back();
    return base.empty() ? "收到的文件" : base;
}

/**
 * 同名文件不覆盖，加 (1)、(2) 后缀。用户的文件比这份传输重要，
 * 同名时宁可多出一个副本，也不能把原来的内容截断。
 */
std::filesystem::path unique_destination(const std::filesystem::path& dir,
                                         const std::string& name) {
    const std::filesystem::path base = std::filesystem::u8path(name);
    std::error_code ec;
    std::filesystem::path candidate = dir / base;
    if (!std::filesystem::exists(candidate, ec)) return candidate;

    const std::string stem = base.stem().u8string();
    const std::string extension = base.extension().u8string();
    for (int index = 1; index < 10000; ++index) {
        candidate = dir / std::filesystem::u8path(
                                stem + " (" + std::to_string(index) + ")" + extension);
        if (!std::filesystem::exists(candidate, ec)) return candidate;
    }
    return dir / std::filesystem::u8path(stem + " (副本)" + extension);
}

}  // namespace

void MessageQueue::push(rtc::message_variant msg) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        queue_.push_back(std::move(msg));
    }
    cv_.notify_all();
}

bool MessageQueue::pop(rtc::message_variant* out, int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                      [this]() { return !queue_.empty() || closed_; })) {
        return false;
    }
    if (queue_.empty()) return false;
    *out = std::move(queue_.front());
    queue_.pop_front();
    return true;
}

bool MessageQueue::closed() {
    std::lock_guard<std::mutex> lock(mutex_);
    return closed_;
}

void MessageQueue::close() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        closed_ = true;
    }
    cv_.notify_all();
}

bool authenticate(const std::shared_ptr<rtc::DataChannel>& dc, const Identity& identity,
                  const std::string& peer_id, const PublicKeyJwk& peer_key, MessageQueue* inbox,
                  int timeout_ms) {
    const std::string my_id = identity.device_id();
    Challenge mine;
    mine.from = my_id;
    mine.to = peer_id;
    mine.nonce = random_b64(16);
    mine.issued_at = now_ms();

    send_json(dc, {{"t", "auth-challenge"}, {"nonce", mine.nonce}, {"issuedAt", mine.issued_at}});

    bool i_verified_peer = false;
    bool peer_verified_me = false;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);

    while (!(i_verified_peer && peer_verified_me)) {
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
                              deadline - std::chrono::steady_clock::now())
                              .count();
        if (left <= 0) {
            std::cerr << "认证超时" << std::endl;
            return false;
        }
        rtc::message_variant msg;
        if (!inbox->pop(&msg, static_cast<int>(left))) return false;
        if (!std::holds_alternative<rtc::string>(msg)) continue;

        nlohmann::json parsed;
        try {
            parsed = nlohmann::json::parse(std::string(std::get<rtc::string>(msg)));
        } catch (const std::exception&) {
            continue;
        }
        const std::string t = parsed.value("t", "");

        if (t == "auth-challenge") {
            // 先确认这个挑战确实是发给我的，再签。少了这一步，
            // 任何人对我们发一个随机串都能换到一个签名。
            Challenge ctx;
            ctx.from = peer_id;
            ctx.to = my_id;
            ctx.nonce = parsed.value("nonce", "");
            ctx.issued_at = parsed.value("issuedAt", 0LL);
            std::vector<unsigned char> signature;
            std::string reason;
            if (!build_response(identity, my_id, ctx, now_ms(), &signature, &reason)) {
                send_json(dc, {{"t", "auth-result"}, {"ok", false}, {"reason", reason}});
                std::cerr << "拒绝签名：" << reason << std::endl;
                return false;
            }
            send_json(dc, {{"t", "auth-response"}, {"sig", b64url(signature)}});
            continue;
        }

        if (t == "auth-response") {
            const auto signature = b64url_decode(parsed.value("sig", ""));
            std::string reason;
            if (verify_response(mine, signature, peer_key, now_ms(), &reason)) {
                i_verified_peer = true;
                send_json(dc, {{"t", "auth-result"}, {"ok", true}});
            } else {
                send_json(dc, {{"t", "auth-result"}, {"ok", false}, {"reason", reason}});
                std::cerr << "对方的签名验不过：" << reason << std::endl;
                return false;
            }
            continue;
        }

        if (t == "auth-result") {
            if (!parsed.value("ok", false)) {
                std::cerr << "对方拒绝了认证" << std::endl;
                return false;
            }
            peer_verified_me = true;
        }
    }
    std::cout << "双向认证通过" << std::endl;
    return true;
}

bool send_text(const std::shared_ptr<rtc::DataChannel>& dc, const Identity& identity,
               const std::string& text, std::string* out_id) {
    // 文字是一帧控制 JSON，不是文件：不带 meta，不占传输配额，对端也不会
    // 因为它去开文件。"粘贴给对方"走的正是这条路，所以这里必须先把通道
    // 状态查出来——send_json 在通道关掉时会静默丢掉，界面就永远停在"发送中"。
    if (!dc || !dc->isOpen()) return false;
    const std::string id = identity.device_id().substr(0, 6) + "-" + random_b64(3);
    send_json(dc, {{"t", "text"}, {"id", id}, {"text", text}});
    if (out_id) *out_id = id;
    std::cout << "已发文字（" << text.size() << " 字节）" << std::endl;
    return true;
}

void AckTracker::on_ack(const std::string& id, uint64_t received) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        received_[id] = received;
    }
    cv_.notify_all();
}

bool AckTracker::wait_for(const std::string& id, uint64_t size, int timeout_ms,
                          const std::atomic<bool>* cancel) {
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
    std::unique_lock<std::mutex> lock(mutex_);
    while (true) {
        const uint64_t got = received_.count(id) ? received_[id] : 0ULL;
        if (got >= size) return true;
        if (cancel && cancel->load()) return false;
        if (std::chrono::steady_clock::now() >= deadline) return false;
        cv_.wait_for(lock, std::chrono::milliseconds(200), [&]() {
            return (received_.count(id) ? received_[id] : 0ULL) >= size;
        });
    }
}

void AckTracker::clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    received_.clear();
}

bool send_file(const std::shared_ptr<rtc::DataChannel>& dc, const Identity& identity,
               const std::string& path, AckTracker* acks, int ack_timeout_ms,
               ProgressFn on_progress, const std::atomic<bool>* cancel) {
    // 路径要按 UTF-8 转成宽字符再打开。MSVC 的 ifstream 收窄字符串时是按本地
    // 代码页找文件的，中文文件名会直接打不开。
    const std::filesystem::path src = std::filesystem::u8path(path);
    std::ifstream in(src, std::ios::binary);
    if (!in) {
        std::cerr << "读不了 " << path << std::endl;
        return false;
    }
    in.seekg(0, std::ios::end);
    const auto size = static_cast<uint64_t>(in.tellg());
    in.seekg(0);

    const size_t cut = path.find_last_of("/\\");
    const std::string name = sanitize(cut == std::string::npos ? path : path.substr(cut + 1));
    const std::string id = identity.device_id().substr(0, 6) + "-" + random_b64(3);

    send_json(dc, {{"t", "meta"}, {"id", id}, {"name", name}, {"size", size},
                   {"mime", "application/octet-stream"}});

    const uint32_t total =
        static_cast<uint32_t>(std::max<uint64_t>(1, (size + kChunkPayload - 1) / kChunkPayload));
    std::cout << "开始发送 " << name << "（" << size << " 字节，" << total << " 片）" << std::endl;

    // 背压。不控的话整个文件会堆在内存里，一个 1 GB 的文件就吃掉 1 GB 内存，
    // 而且进程一退，堆着没发出去的部分就没了。
    //
    // 状态用 shared_ptr 装、按值捕获：回调可能在 send_file 返回之后才被调用，
    // 按引用捕获局部变量就是悬空引用。收尾时再把回调清掉。
    struct DrainState {
        std::mutex mutex;
        std::condition_variable cv;
        bool low = false;
    };
    auto drain = std::make_shared<DrainState>();
    const size_t low_water = water_mark("P2P_LOW_WATER_MB", kLowWaterFallbackMb);
    const size_t high_water = water_mark("P2P_HIGH_WATER_MB", kHighWaterFallbackMb);
    dc->setBufferedAmountLowThreshold(low_water);
    dc->onBufferedAmountLow([drain]() {
        {
            std::lock_guard<std::mutex> lock(drain->mutex);
            drain->low = true;
        }
        drain->cv.notify_all();
    });
    auto wait_drain = [&]() {
        if (dc->bufferedAmount() <= high_water) return;
        std::unique_lock<std::mutex> lock(drain->mutex);
        drain->low = false;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (!drain->low && std::chrono::steady_clock::now() < deadline) {
            // 取消后别在这儿干等到水位降下来
            if (cancel && cancel->load()) return;
            drain->cv.wait_for(lock, std::chrono::milliseconds(200),
                               [&]() { return drain->low; });
        }
    };

    std::vector<unsigned char> buffer(kChunkPayload);
    for (uint32_t index = 0; index < total; index++) {
        if (cancel && cancel->load()) {
            dc->onBufferedAmountLow({});
            send_json(dc, {{"t", "cancel"}, {"id", id}, {"reason", "user"}});
            std::cout << "发送已取消 " << name << std::endl;
            return false;
        }
        wait_drain();
        if (cancel && cancel->load()) {
            dc->onBufferedAmountLow({});
            send_json(dc, {{"t", "cancel"}, {"id", id}, {"reason", "user"}});
            std::cout << "发送已取消 " << name << std::endl;
            return false;
        }
        in.read(reinterpret_cast<char*>(buffer.data()), static_cast<std::streamsize>(kChunkPayload));
        const auto got = static_cast<size_t>(in.gcount());
        auto frame = encode_chunk(index, total, buffer.data(), got);

        // 分片走二进制。libdatachannel 的 binary 是 std::vector<std::byte>。
        rtc::binary payload(frame.size());
        std::transform(frame.begin(), frame.end(), payload.begin(),
                       [](unsigned char b) { return static_cast<std::byte>(b); });
        dc->send(payload);
        if (on_progress && (index % 16 == 0 || index + 1 == total)) {
            // 不必每片都回调，60 KB 一片的话那样太密了
            TransferProgress progress;
            progress.id = id;
            progress.name = name;
            progress.done = std::min<uint64_t>(size, static_cast<uint64_t>(index + 1) * kChunkPayload);
            progress.total = size;
            progress.incoming = false;
            on_progress(progress);
        }
    }
    dc->onBufferedAmountLow({});
    send_json(dc, {{"t", "done"}, {"id", id}, {"size", size}});

    // 等对方的完成确认。这一步不能省。
    //
    // 走到这里只说明"分片都交给库了"，库里可能还压着几十 MB 没发出去。直接返回
    // 的话调用方会把它当成发送成功，进程一退，压在库里的那些就永远到不了对方。
    // 这个 bug 实测过：256 MB 的文件，对方只收到 226 MB，而发送端打印的是"已发完"。
    //
    // 网页端的发送逻辑本来就在等这个确认（transfer.ts 的 waitForAck），
    // 原生侧是漏了。
    // 等确认给足时间：256 MB 传了几秒钟，确认还得排队回来。默认 60 秒。
    const int budget = ack_timeout_ms > 0 ? ack_timeout_ms : 60000;
    const bool confirmed = acks && acks->wait_for(id, size, budget, cancel);
    dc->onBufferedAmountLow({});

    if (cancel && cancel->load()) {
        send_json(dc, {{"t", "cancel"}, {"id", id}, {"reason", "user"}});
        std::cout << "发送已取消 " << name << std::endl;
        return false;
    }
    if (!confirmed) {
        std::cerr << "对方没有确认收完，不能算发送成功" << std::endl;
        return false;
    }
    // 等确认的这段时间里链路可能已经断了，不检查的话会把没送到的当成送到了
    if (!dc->isOpen()) {
        std::cerr << "对方确认之前连接就断了" << std::endl;
        return false;
    }
    std::cout << "已发完 " << name << "（对方已确认）" << std::endl;
    return true;
}

bool receive(const std::shared_ptr<rtc::DataChannel>& dc, MessageQueue* inbox,
             ReceiveOptions* options, ReceiveResult* out) {
    std::ofstream file;
    std::string id;
    std::string name;
    uint64_t declared = 0;
    uint64_t received = 0;
    uint32_t expected_index = 0;
    uint64_t next_ack = kAckInterval;
    std::string target;

    auto report = [&]() {
        if (!options->on_progress) return;
        TransferProgress progress;
        progress.id = id;
        progress.name = name;
        progress.done = received;
        progress.total = declared;
        progress.incoming = true;
        options->on_progress(progress);
    };

    // 取消当前这次接收：关掉半截文件、删掉它、通知对端。
    // 半截文件不能留，否则用户会以为收到了一个坏文件。
    auto debug = [&](const std::string& text) {
        if (options->on_debug) options->on_debug(text);
    };
    auto abort_current = [&](bool notify_peer, const std::string& reason) {
        if (file.is_open()) {
            file.close();
            std::error_code ec;
            std::filesystem::remove(std::filesystem::u8path(target), ec);
            debug("已清理半截文件 " + target + (ec ? "（删除失败：" + ec.message() + "）" : ""));
        }
        if (notify_peer && options->notify_peer_on_cancel) {
            // docs/36：本地主动取消带 reason=user，对端才能显示同一句「已取消」。
            send_json(dc, {{"t", "cancel"}, {"id", id}, {"reason", reason.empty() ? "user" : reason}});
        }
        if (options->on_canceled) options->on_canceled(id, name, reason);
        id.clear();
        name.clear();
        target.clear();
        declared = 0;
        received = 0;
        expected_index = 0;
        next_ack = kAckInterval;
    };

    // 空转才算超时：每收到一条就重新计时，这样界面可以一直守着，
    // 不会因为对方在传一个大文件的中途思考了几秒就把连接判死。
    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(options->idle_timeout_ms);

    while (true) {
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
                              deadline - std::chrono::steady_clock::now())
                              .count();
        if (left <= 0) {
            // 链路已经断了不算错误，那是正常结束
            if (!dc->isOpen()) return true;
            if (!options->idle_is_error) return true;
            options->error = "等待对方超时";
            return false;
        }
        if (options->cancel && options->cancel->load()) {
            debug("本地取消接收，当前 " + id + (file.is_open() ? " 文件打开" : " 没有文件"));
            abort_current(true, "user");
            return true;
        }
        rtc::message_variant msg;
        // 有取消口子时把等待切碎，别让用户点了取消还要等满一个空转周期。
        // 注意切片超时只是"再看一眼取消标记"，不能当成整体空闲超时：
        // 那会让接收流程在大文件传了一半时提前返回，把文件句柄丢掉。
        bool got = false;
        while (true) {
            const auto remain = std::chrono::duration_cast<std::chrono::milliseconds>(
                                    deadline - std::chrono::steady_clock::now())
                                    .count();
            if (remain <= 0) break;
            const int slice = options->cancel
                                  ? std::min(static_cast<int>(remain), 200)
                                  : static_cast<int>(remain);
            if (inbox->pop(&msg, slice)) {
                got = true;
                break;
            }
            if (options->cancel && options->cancel->load()) {
                debug("本地取消接收（等待中），当前 " + id);
                abort_current(true, "user");
                return true;
            }
            if (inbox->closed() || !dc->isOpen()) return true;
        }
        if (!got) {
            if (!dc->isOpen()) return true;
            if (!options->idle_is_error) return true;
            options->error = "等待对方超时";
            return false;
        }
        deadline = std::chrono::steady_clock::now() +
                   std::chrono::milliseconds(options->idle_timeout_ms);

        if (std::holds_alternative<rtc::binary>(msg)) {
            const auto& raw = std::get<rtc::binary>(msg);
            // 没有 meta 就来的分片只能丢掉，没有地方写
            if (!file.is_open()) continue;
            std::vector<unsigned char> frame(raw.size());
            std::transform(raw.begin(), raw.end(), frame.begin(),
                           [](std::byte b) { return static_cast<unsigned char>(b); });
            Chunk chunk;
            std::string reason;
            if (!decode_chunk(frame, &chunk, &reason)) {
                options->error = reason;
                return false;
            }
            if (chunk.index != expected_index) {
                options->error = "分片乱序：等 " + std::to_string(expected_index) + "，来 " +
                                 std::to_string(chunk.index);
                return false;
            }
            const size_t len = frame.size() - chunk.payload_offset;
            file.write(reinterpret_cast<const char*>(frame.data() + chunk.payload_offset),
                       static_cast<std::streamsize>(len));
            expected_index++;
            received += len;
            report();
            // 网页端在等确认做背压，不回它会卡住
            if (received >= next_ack) {
                next_ack = received + kAckInterval;
                send_json(dc, {{"t", "ack"}, {"id", id}, {"received", received}});
            }
            continue;
        }

        if (!std::holds_alternative<rtc::string>(msg)) continue;
        nlohmann::json parsed;
        try {
            parsed = nlohmann::json::parse(std::string(std::get<rtc::string>(msg)));
        } catch (const std::exception&) {
            continue;
        }
        const std::string t = parsed.value("t", "");

        if (t == "meta") {
            // 上一个文件没收到 done 就又来一个 meta，先把旧的收尾
            if (file.is_open()) {
                file.flush();
                file.close();
            }
            id = parsed.value("id", "");
            declared = parsed.value("size", 0ULL);
            received = 0;
            expected_index = 0;
            next_ack = kAckInterval;
            name = sanitize(parsed.value("name", ""));
            std::filesystem::create_directories(std::filesystem::u8path(options->save_dir));
            const std::filesystem::path dest =
                unique_destination(std::filesystem::u8path(options->save_dir), name);
            target = dest.u8string();
            file.open(dest, std::ios::binary | std::ios::trunc);
            if (!file) {
                options->error = "建不了 " + target;
                return false;
            }
            std::cout << "开始接收 " << name << "（" << declared << " 字节）→ " << target
                      << std::endl;
            report();
            continue;
        }
        if (t == "text") {
            const std::string text = parsed.value("text", "");
            // 先回执再交给上层：回执是协议层的事，和界面怎么显示无关；早一步
            // 发出去，对端的"已送达"就能早一步落定。老对端不认识 text-ack，
            // 只会当成一条不认识的帧忽略掉，不会因此出错。
            send_json(dc, {{"t", "text-ack"}, {"id", parsed.value("id", "")}});
            std::cout << "收到文字：" << text << std::endl;
            if (options->on_text) options->on_text(text);
            if (out) out->got_text = true;
            if (options->stop_after_first) return true;
            continue;
        }
        if (t == "done") {
            if (!file.is_open()) continue;
            file.flush();
            file.close();
            const uint64_t written = static_cast<uint64_t>([&]() {
                std::ifstream check(std::filesystem::u8path(target),
                                    std::ios::binary | std::ios::ate);
                return check ? static_cast<uint64_t>(check.tellg()) : 0ULL;
            }());
            if (written != declared) {
                options->error = "大小不一致：落盘 " + std::to_string(written) + "，声明 " +
                                 std::to_string(declared);
                return false;
            }
            send_json(dc, {{"t", "ack"}, {"id", id}, {"received", written}});
            std::cout << "已收完 " << written << " 字节 → " << target << std::endl;
            if (out) out->saved_path = target;
            // 最后一次进度要先报，再报完成。反过来的话界面会先按完成收尾，
            // 后面那条 100% 的进度又会另起一行，列表里留下一条"接收中 100%"。
            report();
            if (options->on_file_done) options->on_file_done(target);
            if (options->stop_after_first) return true;
            continue;
        }
        if (t == "cancel") {
            const std::string cancel_id = parsed.value("id", "");
            debug("收到取消帧 " + cancel_id + "，当前 " + id +
                  (file.is_open() ? " 文件打开" : " 没有文件"));
            if (file.is_open() && (cancel_id.empty() || cancel_id == id)) {
                std::cout << "接收已取消 " << name << std::endl;
                const std::string cancel_reason = parsed.value("reason", "");
                // 先带着原因收尾，让 on_canceled 只发一条带 message 的事件；
                // 这一帧可能同时在取消对向的发送（id 省略时），再交给会话层。
                abort_current(false, cancel_reason);
                if (options->on_control) options->on_control(parsed);
                continue;
            }
            // 不是这次接收的取消帧，可能是在取消发出去的那个文件
            if (options->on_control && options->on_control(parsed)) continue;
            continue;
        }
        // 自己不认识的帧交给调用方，典型的是发送侧在等的 ack
        if (options->on_control && options->on_control(parsed)) continue;
    }
}

bool receive_once(const std::shared_ptr<rtc::DataChannel>& dc, MessageQueue* inbox,
                  const std::string& save_dir, int timeout_ms, bool* got_text,
                  std::string* saved_path) {
    ReceiveOptions options;
    options.save_dir = save_dir;
    options.idle_timeout_ms = timeout_ms;
    options.stop_after_first = true;
    ReceiveResult result;
    const bool ok = receive(dc, inbox, &options, &result);
    if (got_text) *got_text = result.got_text;
    if (saved_path) *saved_path = result.saved_path;
    return ok && (result.got_text || !result.saved_path.empty());
}

}  // namespace p2p
