# 第三方组件

本项目自身代码以 MIT 发布。随二进制或源码一起分发的第三方组件如下；各组件的
完整许可证以对应上游仓库/包内的 LICENSE 为准。

## Windows 托盘内置

| 组件 | 版本 | 许可证 | 来源 |
| --- | --- | --- | --- |
| qrcode-generator | 2.0.4 | MIT | https://github.com/kazuhikoarase/qrcode-generator |
| jsQR | 1.4.0 | Apache-2.0 | https://github.com/cozmo/jsQR |
| libdatachannel | 0.24.x | MPL-2.0 | https://github.com/paullouisageneau/libdatachannel |
| OpenSSL | 3.x | Apache-2.0 | https://www.openssl.org |
| nlohmann/json | 3.x | MIT | https://github.com/nlohmann/json |
| WebView2 SDK | Microsoft | Microsoft 许可 | https://developer.microsoft.com/microsoft-edge/webview2/ |

`native-cpp/tray/web/qrcode.js` 和 `jsqr.js` 的文件头保留了原许可证声明；
Apache-2.0 全文见 <https://www.apache.org/licenses/LICENSE-2.0>。

## 网页端

`app/package.json` 中的 npm 依赖（React、Vite、Hono、qrcode、zxing-wasm、
ggwave 等）各自带有许可证；安装依赖后可在 `node_modules/<包>/LICENSE` 查看。
构建产物部署时，建议在页面底部保留“第三方组件”链接或把本文件一并发布。

## 安卓端

`android/app/build.gradle.kts` 中的依赖（AndroidX Compose、OkHttp、
WebRTC SDK、ZXing 等）各自带有许可证；AAR/POM 内包含对应的 LICENSE/NOTICE。
发布 APK 时请保留这些声明。
