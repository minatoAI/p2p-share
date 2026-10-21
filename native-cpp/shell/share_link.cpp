// 同 session.cpp：filesystem / 流式头要排在 json.hpp 前面
#include <filesystem>
#include <fstream>
#include <istream>

#include "share_link.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <thread>

#include <windows.h>
#include <winhttp.h>

#include "peer.h"
#include "protocol.h"

namespace shell {
namespace {

constexpr int64_t kShareTtlMs = 24LL * 60 * 60 * 1000;
constexpr int kHttpTimeoutMs = 6000;

std::wstring widen(const std::string& text) {
    if (text.empty()) return {};
    const int len = MultiByteToWideChar(CP_UTF8, 0, text.data(),
                                        static_cast<int>(text.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(len), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), len);
    return out;
}

std::string narrow(const std::wstring& text) {
    if (text.empty()) return {};
    const int len = WideCharToMultiByte(CP_UTF8, 0, text.data(),
                                        static_cast<int>(text.size()), nullptr, 0, nullptr,
                                        nullptr);
    std::string out(static_cast<size_t>(len), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), len,
                        nullptr, nullptr);
    return out;
}

nlohmann::json write_jwk(const p2p::PublicKeyJwk& jwk) {
    return nlohmann::json{{"kty", jwk.kty}, {"crv", jwk.crv}, {"x", jwk.x}, {"y", jwk.y}};
}

bool read_jwk(const nlohmann::json& node, p2p::PublicKeyJwk* out) {
    if (!node.is_object()) return false;
    out->kty = node.value("kty", "");
    out->crv = node.value("crv", "");
    out->x = node.value("x", "");
    out->y = node.value("y", "");
    return out->kty == "EC" && out->crv == "P-256" && !out->x.empty() && !out->y.empty();
}

struct HttpResponse {
    int status = 0;
    std::string body;
    std::string error;
};

HttpResponse http_request(const std::string& url, const std::wstring& method,
                          const std::string& body) {
    HttpResponse out;
    const std::wstring wide_url = widen(url);

    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    wchar_t host[256] = {};
    wchar_t path[2048] = {};
    parts.lpszHostName = host;
    parts.dwHostNameLength = 255;
    parts.lpszUrlPath = path;
    parts.dwUrlPathLength = 2047;
    if (!WinHttpCrackUrl(wide_url.c_str(), 0, 0, &parts)) {
        out.error = "链接格式不对";
        return out;
    }

    const std::wstring host_w(host, parts.dwHostNameLength);
    const std::wstring path_w(path, parts.dwUrlPathLength);
    HINTERNET session = WinHttpOpen(L"p2p-share-tray/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) {
        out.error = "网络初始化失败";
        return out;
    }
    WinHttpSetTimeouts(session, kHttpTimeoutMs, kHttpTimeoutMs, kHttpTimeoutMs, kHttpTimeoutMs);

    HINTERNET connection = WinHttpConnect(session, host_w.c_str(), parts.nPort, 0);
    if (!connection) {
        out.error = "连不上注册表";
        WinHttpCloseHandle(session);
        return out;
    }
    HINTERNET request = WinHttpOpenRequest(
        connection, method.c_str(), path_w.c_str(), nullptr, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
    if (!request) {
        out.error = "请求建不起来";
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return out;
    }

    const std::wstring headers = L"Content-Type: application/json\r\n";
    BOOL ok = WinHttpSendRequest(
        request, headers.c_str(), static_cast<DWORD>(headers.size()),
        body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
        static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0);
    if (ok) ok = WinHttpReceiveResponse(request, nullptr);
    if (!ok) {
        out.error = "请求发不出去";
    } else {
        DWORD status = 0;
        DWORD size = sizeof(status);
        WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &size,
                            WINHTTP_NO_HEADER_INDEX);
        out.status = static_cast<int>(status);
        DWORD available = 0;
        while (WinHttpQueryDataAvailable(request, &available) && available > 0) {
            std::string chunk(available, '\0');
            DWORD read = 0;
            if (!WinHttpReadData(request, chunk.data(), available, &read)) break;
            chunk.resize(read);
            out.body += chunk;
        }
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);
    return out;
}

std::string http_error_text(const HttpResponse& response) {
    if (!response.error.empty()) return response.error;
    try {
        const auto parsed = nlohmann::json::parse(response.body);
        const std::string error = parsed.value("error", "");
        if (!error.empty()) {
            const auto limit = parsed.value("limit", 0);
            return error + (limit ? "（上限 " + std::to_string(limit) + " 条）" : "");
        }
    } catch (const std::exception&) {
    }
    return "HTTP " + std::to_string(response.status);
}

int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

}  // namespace

ShareHub::ShareHub(p2p::Identity identity, std::string state_dir,
                   p2p::SignalLink* link, std::string lighthouse,
                   std::function<std::string()> device_name, Emit emit)
    : identity_(std::move(identity)),
      state_dir_(std::move(state_dir)),
      link_(link),
      origin_(p2p::http_origin(std::move(lighthouse))),
      device_name_(std::move(device_name)),
      emit_(std::move(emit)) {
    load();
}

ShareHub::~ShareHub() { stop(); }

void ShareHub::load() {
    const auto file = std::filesystem::u8path(state_dir_) / "shares.json";
    std::ifstream in(file, std::ios::binary);
    if (!in) return;
    nlohmann::json node;
    try {
        in >> node;
    } catch (const std::exception&) {
        return;
    }
    const int64_t now = now_ms();
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& item : node.value("items", nlohmann::json::array())) {
        Share share;
        share.token = item.value("token", "");
        share.path = item.value("path", "");
        share.name = item.value("name", "");
        share.mime = item.value("mime", "application/octet-stream");
        share.size = item.value("size", 0ULL);
        share.expires_at = item.value("expiresAt", 0LL);
        if (share.token.empty() || share.path.empty() || share.expires_at <= now) continue;
        std::error_code ec;
        if (!std::filesystem::exists(std::filesystem::u8path(share.path), ec)) continue;
        shares_.push_back(std::move(share));
    }
    save_locked();
}

void ShareHub::save_locked() {
    nlohmann::json items = nlohmann::json::array();
    for (const auto& share : shares_) {
        items.push_back({{"token", share.token},
                         {"path", share.path},
                         {"name", share.name},
                         {"mime", share.mime},
                         {"size", share.size},
                         {"expiresAt", share.expires_at}});
    }
    std::ofstream out(std::filesystem::u8path(state_dir_) / "shares.json",
                      std::ios::binary | std::ios::trunc);
    if (!out) return;
    out << nlohmann::json{{"version", 1}, {"items", items}}.dump(2) << "\n";
}

ShareHub::Share* ShareHub::find_locked(const std::string& token) {
    for (auto& share : shares_) {
        if (share.token == token) return &share;
    }
    return nullptr;
}

void ShareHub::emit_shares() {
    nlohmann::json items = nlohmann::json::array();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& share : shares_) {
            const bool downloading = share.phase == "connecting" || share.phase == "sending";
            items.push_back({{"token", share.token},
                             {"link", origin_ + "/#s=" + share.token},
                             {"name", share.name},
                             {"bytes", share.size},
                             {"expiresAt", share.expires_at},
                             {"phase", share.phase},
                             {"visitor", share.visitor_name},
                             {"downloads", downloading ? 1 : 0}});
        }
    }
    emit_(nlohmann::json{{"t", "shares"}, {"items", items}});
}

void ShareHub::create(const std::string& path) {
    std::error_code ec;
    const auto source = std::filesystem::u8path(path);
    const uint64_t size = std::filesystem::file_size(source, ec);
    if (ec) {
        emit_(nlohmann::json{{"t", "toast"}, {"text", "读不了这个文件"}});
        emit_(nlohmann::json{{"t", "share-cancelled"}});
        return;
    }
    std::string name = source.filename().u8string();
    if (name.empty()) name = "分享的文件";

    const nlohmann::json body{{"deviceId", identity_.device_id()},
                              {"deviceName", device_name_()},
                              {"publicKey", write_jwk(identity_.public_jwk())},
                              {"name", name},
                              {"size", size},
                              {"mime", "application/octet-stream"},
                              {"ttlMs", kShareTtlMs}};
    const auto response = http_request(origin_ + "/api/share", L"POST", body.dump());
    if (response.status < 200 || response.status >= 300) {
        const std::string detail = http_error_text(response);
        emit_(nlohmann::json{{"t", "toast"}, {"text", "生成链接失败：" + detail}});
        emit_(nlohmann::json{{"t", "share-cancelled"}});
        emit_(nlohmann::json{{"t", "debug"}, {"text", "分享创建失败：" + detail}});
        return;
    }
    std::string token;
    int64_t expires_at = 0;
    try {
        const auto parsed = nlohmann::json::parse(response.body);
        token = parsed.value("token", "");
        expires_at = parsed.value("expiresAt", 0LL);
    } catch (const std::exception&) {
    }
    if (token.empty()) {
        emit_(nlohmann::json{{"t", "toast"}, {"text", "注册表没给分享编号"}});
        emit_(nlohmann::json{{"t", "share-cancelled"}});
        return;
    }
    if (expires_at == 0) expires_at = now_ms() + kShareTtlMs;

    std::string link;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        // 同一个文件重复挂：旧 token 先留着，用户可以在列表里自己撤
        Share share;
        share.token = token;
        share.path = path;
        share.name = name;
        share.mime = "application/octet-stream";
        share.size = size;
        share.expires_at = expires_at;
        shares_.push_back(std::move(share));
        save_locked();
        link = origin_ + "/#s=" + token;
    }
    emit_(nlohmann::json{{"t", "share-created"},
                         {"token", token},
                         {"link", link},
                         {"name", name},
                         {"bytes", size},
                         {"expiresAt", expires_at}});
    emit_shares();
}

void ShareHub::revoke(const std::string& token) {
    std::string visitor;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        auto* share = find_locked(token);
        if (!share) return;
        if (active_ && active_token_ == token) visitor = active_visitor_;
        shares_.erase(shares_.begin() + (share - shares_.data()));
        save_locked();
    }
    emit_shares();

    if (!visitor.empty()) {
        refuse(visitor, token, "revoked");
        std::lock_guard<std::mutex> lock(mutex_);
        if (cancel_) cancel_->store(true);
        if (channel_) {
            try {
                channel_->close();
            } catch (const std::exception&) {
            }
        }
        if (inbox_) inbox_->close();
    }

    const auto response = http_request(origin_ + "/api/share/" + token, L"DELETE",
                                       nlohmann::json{{"deviceId", identity_.device_id()}}.dump());
    if (response.status < 200 || response.status >= 300) {
        const std::string detail = http_error_text(response);
        emit_(nlohmann::json{{"t", "debug"},
                             {"text", "撤销请求没成功：" + detail}});
        // 本地已经删了，但注册表还认这条链接。不能只说"已取消"，否则
        // 用户以为链接已经失效了。
        emit_(nlohmann::json{{"t", "toast"},
                             {"text", "本地已取消，但服务器没确认，链接可能还能用一会儿"}});
    }
    emit_(nlohmann::json{{"t", "debug"}, {"text", "分享已撤销：" + token}});
}

bool ShareHub::is_active_peer(const std::string& device_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return active_ && !device_id.empty() && device_id == active_visitor_;
}

void ShareHub::refuse(const std::string& to, const std::string& token, const std::string& reason) {
    if (!link_ || to.empty()) return;
    link_->send(nlohmann::json{{"t", "share-revoked"},
                               {"from", identity_.device_id()},
                               {"to", to},
                               {"token", token},
                               {"reason", reason}});
}

void ShareHub::set_visitor_phase(const std::string& token, const std::string& phase,
                                 const std::string& visitor_name) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (auto* share = find_locked(token)) {
            share->phase = phase;
            share->visitor_name = visitor_name;
        }
    }
    emit_shares();
}

void ShareHub::handle_signal(const nlohmann::json& msg) {
    const std::string type = msg.value("t", "");
    if (type == "share-connect") {
        const std::string from = msg.value("from", "");
        const std::string token = msg.value("token", "");
        const std::string visitor_name = msg.value("name", "访客");
        p2p::PublicKeyJwk visitor_key;
        if (from.empty() || token.empty() || !read_jwk(msg.value("publicKey", nlohmann::json()), &visitor_key)) {
            return;
        }
        // 设备号必须由送来的公钥推导。灯塔或中间人换一把钥匙就对不上。
        if (visitor_key.device_id() != from) {
            emit_(nlohmann::json{{"t", "debug"},
                                 {"text", "拒绝访客：设备号和公钥对不上 " + from}});
            return;
        }

        // 这里的状态判断必须一次做完：先看链接在不在、过没过期，再看名额。
        // 判断和占名额必须在同一把锁里，否则两个访客会同时看到"没人用"。
        bool not_found = false;
        bool expired = false;
        bool busy = false;
        bool duplicate = false;
        Share share;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            auto* found = find_locked(token);
            if (!found) {
                not_found = true;
            } else if (now_ms() > found->expires_at) {
                expired = true;
            } else if (active_ && active_token_ == token && active_visitor_ == from) {
                duplicate = true;
            } else if (active_) {
                busy = true;
            } else {
                active_ = true;
                active_token_ = token;
                active_visitor_ = from;
                found->phase = "connecting";
                found->visitor_name = visitor_name;
                share = *found;
            }
        }
        if (not_found) {
            refuse(from, token, "not-here");
            return;
        }
        if (expired) {
            refuse(from, token, "expired");
            return;
        }
        if (duplicate) return;
        if (busy) {
            refuse(from, token, "busy");
            return;
        }
        emit_shares();
        start_serve(share, from, visitor_key, visitor_name);
        return;
    }

    if (type == "share-leave") {
        const std::string token = msg.value("token", "");
        const std::string from = msg.value("from", "");
        std::lock_guard<std::mutex> lock(mutex_);
        if (!active_ || token != active_token_ || from != active_visitor_) return;
        if (auto* share = find_locked(token)) share->phase = "left";
        if (cancel_) cancel_->store(true);
        if (channel_) {
            try {
                channel_->close();
            } catch (const std::exception&) {
            }
        }
        if (inbox_) inbox_->close();
        return;
    }

    // 访客侧的撤销通知，分享者用不到
    if (type == "share-revoked") return;

    if (type == "sdp" || type == "ice") {
        std::lock_guard<std::mutex> lock(mutex_);
        if (active_ && msg.value("from", "") == active_visitor_ && peer_) {
            peer_->handle(msg);
        }
    }
}

void ShareHub::start_serve(const Share& share, const std::string& visitor_id,
                           const p2p::PublicKeyJwk& visitor_key, const std::string& visitor_name) {
    if (serve_thread_.joinable()) serve_thread_.join();
    serve_thread_ = std::thread([this, visitor_id, visitor_key, visitor_name, share]() {
        serve(visitor_id, visitor_key, visitor_name, share.token, share.path);
    });
}

void ShareHub::serve(std::string visitor_id, p2p::PublicKeyJwk visitor_key,
                     std::string visitor_name, std::string token, std::string path) {
    auto inbox = std::make_shared<p2p::MessageQueue>();
    auto cancel = std::make_shared<std::atomic<bool>>(false);
    auto peer = std::make_shared<p2p::Peer>(identity_.device_id(), visitor_id, true, link_);
    peer->on_message([inbox](rtc::message_variant msg) { inbox->push(std::move(msg)); });
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopping_ || !active_ || active_token_ != token || active_visitor_ != visitor_id) {
            inbox->close();
            return;
        }
        peer_ = peer;
        inbox_ = inbox;
        cancel_ = cancel;
    }

    emit_(nlohmann::json{{"t", "debug"}, {"text", "分享访客来取件：" + visitor_name}});

    std::shared_ptr<rtc::DataChannel> channel;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (!stopping_ && !cancel->load() && std::chrono::steady_clock::now() < deadline) {
        channel = peer->channel();
        if (channel && channel->isOpen()) break;
        if (peer->failed()) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!channel || !channel->isOpen()) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (channel_) channel_.reset();
        }
        finish_serve(token, visitor_name, false, "数据通道没建起来");
        return;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        channel_ = channel;
    }
    if (!p2p::authenticate(channel, identity_, visitor_id, visitor_key, inbox.get(), 20000)) {
        finish_serve(token, visitor_name, false, "访客认证没通过");
        return;
    }
    set_visitor_phase(token, "sending", visitor_name);
    emit_(nlohmann::json{{"t", "debug"}, {"text", "开始给 " + visitor_name + " 发送分享文件"}});

    p2p::AckTracker acks;
    p2p::ReceiveOptions options;
    options.save_dir = state_dir_;
    options.idle_timeout_ms = 3000;
    options.idle_is_error = false;
    options.cancel = cancel.get();
    options.notify_peer_on_cancel = false;
    options.on_debug = [this](const std::string& text) {
        emit_(nlohmann::json{{"t", "debug"}, {"text", "分享接收：" + text}});
    };
    options.on_control = [channel, &acks, cancel](const nlohmann::json& frame) {
        const std::string type = frame.value("t", "");
        if (type == "ack") {
            acks.on_ack(frame.value("id", ""), frame.value("received", 0ULL));
            return true;
        }
        if (type == "ping") {
            try {
                channel->send(nlohmann::json{{"t", "pong"}, {"id", frame.value("id", "")}}.dump());
            } catch (const std::exception&) {
            }
            return true;
        }
        if (type == "pong") return true;
        if (type == "cancel") {
            cancel->store(true);
            return true;
        }
        return false;
    };
    std::thread receiver([this, channel, inbox, &options, cancel]() {
        while (!stopping_ && !cancel->load() && channel->isOpen()) {
            p2p::receive(channel, inbox.get(), &options, nullptr);
        }
        // 通道被访客那头关掉时，发送侧还在等 ack。这里也置位，别让名额
        // 一直占着等到 ack 超时。
        cancel->store(true);
    });

    const bool sent = p2p::send_file(
        channel, identity_, path, &acks, 60000,
        [this, visitor_name](const p2p::TransferProgress& progress) {
            emit_(nlohmann::json{{"t", "progress"},
                                 {"id", progress.id},
                                 {"name", progress.name},
                                 {"done", progress.done},
                                 {"total", progress.total},
                                 {"incoming", false},
                                 {"share", true},
                                 {"peer", visitor_name}});
        },
        cancel.get());

    // 先让接收线程退出，再关通道。反过来的话，接收线程可能正卡在往
    // 关闭中的通道写取消帧上，join 就回不来了。
    cancel->store(true);
    inbox->close();
    receiver.join();
    try {
        channel->close();
    } catch (const std::exception&) {
    }

    if (sent) {
        emit_(nlohmann::json{{"t", "debug"}, {"text", "已把分享文件交给 " + visitor_name}});
        finish_serve(token, visitor_name, true, "");
    } else {
        finish_serve(token, visitor_name, false, "传输没完成");
    }
}

void ShareHub::finish_serve(const std::string& token, const std::string& visitor_name, bool ok,
                            const std::string& note) {
    std::string phase = ok ? "done" : "failed";
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (auto* share = find_locked(token)) {
            share->phase = phase;
            share->visitor_name = visitor_name;
        }
        if (active_token_ == token) {
            active_ = false;
            active_token_.clear();
            active_visitor_.clear();
            channel_.reset();
            inbox_.reset();
            cancel_.reset();
            peer_.reset();
        }
    }
    if (!ok) {
        emit_(nlohmann::json{{"t", "debug"},
                             {"text", "分享给 " + visitor_name + " 失败：" + note}});
    }
    emit_shares();
}

void ShareHub::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopping_) return;
        stopping_ = true;
        if (cancel_) cancel_->store(true);
        if (channel_) {
            try {
                channel_->close();
            } catch (const std::exception&) {
            }
        }
        if (inbox_) inbox_->close();
    }
    if (serve_thread_.joinable()) serve_thread_.join();
}

}  // namespace shell
