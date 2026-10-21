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

## 2026-10-22 实测

环境同 `bench/README.md`：Windows 11 + WiFi 6，手机 Mi MIX 2S，同一 AP，手机到路由器 RTT 平均 55 ms。

| 配置 | W → A | A → W |
| --- | --- | --- |
| 当前 App（Android libwebrtc + Windows libdatachannel） | 6.0–6.8 MB/s | 12.9 MB/s |
| JNI libdatachannel，Android 收 16 MB / 发 1 MB，256 KB 分片 | **15.5 MB/s** | **9.8 MB/s** |
| 同上，Android 发 16 MB | — | 8.2 MB/s |
| 同上，Android 发 4 MB | — | 8.5 MB/s |
| 同上，Android 发 1 MB + 16 KB 分片 | — | 7.3 MB/s |
| 同上，初始 cwnd 128 + RTCC | 10.9 MB/s | 9.8 MB/s |

结论：

1. **接收方向是最大瓶颈**：Android 接收缓冲从默认调到 16 MB，W→A 从 6.8 提到 **15.5 MB/s（2.3 倍）**。
   这直接证明“手机 WiFi 高 RTT + SCTP 接收窗口/缓冲”是当前 Windows→安卓慢的主因。
2. **发送方向没有变好**：libdatachannel 在 Android 上发 100 MB 只有 9.8 MB/s，低于当前 libwebrtc 的 12.9。
   当前 Android libwebrtc 的发送路径已经比这个 JNI 原型好，不能为了接收优化直接把 Android 整体换掉。
3. **调 SCTP 拥塞控制参数没有收益**：初始 cwnd 128、maxBurst、RTCC 反而让 W→A 从 15.5 掉到 10.9。
   libdatachannel 的默认 CC 在这条链路上更好。
4. 分片 256 KB 比 16/60 KB 好；发送缓冲 1 MB 比 4/16 MB 好。

## 这说明什么

- SCTP 拥塞控制在高 RTT 下确实影响很大，但**接收窗口/缓冲**是更容易拿到收益的杠杆；
- JNI + libdatachannel 是可行的，但**不能简单替换整个 Android 传输层**，否则 A→W 会退步；
- 下一步应该做“混合/按方向优化”：
  - Android 接收用可调缓冲的 libdatachannel；
  - Android 发送保留 libwebrtc，或继续调 libdatachannel 发送路径；
  - 或者直接做局域网 TCP/TLS，绕开 SCTP（基线已验证 16.4/21.3 MB/s）。

## 限制

- 这是基准程序，不是 App 集成；`app_process` 是 shell UID，真实 App 进程的调度/网络优先级可能不同。
- 只测了单条 DataChannel、单条流；多流/多连接未测。
- 没有做 TLS 证书 pin；WebRTC 本身有 DTLS，正式集成仍要做身份校验。
- 日志里的 MB/s 是 100 MB 单次结果，WiFi 波动约 ±10%。
