#pragma once
// 认证、文本和文件传输。
//
// 顺序是：数据通道打开 → 双向认证 → 传东西。认证没过不碰数据。
//
// 认证走数据通道而不走信令，这是有意的：一次性随机串是在已经过 DTLS 加密的
// 通道上交换的，能正确应答的人必然就是这条链路的另一端。
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <rtc/rtc.hpp>

#include "crypto.h"

namespace p2p {

/** 数据通道的消息队列。库的回调在自己的线程上跑，流程代码按顺序取。 */
class MessageQueue {
public:
    void push(rtc::message_variant msg);
    /** 等一条消息，超时返回 false，队列关掉也返回 false */
    bool pop(rtc::message_variant* out, int timeout_ms);
    /** 队列是否已经关掉（会话收尾时用） */
    bool closed();
    void close();

private:
    std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<rtc::message_variant> queue_;
    bool closed_ = false;
};

/**
 * 一次传输的进度。
 *
 * 界面上要显示进度条，所以传输过程必须能往外报数。原生侧的进度回调就这一条
 * 通道，命令行和界面都走它，消息格式由各自的回调决定。
 */
struct TransferProgress {
    std::string id;
    std::string name;
    uint64_t done = 0;
    uint64_t total = 0;
    /** true 表示这是收进来的，false 表示发出去的 */
    bool incoming = false;
};

using ProgressFn = std::function<void(const TransferProgress&)>;

/**
 * 发送侧等确认用的表。
 *
 * 为什么单独拎出来：收消息那条循环独占着消息队列，发送侧不能也去抢，
 * 否则两边会把对方的消息吃掉（发送侧等 ack 时可能吞掉一个 meta，
 * 接收侧则可能吞掉 ack）。所以收的那条循环把 ack 记到这里，发送侧等这里。
 */
class AckTracker {
public:
    void on_ack(const std::string& id, uint64_t received);
    /**
     * 等到 received >= size 或者超时。返回是否等到。
     *
     * cancel 非空时每 200ms 看一眼，取消后立刻返回 false，不用把整个超时等完。
     */
    bool wait_for(const std::string& id, uint64_t size, int timeout_ms,
                  const std::atomic<bool>* cancel = nullptr);
    void clear();

private:
    std::mutex mutex_;
    std::condition_variable cv_;
    std::map<std::string, uint64_t> received_;
};

/** 双向认证。两个方向都验完才返回 true。 */
bool authenticate(const std::shared_ptr<rtc::DataChannel>& dc,
                  const Identity& identity, const std::string& peer_id,
                  const PublicKeyJwk& peer_key, MessageQueue* inbox, int timeout_ms);

/** 发一段文字 */
bool send_text(const std::shared_ptr<rtc::DataChannel>& dc, const Identity& identity,
               const std::string& text);

/**
 * 发一个文件。分片头是两个小端 uint32：序号、总数。
 *
 * acks 用来等对方确认收完。这个参数不能是空的：只把分片交给库不等于送到了，
 * 库里可能还压着几十 MB。传 nullptr 就只能保证"发出去了"，不保证对方收到了。
 *
 * ack_timeout_ms 是等确认的上限，0 表示用默认值。
 * on_progress 每次推进都会回调，可以传空。
 * cancel 非空时每片/每次等待都看一眼，置位后给对方发一条 cancel 并返回 false，
 * 调用方据此区分"被取消"和"失败了"。
 */
bool send_file(const std::shared_ptr<rtc::DataChannel>& dc, const Identity& identity,
               const std::string& path, AckTracker* acks, int ack_timeout_ms = 0,
               ProgressFn on_progress = {}, const std::atomic<bool>* cancel = nullptr);

/**
 * 一直收，直到通道关了、或者空转超过 idle_timeout_ms。
 *
 * 命令行要的是"收到一样东西就结束"，界面要的是"一直守着"，所以用
 * stop_after_first 区分，实现只有一份。
 */
struct ReceiveOptions {
    std::string save_dir;
    /** 空转多久算完。收到东西就重新计时。 */
    int idle_timeout_ms = 60000;
    /** 命令行用：收到一样东西（文字或文件）就返回 */
    bool stop_after_first = false;
    /**
     * 空转超时算不算错误。
     *
     * 命令行要算（它就是"等一样东西"，等不到就是失败）；界面那条常驻接收循环
     * 不能算，它本来就是一直守着，空转几秒是常态。以前没区分，界面上会时不时
     * 冒一句"接收出错：等待对方超时"，其实什么都没错。
     */
    bool idle_is_error = true;
    ProgressFn on_progress;
    std::function<void(const std::string& text)> on_text;
    /** 一个文件完整落盘时回调，参数是路径 */
    std::function<void(const std::string& path)> on_file_done;
    /**
     * 一次接收被取消时回调（自己取消或对方取消）。半截文件已经删掉，
     * 参数是这次传输的 id、文件名和取消原因。
     *
     * 原因取值见 docs/36：screen-off / user / peer-offline，旧版本或空缺时
     * 是空串，界面端统一显示「已取消」。
     */
    std::function<void(const std::string& id, const std::string& name,
                       const std::string& reason)> on_canceled;
    /** 非空时置位就中止当前这次接收，删掉半截文件并通知对端 */
    const std::atomic<bool>* cancel = nullptr;
    /**
     * 本地取消时要不要给对端发 cancel 帧。
     *
     * 自己主动取消接收时要发，不然对方还在往这条通道里灌数据。但"收尾"
     * 场景（发送已经完成，只是让接收线程退出）不该发，而且那时通道可能
     * 正在关闭，往上面写会把线程卡住。
     */
    bool notify_peer_on_cancel = true;
    /** 排查用：接收流程里的关键节点，界面忽略，测试从日志里看 */
    std::function<void(const std::string&)> on_debug;
    /**
     * 自己不处理的控制帧交给它（典型的是 ack：那是发送侧在等的）。
     * 返回 true 表示已被消费。不设就直接丢掉。
     */
    std::function<bool(const nlohmann::json&)> on_control;
    /** 出错或超时的说明，成功结束时为空 */
    std::string error;
};

struct ReceiveResult {
    bool got_text = false;
    /** 最后落盘的那个文件的路径 */
    std::string saved_path;
};

/** 返回 false 表示出错（原因在 options.error 里） */
bool receive(const std::shared_ptr<rtc::DataChannel>& dc, MessageQueue* inbox,
             ReceiveOptions* options, ReceiveResult* out);

/**
 * 等对方发来的第一期东西：文字直接打出来，文件落盘。收完一样就返回。
 * 这是 receive 的薄封装，命令行用。
 */
bool receive_once(const std::shared_ptr<rtc::DataChannel>& dc, MessageQueue* inbox,
                  const std::string& save_dir, int timeout_ms, bool* got_text,
                  std::string* saved_path);

}  // namespace p2p
