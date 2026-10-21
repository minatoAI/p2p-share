# 在线互传 / P2P Share

**直接在设备之间传文件，内容不经过服务器。** 网页、Windows 托盘、安卓三个客户端，
用配对码或公开链接连接；灯塔只负责信令和在线状态，文件走浏览器/原生端的
WebRTC DataChannel。

> Public demo: <https://p2p-share-web.pages.dev>（不承诺 SLA，仅用于体验）

## 功能

- 网页 ↔ 安卓、网页 ↔ Windows、安卓 ↔ Windows 双向配对
- 文件、文字、公开链接取件；断线重连、离线等待、传输中取消
- 六位配对码 + 六位短认证串核对；配对码 20 秒轮换、30 秒有效
- 网页端刷新即换身份；Windows/安卓持久化身份和联系人
- 服务端不转发文件字节，只保存配对码和公开分享的元数据

## 目录

| 路径 | 内容 |
| --- | --- |
| `app/` | 网页端：React + Vite，Cloudflare Worker 灯塔，端到端测试 |
| `native-cpp/` | Windows 原生端：C++ / Win32 / WebView2，命令行与托盘 |
| `android/` | 安卓端：Kotlin / Compose / WebRTC |
| `BUILD.md` | 三端构建与测试说明 |
| `THIRD_PARTY_NOTICES.md` | 随包分发的第三方库说明 |

## 下载

GitHub Releases 提供两个安装包：

- `p2p-share-android-0.4.4.apk`：Android 8.0+（minSdk 26），arm64-v8a。
  这是用 Android debug key 签名的可直接安装包，不是应用商店版本。
- `p2p-share-windows-x64-setup.exe`：Windows 10/11 x64，按用户安装到
  `%LOCALAPPDATA%\p2p-share`，不需要管理员权限。安装包未做代码签名，
  SmartScreen 可能提示“未知发布者”。

## 快速开始

网页端：

```bash
cd app
npm install
npm run dev
```

Windows 端需要 VS 2022 C++ 工具链、CMake、Ninja、vcpkg，以及
`libdatachannel`、`webview2`、`openssl`、`nlohmann-json`。命令见
[BUILD.md](BUILD.md#windows)。

安卓端用 Android Studio 打开 `android/`，或：

```bash
cd android
./gradlew assembleDebug
```

默认灯塔是 `wss://p2p-share-web.pages.dev/ws/presence`，可在网页设置、
安卓设置或 Windows `settings.json` 中改成自建地址。自建部署方式见
`app/wrangler.jsonc` 和 `app/pages/wrangler.jsonc`。

## 测试

```bash
cd app
npm run typecheck
npm test
npm run test:worker
npm run test:e2e
```

测试覆盖配对、双向文字/文件、公开链接、断线恢复、取消、错误码和跨端互操作。
这些测试默认连公开灯塔；离线跑法见 [BUILD.md](BUILD.md#测试说明)。

## 隐私

- 文件内容只在设备之间传输，灯塔看不到文件字节。
- 灯塔保存：设备号、昵称、公钥、在线状态、配对码、公开分享的元数据。
- 网页端身份只在内存里，刷新即消失；原生端身份在本机。
- 公开链接的访客不需要账号；分享者离线后链接进入离线态，上线后恢复。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方组件许可见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 状态

这是从原型整理出的首个开源版本。接口和文件格式还可能调整；不要把它当成
经过安全审计的生产级产品。问题、建议和 PR 欢迎提。
