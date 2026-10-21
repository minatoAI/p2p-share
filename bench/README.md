# 局域网性能基线

这套小程序只做一件事：**绕开 App、WebRTC、协议栈，用 TCP 把当前 WiFi 的物理上限跑出来**，
再拿 App 的实测数字和它对比。

## 构建 Android 端

需要 Android SDK（build-tools + platform-tools）和 JDK 11+：

```bash
export ANDROID_SDK=/path/to/android-sdk
bash bench/android/build.sh
```

它会把 `TcpBench` 编译成 dex 推到手机的 `/data/local/tmp/tcpbench.dex`。

## 跑基线

先让手机和电脑在同一个局域网，记下手机 IP。以下命令都在电脑上执行：

```bash
# 手机 → 电脑
node bench/win/tcp-sink.js 9000
adb shell "CLASSPATH=/data/local/tmp/tcpbench.dex app_process /system/bin TcpBench send <电脑IP> 9000 100"

# 电脑 → 手机
adb shell "CLASSPATH=/data/local/tmp/tcpbench.dex app_process /system/bin TcpBench recv 9001 100"
node bench/win/tcp-source.js <手机IP> 9001 100

# 手机 4 条 TCP 并发，看单流是不是被窗口限制
node bench/win/tcp-sink.js 9002 4
adb shell "CLASSPATH=/data/local/tmp/tcpbench.dex app_process /system/bin TcpBench send4 <电脑IP> 9002 100"
```

`TcpBench` 默认把 socket 收发缓冲设成 4 MB，按 1 MB 块读写，不落盘；它量的是网络和手机
系统调用层的上限，不是 App 业务路径。

## TLS 1.3 + TCP 备选基线

局域网直连方案的安全版本，用来验证加密后的吞吐是否还够：

```bash
bash bench/tls-gen.sh             # 生成自签证书
bash bench/android/build-tls.sh  # 编译并推送 TlsBench + 证书

# 手机 → 电脑
node bench/win/tls-sink.js 9443
adb shell "CLASSPATH=/data/local/tmp/tlsbench.dex app_process /system/bin TlsBench send <电脑IP> 9443 100"

# 电脑 → 手机
adb shell "CLASSPATH=/data/local/tmp/tlsbench.dex app_process /system/bin TlsBench recv 9444 100"
node bench/win/tls-source.js <手机IP> 9444
```

自签证书只给基准用，生产方案要用现有设备身份做 TLS 证书/公钥 pin。

## 2026-10-22 实测

环境：Windows 11 + Realtek 8852BE（WiFi 6，协商 1201 Mbps），Xiaomi AX3000T 5G，
手机 Mi MIX 2S（802.11ac，Link speed 351–468 Mbps），两端同一 AP。

| 方式 | 吞吐 |
| --- | --- |
| 电脑 ↔ 电脑，走同一 WiFi（历史实测） | 66–76 MB/s |
| 手机 → 电脑，单条 TCP | 17.2 MB/s |
| 手机 → 电脑，4 条 TCP 并发 | 21.3 MB/s |
| 电脑 → 手机，单条 TCP | 20.2 MB/s |
| 手机 → 电脑，TLS 1.3 + TCP | 16.4 MB/s |
| 电脑 → 手机，TLS 1.3 + TCP | 21.3 MB/s |
| 当前 App，安卓 → Windows | 12.9 MB/s |
| 当前 App，Windows → 安卓 | 6.0–6.8 MB/s |

手机到路由器的 ping 平均约 55 ms（最低 19 ms，最高 99 ms），远高于电脑到路由器的 0 ms；
这是手机 WiFi 省电/链路适配的结果。TCP 靠 4 MB 窗口还能跑 17–20 MB/s，而 WebRTC 的
SCTP 在同样的 RTT 下受拥塞窗口和缓冲影响更明显。

## 结论

- **手机侧的物理上限大约 17–21 MB/s，不是电脑↔电脑的 70 MB/s。**
- 安卓 → Windows 已经跑到 TCP 基线的约 75%，剩余空间不大；
- Windows → 安卓只有 TCP 基线的约 30%，是主要优化点；
- TLS 1.3 加密后仍有 16.4 / 21.3 MB/s，说明“局域网 TCP/TLS 直连”是可行备选；
- 继续调 App 层分片/缓冲/落盘收益很小（实测在噪声内），要明显提升需要换传输方式
  （局域网 TCP/TLS 直连、QUIC，或 Android 上可调 SCTP 缓冲的 libdatachannel）。

## 其他备选验证到哪一步

- **libdatachannel**：Windows 原生端已经在用，`native-cpp/tools/throughput.cpp` 回环
  128 MB / 16 MB SCTP 缓冲实测 128.6 MB/s（3.44 核，两端同进程），说明桌面侧协议栈
  本身能跑满千兆；Android 侧换 libdatachannel 需要 NDK/JNI，本轮没有环境，未验证。
- **QUIC**：没有现成实现，未做数据；按 `docs/14-传输协议演进路线.md` 的结论，
  它适合多千兆/高 RTT/连接迁移，不适合为了当前千兆 WiFi 的速度去换。
- **局域网 TCP/TLS**：本轮已验证，手机→电脑 16.4 MB/s，电脑→手机 21.3 MB/s，
  是当前最接近物理上限、落地成本最低的备选。
