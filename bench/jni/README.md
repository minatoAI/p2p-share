# JNI + libdatachannel 最小验证

目的：在 Android 上用 JNI 跑 **libdatachannel**，和 Windows 端建立一条 WebRTC DataChannel，
在真实 WiFi（手机到路由器 RTT 约 55 ms）下传 100 MB，观察：

- 把 SCTP 接收缓冲从默认值调到 16 MB，能提升多少；
- 高 RTT 下 SCTP 拥塞控制/发送缓冲对双向吞吐的影响；
- 和当前 App（Android libwebrtc + Windows libdatachannel）的 12.9 / 6.8 MB/s 对比。

## 组成

```text
peer.cpp            核心：WebSocket 信令 + PeerConnection + DataChannel + 吞吐统计
                    （Windows 的 main 也在里面，非 Android 编译时启用）
jni_bridge.cpp      Android JNI 入口（编译成 libjni_bench.so）
android/Bench.java  app_process 驱动，调用 native start()
relay.js            最小 WebSocket 信令中继（两个客户端互转）
CMakeLists.txt      Windows 构建
android/CMakeLists.txt Android 构建
```

## 构建

Windows：

```bat
call vcvars64.bat
cmake -S bench\jni -B bench\jni\build-win -G Ninja -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_TOOLCHAIN_FILE=%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake
cmake --build bench\jni\build-win
```

Android（需要 NDK 28+，vcpkg 已装 `libdatachannel:arm64-android`）：

```bat
set ANDROID_NDK_HOME=<ndk>
cmake -S bench\jni\android -B bench\jni\build-android -G Ninja -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_TOOLCHAIN_FILE=%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake ^
  -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE=%ANDROID_NDK_HOME%/build/cmake/android.toolchain.cmake ^
  -DVCPKG_TARGET_TRIPLET=arm64-android ^
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28
cmake --build bench\jni\build-android
```

Java 侧：

```bash
javac -encoding UTF-8 --release 11 -d out bench/jni/android/Bench.java
d8 --release --output out out/Bench.class
adb push bench/jni/build-android/libjni_bench.so sdcard/Download/
adb push out/classes.dex sdcard/Download/bench.dex
adb shell "cp /sdcard/Download/libjni_bench.so /data/local/tmp/; cp /sdcard/Download/bench.dex /data/local/tmp/"
```

## 跑

电脑上启动信令中继（需要 `ws`，可复用网页端的 node_modules）：

```bash
NODE_PATH=/path/to/app/node_modules node bench/jni/relay.js 9600
```

Windows 端和 Android 端各跑一个。`offer` 是创建 DataChannel 的一侧，`send/recv` 决定谁发数据：

```bash
# W → A：Windows 发，Android 收
bench_peer.exe answer ws://127.0.0.1:9600 100 send
adb shell "CLASSPATH=/data/local/tmp/bench.dex app_process /system/bin Bench offer ws://<电脑IP>:9600 100 recv"

# A → W：Android 发，Windows 收
bench_peer.exe answer ws://127.0.0.1:9600 100 recv
adb shell "CLASSPATH=/data/local/tmp/bench.dex app_process /system/bin Bench offer ws://<电脑IP>:9600 100 send"
```

Android 日志：

```bash
adb logcat -s P2PBench:I
```

接收端加 `P2P_BENCH_SAVE=1` 会把数据写到 `/sdcard/Download/p2p-bench.bin`，用来区分
“纯接收”和“接收 + 落盘”的差距：

```bash
adb shell "P2P_BENCH_SAVE=1 CLASSPATH=/data/local/tmp/bench.dex app_process /system/bin Bench offer ws://<电脑IP>:9600 100 recv"
```

## 2026-10-22 实测

环境同 `bench/README.md`：Windows 11 + WiFi 6，手机 Mi MIX 2S，同一 AP。补充测量：
电脑到手机 **TCP 握手 RTT 中位数 2.2 ms**（p90 6.3 ms）；电脑 ping 手机 73 ms 是 ICMP 的
假象（Android 下行小包/省电处理），不能当 TCP RTT 用。

| 配置 | W → A | A → W |
| --- | --- | --- |
| 当前 App（Android libwebrtc + Windows libdatachannel） | 6.0–6.8 MB/s | 12.9 MB/s |
| 网页 Chromium（libwebrtc）→ 安卓 App（libwebrtc），100 MB | **6.5 MB/s** | — |
| JNI libdatachannel，Android 收 16 MB / 发 1 MB，256 KB 分片 | **11.2–15.7 MB/s**（两次） | **9.8 MB/s** |
| 同上，Android 收 1 MB | **14.3 MB/s** | — |
| 同上，JNI 收到后写 `/sdcard/Download` | **10.2 MB/s** | — |
| 同上，Android 发 16 MB | — | 8.2 MB/s |
| 同上，Android 发 4 MB | — | 8.5 MB/s |
| 同上，Android 发 1 MB + 16 KB 分片 | — | 7.3 MB/s |
| 同上，初始 cwnd 128 + RTCC | 10.9 MB/s | 9.8 MB/s |

结论：

1. **不是“两套 SCTP 互通”问题**：网页 Chromium（libwebrtc）→ 安卓 App（libwebrtc）也是
   **6.5 MB/s**，和当前 Android libwebrtc ↔ Windows libdatachannel 的 6.8 基本一样。
   两端同是 libwebrtc 也慢，说明瓶颈在 **Android libwebrtc 的 DataChannel 接收路径**，
   不是 dcSCTP 和 usrsctp 互通。
2. **不是硬件/WiFi 上限**：同一台手机、同一 WiFi，换 usrsctp 接收能到 10.2–14.3 MB/s；
   手机 TCP 基线 17–21 MB/s。
3. **不是 SCTP 缓冲大小**：Android 接收缓冲 1 MB 时 W→A 仍有 **14.3 MB/s**，和 16 MB 的
   11.2–15.7 在同一量级。
4. **不是高 RTT**：TCP 握手 RTT 中位数只有 2.2 ms；之前用 ICMP ping 得到的 55–75 ms 是
   Android 对下行 ICMP/小包的延迟，不代表 TCP/WebRTC 的 RTT。
5. **文件写入本身也吃掉一部分**：JNI 纯接收 14.3 → 写 `/sdcard/Download` 10.2；
   App 的 MediaStore 路径 6.5–6.8，应用专属目录 5.4。写路径不是全部，但确实是差距的一部分。
6. **发送方向**：libdatachannel 在 Android 上发 100 MB 只有 9.8 MB/s，低于当前 libwebrtc 的 12.9。
   当前 Android libwebrtc 的发送路径已经比 usrsctp 好。
7. **调 SCTP 拥塞控制参数没有收益**：初始 cwnd 128、maxBurst、RTCC 反而让 W→A 掉到 10.9。
8. 分片 256 KB 比 16/60 KB 好；发送缓冲 1 MB 比 4/16 MB 好。

## 这说明什么

- 之前把 ICMP 的 55–75 ms 当成链路 RTT，是测量方法错误；TCP 握手只有 2.2 ms，所以
  “高 RTT 导致 SCTP 慢”这个解释不成立。
- 也不是 dcSCTP ↔ usrsctp 互通：两端 libwebrtc 也是 6.5 MB/s。
- 根因更准确地说是 **Android libwebrtc 的 DataChannel 接收路径 + App 的落盘路径**：
  - 纯接收（JNI/usrsctp）14.3；
  - 加文件写入 10.2；
  - 当前 App 6.5–6.8。
- 所以不需要先 fork 两个库；可以先做两件低风险的事：
  1. 优化 App 接收落盘（减少 MediaStore/Java 层开销）；
  2. 用 JNI libdatachannel 做“接收专用”通道，发送继续用 libwebrtc。
- 如果最终要整体换传输层，再考虑 TCP/TLS（16.4/21.3）或双栈。

## 限制

- 这是基准程序，不是 App 集成；`app_process` 是 shell UID，真实 App 进程的调度/网络优先级可能不同。
- 只测了单条 DataChannel、单条流；多流/多连接未测。
- 没有做 TLS 证书 pin；WebRTC 本身有 DTLS，正式集成仍要做身份校验。
- 日志里的 MB/s 是 100 MB 单次结果，WiFi 波动约 ±10%。
