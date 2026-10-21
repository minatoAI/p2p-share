cmake_minimum_required(VERSION 3.20)
project(p2p-lighthouse-native-cpp CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 静态 triplet 的库是 /MT 编的，我们自己的目标也得用 /MT，否则链接时报
# LNK2038「RuntimeLibrary 不匹配」，列出一堆库名，看不出根因是运行库选项。
# 动态 triplet 则两边都要 /MD，所以这个必须跟着 triplet 走，不能写死。
if(VCPKG_TARGET_TRIPLET MATCHES "static")
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# 必须加：源文件是 UTF-8 且含中文注释。MSVC 默认按本地代码页（936）读，
# 中文会把语法解析搞乱，报一堆看不懂的“未声明的标识符”，甚至吃掉 #include。
if(MSVC)
  add_compile_options(/utf-8)
  # nlohmann 在 C++17 下会生成 filesystem::path 的转换重载。这个项目里的
  # JSON 只和字符串打交道，而 MSVC 的 <filesystem>/<fstream>/<iomanip> 在这条
  # 头文件顺序上会互相踩（path 还没定义就被 json 引用）。直接关掉这部分重载。
  add_compile_definitions(JSON_HAS_FILESYSTEM=0 JSON_HAS_EXPERIMENTAL_FILESYSTEM=0)
endif()

find_package(OpenSSL REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(LibDataChannel CONFIG REQUIRED)


add_library(p2pcore STATIC
  src/crypto.cpp
  src/pairing.cpp
  src/protocol.cpp
  src/signal.cpp
  src/peer.cpp
  src/flow.cpp
  src/store.cpp
)
target_include_directories(p2pcore PUBLIC src)
target_link_libraries(p2pcore PUBLIC OpenSSL::Crypto nlohmann_json::nlohmann_json
                                 LibDataChannel::LibDataChannel)
if(WIN32)
  # SHGetKnownFolderPath 要 shell32 和 ole32（CoTaskMemFree）
  target_link_libraries(p2pcore PUBLIC shell32 ole32)
endif()

# 命令行原型
add_executable(p2p src/cli.cpp)
target_link_libraries(p2p PRIVATE p2pcore)

# 环境自检：能建起 PeerConnection 就说明传输层就位
add_executable(smoke smoke/main.cpp)
target_link_libraries(smoke PRIVATE LibDataChannel::LibDataChannel)

# Windows 外壳：Win32 加 WebView2。界面是本地网页，外壳是原生的。
#
# 注意：vcpkg 的 webview2 port 没有 CMake 配置文件（share 目录下只有元数据），
# 所以 find_package 找不到它，只能自己找头文件和导入库。
if(WIN32)
  find_path(WEBVIEW2_INCLUDE_DIR WebView2.h)
  find_library(WEBVIEW2_LOADER NAMES WebView2Loader.dll.lib WebView2LoaderStatic.lib)
  if(NOT WEBVIEW2_INCLUDE_DIR OR NOT WEBVIEW2_LOADER)
    message(FATAL_ERROR "找不到 WebView2 SDK。先跑 vcpkg install webview2:x64-windows")
  endif()

  # 定义 UNICODE/_UNICODE：不定义的话 IDI_APPLICATION、IDC_ARROW 这类
  # MAKEINTRESOURCE 宏会展开成窄字符的 LPSTR，传给 *W 版本的 API 直接编译不过。
  # 代码里一律显式写 *W 后缀，不依赖通用宏。
  set(SHELL_PAGE_NATIVE "${CMAKE_CURRENT_SOURCE_DIR}/shell/web/index.html")
  # 资源编号只在这一个地方定义，同时喂给 .rc 和 C++ 两侧，不会对不上
  set(SHELL_RESOURCE_ID 101)
  configure_file(shell/shell.rc.in ${CMAKE_CURRENT_BINARY_DIR}/shell.rc @ONLY)
  add_executable(p2p-shell WIN32 shell/main.cpp shell/sendto.cpp shell/notify.cpp shell/session.cpp shell/share_link.cpp shell/picker.cpp shell/overlay.cpp ${CMAKE_CURRENT_BINARY_DIR}/shell.rc)
  # NOMINMAX：windows.h 会把 min 和 max 定义成宏，之后 std::min、std::max、
  # time_point::max() 全被这两个宏吃掉，报的错还很难看懂（"::"右边的非法标记）。
  # 整个目标一起定义，省得每个文件各踩一次。
  target_compile_definitions(p2p-shell PRIVATE UNICODE _UNICODE NOMINMAX
    IDR_INDEX_HTML=${SHELL_RESOURCE_ID})
  target_include_directories(p2p-shell PRIVATE ${WEBVIEW2_INCLUDE_DIR} ${CMAKE_CURRENT_SOURCE_DIR})
  # winmm 是 PlaySound
  target_link_libraries(p2p-shell PRIVATE p2pcore ${WEBVIEW2_LOADER} shlwapi.lib winmm.lib winhttp.lib)
  # 界面文件放到 exe 旁边，外壳按相对路径加载
  add_custom_command(TARGET p2p-shell POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      ${CMAKE_CURRENT_SOURCE_DIR}/shell/web $<TARGET_FILE_DIR:p2p-shell>/web)
  # POST_BUILD 只在目标重新链接时才跑。只改网页不改代码的时候不会重新链接，
  # 于是拷过去的还是旧页面（看着界面没变，其实改了源码没生效，很费时间才发现）。
  # 把页面算进链接依赖，它一动就会重新链接。
  set_property(TARGET p2p-shell APPEND PROPERTY LINK_DEPENDS
    ${CMAKE_CURRENT_SOURCE_DIR}/shell/web/index.html)
  # 页面现在是编进 exe 的资源，页面一动资源就得重编
  # 注意依赖挂在生成出来的那个 .rc 上，不是模板上
  set_property(SOURCE ${CMAKE_CURRENT_BINARY_DIR}/shell.rc APPEND PROPERTY OBJECT_DEPENDS
    ${CMAKE_CURRENT_SOURCE_DIR}/shell/web/index.html)
  # WIN32 子系统正常不带控制台，但自检要打印结果，所以显式指定入口并保留 stdout
  target_link_options(p2p-shell PRIVATE /SUBSYSTEM:CONSOLE /ENTRY:wmainCRTStartup)

  # 「发送到」菜单的转发器。窗口子系统，没有控制台，从资源管理器启动不会闪黑框。
  add_executable(p2p-send WIN32 shell/send.cpp)
  target_include_directories(p2p-send PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

  # 托盘交互原型：只有界面，没有传输层。刻意不链接 p2pcore，
  # 它是拿来让人摸清"点哪儿、下一步看到什么"的，不是产品。
  add_executable(p2p-tray WIN32
    tray/main.cpp
    tray/server.cpp
    shell/notify.cpp
    shell/picker.cpp
    shell/sendto.cpp
    shell/session.cpp
    shell/share_link.cpp)
  target_link_libraries(p2p-tray PRIVATE p2pcore)
  target_compile_definitions(p2p-tray PRIVATE UNICODE _UNICODE NOMINMAX
    _WIN32_WINNT=0x0A00 WINVER=0x0A00
    TRAY_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tray")
  target_include_directories(p2p-tray PRIVATE ${WEBVIEW2_INCLUDE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/shell)
  # ws2_32 是本地静态服务，dwmapi 是圆角，winhttp 是分享注册表
  target_link_libraries(p2p-tray PRIVATE nlohmann_json::nlohmann_json ${WEBVIEW2_LOADER}
    shlwapi.lib winmm.lib shell32.lib ole32.lib ws2_32.lib winhttp.lib dwmapi.lib gdiplus.lib version.lib comdlg32.lib)
  # 单文件：网页和图标都编进 exe 的资源里，旁边不需要任何文件。
  # rc.exe 按工作目录解析相对路径，所以用一个 .rc.in 把绝对路径替换进去。
  set(TRAY_WEB_HTML "${CMAKE_CURRENT_SOURCE_DIR}/tray/web/popup.html")
  set(TRAY_WEB_CSS "${CMAKE_CURRENT_SOURCE_DIR}/tray/web/popup.css")
  set(TRAY_WEB_JS "${CMAKE_CURRENT_SOURCE_DIR}/tray/web/popup.js")
  # 二维码：qrcode-generator 画码，jsQR 解码。都是单文件，随 exe 编进去。
  set(TRAY_WEB_QRCODE "${CMAKE_CURRENT_SOURCE_DIR}/tray/web/qrcode.js")
  set(TRAY_WEB_JSQR "${CMAKE_CURRENT_SOURCE_DIR}/tray/web/jsqr.js")
  set(TRAY_ICON_STATIC "${CMAKE_CURRENT_SOURCE_DIR}/tray/assets/tray.ico")
  set(TRAY_ICON_BADGE "${CMAKE_CURRENT_SOURCE_DIR}/tray/assets/tray-badge.ico")
  foreach(frame RANGE 1 15)
    set(TRAY_ICON_${frame} "${CMAKE_CURRENT_SOURCE_DIR}/tray/assets/tray-${frame}.ico")
  endforeach()
  configure_file(${CMAKE_CURRENT_SOURCE_DIR}/tray/app.rc.in ${CMAKE_CURRENT_BINARY_DIR}/tray_app.rc @ONLY)
  target_sources(p2p-tray PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/tray_app.rc)
  set_property(SOURCE ${CMAKE_CURRENT_BINARY_DIR}/tray_app.rc APPEND PROPERTY OBJECT_DEPENDS
    "${TRAY_WEB_HTML};${TRAY_WEB_CSS};${TRAY_WEB_JS};${TRAY_WEB_QRCODE};${TRAY_WEB_JSQR}")

  # 安装包：自包含，把这一轮构建出来的托盘 exe 作为 RCDATA 编进去。
  # 发布用的安装包必须来自 build-tray-static（静态 CRT + 静态 WebView2 loader），
  # 动态构建里的这一份只用来开发时验证安装流程。
  set(SETUP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/setup")
  set(TRAY_EXE "${CMAKE_CURRENT_BINARY_DIR}/p2p-tray.exe")
  configure_file(${CMAKE_CURRENT_SOURCE_DIR}/setup/setup.rc.in
                 ${CMAKE_CURRENT_BINARY_DIR}/setup.rc @ONLY)
  add_executable(p2p-setup WIN32
    setup/main.cpp
    shell/sendto.cpp
    ${CMAKE_CURRENT_BINARY_DIR}/setup.rc)
  add_dependencies(p2p-setup p2p-tray)
  target_compile_definitions(p2p-setup PRIVATE UNICODE _UNICODE NOMINMAX
    _WIN32_WINNT=0x0A00 WINVER=0x0A00)
  target_include_directories(p2p-setup PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/shell)
  target_link_libraries(p2p-setup PRIVATE shlwapi.lib shell32.lib ole32.lib
    propsys.lib advapi32.lib comctl32.lib uxtheme.lib msimg32.lib)
  # 托盘 exe 一变，内嵌资源就得重编，否则安装包装的还是上一版
  set_property(SOURCE ${CMAKE_CURRENT_BINARY_DIR}/setup.rc APPEND PROPERTY OBJECT_DEPENDS
    "${TRAY_EXE}")
endif()

# 跨语言验收：拿 Rust 和浏览器那边产出的样本，验证 C++ 实现算出的值一致
add_executable(fixture tools/fixture.cpp)
target_link_libraries(fixture PRIVATE p2pcore)

# 身份持久化自检：同一份文件读两次，设备号必须一样，密钥必须还能签名
add_executable(identity-test tools/identity_test.cpp)
target_link_libraries(identity-test PRIVATE p2pcore)

# 原生对原生的吞吐测量。换不换 QUIC 全靠它给出的数字。
add_executable(throughput tools/throughput.cpp)
target_link_libraries(throughput PRIVATE LibDataChannel::LibDataChannel)
