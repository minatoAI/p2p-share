#!/usr/bin/env bash
# 生成 TLS 基准用的自签证书；只用于性能测试，不要用于生产。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$HERE/key.pem" -out "$HERE/cert.pem" -subj "/CN=p2p-bench" >/dev/null 2>&1
echo "已生成 $HERE/key.pem 和 cert.pem"
