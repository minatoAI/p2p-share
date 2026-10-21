// Windows 外壳：一个 Win32 窗口，里面装 WebView2，界面是本地网页。
//
// 为什么这么搭：主路径是右键菜单发文件，窗口只是设置入口（设备名、配对、历史）。
// 所以窗口用网页写最省事，而外壳本身是原生的，系统集成（托盘、右键菜单）
// 照样是原生 API，和界面用什么渲染无关。
//
// 自检模式：p2p-shell.exe --selftest
//   建窗但隐藏，等页面回报"设备号已渲染"，然后退出。
//   用来在没有人看着屏幕的情况下验证整条链路：窗口、WebView2、本地页面、
//   双向桥、以及原生侧给的设备号确实到了页面上。
#include <windows.h>
#include <wrl.h>
#include <WebView2.h>
#include <shlwapi.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "crypto.h"
#include "signal.h"
#include "store.h"

#include "ipc.h"
#include "notify.h"
#include "overlay.h"
#include "picker.h"
#include "session.h"

#include "sendto.h"

using namespace Microsoft::WRL;
using namespace p2p;

namespace {

constexpr wchar_t kVirtualHost[] = L"app.local";
constexpr wchar_t kStartUrl[] = L"https://app.local/index.html";
// 自定义消息：把"往页面发消息"这件事挪到界面线程去做
constexpr UINT kPostToPage = WM_APP + 1;
// 托盘图标上的鼠标事件
constexpr UINT kTrayMessage = WM_APP + 2;
// 自检用：在界面线程上发一个气泡
constexpr UINT kDoNotify = WM_APP + 3;
// 托盘右键菜单的项
constexpr UINT kMenuOpen = 1;
constexpr UINT kMenuSendTo = 2;
constexpr UINT kMenuExit = 3;

ComPtr<ICoreWebView2Controller> g_controller;
/** 造 WebResourceResponse 要用它，所以留一份 */
ComPtr<ICoreWebView2Environment> g_environment;
ComPtr<ICoreWebView2> g_webview;
HWND g_window = nullptr;
bool g_selftest = false;
std::wstring g_screenshot;
bool g_want_advertise = false;
std::atomic<bool> g_page_ready{false};
/** 页面说过 ready 了，可以收消息了 */
std::atomic<bool> g_page_listening{false};
/** 页面还没准备好之前攒下的消息 */
std::mutex g_outbox_mutex;
std::vector<std::string> g_outbox;
/** 等页面就绪的期间攒下来的文件路径，页面一 ready 就交给它 */
std::mutex g_pending_mutex;
std::vector<std::filesystem::path> g_pending_files;
std::string g_identity_path;
// 脚本化验收用：连上之后自动发这个文件，收发完自动退出
std::string g_join_code;
std::string g_send_when_connected;
bool g_exit_when_done = false;
// 隐藏窗口但不退出：无人值守地跑一次真实收发用
bool g_hidden = false;
// 换一个数据目录。测试要在同一台机器上跑两个实例，它们必须是两台不同的设备，
// 共用一份身份的话设备号一样，谁该建通道都算不出来。
std::filesystem::path g_state_dir;

std::unique_ptr<shell::Session> g_session;
shell::Overlay g_overlay;
// 自检用：不连灯塔，直接喂几条假进度，验证悬浮组件的绘制和拖放
bool g_test_overlay = false;
/** 命令行给的灯塔地址，读盘之后要重新应用，否则会被设置文件覆盖 */
std::string g_lighthouse_flag;
shell::Tray g_tray;
shell::NotifySound g_notify_sound = shell::NotifySound::Balloon;
// 设置文件里的那份。启动时读，用户改了立刻写回去。
Settings g_settings;
/** 自检用：不发通知就退出，通知发完再退出 */
bool g_test_notify = false;

/**
 * 把 JSON 发到页面。可以从任意线程调用。
 *
 * WebView2 的接口只在界面线程（STA）上安全，所以不能直接在这里调，
 * 要 PostMessage 转给窗口过程去发。后台线程（比如报码那条）就靠它。
 */
/**
 * 把编进 exe 的资源原样读出来。
 *
 * 界面就一个 html，编进 exe 之后分发只需要一个文件，不会出现"exe 拷走了、
 * web 目录忘了拷"这种情况。读一次就缓存住，页面每次加载都读一遍没必要。
 */
const std::string& embedded_page() {
    static const std::string page = []() {
        HRSRC found = FindResourceW(nullptr, MAKEINTRESOURCEW(IDR_INDEX_HTML), RT_RCDATA);
        if (!found) {
            // 按名字没找到就按类型枚举。顺带把枚举到的名字打出来：
            // 上次这里报 1814（名字找不到）而数据确实在 exe 里，
            // 打出来才能知道它到底存成了什么。
            std::fprintf(stderr, "[资源] 按名字 101 没找到（GetLastError=%lu），改成枚举 RCDATA\n",
                         GetLastError());
            struct State {
                HRSRC handle = nullptr;
                std::string names;
            } state;
            EnumResourceNamesW(
                nullptr, RT_RCDATA,
                [](HMODULE, LPCWSTR, LPWSTR name, LONG_PTR param) -> BOOL {
                    auto* state = reinterpret_cast<State*>(param);
                    if (IS_INTRESOURCE(name)) {
                        state->names += " #" + std::to_string(reinterpret_cast<ULONG_PTR>(name));
                    } else {
                        state->names += " (字符串名)";
                    }
                    if (!state->handle) state->handle = FindResourceW(nullptr, name, RT_RCDATA);
                    return TRUE;
                },
                reinterpret_cast<LONG_PTR>(&state));
            std::fprintf(stderr, "[资源] RCDATA 里有这些：%s\n",
                         state.names.empty() ? "（一个都没有）" : state.names.c_str());
            found = state.handle;
        }
        if (!found) {
            std::fprintf(stderr, "[资源] 还是没拿到页面，界面起不来\n");
            return std::string();
        }
        HGLOBAL loaded = LoadResource(nullptr, found);
        if (!loaded) return std::string();
        const void* data = LockResource(loaded);
        const DWORD size = SizeofResource(nullptr, found);
        if (!data || size == 0) return std::string();
        return std::string(static_cast<const char*>(data), size);
    }();
    return page;
}

/**
 * 稍等一下再关窗口。
 *
 * 为什么不能收完就关：确认帧是用 dc->send() 发出去的，那是**异步**的，数据先
 * 进 libdatachannel 的缓冲。紧接着销毁 PeerConnection，这一帧就上不了线，
 * 发送端等不到确认会报"对方没有确认收完"——文件其实完好无损。
 *
 * 真实使用时窗口不会自己关，所以只有自动化验证这条路会遇到；但正因为它是
 * 验证路径，报假失败比报不出失败更糟。
 */
void graceful_close() {
    std::thread([]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(1500));
        if (g_window) PostMessageW(g_window, WM_CLOSE, 0, 0);
    }).detach();
}

std::string utf16_to_utf8(const std::wstring& text) {
    if (text.empty()) return {};
    const int need = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                         nullptr, 0, nullptr, nullptr);
    if (need <= 0) return {};
    std::string out(static_cast<size_t>(need), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), need,
                        nullptr, nullptr);
    return out;
}

std::wstring utf8_to_utf16(const std::string& text) {
    if (text.empty()) return {};
    const int need = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                         nullptr, 0);
    if (need <= 0) return {};
    std::wstring out(static_cast<size_t>(need), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), need);
    return out;
}

void post_to_page(const std::string& json) {
    if (!g_window) return;
    // 页面注册监听之前发出去的消息会直接丢掉，没有报错也没有痕迹。
    // 会话在连上灯塔的那一刻就会推状态和历史，而那时候页面多半还没加载完，
    // 所以先攒着，等页面说"我准备好了"再一次性补发。
    if (!g_page_listening.load()) {
        std::lock_guard<std::mutex> lock(g_outbox_mutex);
        g_outbox.push_back(json);
        return;
    }
    auto* payload = new std::wstring(utf8_to_utf16(json));
    if (!PostMessageW(g_window, kPostToPage, reinterpret_cast<WPARAM>(payload), 0)) {
        delete payload;
    }
}

std::string json_escape(const std::string& text) {
    std::string out;
    for (char c : text) {
        if (c == '"' || c == '\\') out.push_back('\\');
        out.push_back(c);
    }
    return out;
}

/** 让页面开始发送这些文件 */
std::string files_message(const std::vector<std::filesystem::path>& files) {    nlohmann::json node{{"t", "files"}, {"paths", nlohmann::json::array()}};
    for (const auto& file : files) node["paths"].push_back(file.u8string());
    return node.dump();
}

/**
 * 「发送到」菜单或者命令行递进来的文件。页面还没就绪就先攒着，
 * 等页面说 ready 了再补交，否则这些文件会掉在空档里。
 */
void accept_files(const std::vector<std::filesystem::path>& files) {
    if (files.empty()) return;
    std::printf("[发送到] 收到 %zu 个文件\n", files.size());
    std::fflush(stdout);
    if (!g_page_ready.load()) {
        std::lock_guard<std::mutex> lock(g_pending_mutex);
        g_pending_files.insert(g_pending_files.end(), files.begin(), files.end());
        return;
    }
    post_to_page(files_message(files));
}

/** 灯塔地址。外壳里先写死本地，以后做成设置项。 */
const char* kLighthouse = "ws://127.0.0.1:8787/ws/presence";

Identity& identity() {
    // 身份从磁盘读，第一次启动才生成。之前每次启动都是新的设备号，
    // 结果就是"配对过一次"根本留不住，通讯录毫无意义。
    static Identity value = []() {
        const auto dir = g_state_dir.empty() ? default_app_dir() : g_state_dir;
        try {
            const auto loaded = load_or_create_identity(dir);
            g_identity_path = loaded.file.u8string();
            std::printf("%s 身份文件 %s\n", loaded.created ? "[身份] 首次启动，已生成" : "[身份] 已加载",
                        g_identity_path.c_str());
            std::fflush(stdout);
            return loaded.identity;
        } catch (const std::exception& e) {
            // 读坏了就说清楚，不静默重建。静默重建会让设备号无声无息地变，
            // 对方那边看着就是"来了一台新设备"，比报错难查得多。
            std::fprintf(stderr, "身份读不出来（%s），这次用临时身份启动\n", e.what());
            std::fflush(stderr);
            g_identity_path = "（未持久化）";
            return Identity::generate();
        }
    }();
    return value;
}

/** 报码。放到后台线程，别卡住界面线程。 */
void advertise_async() {
    // 报码这件事现在交给会话去办：它会连灯塔、报上公钥、把码发回页面。
    // 以前这里自己起一个 SignalLink 重写一遍，和会话里的逻辑是两套。
    if (g_session) g_session->advertise();
}

/** 页面发来的消息 */
void on_page_message(const std::string& json) {
    std::printf("[桥] 页面说：%s\n", json.c_str());
    std::fflush(stdout);

    if (json.find("\"ready\"") != std::string::npos) {
        // 从这里开始页面能收消息了。先把攒着的补发出去，再往下走。
        {
            std::vector<std::string> pending;
            {
                std::lock_guard<std::mutex> lock(g_outbox_mutex);
                pending.swap(g_outbox);
            }
            g_page_listening = true;
            for (const auto& item : pending) post_to_page(item);
        }
        const std::string id = identity().device_id();
        post_to_page("{\"t\":\"device\",\"id\":\"" + id + "\"}");
        nlohmann::json status{{"t", "status"},
                              {"identityPath", g_identity_path},
                              {"sendtoInstalled", shell::sendto_installed()},
                              {"appDir", default_app_dir().u8string()},
                              {"deviceName", g_settings.device_name}};
        post_to_page(status.dump());
        // 提示音候选列表交给页面渲染。列表只在原生侧维护一份，
        // 免得界面上的选项和实际能放的声音对不上。
        nlohmann::json sounds{{"t", "sounds"},
                              {"current", shell::sound_name(g_notify_sound)},
                              {"items", nlohmann::json::array()}};
        size_t count = 0;
        const shell::SoundEntry* entries = shell::notify_sounds(&count);
        for (size_t i = 0; i < count; i++) {
            sounds["items"].push_back(
                {{"id", entries[i].name},
                 {"label", utf16_to_utf8(entries[i].label)},
                 {"seconds", shell::sound_seconds(entries[i].id)}});
        }
        post_to_page(sounds.dump());
        // 页面没就绪之前通过「发送到」递进来的文件，现在补交给它
        std::vector<std::filesystem::path> pending;
        {
            std::lock_guard<std::mutex> lock(g_pending_mutex);
            pending.swap(g_pending_files);
        }
        if (!pending.empty()) {
            std::printf("[发送到] 补交 %zu 个文件给页面\n", pending.size());
            std::fflush(stdout);
            post_to_page(files_message(pending));
        }
        return;
    }
    if (json.find("\"preview-sound\"") != std::string::npos) {
        // 试听：只放声音，不弹气泡。用选中的那个，不是当前保存的那个，
        // 这样用户点几下就能挑完再定。
        std::string id = "balloon";
        try {
            const auto msg = nlohmann::json::parse(json);
            id = msg.value("id", id);
        } catch (const std::exception&) {
        }
        const auto sound = shell::sound_from_name(id);
        shell::play(sound);
        std::printf("[提示音] 试听 %s（%.2f 秒）\n", shell::sound_name(sound),
                    shell::sound_seconds(sound));
        std::fflush(stdout);
        return;
    }
    if (json.find("\"set-sound\"") != std::string::npos) {
        std::string id = shell::sound_name(g_notify_sound);
        try {
            const auto msg = nlohmann::json::parse(json);
            id = msg.value("id", id);
        } catch (const std::exception&) {
        }
        g_notify_sound = shell::sound_from_name(id);
        g_settings.notify_sound = shell::sound_name(g_notify_sound);
        try {
            save_settings(g_state_dir.empty() ? default_app_dir() : g_state_dir, g_settings);
            std::printf("[提示音] 已改成 %s 并存下来了\n", g_settings.notify_sound.c_str());
        } catch (const std::exception& e) {
            std::fprintf(stderr, "[提示音] 存不进去：%s\n", e.what());
        }
        std::fflush(stdout);
        // 立刻放一遍，让用户听到改成了什么
        shell::play(g_notify_sound);
        return;
    }
    if (json.find("\"pick-files\"") != std::string::npos) {
        // 弹系统选择框。这会在界面线程上阻塞一下，但用户本来就在等对话框，
        // 而且选完才返回，是符合预期的。
        const auto picked = shell::pick_files(g_window);
        if (!picked.empty()) accept_files(picked);
        return;
    }
    if (json.find("\"pick-folder\"") != std::string::npos) {
        const auto picked = shell::pick_folder(g_window);
        if (!picked.empty()) accept_files(picked);
        return;
    }
    if (json.find("\"join\"") != std::string::npos) {
        try {
            const auto msg = nlohmann::json::parse(json);
            const std::string code = msg.value("code", "");
            if (!code.empty() && g_session) {
                std::printf("[配对] 用码连接 %s\n", code.c_str());
                std::fflush(stdout);
                g_session->join(code);
            }
        } catch (const std::exception&) {
        }
        return;
    }
    if (json.find("\"send-files\"") != std::string::npos) {
        try {
            const auto msg = nlohmann::json::parse(json);
            std::vector<std::string> paths;
            for (const auto& item : msg.value("paths", nlohmann::json::array())) {
                if (item.is_string()) paths.push_back(item.get<std::string>());
            }
            if (!paths.empty() && g_session) {
                std::printf("[发送] 交给会话 %zu 个文件\n", paths.size());
                std::fflush(stdout);
                g_session->send_files(paths);
            }
        } catch (const std::exception&) {
        }
        return;
    }
    if (json.find("\"send-text\"") != std::string::npos) {
        try {
            const auto msg = nlohmann::json::parse(json);
            const std::string text = msg.value("text", "");
            if (!text.empty() && g_session) g_session->send_text(text);
        } catch (const std::exception&) {
        }
        return;
    }
    if (json.find("\"disconnect\"") != std::string::npos) {
        if (g_session) g_session->disconnect_peer();
        return;
    }
    if (json.find("\"history-shown\"") != std::string::npos) {
        try {
            const auto msg = nlohmann::json::parse(json);
            std::printf("[桥] 界面已铺上 %d 条传输记录\n", msg.value("count", 0));
        } catch (const std::exception&) {
        }
        std::fflush(stdout);
        return;
    }
    if (json.find("\"device-shown\"") != std::string::npos) {
        // 页面确实把设备号渲染出来了。自检模式下这就是全部的验收条件。
        std::printf("[桥] 页面已渲染设备号\n");
        std::fflush(stdout);
        g_page_ready = true;
        if (g_want_advertise) {
            // 自检模式下自动点一下"生成配对码"，把外壳到灯塔这条链路也走一遍
            advertise_async();
            return;
        }
        if (!g_screenshot.empty()) {
            // 截一张图，用来在没有人的情况下看界面长什么样
            ComPtr<IStream> stream;
            if (SUCCEEDED(SHCreateStreamOnFileEx(g_screenshot.c_str(),
                                                 STGM_CREATE | STGM_WRITE,
                                                 FILE_ATTRIBUTE_NORMAL, TRUE, nullptr,
                                                 &stream))) {
                g_webview->CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream.Get(),
                    Callback<ICoreWebView2CapturePreviewCompletedHandler>(
                        [](HRESULT code) -> HRESULT {
                            (void)code;
                            std::printf("[桥] 截图已保存");
                            std::printf("\n");
                            std::fflush(stdout);
                            PostQuitMessage(0);
                            return S_OK;
                        })
                        .Get());
                return;
            }
        }
        if (g_selftest) PostQuitMessage(0);
        return;
    }
    if (json.find("\"code-shown\"") != std::string::npos) {
        std::printf("[桥] 页面已显示配对码\n");
        std::fflush(stdout);
        if (!g_screenshot.empty()) {
            ComPtr<IStream> stream;
            if (SUCCEEDED(SHCreateStreamOnFileEx(g_screenshot.c_str(), STGM_CREATE | STGM_WRITE,
                                                 FILE_ATTRIBUTE_NORMAL, TRUE, nullptr, &stream))) {
                g_webview->CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream.Get(),
                    Callback<ICoreWebView2CapturePreviewCompletedHandler>(
                        [](HRESULT code) -> HRESULT {
                            (void)code;
                            std::printf("[桥] 截图已保存\n");
                            std::fflush(stdout);
                            PostQuitMessage(0);
                            return S_OK;
                        })
                        .Get());
                return;
            }
        }
        // 只有在自检模式下才"看到码就退出"。以前这里无条件退出，
        // 结果是任何带 --advertise 启动的实例显示完配对码就把自己关了，
        // 对方再拿着码去连就是"对方不在线"。查这个查了很久。
        if (g_selftest) PostQuitMessage(0);
        return;
    }
    if (json.find("\"advertise\"") != std::string::npos) {
        advertise_async();
        return;
    }
}

std::wstring exe_dir() {
    wchar_t buffer[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    std::wstring path(buffer);
    const size_t cut = path.find_last_of(L"\\/");
    return cut == std::wstring::npos ? L"." : path.substr(0, cut);
}

HRESULT on_controller_created(HRESULT hr, ICoreWebView2Controller* controller) {
    if (FAILED(hr) || !controller) {
        std::fprintf(stderr, "WebView2 控制器建不起来：0x%08lx\n", hr);
        return hr;
    }
    g_controller = controller;
    g_controller->get_CoreWebView2(&g_webview);
    if (!g_webview) return E_FAIL;

    // 页面从哪来：优先用编进 exe 的资源，取不到就退回 exe 旁边的 web 目录。
    //
    // 资源方式是为了单文件分发（不会出现"exe 拷走了、web 目录忘了拷"）。
    // 但现在按名字取资源还没弄通（FindResource 报 1814，而页面确实在 exe 里），
    // 所以留一条目录兜底，免得资源这条路出问题时整个界面起不来。
    //
    // 两种方式都用虚拟域名 app.local 而不是 file://，因为需要一个"正常的
    // https 源"，crypto.subtle 这类只在安全上下文可用的能力才拿得到。
    const std::string& page = embedded_page();
    if (!page.empty()) {
        g_webview->AddWebResourceRequestedFilter(L"https://app.local/*",
                                                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        EventRegistrationToken resource_token;
        g_webview->add_WebResourceRequested(
            Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                    if (!g_environment) return S_OK;
                    const std::string& html = embedded_page();
                    if (html.empty()) return S_OK;
                    // 内存流。SHCreateMemStream 会复制一份，所以传局部数据没问题
                    IStream* stream = SHCreateMemStream(
                        reinterpret_cast<const BYTE*>(html.data()),
                        static_cast<UINT>(html.size()));
                    if (!stream) return S_OK;
                    ComPtr<ICoreWebView2WebResourceResponse> response;
                    if (SUCCEEDED(g_environment->CreateWebResourceResponse(
                            stream, 200, L"OK", L"Content-Type: text/html; charset=utf-8",
                            &response))) {
                        args->put_Response(response.Get());
                    }
                    stream->Release();
                    return S_OK;
                })
                .Get(),
            &resource_token);
        std::printf("[界面] 用 exe 内嵌的页面（%zu 字节）\n", page.size());
        std::fflush(stdout);
    } else {
        const std::wstring web_root = exe_dir() + L"\\web";
        ComPtr<ICoreWebView2_3> webview3;
        if (FAILED(g_webview.As(&webview3))) {
            std::fprintf(stderr, "WebView2 版本太旧，没有 SetVirtualHostNameToFolderMapping\n");
            return E_FAIL;
        }
        webview3->SetVirtualHostNameToFolderMapping(
            kVirtualHost, web_root.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
        std::printf("[界面] 用 exe 旁边的 web 目录（内嵌资源没取到）\n");
        std::fflush(stdout);
    }

    EventRegistrationToken token;
    g_webview->add_WebMessageReceived(
        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                LPWSTR raw = nullptr;
                if (FAILED(args->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
                const std::wstring wide(raw);
                CoTaskMemFree(raw);
                // 必须走真正的 UTF-16 转 UTF-8。这里以前是
                // std::string(wide.begin(), wide.end())，那是把每个 wchar_t 截成
                // 一个字节，ASCII 看着没事，一遇到中文（文件名、设备名）就烂掉。
                on_page_message(utf16_to_utf8(wide));
                return S_OK;
            })
            .Get(),
        &token);

    RECT bounds;
    GetClientRect(g_window, &bounds);
    g_controller->put_Bounds(bounds);
    g_controller->put_IsVisible(TRUE);
    g_webview->Navigate(kStartUrl);
    return S_OK;
}

HRESULT on_environment_created(HRESULT hr, ICoreWebView2Environment* environment) {
    if (FAILED(hr) || !environment) {
        std::fprintf(stderr, "WebView2 环境建不起来：0x%08lx\n", hr);
        return hr;
    }
    g_environment = environment;
    environment->CreateCoreWebView2Controller(
        g_window,
        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            &on_controller_created)
            .Get());
    return S_OK;
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case kPostToPage: {
            // 这里已经是界面线程了，可以安全地碰 WebView2
            auto* payload = reinterpret_cast<std::wstring*>(wparam);
            if (payload) {
                if (g_webview) g_webview->PostWebMessageAsJson(payload->c_str());
                delete payload;
            }
            return 0;
        }
        case WM_COPYDATA: {
            // p2p-send 把「发送到」选中的文件递过来
            auto* data = reinterpret_cast<const COPYDATASTRUCT*>(lparam);
            if (data && data->dwData == shell::kCopyDataPaths && data->lpData) {
                const auto count = data->cbData / sizeof(wchar_t);
                accept_files(
                    shell::unpack_paths(reinterpret_cast<const wchar_t*>(data->lpData), count));
                return TRUE;
            }
            return FALSE;
        }
        case kDoNotify: {
            const bool ok =
                g_tray.notify(L"设备已上线", L"书房台式机　现在可以发文件给它", g_notify_sound);
            std::printf("[通知] 气泡已发出：%s（提示音 %s）\n", ok ? "是" : "否",
                        shell::sound_name(g_notify_sound));
            std::fflush(stdout);
            // 留出时间给截图和听声音，然后自己退出
            SetTimer(window, 1, 25000, nullptr);  // 留够时间给人看和听
            return 0;
        }
        case WM_TIMER:
            if (wparam == 1) {
                KillTimer(window, 1);
                PostMessageW(window, WM_CLOSE, 0, 0);
            }
            return 0;
        case kTrayMessage: {
            // 用 NOTIFYICON_VERSION_4 的时候事件在 LOWORD(lParam) 里，
            // 不再是老版本那样直接就是 lParam。
            //
            // 外壳会就气泡的生命周期回调下面这几个事件。收到 NIN_BALLOONSHOW
            // 才说明它真的把气泡显示出来了；一个都没收到就是被系统丢掉了，
            // 这时候 Shell_NotifyIcon 仍然返回成功，光看返回值判断不出来。
            switch (LOWORD(lparam)) {
                case NIN_BALLOONSHOW:
                    std::printf("[托盘] 系统回话：气泡已显示\n");
                    std::fflush(stdout);
                    return 0;
                case NIN_BALLOONHIDE:
                    std::printf("[托盘] 系统回话：气泡被遮住或收起\n");
                    std::fflush(stdout);
                    return 0;
                case NIN_BALLOONTIMEOUT:
                    std::printf("[托盘] 系统回话：气泡超时消失\n");
                    std::fflush(stdout);
                    return 0;
                case NIN_BALLOONUSERCLICK:
                    std::printf("[托盘] 用户点了气泡\n");
                    std::fflush(stdout);
                    return 0;
                default:
                    break;
            }
            switch (LOWORD(lparam)) {
                case WM_LBUTTONUP:
                    // 左键点托盘：把窗口叫出来
                    ShowWindow(window, SW_SHOW);
                    SetForegroundWindow(window);
                    return 0;
                case WM_RBUTTONUP:
                case WM_CONTEXTMENU: {
                    POINT cursor;
                    GetCursorPos(&cursor);
                    HMENU menu = CreatePopupMenu();
                    AppendMenuW(menu, MF_STRING, kMenuOpen, L"打开主窗口");
                    AppendMenuW(menu, MF_STRING, kMenuSendTo,
                                shell::sendto_installed() ? L"从「发送到」菜单移除"
                                                          : L"装到「发送到」菜单");
                    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
                    AppendMenuW(menu, MF_STRING, kMenuExit, L"退出");
                    // 不先抢前台，菜单会点不掉（老毛病）
                    SetForegroundWindow(window);
                    const UINT picked = TrackPopupMenu(
                        menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY, cursor.x,
                        cursor.y, 0, window, nullptr);
                    DestroyMenu(menu);
                    PostMessageW(window, WM_NULL, 0, 0);
                    if (picked == kMenuOpen) {
                        ShowWindow(window, SW_SHOW);
                        SetForegroundWindow(window);
                    } else if (picked == kMenuSendTo) {
                        try {
                            if (shell::sendto_installed()) {
                                shell::uninstall_sendto();
                                std::printf("[托盘] 已从「发送到」菜单移除\n");
                            } else {
                                const auto link = shell::install_sendto();
                                std::printf("[托盘] 已装到「发送到」菜单：%s\n",
                                            link.u8string().c_str());
                            }
                            std::fflush(stdout);
                            nlohmann::json status{{"t", "status"},
                                                  {"sendtoInstalled", shell::sendto_installed()}};
                            post_to_page(status.dump());
                        } catch (const std::exception& e) {
                            std::fprintf(stderr, "[托盘] 改「发送到」失败：%s\n", e.what());
                        }
                    } else if (picked == kMenuExit) {
                        DestroyWindow(window);
                    }
                    return 0;
                }
                default:
                    return 0;
            }
        }
        case WM_DROPFILES: {
            // 拖放走窗口级别，不走网页。网页那边拿不到文件路径（浏览器不给），
            // 而发送是按路径读文件的。
            HDROP drop = reinterpret_cast<HDROP>(wparam);
            const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
            std::vector<std::filesystem::path> paths;
            for (UINT i = 0; i < count; i++) {
                wchar_t buffer[MAX_PATH] = {};
                if (DragQueryFileW(drop, i, buffer, MAX_PATH)) paths.emplace_back(buffer);
            }
            DragFinish(drop);
            std::printf("[拖放] 收到 %zu 项\n", paths.size());
            std::fflush(stdout);
            accept_files(paths);
            return 0;
        }
        case WM_SIZE:
            if (g_controller) {
                RECT bounds;
                GetClientRect(window, &bounds);
                g_controller->put_Bounds(bounds);
            }
            return 0;
        case WM_DESTROY:
            g_tray.remove();
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(window, message, wparam, lparam);
    }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    std::vector<std::filesystem::path> files;
    for (int i = 1; i < argc; i++) {
        const std::wstring flag = argv[i];
        if (flag == L"--selftest") {
            g_selftest = true;
        } else if (flag == L"--advertise") {
            g_want_advertise = true;
        } else if (flag == L"--screenshot" && i + 1 < argc) {
            g_screenshot = argv[++i];
        } else if (flag == L"--test-notify") {
            // 自检托盘和气泡通知：装上图标，弹一个气泡，等几秒再看结果。
            // 用来在没有人盯着屏幕的时候验证通知真的弹出来了。
            g_test_notify = true;
        } else if (flag == L"--sound" && i + 1 < argc) {
            g_notify_sound = shell::sound_from_name(utf16_to_utf8(argv[++i]));
        } else if (flag == L"--set-sound" && i + 1 < argc) {
            // 不开窗直接改提示音。界面上也是走同一份设置，这里只是给脚本和
            // 无人值守的验证用，顺便放一遍好让人听到改成了什么。
            CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
            const auto sound = shell::sound_from_name(utf16_to_utf8(argv[++i]));
            g_settings.notify_sound = shell::sound_name(sound);
            int code = 0;
            try {
                save_settings(default_app_dir(), g_settings);
                std::printf("[提示音] 已设为 %s（%.2f 秒）\n", g_settings.notify_sound.c_str(),
                            shell::sound_seconds(sound));
            } catch (const std::exception& e) {
                std::fprintf(stderr, "[提示音] 存不进去：%s\n", e.what());
                code = 1;
            }
            shell::play(sound);
            std::fflush(stdout);
            CoUninitialize();
            return code;
        } else if (flag == L"--join-code" && i + 1 < argc) {
            g_join_code = utf16_to_utf8(argv[++i]);
        } else if (flag == L"--send-when-connected" && i + 1 < argc) {
            g_send_when_connected = utf16_to_utf8(argv[++i]);
            g_exit_when_done = true;
        } else if (flag == L"--state-dir" && i + 1 < argc) {
            g_state_dir = std::filesystem::u8path(utf16_to_utf8(argv[++i]));
        } else if (flag == L"--lighthouse" && i + 1 < argc) {
            // 先存到独立变量里。**不能直接写 g_settings**：设置是在参数解析
            // 之后才从磁盘读的，读的时候会把整个 g_settings 换掉，这里写的值
            // 就被静默丢了。见下面 load_settings 之后重新应用那几行。
            g_lighthouse_flag = utf16_to_utf8(argv[++i]);
        } else if (flag == L"--test-overlay") {
            g_test_overlay = true;
        } else if (flag == L"--hidden") {
            g_hidden = true;
        } else if (flag == L"--exit-when-received") {
            g_exit_when_done = true;
        } else if (flag == L"--list-sounds") {
            size_t count = 0;
            const shell::SoundEntry* entries = shell::notify_sounds(&count);
            for (size_t n = 0; n < count; n++) {
                std::printf("%-12s %-28s %.2f 秒\n", entries[n].name,
                            utf16_to_utf8(entries[n].label).c_str(),
                            shell::sound_seconds(entries[n].id));
            }
            std::fflush(stdout);
            return 0;
        } else if (flag == L"--install-sendto" || flag == L"--uninstall-sendto" ||
                   flag == L"--sendto-status") {
            // 这三个是安装/查询「发送到」菜单，不需要开窗，也不要 WebView2
            CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
            int code = 0;
            try {
                if (flag == L"--install-sendto") {
                    const auto link = shell::install_sendto();
                    std::printf("[发送到] 已安装：%s\n", link.u8string().c_str());
                } else if (flag == L"--uninstall-sendto") {
                    shell::uninstall_sendto();
                    std::printf("[发送到] 已卸载\n");
                } else {
                    const bool there = shell::sendto_installed();
                    std::printf("[发送到] %s\n", there ? "已安装" : "未安装");
                    code = there ? 0 : 1;
                }
            } catch (const std::exception& e) {
                std::fprintf(stderr, "[发送到] 失败：%s\n", e.what());
                code = 1;
            }
            std::fflush(stdout);
            CoUninitialize();
            return code;
        } else if (flag.rfind(L"--", 0) != 0) {
            // 不是开关，那就是文件路径（资源管理器通过「发送到」就是这么调的）
            files.emplace_back(flag);
        }
    }

    // 参数解析完了才知道用哪个数据目录，所以设置在这里读。
    // 命令行开关（--sound）在后面覆盖它。
    g_settings = load_settings(g_state_dir.empty() ? default_app_dir() : g_state_dir);
    // 命令行参数优先级高于磁盘里的设置，所以必须在读盘之后重新应用一次
    if (!g_lighthouse_flag.empty()) g_settings.lighthouse = g_lighthouse_flag;
    g_notify_sound = shell::sound_from_name(g_settings.notify_sound);

    // 已经有实例在跑，就把文件交给它，自己退出。绝不能开第二个窗口：
    // 托盘会有两个图标，两个进程还会拿着同一份身份去连灯塔。
    if (!files.empty() && shell::deliver_to_running_instance(files)) {
        std::printf("[单实例] 已把 %zu 个文件交给正在运行的实例\n", files.size());
        std::fflush(stdout);
        return 0;
    }
    if (!g_selftest && !files.empty()) {
        // 带文件启动：先攒着，等页面就绪再发
        std::lock_guard<std::mutex> lock(g_pending_mutex);
        g_pending_files = files;
    }

    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    WNDCLASSW wc = {};
    wc.lpfnWndProc = window_proc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = shell::kWindowClass;
    // IDC_ARROW 是 ANSI 宏，宽字符接口要点类型转换
    wc.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
    wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    RegisterClassW(&wc);

    g_window = CreateWindowExW(0, shell::kWindowClass, shell::kWindowTitle, WS_OVERLAPPEDWINDOW,
                               CW_USEDEFAULT, CW_USEDEFAULT, 720, 640, nullptr, nullptr,
                               wc.hInstance, nullptr);
    if (!g_window) {
        std::fprintf(stderr, "建窗失败\n");
        return 1;
    }
    // 自检模式完全不显示窗口。通知自检要显示但**不抢焦点**：SW_SHOWNOACTIVATE
    // 只把窗口画出来，不动用户当前正在用的那个窗口。
    if (g_test_notify) {
        ShowWindow(g_window, SW_SHOWNOACTIVATE);
    } else if (g_hidden || g_selftest) {
        // 藏起来，但消息循环照跑
    } else {
        ShowWindow(g_window, SW_SHOW);
    }

    // 整个窗口都接受拖放，不是只有某一小块
    DragAcceptFiles(g_window, TRUE);

    // 悬浮组件。拖进来的东西和窗口拖放走同一条路（accept_files）。
    if (!g_overlay.create(wc.hInstance, [](const std::vector<std::filesystem::path>& paths) {
            std::printf("[悬浮] 拖进来 %zu 项\n", paths.size());
            std::fflush(stdout);
            accept_files(paths);
        })) {
        std::fprintf(stderr, "[悬浮] 建不起来\n");
    }

    // 托盘常驻。左键叫出窗口，右键出菜单。
    {
        HICON icon = LoadIconW(nullptr, IDI_APPLICATION);
        const std::wstring tip = std::wstring(L"设备互传（") + shell::kWindowTitle + L"）";
        if (g_tray.install(g_window, kTrayMessage, tip, icon)) {
            std::printf("[托盘] 图标已就位，提示音 %s（%.2f 秒）\n",
                        shell::sound_name(g_notify_sound), shell::sound_seconds(g_notify_sound));
        } else {
            std::fprintf(stderr, "[托盘] 图标装不上\n");
        }
        std::fflush(stdout);
    }

    // 会话在这里起来：窗口已经有了，页面随时可以收到它发的消息。
    // emit 走 post_to_page，所以会话线程里的消息会被转到界面线程再发给页面。
    if (!g_selftest || g_want_advertise) {
        g_session = std::make_unique<shell::Session>(
            identity(), g_settings,
            g_state_dir.empty() ? default_app_dir() : g_state_dir,
            [](const nlohmann::json& msg) {
                                                         // 脚本化验收用：走到"已连接"就把文件发出去，
                                                         // 发完就退出。调的是界面调的同一批方法。
                                                         if (msg.value("t", "") == "state" &&
                                                             msg.value("value", "") == "connected" &&
                                                             !g_send_when_connected.empty() &&
                                                             g_session) {
                                                             std::printf("[验收] 已连接，开始发送\n");
                                                             std::fflush(stdout);
                                                             g_session->send_files(
                                                                 {g_send_when_connected});
                                                         }
                                                         if (msg.value("t", "") == "file-done") {
                                                             std::printf("[验收] 收到文件 %s\n",
                                                                         msg.value("path", "").c_str());
                                                             std::fflush(stdout);
                                                             if (g_exit_when_done && g_window) {
                                                                 graceful_close();
                                                             }
                                                         }
                                                         if (msg.value("t", "") == "sent") {
                                                             std::printf("[验收] 已发出 %s\n",
                                                                         msg.value("path", "").c_str());
                                                             std::fflush(stdout);
                                                             if (g_exit_when_done && g_window) {
                                                                 graceful_close();
                                                             }
                                                         }
                                                         if (msg.value("t", "") == "state" &&
                                                             msg.value("value", "") == "error") {
                                                             std::printf("[验收] 出错 %s\n",
                                                                         msg.value("detail", "")
                                                                             .c_str());
                                                             std::fflush(stdout);
                                                         }
                                                         // 悬浮组件跟着同一批事件走。
                                                         // 它和窗口是两个出口，互不影响。
                                                         const std::string kind = msg.value("t", "");
                                                         if (kind == "progress") {
                                                             g_overlay.update(
                                                                 msg.value("id", ""),
                                                                 msg.value("name", ""),
                                                                 msg.value("done", 0ULL),
                                                                 msg.value("total", 0ULL),
                                                                 msg.value("incoming", false));
                                                         } else if (kind == "file-done") {
                                                             g_overlay.flash(L"文件已收完");
                                                         } else if (kind == "sent") {
                                                             g_overlay.flash(L"已发送");
                                                         } else if (kind == "peer") {
                                                             g_overlay.set_hint(
                                                                 L"拖到这里发给 " +
                                                                 utf8_to_utf16(msg.value("name", "")));
                                                         }
                                                         post_to_page(msg.dump());
                                                     });
        g_session->start();
        if (!g_join_code.empty()) g_session->join(g_join_code);
    }

    if (g_test_overlay) {
        // 悬浮组件的自检：不连灯塔，喂几条假进度，看它画出来没有。
        g_overlay.set_hint(L"拖到这里发给 书房台式机");
        g_overlay.update("t1", "报告.pdf", 42, 100, true);
        g_overlay.update("t2", "照片.zip", 0, 0, false);
        g_overlay.update("t3", "很长的文件名测试一下截断效果-2026-10-16.tar.gz", 78, 100, true);
        std::printf("[悬浮] 已显示，%s\n", g_overlay.visible() ? "可见" : "不可见");
        std::fflush(stdout);
        // 那个位置上到底谁在最前面？如果拿到的不是我们的窗口类名，说明是没在最
        // 前面，而不是没画出来。这两件事的修法完全不同。
        {
            POINT probe = {1110, 30};
            HWND top = WindowFromPoint(probe);
            wchar_t cls[128] = {};
            if (top) GetClassNameW(top, cls, 128);
            std::printf("[悬浮] 该点最前面的是 %ls\n", cls);
            std::fflush(stdout);
        }
        std::thread([]() {
            std::this_thread::sleep_for(std::chrono::milliseconds(1500));
            if (g_selftest && g_window) PostMessageW(g_window, WM_CLOSE, 0, 0);
        }).detach();
    }

    if (g_test_notify) {
        // 只是等消息循环跑起来，真正发通知在界面线程上做
        std::thread([]() {
            std::this_thread::sleep_for(std::chrono::milliseconds(1200));
            if (g_window) PostMessageW(g_window, kDoNotify, 0, 0);
        }).detach();
    }

    wchar_t user_data[MAX_PATH] = {};
    GetEnvironmentVariableW(L"LOCALAPPDATA", user_data, MAX_PATH);
    std::wstring folder = std::wstring(user_data) + L"\\p2p-lighthouse\\webview2";
    // 两个实例不能共用同一个 WebView2 用户数据目录，会互相锁住。
    // 分数据目录跑（测试用）的时候顺手也把这份分开。
    if (!g_state_dir.empty()) folder += L"-" + g_state_dir.filename().wstring();

    const HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, folder.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            &on_environment_created)
            .Get());
    if (FAILED(hr)) {
        std::fprintf(stderr, "CreateCoreWebView2EnvironmentWithOptions 失败：0x%08lx\n", hr);
        return 1;
    }

    if (g_selftest) {
        // 给它一个上限，别在自检里挂死
        std::thread([]() {
            for (int i = 0; i < 60 && !g_page_ready.load(); i++) {
                std::this_thread::sleep_for(std::chrono::milliseconds(500));
            }
            if (!g_page_ready.load()) {
                std::printf("[自检] 超时：页面没回来\n");
                std::fflush(stdout);
                PostQuitMessage(2);
            }
        }).detach();
    }

    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0)) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    g_overlay.destroy();
    if (g_session) {
        g_session->stop();
        g_session.reset();
    }
    if (g_controller) g_controller->Close();
    CoUninitialize();

    if (g_selftest) {
        std::printf(g_page_ready.load() ? "[自检] 通过\n" : "[自检] 失败\n");
        std::fflush(stdout);
        return g_page_ready.load() ? 0 : 1;
    }
    return 0;
}
