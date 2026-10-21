#!/usr/bin/env bash
# 编译 TcpBench 并推到已连接的 Android 设备。
# 需要设置 ANDROID_SDK；ADB 可选（默认 $ANDROID_SDK/platform-tools/adb）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SDK=${ANDROID_SDK:?请设置 ANDROID_SDK}
ADB=${ADB:-$SDK/platform-tools/adb}
D8=$(ls "$SDK"/build-tools/*/d8 2>/dev/null | tail -1)
[ -n "$D8" ] || { echo "找不到 d8，检查 ANDROID_SDK/build-tools" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
javac -encoding UTF-8 --release 11 -d "$TMP" "$HERE/TcpBench.java"
"$D8" --release --output "$TMP" "$TMP/TcpBench.class"
"$ADB" push "$TMP/classes.dex" sdcard/Download/tcpbench.dex
"$ADB" shell "cp /sdcard/Download/tcpbench.dex /data/local/tmp/tcpbench.dex"
echo "已推送 /data/local/tmp/tcpbench.dex"
echo "示例：adb shell \"CLASSPATH=/data/local/tmp/tcpbench.dex app_process /system/bin TcpBench send 192.168.1.10 9000 100\""
