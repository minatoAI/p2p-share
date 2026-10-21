#include "peer.h"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>

namespace p2p {

bool owns_channel(const std::string& my_id, const std::string& peer_id) { return my_id > peer_id; }

void tune_transport() {
    // SCTP 的收发缓冲默认只有 1 MB，这是原生对原生吞吐的真正瓶颈。
    //
    // 本机实测（tools/throughput.cpp，回环，两端同进程）：
    //   默认 1 MB   19.9 MB/s
    //   4 MB        67.6 MB/s
    //   16 MB      130.7 MB/s
    //   64 MB      129.4 MB/s
    // 也就是说不调这个，传输速度差 6.6 倍。而且 16 MB 就到头了，再加大没用。
    //
    // 维护者的说法能解释为什么：默认 1 MB 意味着 50 ms RTT 下理论上限只有
    // 200 Mbit/s。调大之后瓶颈转移到 DTLS 加解密上（实测 16 MB 时两端共占
    // 约 3.4 个核），那时候再谈换不换 QUIC 才有意义。
    //
    // 这是全局设置，必须在建 PeerConnection 之前调用，所以做成显式的初始化
    // 函数，由各入口在最前面调一次，而不是塞进构造函数里偷偷调。
    static std::once_flag once;
    std::call_once(once, []() {
        rtc::SctpSettings settings;
        size_t buffer = 16 * 1024 * 1024;
        // 留一个环境变量覆盖，用来在真机上做前后对比（把默认值调回 1 MB 看差多少）。
        // 正常使用不要设它。
        if (const char* override_mb = std::getenv("P2P_SCTP_MB")) {
            const long value = std::strtol(override_mb, nullptr, 10);
            if (value > 0) buffer = static_cast<size_t>(value) * 1024 * 1024;
        }
        settings.recvBufferSize = buffer;
        settings.sendBufferSize = buffer;
        rtc::SetSctpSettings(settings);
    });
}

Peer::Peer(std::string my_id, std::string peer_id, bool initiator, SignalLink* link)
    : my_id_(std::move(my_id)), peer_id_(std::move(peer_id)), link_(link) {
    tune_transport();
    rtc::Configuration config;
    config.iceServers.emplace_back("stun:stun.cloudflare.com:3478");
    pc_ = std::make_shared<rtc::PeerConnection>(config);

    pc_->onLocalDescription([this](rtc::Description desc) {
        // 先把 SDP 发出去，再放候选。顺序反了对方会把候选当"会话还没建时的迟到候选"丢掉。
        nlohmann::json msg{{"t", "sdp"},
                           {"from", my_id_},
                           {"to", peer_id_},
                           {"description",
                            {{"type", std::string(desc.typeString())}, {"sdp", std::string(desc)}}}};
        link_->send(msg);
        local_sent_ = true;
        flush_local_candidates();
    });

    pc_->onLocalCandidate([this](rtc::Candidate candidate) {
        if (!local_sent_.load()) {
            std::lock_guard<std::mutex> lock(candidate_mutex_);
            pending_local_.push_back(candidate);
            return;
        }
        nlohmann::json msg{{"t", "ice"},
                           {"from", my_id_},
                           {"to", peer_id_},
                           {"candidate",
                            {{"candidate", candidate.candidate()}, {"sdpMid", candidate.mid()}}}};
        link_->send(msg);
    });

    pc_->onStateChange([this](rtc::PeerConnection::State state) {
        std::cout << "[连接] " << static_cast<int>(state) << std::endl;
        if (state == rtc::PeerConnection::State::Failed ||
            state == rtc::PeerConnection::State::Closed) {
            failed_ = true;
            cv_.notify_all();
        }
    });

    pc_->onDataChannel([this](std::shared_ptr<rtc::DataChannel> dc) { wire(dc); });

    if (initiator) {
        wire(pc_->createDataChannel("data"));
    }
}

Peer::~Peer() {
    if (pc_) {
        try {
            pc_->close();
        } catch (const std::exception&) {
            // 已经关了
        }
    }
}

void Peer::flush_local_candidates() {
    std::vector<rtc::Candidate> queued;
    {
        std::lock_guard<std::mutex> lock(candidate_mutex_);
        queued.swap(pending_local_);
    }
    for (const auto& candidate : queued) {
        nlohmann::json msg{{"t", "ice"},
                           {"from", my_id_},
                           {"to", peer_id_},
                           {"candidate",
                            {{"candidate", candidate.candidate()}, {"sdpMid", candidate.mid()}}}};
        link_->send(msg);
    }
}

void Peer::flush_remote_candidates() {
    std::vector<rtc::Candidate> queued;
    {
        std::lock_guard<std::mutex> lock(candidate_mutex_);
        queued.swap(pending_remote_);
    }
    for (const auto& candidate : queued) {
        try {
            pc_->addRemoteCandidate(candidate);
        } catch (const std::exception& e) {
            std::cerr << "忽略一条加不上的候选：" << e.what() << std::endl;
        }
    }
}

void Peer::wire(const std::shared_ptr<rtc::DataChannel>& dc) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        dc_ = dc;
    }
    dc->onOpen([this]() {
        if (on_open_) on_open_();
        cv_.notify_all();
    });
    dc->onMessage([this](rtc::message_variant msg) {
        if (on_message_) on_message_(std::move(msg));
    });
    dc->onClosed([this]() {
        failed_ = true;
        cv_.notify_all();
    });
}

void Peer::handle(const nlohmann::json& msg) {
    const std::string t = msg.value("t", "");
    if (t == "sdp") {
        const auto& desc = msg.at("description");
        const std::string type = desc.value("type", "");
        const std::string sdp = desc.value("sdp", "");
        try {
            pc_->setRemoteDescription(rtc::Description(sdp, type));
        } catch (const std::exception& e) {
            std::cerr << "设远端描述失败：" << e.what() << std::endl;
            failed_ = true;
            return;
        }
        remote_set_ = true;
        flush_remote_candidates();
        return;
    }
    if (t == "ice") {
        const auto& cand = msg.at("candidate");
        rtc::Candidate candidate(cand.value("candidate", ""), cand.value("sdpMid", ""));
        if (!remote_set_.load()) {
            // 描述还没设好，先压着。早先"加不上就丢"的结果是候选全丢、ICE 必失败。
            std::lock_guard<std::mutex> lock(candidate_mutex_);
            pending_remote_.push_back(candidate);
            return;
        }
        try {
            pc_->addRemoteCandidate(candidate);
        } catch (const std::exception& e) {
            std::cerr << "忽略一条加不上的候选：" << e.what() << std::endl;
        }
    }
}

bool Peer::wait_open(int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex_);
    return cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                        [this]() {
                            return (dc_ && dc_->isOpen()) || failed_.load();
                        }) &&
           dc_ && dc_->isOpen();
}

}  // namespace p2p
