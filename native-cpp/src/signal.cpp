#include "signal.h"

#include <cstdio>
#include <cstdlib>

#include <chrono>

namespace p2p {

/** 信令逐条跟踪。默认关着，排查时用 P2P_SIGNAL_TRACE=1 打开。 */
bool trace_enabled() {
    static const bool on = []() {
        const char* value = std::getenv("P2P_SIGNAL_TRACE");
        return value && *value && std::string(value) != "0";
    }();
    return on;
}

std::string percent_encode(const std::string& text) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : text) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 0x0f]);
        }
    }
    return out;
}

SignalLink::SignalLink(const std::string& url, const std::string& device_id,
                       const std::string& name)
    : url_(url),
      device_id_(device_id),
      name_(name),
      alive_(std::make_shared<std::atomic<bool>>(true)) {
    open_socket();
}

SignalLink::~SignalLink() {
    // 先让所有回调失效，再拆 socket。回调可能在库的线程上正跑到一半。
    alive_->store(false);
    close();
}

std::string SignalLink::endpoint() const {
    // 灯塔要求把身份写在查询串里，缺了它只会回一个 400 missing-device-id
    return url_ + (url_.find('?') == std::string::npos ? "?" : "&") +
           "deviceId=" + device_id_ + "&name=" + percent_encode(name_);
}

void SignalLink::open_socket() {
    if (disposed_.load()) return;
    const uint64_t gen = generation_.load();
    const auto alive = alive_;

    rtc::WebSocket::Configuration config;
    // WebSocket 协议层的 ping。它不是应用层消息，灯塔的免费额度不计这一笔。
    // 空闲 20 秒发一次；连续两次没回 pong 就判失败，交给会话层重连。
    // 没有 maxOutstandingPings 的话，半死的连接永远不会报错。
    config.pingInterval = std::chrono::seconds(20);
    config.maxOutstandingPings = 2;
    config.connectionTimeout = std::chrono::seconds(8);
    auto ws = std::make_shared<rtc::WebSocket>(config);

    ws->onOpen([this, alive, gen]() {
        if (!alive->load() || gen != generation_.load()) return;
        open_ = true;
        cv_.notify_all();
    });
    ws->onClosed([this, alive, gen]() {
        if (!alive->load() || gen != generation_.load()) return;
        std::fprintf(stderr, "灯塔连接已关闭\n");
        std::fflush(stderr);
        closed_ = true;
        cv_.notify_all();
    });
    ws->onError([this, alive, gen](std::string err) {
        if (!alive->load() || gen != generation_.load()) return;
        std::fprintf(stderr, "灯塔连接出错：%s\n", err.c_str());
        std::fflush(stderr);
        closed_ = true;
        cv_.notify_all();
    });
    ws->onMessage([this, alive, gen](rtc::message_variant msg) {
        if (!alive->load() || gen != generation_.load()) return;
        if (!std::holds_alternative<rtc::string>(msg)) return;
        try {
            auto parsed = nlohmann::json::parse(std::string(std::get<rtc::string>(msg)));
            std::lock_guard<std::mutex> lock(mutex_);
            inbox_.push_back(std::move(parsed));
        } catch (const std::exception&) {
            // 解不出来的消息直接丢，不值得让整条链路出错
        }
        cv_.notify_all();
    });

    {
        std::lock_guard<std::mutex> lock(send_mutex_);
        if (disposed_.load()) return;
        // open() 可能在返回前就触发 onOpen，所以 ws_ 必须先就位
        ws_ = ws;
    }
    try {
        ws->open(endpoint());
    } catch (const std::exception& error) {
        // 多半是 stop() 在这一瞬间把 socket 关了
        std::fprintf(stderr, "灯塔连接建立失败：%s\n", error.what());
        std::fflush(stderr);
        closed_ = true;
        cv_.notify_all();
    }
}

void SignalLink::reconnect() {
    if (disposed_.load()) return;
    // 这一代之后，旧 socket 的回调全部作废
    ++generation_;
    std::shared_ptr<rtc::WebSocket> old;
    {
        std::lock_guard<std::mutex> lock(send_mutex_);
        old = std::move(ws_);
    }
    if (old) {
        try {
            old->close();
        } catch (const std::exception&) {
            // 已经关了
        }
    }
    open_ = false;
    closed_ = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        // 旧连接上没来得及处理的消息已经过期了，留着只会把新连接带偏
        inbox_.clear();
    }
    cv_.notify_all();
    open_socket();
}

void SignalLink::drop() {
    if (disposed_.load()) return;
    ++generation_;
    std::shared_ptr<rtc::WebSocket> old;
    {
        std::lock_guard<std::mutex> lock(send_mutex_);
        old = std::move(ws_);
    }
    if (old) {
        try {
            old->close();
        } catch (const std::exception&) {
            // 已经关了
        }
    }
    open_ = false;
    // 外层循环看 closed() 退出，再由它自己调 reconnect()
    closed_ = true;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        inbox_.clear();
    }
    cv_.notify_all();
}

void SignalLink::send(const nlohmann::json& msg) {
    if (disposed_.load()) return;
    remember("发出", msg);
    // 见头文件里 send_mutex_ 的说明：这里会被主线程和 libdatachannel 的
    // 回调线程同时调用，不加锁会丢消息
    std::lock_guard<std::mutex> lock(send_mutex_);
    if (!ws_) return;
    try {
        const std::string text = msg.dump();
        // 记一下大小。sdp 是信令里最大的一条（带 ICE 候选），排查"只有 sdp
        // 收不到"时必须知道它到底多大，光看类型看不出名堂
        if (msg.value("t", "") == "sdp") {
            std::fprintf(stderr, "[信令] sdp 大小 %zu 字节\n", text.size());
            std::fflush(stderr);
        }
        // send() 有个容易忽略的返回值：同步发出去返回 true，如果内核缓冲区满
        // 就返回 false，数据改由异步缓冲发送。原生端配对后是连着快速发
        // pair-response / watch / sdp / ice 的，sdp 又正好是最大的一条，
        // 所以它比 ice 更容易撞上缓冲区满。这个返回值必须记下来——
        // 光看"发出去了"是看不出走没走异步那条路的。
        const bool queued = ws_->send(rtc::string(text));
        if (!queued || msg.value("t", "") == "sdp") {
            std::fprintf(stderr, "[信令] %s 发出结果=%s (%zu 字节)\n", msg.value("t", "").c_str(),
                         queued ? "同步" : "转异步", text.size());
            std::fflush(stderr);
        }
    } catch (const std::exception& error) {
        // 以前这里是静默的：send 抛出去会被回调那边吞掉，连一条日志都没有
        std::fprintf(stderr, "[信令] 发送失败 t=%s：%s\n", msg.value("t", "").c_str(),
                     error.what());
        std::fflush(stderr);
    }
}

void SignalLink::remember(const char* direction, const nlohmann::json& msg) {
    // 只留最近这些条。信令本身不多，但 ICE 阶段可能密集，所以要有上限。
    constexpr size_t kKeep = 400;
    char line[256] = {};
    std::snprintf(line, sizeof(line), "%s t=%-16s from=%s to=%s", direction,
                  msg.value("t", "").c_str(), msg.value("from", "").c_str(),
                  msg.value("to", "").c_str());
    std::lock_guard<std::mutex> lock(trace_mutex_);
    recent_.push_back(line);
    if (recent_.size() > kKeep) recent_.pop_front();
    if (trace_enabled()) std::fprintf(stderr, "[信令] %s\n", line);
}

void SignalLink::dump_recent(const char* reason) const {
    std::lock_guard<std::mutex> lock(trace_mutex_);
    std::fprintf(stderr, "[信令] ==== %s，以下是最近 %zu 条信令 ====\n", reason, recent_.size());
    for (const auto& line : recent_) std::fprintf(stderr, "[信令] %s\n", line.c_str());
    std::fprintf(stderr, "[信令] ==== 倒完 ====\n");
    std::fflush(stderr);
}

bool SignalLink::next(nlohmann::json* out, int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                      [this]() { return !inbox_.empty() || closed_.load(); })) {
        return false;
    }
    if (inbox_.empty()) return false;
    // 在**出队**这一层记，不在各个处理循环里记：这样被 continue 丢掉的
    // 消息也会留下痕迹，而"被丢掉"正是要查的东西
    remember("收到", inbox_.front());
    *out = std::move(inbox_.front());
    inbox_.pop_front();
    return true;
}

void SignalLink::close() {
    disposed_ = true;
    ++generation_;
    std::shared_ptr<rtc::WebSocket> old;
    {
        std::lock_guard<std::mutex> lock(send_mutex_);
        old = std::move(ws_);
    }
    if (old) {
        try {
            old->close();
        } catch (const std::exception&) {
            // 已经关了
        }
    }
    open_ = false;
    closed_ = true;
    cv_.notify_all();
}

std::string http_origin(std::string url) {
    if (url.rfind("wss://", 0) == 0) {
        url = "https://" + url.substr(6);
    } else if (url.rfind("ws://", 0) == 0) {
        url = "http://" + url.substr(5);
    }
    const auto scheme = url.find("://");
    const auto slash = url.find('/', scheme == std::string::npos ? 0 : scheme + 3);
    if (slash != std::string::npos) url.resize(slash);
    return url;
}

}  // namespace p2p
