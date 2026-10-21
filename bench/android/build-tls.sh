#!/usr/bin/env bash
# 编译 TlsBench 并推送 dex 和自签证书到设备。先跑 bench/tls-gen.sh。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SDK=${ANDROID_SDK:?请设置 ANDROID_SDK}
ADB=${ADB:-$SDK/platform-tools/adb}
D8=$(ls "$SDK"/build-tools/*/d8 2>/dev/null | tail -1)
[ -n "$D8" ] || { echo "找不到 d8，检查 ANDROID_SDK/build-tools" >&2; exit 1; }
[ -f "$ROOT/bench/key.pem" ] || { echo "先跑 bench/tls-gen.sh" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
javac -encoding UTF-8 --release 11 -d "$TMP" "$HERE/TlsBench.java"
"$D8" --release --output "$TMP" "$TMP"/*.class
"$ADB" push "$TMP/classes.dex" sdcard/Download/tlsbench.dex
"$ADB" push "$ROOT/bench/key.pem" sdcard/Download/tls-key.pem
"$ADB" push "$ROOT/bench/cert.pem" sdcard/Download/tls-cert.pem
"$ADB" shell "cp /sdcard/Download/tlsbench.dex /data/local/tmp/tlsbench.dex; cp /sdcard/Download/tls-key.pem /data/local/tmp/tls-key.pem; cp /sdcard/Download/tls-cert.pem /data/local/tmp/tls-cert.pem"
echo "已推送 /data/local/tmp/tlsbench.dex 和证书"
