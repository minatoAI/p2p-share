// 最小 libdatachannel 吞吐测试：WebSocket 信令 + 一条 DataChannel。
// 同一份代码编到 Windows（bench_peer.exe）和 Android（JNI .so），用来对比
// 安卓侧换 libdatachannel 后、真实高 RTT WiFi 下的 SCTP 表现。
#include <rtc/rtc.hpp>
#include <rtc/candidate.hpp>
#include <rtc/datachannel.hpp>
#include <rtc/description.hpp>
#include <rtc/peerconnection.hpp>
#include <rtc/websocket.hpp>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#ifdef __ANDROID__
#include <android/log.h>
#define BENCH_LOG(...) __android_log_print(ANDROID_LOG_INFO, "P2PBench", __VA_ARGS__)
#else
#define BENCH_LOG(...) do { std::printf(__VA_ARGS__); std::printf("\n"); std::fflush(stdout); } while (0)
#endif

namespace {

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr size_t kChunk = 256 * 1024;
constexpr size_t kRecvBuffer = 16 * 1024 * 1024;
constexpr size_t kSendBuffer = 1 * 1024 * 1024;

struct Options {
    std::string role;  // offer / answer
    std::string url;   // ws://host:port
    int megabytes = 100;
    bool send = false;
};

struct State {
    std::atomic<bool> done{false};
    std::atomic<uint64_t> bytes{0};
    std::atomic<bool> started{false};
    Clock::time_point start;
    std::mutex mutex;
};

void log_stats(const char* direction, uint64_t bytes, Clock::time_point start) {
    const double seconds = std::chrono::duration<double>(Clock::now() - start).count();
    const double mib = static_cast<double>(bytes) / 1048576.0;
    BENCH_LOG("[%s] %llu bytes in %.2f s = %.1f MiB/s", direction,
              static_cast<unsigned long long>(bytes), seconds, mib / seconds);
}

void run_peer(const Options& options) {
    rtc::SctpSettings sctp;
    sctp.recvBufferSize = kRecvBuffer;
#ifdef __ANDROID__
    sctp.sendBufferSize = options.send ? kSendBuffer : kRecvBuffer;
#else
    sctp.sendBufferSize = kRecvBuffer;
#endif
    rtc::SetSctpSettings(sctp);
    BENCH_LOG("start role=%s send=%d mb=%d recv=16MB send=1MB(Android)/16MB(other)", options.role.c_str(),
              options.send ? 1 : 0, options.megabytes);

    auto state = std::make_shared<State>();
    auto ws = std::make_shared<rtc::WebSocket>();
    std::shared_ptr<rtc::PeerConnection> pc;
    std::shared_ptr<rtc::DataChannel> dc;
    std::mutex signal_mutex;

    auto send_signal = [ws, &signal_mutex](const json& message) {
        std::lock_guard<std::mutex> lock(signal_mutex);
        if (ws->isOpen()) ws->send(message.dump());
    };

    ws->onOpen([&, state]() {
        BENCH_LOG("signaling open");
        rtc::Configuration config;
        config.iceServers.emplace_back("stun:stun.cloudflare.com:3478");
        pc = std::make_shared<rtc::PeerConnection>(config);
        pc->onLocalDescription([send_signal](rtc::Description description) {
            send_signal(json{{"type", description.typeString()}, {"sdp", std::string(description)}});
        });
        pc->onLocalCandidate([send_signal](rtc::Candidate candidate) {
            send_signal(json{{"type", "candidate"},
                             {"candidate", candidate.candidate()},
                             {"mid", candidate.mid()}});
        });
        pc->onStateChange([](rtc::PeerConnection::State s) {
            BENCH_LOG("pc state=%d", static_cast<int>(s));
        });

        auto wire_channel = [&, state](std::shared_ptr<rtc::DataChannel> channel) {
            dc = channel;
            channel->setBufferedAmountLowThreshold(8 * 1024 * 1024);
            channel->onOpen([&, state, channel]() {
                BENCH_LOG("data channel open, maxMessage=%zu", channel->maxMessageSize());
                if (!options.send) return;
                std::thread([&, state, channel]() {
                    std::vector<rtc::byte> chunk(kChunk, static_cast<rtc::byte>(0x5a));
                    const uint64_t total = static_cast<uint64_t>(options.megabytes) * 1024 * 1024;
                    uint64_t sent = 0;
                    auto start = Clock::now();
                    while (sent < total) {
                        while (channel->bufferedAmount() > kRecvBuffer / 2) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(2));
                        }
                        const size_t n = static_cast<size_t>(std::min<uint64_t>(kChunk, total - sent));
                        rtc::binary message(n);
                        std::memcpy(message.data(), chunk.data(), n);
                        channel->send(std::move(message));
                        sent += n;
                    }
                    BENCH_LOG("sender queued %llu bytes", static_cast<unsigned long long>(sent));
                    // 等接收端 ack；最多 30 秒
                    const auto deadline = Clock::now() + std::chrono::seconds(30);
                    while (!state->done.load() && Clock::now() < deadline) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(20));
                    }
                    log_stats("send", sent, start);
                    state->done = true;
                }).detach();
            });
            channel->onMessage([&, state](rtc::message_variant data) {
                if (std::holds_alternative<rtc::binary>(data)) {
                    const auto& bytes = std::get<rtc::binary>(data);
                    if (!state->started.exchange(true)) state->start = Clock::now();
                    const uint64_t total = static_cast<uint64_t>(options.megabytes) * 1024 * 1024;
                    const uint64_t now = state->bytes.fetch_add(bytes.size()) + bytes.size();
                    if (now >= total && !state->done.exchange(true)) {
                        log_stats("recv", now, state->start);
                        if (dc && dc->isOpen()) dc->send("ack");
                    }
                } else {
                    const auto& text = std::get<std::string>(data);
                    if (text == "ack") {
                        BENCH_LOG("received ack");
                        state->done = true;
                    }
                }
            });
        };

        if (options.role == "offer") {
            wire_channel(pc->createDataChannel("bench"));
            pc->setLocalDescription();
        } else {
            pc->onDataChannel([wire_channel](std::shared_ptr<rtc::DataChannel> channel) {
                wire_channel(channel);
            });
        }
        if (options.role == "offer") {
            // createDataChannel 会触发 offer
        }
    });

    ws->onMessage([&, state](rtc::message_variant data) {
        if (!std::holds_alternative<std::string>(data)) return;
        const json message = json::parse(std::get<std::string>(data), nullptr, false);
        if (message.is_discarded() || !pc) return;
        const std::string type = message.value("type", "");
        if (type == "offer" || type == "answer") {
            pc->setRemoteDescription(rtc::Description(message.value("sdp", ""), type));
            if (type == "offer" && options.role == "answer") {
                pc->setLocalDescription();
            }
        } else if (type == "candidate") {
            pc->addRemoteCandidate(rtc::Candidate(message.value("candidate", ""),
                                                  message.value("mid", "")));
        }
    });

    ws->onClosed([]() { BENCH_LOG("signaling closed"); });
    ws->onError([](std::string error) { BENCH_LOG("signaling error: %s", error.c_str()); });
    ws->open(options.url);

    const auto deadline = Clock::now() + std::chrono::seconds(120);
    while (!state->done.load() && Clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    BENCH_LOG("finish done=%d", state->done.load() ? 1 : 0);
    if (dc) dc->close();
    if (pc) pc->close();
    ws->close();
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
}

}  // namespace

#ifndef __ANDROID__
int main(int argc, char** argv) {
    if (argc < 5) {
        std::fprintf(stderr, "usage: %s <offer|answer> <ws://host:port> <mb> <send|recv>\n", argv[0]);
        return 2;
    }
    Options options;
    options.role = argv[1];
    options.url = argv[2];
    options.megabytes = std::atoi(argv[3]);
    options.send = std::strcmp(argv[4], "send") == 0;
    rtc::Preload();
    run_peer(options);
    rtc::Cleanup();
    return 0;
}
#endif
