#pragma once
// 灯塔长连接。配对和建连的信令都走它。
//
// libdatachannel 自带 WebSocket 客户端，所以不用再加别的依赖。
// 它的回调在库自己的线程上跑，所以这里只往队列里塞，不阻塞。
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>

#include <nlohmann/json.hpp>
#include <rtc/rtc.hpp>

namespace p2p {

class SignalLink {
public:
    SignalLink(const std::string& url, const std::string& device_id, const std::string& name);
    ~SignalLink();

    void send(const nlohmann::json& msg);
    /** 等一条消息。超时返回 false。 */
    bool next(nlohmann::json* out, int timeout_ms);
    bool connected() const { return open_.load(); }
    bool closed() const { return closed_.load(); }
    void close();
    /**
     * 丢掉当前 WebSocket 另开一条。
     *
     * 用于灯塔断开后的重连。对端（Peer）持有的是 SignalLink 的指针，
     * 所以这里只换内部的 socket，不换对象本身。
     */
    void reconnect();
    /**
     * 主动断开当前 socket，但对象还能接着用：外层会按掉线流程再走一遍
     * 重连和 hello，新名字就在这一步带上去。和 close() 不同，这个不是永久关闭。
     */
    void drop();
    /** 改报到时用的设备名。下一次连接生效，只在信令线程上调。 */
    void set_name(const std::string& name) { name_ = name; }

    /**
     * 把最近收发的信令倒出来。
     *
     * 为什么是"倒出来"而不是"实时打印"：这个竞态对时序很敏感，加一行 stderr
     * 输出就能把它盖掉（实测：开实时打印跑 64 次全过，不开稳定 4 次失败）。
     * 所以平时只记在内存里，出问题时才倒出来——正常路径上零 I/O。
     */
    void dump_recent(const char* reason) const;

private:
    /** 记一条，环形缓冲，只留最近这些条 */
    void remember(const char* direction, const nlohmann::json& msg);
    void open_socket();
    std::string endpoint() const;

    std::string url_;
    std::string device_id_;
    std::string name_;

    std::shared_ptr<rtc::WebSocket> ws_;
    /**
     * 回调里只认自己那一代 socket。
     *
     * 重连时旧的 socket 可能还有迟到的 onClosed/onMessage；不按世代过滤的话，
     * 它们会把刚建好的新连接标成断开，或者往新连接的消息队列里塞旧数据。
     */
    std::atomic<uint64_t> generation_{0};
    /** close() 之后就不该再重连，否则退出时还会留下一串重试。 */
    std::atomic<bool> disposed_{false};
    /**
     * 回调可能在 SignalLink 析构之后才跑，所以它们捕获这个共享标志而不是裸 this。
     * 标志本身由回调持有，析构时先置 false 再拆 socket。
     */
    std::shared_ptr<std::atomic<bool>> alive_;
    /**
     * 保护 ws_->send()。
     *
     * 这个锁不是可有可无的：send() 会被**两个线程**调用。配对那一串
     * （pair-response、watch）走主线程，而 libdatachannel 的
     * onLocalDescription / onLocalCandidate 回调跑在它自己的线程里，
     * sdp 和 ice 都是从那里发出来的。
     *
     * 实测症状：浏览器收到全部 ice，却一条 sdp 都没收到。原因就是 sdp 是
     * 回调线程发的第一条消息，那一刻主线程可能还在发 watch，两个线程同时
     * 进 ws_->send() 就把它挤掉了；ice 发得晚，主线程已经忙完，所以不受影响。
     * 这也解释了为什么网页↔网页不会这样——那边是 JS 单线程。
     */
    std::mutex send_mutex_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<nlohmann::json> inbox_;
    std::atomic<bool> open_{false};
    std::atomic<bool> closed_{false};
    mutable std::mutex trace_mutex_;
    std::deque<std::string> recent_;
};

/** 设备名里有中文和空格，拼进查询串之前要编码 */
std::string percent_encode(const std::string& text);

/**
 * 信令地址换成人能打开的站点地址。
 * wss://host/ws/presence → https://host，配对链接和分享链接都从这里拼。
 */
std::string http_origin(std::string url);

}  // namespace p2p
