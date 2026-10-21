#pragma once
// WebRTC 数据通道。libdatachannel 负责协议本身，这里只管接线。
//
// 谁建通道由设备号大小决定，和浏览器端、Rust 端是同一条规则。
// 非发起方想连的时候先发 connect-request，由发起方真的去建，
// 这样“谁发起”永远只有一个答案，不会有 offer 撞车。
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <rtc/rtc.hpp>

#include "signal.h"

namespace p2p {

/** 设备号大的那侧建通道。两端结论一致。 */
bool owns_channel(const std::string& my_id, const std::string& peer_id);

/**
 * 调传输层的参数。必须在建 PeerConnection 之前调一次。
 *
 * 现在只做一件事：把 SCTP 的收发缓冲从默认的 1 MB 提到 16 MB。
 * 这一项在本机实测里带来 6.6 倍差距（19.9 到 130.7 MB/s），
 * 详细的数字和为什么见 peer.cpp 里的注释。
 */
void tune_transport();

class Peer {
public:
    Peer(std::string my_id, std::string peer_id, bool initiator, SignalLink* link);
    ~Peer();

    /** 处理一条握手期的信令（sdp 或 ice） */
    void handle(const nlohmann::json& msg);

    /** 等数据通道打开 */
    bool wait_open(int timeout_ms);
    std::shared_ptr<rtc::DataChannel> channel() const { return dc_; }
    bool failed() const { return failed_.load(); }

    /** 通道打开时回调（在库的线程里跑，别在里面做重活） */
    void on_open(std::function<void()> cb) { on_open_ = std::move(cb); }
    void on_message(std::function<void(rtc::message_variant)> cb) { on_message_ = std::move(cb); }

private:
    void wire(const std::shared_ptr<rtc::DataChannel>& dc);
    void flush_local_candidates();
    void flush_remote_candidates();

    std::string my_id_;
    std::string peer_id_;
    SignalLink* link_;
    std::shared_ptr<rtc::PeerConnection> pc_;

    std::mutex mutex_;
    std::condition_variable cv_;
    std::shared_ptr<rtc::DataChannel> dc_;
    std::atomic<bool> failed_{false};

    // 顺序陷阱的两半，和 Rust 版踩过的是同一对：
    //   本地候选可能早于自己的 SDP 发出（对方会把迟到候选丢掉）
    //   远端候选可能早于对方的 SDP 到达（描述没设好时加不进去）
    std::atomic<bool> local_sent_{false};
    std::atomic<bool> remote_set_{false};
    std::vector<rtc::Candidate> pending_local_;
    std::vector<rtc::Candidate> pending_remote_;
    std::mutex candidate_mutex_;

    std::function<void()> on_open_;
    std::function<void(rtc::message_variant)> on_message_;
};

}  // namespace p2p
