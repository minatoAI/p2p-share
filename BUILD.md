# 构建与测试

三端都依赖公开灯塔做信令。默认地址在源码里是
`wss://p2p-share-web.pages.dev/ws/presence`；自建时改各端的 lighthouse 配置。

## 网页端

需要 Node.js 20+。

```bash
cd app
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm test             # 核心层单元测试
npm run test:worker  # 本地 Wrangler + Worker 集成测试
npm run test:e2e     # Playwright，默认 Edge 通道
```

`npm run test:worker` / `test:e2e` 会启动本地 Wrangler 和浏览器，不需要线上账号。
如果本机端口/浏览器通道不同，看 `app/playwright.config.ts` 和 `app/vite.config.ts`。

## Windows

需要：

- Visual Studio 2022 的“使用 C++ 的桌面开发”工作负载（MSVC + Windows SDK）
- CMake 3.20+、Ninja
- vcpkg
- WebView2 Runtime（安装包运行时会用；开发机一般已带）

在 **x64 Native Tools Command Prompt for VS 2022** 里执行：

```bat
vcpkg install libdatachannel:x64-windows nlohmann-json:x64-windows ^
  openssl:x64-windows webview2:x64-windows

cmake -S native-cpp -B native-cpp/build -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_TOOLCHAIN_FILE=%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake

cmake --build native-cpp/build --target p2p p2p-tray p2p-setup
```

产物：

- `native-cpp/build/p2p.exe`：命令行原型，可用于对传测试
- `native-cpp/build/p2p-tray.exe`：托盘客户端
- `native-cpp/build/p2p-setup.exe`：安装包（开发构建，内嵌同一份托盘）

发布用静态包：

```bat
vcpkg install libdatachannel:x64-windows-static nlohmann-json:x64-windows-static ^
  openssl:x64-windows-static webview2:x64-windows-static

cmake -S native-cpp -B native-cpp/build-static -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_TOOLCHAIN_FILE=%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake ^
  -DVCPKG_TARGET_TRIPLET=x64-windows-static

cmake --build native-cpp/build-static --target p2p-tray p2p-setup
```

`p2p-setup.exe` 会把 `p2p-tray.exe` 作为资源编进去，所以要先构建 tray。
安装包未签名；公开分发前如果需要，可自行用代码签名证书签。

## 安卓

需要 JDK 17、Android SDK 37、Android Studio 或命令行 Gradle。

```bash
cd android
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

release 构建默认不配置签名：

```bash
./gradlew assembleRelease
# app/build/outputs/apk/release/app-release-unsigned.apk
```

用 `apksigner` 签名后再分发；GitHub Release 里的 APK 是用 Android debug key
签名的可直接安装包，不是商店版本。

## 测试说明

- 网页核心测试不联网；worker/e2e 会拉本地 Wrangler 和真实浏览器。
- 原生互操作 e2e 需要先构建 `p2p.exe`，并设置 `NATIVE_BIN`、`VCPKG_BIN`、
  `LIGHTHOUSE`、`E2E_BASE_URL`，详见 `app/tests/e2e/native-interop.spec.ts` 顶部。
- 公开灯塔只用于联调，不保证可用性和数据保留；生产部署请用
  `app/wrangler.jsonc` + `app/pages/wrangler.jsonc` 建自己的 Cloudflare 资源。
