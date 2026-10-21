// 原生对原生的吞吐测量。
//
// 为什么要有这个：换不换 QUIC 这件事，全靠这个数字说话。在拿到它之前，
// 所有「QUIC 快 3 到 10 倍」的说法都是从别人的机器上抄来的，和我们无关。
//
// 做法是在一个进程里建两条 PeerConnection，互相交换描述和候选，走 127.0.0.1
// 的真实 UDP socket，上面还是完整的 SCTP over DTLS 那条栈。这样测的是协议栈
// 本身，不掺网络。代价有两个，报数的时候必须一起说清楚：
//   1. 两端在同一个进程里抢同一个 CPU，真机两边两台机器时数字会不同
//   2. 回环没有真实网卡，所以这是上限，不是局域网预期
//
// 用法：
//   throughput [--mb 256] [--chunk 256] [--sctp 0] [--seconds 0]
//     --mb      传多少 MB，默认 256
//     --chunk   每条消息多少 KB，默认 256（和传输协议里的分片量级一致）
//     --sctp    SCTP 收发缓冲设成多少 MB，0 表示用库的默认值（1 MB）
//     --seconds 按时间跑而不是按字节跑，0 表示按字节
//
// 输出里除了速度还给 CPU 占用：如果 CPU 打满一核，说明瓶颈在加密和用户态
// 搬数据，那 QUIC 的收益就大；如果 CPU 很闲而速度上不去，那是缓冲或者拥塞
// 控制的问题，调参就能解决，不必换协议。
#include <rtc/rtc.hpp>

#ifdef _WIN32
// 必须在 windows.h 之前：它会把 min 和 max 定义成宏，
// 之后 std::min 和 time_point::max() 都会被这俩宏吃掉，报的错还很难看懂。
#define NOMINMAX
#include <windows.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace std::chrono;

namespace {

/** 进程累计占用的 CPU 时间（内核加用户），用来判断是不是 CPU 瓶颈 */
double process_cpu_seconds() {
#ifdef _WIN32
    FILETIME creation = {}, exit_time = {}, kernel = {}, user = {};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit_time, &kernel, &user)) return 0;
    auto to_seconds = [](const FILETIME& ft) {
        ULARGE_INTEGER value;
        value.LowPart = ft.dwLowDateTime;
        value.HighPart = ft.dwHighDateTime;
        // FILETIME 是 100 纳秒为单位
        return static_cast<double>(value.QuadPart) / 1e7;
    };
    return to_seconds(kernel) + to_seconds(user);
#else
    return 0;
#endif
}

struct Options {
    size_t megabytes = 256;
    size_t chunk_kb = 256;
    size_t sctp_mb = 0;
    double seconds = 0;
};

bool parse(int argc, char** argv, Options* out) {
    for (int i = 1; i < argc; i++) {
        const std::string flag = argv[i];
        auto next = [&](size_t* target) {
            if (i + 1 >= argc) return false;
            *target = static_cast<size_t>(std::stoull(argv[++i]));
            return true;
        };
        if (flag == "--mb") {
            if (!next(&out->megabytes)) return false;
        } else if (flag == "--chunk") {
            if (!next(&out->chunk_kb)) return false;
        } else if (flag == "--sctp") {
            if (!next(&out->sctp_mb)) return false;
        } else if (flag == "--seconds") {
            if (i + 1 >= argc) return false;
            out->seconds = std::stod(argv[++i]);
        } else {
            return false;
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    rtc::InitLogger(rtc::LogLevel::Warning);
    Options options;
    if (!parse(argc, argv, &options)) {
        std::printf("用法：throughput [--mb 256] [--chunk 256] [--sctp 0] [--seconds 0]\n");
        return 2;
    }

    if (options.sctp_mb > 0) {
        rtc::SctpSettings settings;
        settings.recvBufferSize = options.sctp_mb * 1024 * 1024;
        settings.sendBufferSize = options.sctp_mb * 1024 * 1024;
        rtc::SetSctpSettings(settings);
        std::printf("SCTP 收发缓冲设成 %zu MB\n", options.sctp_mb);
    } else {
        std::printf("SCTP 缓冲用库的默认值（1 MB）\n");
    }

    const size_t total = options.megabytes * 1024 * 1024;
    const size_t chunk = options.chunk_kb * 1024;
    const auto deadline = options.seconds > 0
                              ? steady_clock::now() + milliseconds(static_cast<long>(options.seconds * 1000))
                              : steady_clock::time_point::max();

    rtc::Configuration config;
    // 只走回环，别让它去挑 Teredo 之类的候选，那些会把测量搞乱
    config.bindAddress = "127.0.0.1";
    config.disableAutoNegotiation = false;

    auto sender = std::make_shared<rtc::PeerConnection>(config);
    auto receiver = std::make_shared<rtc::PeerConnection>(config);

    // 连不上的时候，日志和状态回调是唯一能看出卡在哪一步的东西
    // （候选没换出去？ICE 没配对？DTLS 没握上？）
    sender->onStateChange([](rtc::PeerConnection::State state) {
        std::printf("[发送侧] 连接状态：%d\n", static_cast<int>(state));
        std::fflush(stdout);
    });
    receiver->onStateChange([](rtc::PeerConnection::State state) {
        std::printf("[接收侧] 连接状态：%d\n", static_cast<int>(state));
        std::fflush(stdout);
    });

    sender->onLocalDescription([receiver](rtc::Description d) { receiver->setRemoteDescription(d); });
    sender->onLocalCandidate([receiver](rtc::Candidate c) { receiver->addRemoteCandidate(c); });
    receiver->onLocalDescription([sender](rtc::Description d) { sender->setRemoteDescription(d); });
    receiver->onLocalCandidate([sender](rtc::Candidate c) { sender->addRemoteCandidate(c); });

    std::atomic<size_t> received{0};
    std::atomic<bool> finished{false};
    std::mutex mutex;
    std::condition_variable cv;

    // 发送侧缓冲满了就等这个条件，别用 sleep：
    // Windows 的 sleep 粒度默认是 15 毫秒，轮询一次就足以把吞吐打骨折。
    std::atomic<bool> buffer_low{false};
    std::atomic<size_t> watermark{4 * 1024 * 1024};

    // 收侧必须把拿到的通道存住。
    // onDataChannel 的参数是回调的局部 shared_ptr，回调一返回它就析构了，
    // 底下的 SCTP 流会跟着被关掉，表现是"通道打开又立刻关闭"。
    // 官方 example 把它放进 map 就是为了这个。
    std::shared_ptr<rtc::DataChannel> receiver_channel;

    receiver->onDataChannel([&](std::shared_ptr<rtc::DataChannel> channel) {
        std::printf("[接收侧] 收到数据通道\n");
        std::fflush(stdout);
        receiver_channel = channel;
        // 必须用"二进制加文本"那个双回调重载：
        // 单回调的签名收的是 message_variant，而 variant 不会隐式转成 binary，
        // 只写一个 lambda 的话编译器找不到可用的重载。
        channel->onMessage(
            [&](rtc::binary data) {
                const size_t now = received.fetch_add(data.size()) + data.size();
                if (now >= total || steady_clock::now() >= deadline) {
                    finished = true;
                    cv.notify_all();
                }
            },
            [](rtc::string) {});
    });

    auto channel = sender->createDataChannel("bench");
    channel->onOpen([&]() {
        std::printf("[发送侧] 数据通道已打开\n");
        std::fflush(stdout);
        cv.notify_all();
    });
    channel->onClosed([]() { std::printf("[发送侧] 数据通道已关闭\n"); });
    channel->onError([](std::string e) { std::printf("[发送侧] 数据通道出错：%s\n", e.c_str()); });
    channel->setBufferedAmountLowThreshold(1024 * 1024);
    channel->onBufferedAmountLow([&]() {
        buffer_low = true;
        cv.notify_all();
    });

    sender->setLocalDescription();

    {
        std::unique_lock<std::mutex> lock(mutex);
        if (!cv.wait_for(lock, seconds(20), [&]() { return channel->isOpen(); })) {
            std::printf("数据通道没打开（20 秒超时）\n");
            return 1;
        }
    }
    std::printf("数据通道已打开，开始传 %zu MB，每条消息 %zu KB（库允许的单条上限 %zu 字节）\n",
                options.megabytes, options.chunk_kb, channel->maxMessageSize());

    std::vector<std::byte> payload(chunk, std::byte{0x5a});
    size_t sent = 0;
    const double cpu_before = process_cpu_seconds();
    const auto started = steady_clock::now();

    while (!finished.load()) {
        if (options.seconds > 0 && steady_clock::now() >= deadline) {
            finished = true;
            break;
        }
        if (options.seconds == 0 && sent >= total) break;

        const size_t buffered = channel->bufferedAmount();
        if (buffered < watermark.load()) {
            const size_t remaining = options.seconds > 0 ? chunk : total - sent;
            const size_t size = std::min(chunk, remaining);
            if (channel->send(reinterpret_cast<const rtc::byte*>(payload.data()), size)) {
                sent += size;
            } else {
                // 库说缓冲满了，等它降到阈值以下
                buffer_low = false;
                std::unique_lock<std::mutex> lock(mutex);
                cv.wait_for(lock, milliseconds(50), [&]() { return buffer_low.load(); });
            }
        } else {
            buffer_low = false;
            std::unique_lock<std::mutex> lock(mutex);
            cv.wait_for(lock, milliseconds(50), [&]() { return buffer_low.load(); });
        }
    }

    // 收完最后几片，别把在途的数据算丢了
    {
        std::unique_lock<std::mutex> lock(mutex);
        cv.wait_for(lock, seconds(30), [&]() { return received.load() >= (options.seconds > 0 ? 0 : total); });
    }

    const auto elapsed = duration<double>(steady_clock::now() - started).count();
    const double cpu_used = process_cpu_seconds() - cpu_before;
    const size_t got = received.load();
    const double mb = static_cast<double>(got) / (1024.0 * 1024.0);

    std::printf("\n收到 %zu 字节（%.1f MB），用时 %.2f 秒\n", got, mb, elapsed);
    if (elapsed > 0) {
        std::printf("吞吐 %.1f MB/s（%.2f Gbit/s）\n", mb / elapsed, mb * 8.0 / elapsed / 1024.0);
    }
    std::printf("本进程 CPU 占用 %.2f 秒，相当于 %.0f%% 的一个核\n", cpu_used,
                elapsed > 0 ? cpu_used / elapsed * 100.0 : 0.0);
    // 两个 PeerConnection 在同一进程里，所以这个 CPU 是收发两端合起来的
    std::printf("（两端同进程，CPU 是收发合起来算的；回环没有真实网卡，这是上限）\n");

    channel->close();
    sender->close();
    receiver->close();
    rtc::Cleanup();
    return 0;
}
