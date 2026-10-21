// 托盘端交互原型：只有界面，没有传输。
//
// 这个 exe 的目的是让人**真实地摸一遍**托盘交互：左键弹出小窗、右键出系统菜单、
// 首次启动的角标和提示、选文件之后问发给谁。所有数据都是示例数据，
// 不连灯塔、不发文件、不监听剪贴板（读剪贴板只为让列表里出现"你现在复制的那段"）。
//
// 为什么用 Win32 而不是 Electron：托盘、系统菜单、气泡通知这些正是原型要验证的东西，
// 用别人的壳会把这些细节一起盖住；而项目的原生端本来就是 C++ 加 WebView2，
// 这里直接沿用同一套地基，验证完的经验可以整块搬过去。
//
// 自检 / 截图：p2p-tray.exe --shot analysis/tray-home.png --state home --theme dark
// 直接看小窗：p2p-tray.exe --show
#include <windows.h>

#include <dwmapi.h>
#include <commdlg.h>
#include <gdiplus.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wrl.h>
#include <WebView2.h>

// filesystem/流式头要排在 json.hpp 前面，原因见 shell/session.cpp 顶部
#include <filesystem>
#include <fstream>
#include <istream>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <utility>
#include <vector>
#include <ctime>

#include "notify.h"
#include "server.h"
#include "session.h"
#include "store.h"
#include "picker.h"
#include "sendto.h"

using namespace Microsoft::WRL;
namespace fs = std::filesystem;

// SDK 版本不同，这两个新常量不一定有定义
#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif
#ifndef DWMWCP_ROUND
#define DWMWCP_ROUND 2
#endif
#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
#define DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 ((DPI_AWARENESS_CONTEXT)-4)
#endif

namespace {

constexpr wchar_t kMsgClass[] = L"P2PTrayProto.Msg";
constexpr wchar_t kPopupClass[] = L"P2PTrayProto.Popup";
constexpr wchar_t kAppName[] = L"在线互传";
constexpr wchar_t kSendToName[] = L"在线互传.lnk";
constexpr wchar_t kRunKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kRunValue[] = L"P2PShareTray";
constexpr wchar_t kAumid[] = L"P2PShare.Tray";

constexpr UINT kTrayCallback = WM_APP + 1;
constexpr UINT kPostToPage = WM_APP + 2;
constexpr UINT kNotifyEvent = WM_APP + 3;
constexpr UINT kFileReceived = WM_APP + 4;
constexpr UINT kErrorEvent = WM_APP + 5;
constexpr UINT kPairAsk = WM_APP + 6;
constexpr UINT kPairAskTimeout = WM_APP + 7;
/** 输码方也要看到六位核对码：只叫出小窗，不阻塞等按钮 */
constexpr UINT kPairShow = WM_APP + 13;
constexpr UINT_PTR kWatchTimer = 1;
constexpr UINT_PTR kShotTimer = 2;
constexpr UINT_PTR kDumpWindows = 7;
constexpr UINT_PTR kShowTimer = 8;
constexpr UINT_PTR kAnimTimer = 11;
constexpr UINT_PTR kFirstRunTimer = 3;
constexpr UINT_PTR kReceiveNotifyTimer = 12;

// 小窗的尺寸用 DIP 写，实际像素按 DPI 放大
constexpr int kPopupWidthDip = 384;
constexpr int kPopupHeightDip = 520;

enum MenuId : UINT {
    kMenuSettings = 1000,
    kMenuSend = 1001,
    kMenuLink,
    kMenuSync,
    kMenuSavePath,
    kMenuSendTo,
    kMenuAutoSync,
    kMenuAutostart,
    kMenuOpenUi,
    kMenuExit,
};

// ---- 全局 ----
HWND g_msg = nullptr;
HWND g_popup = nullptr;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;
ComPtr<ICoreWebView2Environment> g_environment;

shell::Tray g_tray;
HICON g_icon = nullptr;
HICON g_icon_badge = nullptr;
// 传输中的动画帧：0 是静止帧，1..15 是箭头"滚动"的几帧（每帧 4px）
HICON g_anim[16] = {};
int g_anim_index = 0;
bool g_busy = false;
ULONGLONG g_last_left_click = 0;
/** 最近一次自动收起的时间：点托盘时窗口可能先失焦收起，再用它判断这次点击是"关" */
ULONGLONG g_hidden_at = 0;

/** 点气泡时该做什么。气泡本身不携带动作，只记最近一条是为什么弹的。 */
enum class BalloonAction { None, ShowPopup, OpenSaveDir };
BalloonAction g_balloon_action = BalloonAction::None;

struct NotifyRequest {
    std::wstring title;
    std::wstring text;
    shell::NotifySound sound;
    BalloonAction action;
};

/** 配对确认现在在小窗里做：信令线程等页面里的用户点「一致/不一致」。 */
struct PairReply {
    std::mutex mutex;
    std::condition_variable cv;
    bool pending = false;
    bool answered = false;
    bool accepted = false;
};
PairReply g_pair_reply;

/** 连续收到的文件先攒一下，别一个文件弹一次气泡。只在界面线程访问。 */
std::vector<std::wstring> g_received_files;

bool g_page_ready = false;
std::vector<std::string> g_outbox;
std::mutex g_outbox_mutex;
bool g_menu_open = false;
bool g_in_dialog = false;
std::unique_ptr<shell::Session> g_session;
p2p::Settings g_settings;
fs::path g_session_dir;
// 页面量出来的内容高度（DIP）。默认值只是兜底，页面一 ready 就会改成真实值。
ULONGLONG g_shown_at = 0;
double g_scale = 1.0;
bool g_dark = false;
COLORREF g_window_bg = RGB(246, 247, 249);

// 截图模式：设了就不装托盘，跑完自己退出
bool g_shot_mode = false;
std::wstring g_shot_path;
std::string g_shot_state = "home";
std::string g_shot_theme;

bool g_show_on_start = false;
bool g_show_menu_on_start = false;
bool g_stock_icon = false;
bool g_skip_tray_install = false;
bool g_no_dpi = false;
/** 安静启动：不弹小窗，只把托盘和服务挂上（自启时用得上，也方便无人值守测试） */
bool g_quiet = false;
/** 强制用编进 exe 的网页和图标，忽略源码目录（验证单文件发布时用） */
bool g_force_embedded = false;
/** 测试用：指定身份/历史目录，免得动到真身 */
std::wstring g_state_dir_override;
/** 测试用：起来就向灯塔要配对码 */
bool g_auto_advertise = false;
/** 测试用：起来就用这个码去连对方 */
std::string g_auto_join;
/** 测试用：起来就从通讯录连回指定设备（验证重启后的重连） */
std::string g_auto_connect;
/** 测试用：连上之后自动发一段文字 */
std::string g_pending_text;
/** 测试用：连上之后自动发这些文件（可重复 --send-file） */
std::vector<std::string> g_pending_files;
/** 测试用：点"＋"挂链接时直接用这个文件，不弹系统选择框 */
std::string g_share_file_override;
/** 测试用：配对请求不弹确认框，直接接受 */
bool g_auto_accept = false;
/** SendTo / 命令行带进来的文件，页面就绪后走"发送这些文件"的界面 */
std::vector<fs::path> g_launch_files;
/** 同一份数据目录只允许一个实例；名字里带目录哈希，托盘↔托盘联调不打架 */
HANDLE g_instance_mutex = nullptr;
/** 页面就绪之后要不要主动把小窗弹出来（首次启动、托盘起不来、--show 都用它） */
bool g_want_popup = false;
/** 小窗有没有真正被激活过。没激活过就不能按"失焦"收起来，否则一弹就没了 */
bool g_ever_activated = false;
fs::path g_sample_dir;

struct ProtoState {
    /** 只用于界面显示和旧版本迁移；真正落盘的是 settings.json 的 saveDir */
    std::wstring save_path;
    bool notice_shown = false;
};
ProtoState g_state;
/** 旧版 state.json 里记过 autostart，启动时迁到注册表一次 */
bool g_legacy_autostart = false;
fs::path g_state_file;
/** 状态文件和 WebView2 的落脚点。AppData 写不了的时候会换成 exe 旁边。 */
fs::path g_base_dir;
std::wstring g_log_flag_path;

// ---- 小工具 ----

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

/** 收到配对请求时，叫出小窗，并在信令线程上等页面里的选择。 */
bool ask_pair_confirmation(const std::string& name, const std::string& sas) {
    if (!g_msg) return false;
    (void)name;
    (void)sas;
    {
        std::lock_guard<std::mutex> lock(g_pair_reply.mutex);
        if (g_pair_reply.pending) return false;
        g_pair_reply.pending = true;
        g_pair_reply.answered = false;
        g_pair_reply.accepted = false;
    }
    // 配对请求的 JSON 已经由 Session 发给页面了；这里只负责把小窗叫出来。
    PostMessageW(g_msg, kPairAsk, 0, 0);
    std::unique_lock<std::mutex> lock(g_pair_reply.mutex);
    const bool answered = g_pair_reply.cv.wait_for(lock, std::chrono::seconds(60), [&] {
        return g_pair_reply.answered;
    });
    const bool accepted = answered && g_pair_reply.accepted;
    g_pair_reply.pending = false;
    g_pair_reply.answered = false;
    lock.unlock();
    if (!answered) {
        PostMessageW(g_msg, kPairAskTimeout, 0, 0);
        return false;
    }
    return accepted;
}

FILE* g_log = nullptr;

void log_line(const std::string& text) {
    std::fwrite(text.data(), 1, text.size(), stdout);
    std::fputc(10, stdout);
    std::fflush(stdout);
    if (g_log) {
        std::fwrite(text.data(), 1, text.size(), g_log);
        std::fputc(10, g_log);
        std::fflush(g_log);
    }
}

std::string human_size(std::uintmax_t bytes) {
    char buffer[64];
    if (bytes < 1024) {
        std::snprintf(buffer, sizeof(buffer), "%llu B", static_cast<unsigned long long>(bytes));
    } else if (bytes < 1024ull * 1024) {
        std::snprintf(buffer, sizeof(buffer), "%.1f KB", bytes / 1024.0);
    } else if (bytes < 1024ull * 1024 * 1024) {
        std::snprintf(buffer, sizeof(buffer), "%.1f MB", bytes / (1024.0 * 1024.0));
    } else {
        std::snprintf(buffer, sizeof(buffer), "%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0));
    }
    return buffer;
}

fs::path exe_dir() {
    wchar_t buffer[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    return fs::path(buffer).parent_path();
}

fs::path app_data_dir() {
    wchar_t buffer[MAX_PATH] = {};
    GetEnvironmentVariableW(L"LOCALAPPDATA", buffer, MAX_PATH);
    return fs::path(buffer) / L"p2p-tray-proto";
}

bool is_dark_mode() {
    DWORD value = 1;
    DWORD size = sizeof(value);
    RegGetValueW(HKEY_CURRENT_USER,
                 L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                 L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &value, &size);
    return value == 0;
}

/**
 * 状态文件放哪儿。
 *
 * 正常机器上用 %LOCALAPPDATA%；如果那儿写不进去（受限环境、临时账号之类），
 * 退回 exe 旁边。原型最要紧的是"能跑起来让人看"，不该因为一个目录就起不来。
 */
fs::path pick_base_dir() {
    const fs::path preferred = app_data_dir();
    std::error_code ec;
    fs::create_directories(preferred, ec);
    {
        std::ofstream probe(preferred / L".write-test", std::ios::binary);
        if (probe) {
            probe << "ok";
            probe.close();
            fs::remove(preferred / L".write-test", ec);
            return preferred;
        }
    }
    const fs::path fallback = exe_dir() / L"tray-data";
    fs::create_directories(fallback, ec);
    log_line("[启动] AppData 写不进去，改用 " + fallback.u8string());
    return fallback;
}

void enable_dpi_awareness() {
    using Fn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
    if (HMODULE user32 = GetModuleHandleW(L"user32.dll")) {
        auto fn = reinterpret_cast<Fn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
        if (fn) fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

// ---- 状态文件 ----

void load_state() {
    g_state_file = g_base_dir / L"state.json";
    std::error_code ec;
    if (!fs::exists(g_state_file, ec)) return;
    try {
        std::ifstream in(g_state_file);
        nlohmann::json node;
        in >> node;
        g_state.save_path = utf8_to_utf16(node.value("savePath", ""));
        g_state.notice_shown = node.value("noticeShown", false);
        g_legacy_autostart = node.value("autostart", false);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[状态] 读不出来，按第一次启动处理：%s\n", e.what());
    }
}

void save_state() {
    try {
        fs::create_directories(g_base_dir);
        // 保存位置、同步开关都归 settings.json，自启归注册表，这里只留界面状态。
        nlohmann::json node{{"noticeShown", g_state.notice_shown}};
        std::ofstream out(g_state_file);
        out << node.dump(2);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[状态] 存不进去：%s\n", e.what());
    }
}

// ---- 开机自启 ----
// 只用 HKCU，不需要管理员。值写成带引号的 exe 路径加 --quiet：
// 开机时不弹小窗，只把托盘和会话挂上。

std::wstring current_exe_path() {
    wchar_t buffer[MAX_PATH] = {};
    const DWORD len = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    return len == 0 ? std::wstring() : std::wstring(buffer, len);
}

bool autostart_enabled() {
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_READ, &key) != ERROR_SUCCESS) return false;
    wchar_t value[1024] = {};
    DWORD size = sizeof(value);
    DWORD type = 0;
    const LSTATUS status = RegQueryValueExW(key, kRunValue, nullptr, &type,
                                            reinterpret_cast<LPBYTE>(value), &size);
    RegCloseKey(key);
    return status == ERROR_SUCCESS && type == REG_SZ;
}

bool set_autostart(bool enabled) {
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kRunKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key,
                        nullptr) != ERROR_SUCCESS) {
        return false;
    }
    LSTATUS status = ERROR_SUCCESS;
    if (enabled) {
        const std::wstring command = L"\"" + current_exe_path() + L"\" --quiet";
        status = RegSetValueExW(key, kRunValue, 0, REG_SZ,
                                reinterpret_cast<const BYTE*>(command.c_str()),
                                static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t)));
    } else {
        status = RegDeleteValueW(key, kRunValue);
        if (status == ERROR_FILE_NOT_FOUND) status = ERROR_SUCCESS;
    }
    RegCloseKey(key);
    return status == ERROR_SUCCESS;
}

// ---- 示例文件 ----
// 传输记录里的"在文件夹中显示""打开"要真能用，否则点下去没反应，
// 体验就断了。所以在临时目录里放两份真的文件，只为了让人点得动。

fs::path ensure_samples() {
    fs::path dir = g_base_dir / L"示例文件";
    std::error_code ec;
    fs::create_directories(dir, ec);

    const fs::path note = dir / L"会议纪要-10月.txt";
    if (!fs::exists(note, ec)) {
        std::ofstream out(note, std::ios::binary);
        // 带 BOM：记事本双击打开时不会被认成 ANSI 而变成乱码
        out << "\xEF\xBB\xBF";
        out << "10 月 18 日 产品例会\n\n"
               "一、托盘端原型\n"
               "  左键单击弹出小窗，右键是系统菜单。首次启动先提示设置保存位置。\n\n"
               "二、还没定的\n"
               "  剪贴板历史保留多久；多设备时顶部切换器要不要显示在线状态。\n\n"
               "三、下次带上的\n"
               "  拖文件到托盘图标直接发；系统分享菜单里的入口。\n";
    }

    // 一张真图片，用站点图标顶替，保证"打开"能看到东西
    const fs::path image = dir / L"产品图标.png";
    if (!fs::exists(image, ec)) {
        const fs::path source = exe_dir() / L"../../app/public/icon-512.png";
        if (fs::exists(source, ec)) fs::copy_file(source, image, ec);
    }
    return dir;
}

// ---- 剪贴板 ----

std::wstring read_clipboard_text() {
    if (!OpenClipboard(nullptr)) return {};
    std::wstring out;
    if (HANDLE handle = GetClipboardData(CF_UNICODETEXT)) {
        if (const auto* text = static_cast<const wchar_t*>(GlobalLock(handle))) {
            out.assign(text);
            GlobalUnlock(handle);
        }
    }
    CloseClipboard();
    return out;
}

// 编进 exe 的资源编号，必须和 tray/app.rc.in 里的一致
constexpr int kResHtml = 201;
constexpr int kResCss = 202;
constexpr int kResJs = 203;
constexpr int kResQrCode = 204;
constexpr int kResJsqr = 205;
constexpr int kResIconStatic = 301;
constexpr int kResIconBadge = 302;
constexpr int kResIconFrame1 = 303;

std::pair<const BYTE*, size_t> resource_bytes(int id) {
    HRSRC found = FindResourceW(nullptr, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (!found) return {nullptr, 0};
    HGLOBAL loaded = LoadResource(nullptr, found);
    if (!loaded) return {nullptr, 0};
    const void* data = LockResource(loaded);
    if (!data) return {nullptr, 0};
    return {static_cast<const BYTE*>(data), SizeofResource(nullptr, found)};
}

/**
 * 从内嵌的 .ico 里取一个尺寸，做成 HICON。
 *
 * 不用 LoadImage 读资源：那套要的是 RT_GROUP_ICON，而且在这台机器上直接失败过。
 * 这里自己翻 ICO 目录，挑一张最接近的图，交给 CreateIconFromResourceEx。
 */
HICON embedded_icon(int id, int size) {
    const auto [bytes, length] = resource_bytes(id);
    if (!bytes || length < 22) return nullptr;
    WORD count = 0;
    std::memcpy(&count, bytes + 4, 2);
    int best = -1;
    int best_score = 9999;
    for (int i = 0; i < count; i++) {
        const BYTE* entry = bytes + 6 + i * 16;
        const int width = entry[0] == 0 ? 256 : entry[0];
        // 优先选不小于目标尺寸的，找不到再退而求其次
        const int score = width >= size ? width - size : (size - width) + 100;
        if (score < best_score) {
            best_score = score;
            best = i;
        }
    }
    if (best < 0) return nullptr;
    DWORD image_bytes = 0;
    DWORD offset = 0;
    std::memcpy(&image_bytes, bytes + 6 + best * 16 + 8, 4);
    std::memcpy(&offset, bytes + 6 + best * 16 + 12, 4);
    if (offset + image_bytes > length) return nullptr;
    return CreateIconFromResourceEx(const_cast<BYTE*>(bytes + offset), image_bytes, TRUE, 0x00030000,
                                    size, size, LR_DEFAULTCOLOR);
}

/** 取 GDI+ 的 PNG 编码器 CLSID */
int png_encoder_clsid(CLSID* clsid) {
    UINT count = 0;
    UINT size = 0;
    Gdiplus::GetImageEncodersSize(&count, &size);
    if (size == 0) return -1;
    std::vector<BYTE> buffer(size);
    auto* codecs = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buffer.data());
    Gdiplus::GetImageEncoders(count, size, codecs);
    for (UINT i = 0; i < count; i++) {
        if (wcscmp(codecs[i].MimeType, L"image/png") == 0) {
            *clsid = codecs[i].Clsid;
            return static_cast<int>(i);
        }
    }
    return -1;
}

/**
 * 把剪贴板里的位图另存成 PNG。
 *
 * 截图工具（Win+Shift+S）复制的是内存里的位图，不是文件路径，所以先落一份到盘上，
 * 后面就能和"发送文件"走同一条路。存到自己的数据目录，退出时清理。
 */
/** 清掉几小时前的剪贴板截图，免得开一次小窗就多一份 */
void prune_old_clipboard_images(const fs::path& dir) {
    std::error_code ec;
    const auto now = fs::file_time_type::clock::now();
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
        if (!entry.is_regular_file()) continue;
        std::error_code time_ec;
        const auto written = fs::last_write_time(entry.path(), time_ec);
        if (time_ec) continue;
        if (now - written > std::chrono::hours(6)) fs::remove(entry.path(), ec);
    }
}

bool save_clipboard_image(const fs::path& path) {
    HBITMAP bitmap = nullptr;
    if (OpenClipboard(nullptr)) {
        bitmap = static_cast<HBITMAP>(GetClipboardData(CF_BITMAP));
        CloseClipboard();
    }
    if (!bitmap) return false;

    Gdiplus::Bitmap image(bitmap, nullptr);
    CLSID clsid = {};
    if (png_encoder_clsid(&clsid) < 0) return false;
    return image.Save(path.c_str(), &clsid, nullptr) == Gdiplus::Ok;
}

/**
 * 剪贴板里的文件路径。
 *
 * 资源管理器 Ctrl+C 文件时，剪贴板里放的是 CF_HDROP——一份路径清单，不是文件内容。
 * 好处是多大都不经过内存，我们可以按路径直接读盘；多选也只是清单里有几项。
 * 缺点是从 Outlook、压缩包里复制出来的"虚拟文件"没有真实路径，这里会读不到。
 */
std::vector<fs::path> read_clipboard_files() {
    std::vector<fs::path> files;
    if (!OpenClipboard(nullptr)) return files;
    if (HANDLE handle = GetClipboardData(CF_HDROP)) {
        if (auto drop = static_cast<HDROP>(handle)) {
            const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
            for (UINT index = 0; index < count; index++) {
                const UINT length = DragQueryFileW(drop, index, nullptr, 0);
                std::wstring path(length + 1, 0);
                DragQueryFileW(drop, index, path.data(), length + 1);
                path.resize(length);
                if (!path.empty()) files.emplace_back(path);
            }
        }
    }
    CloseClipboard();
    return files;
}

/**
 * 剪贴板里能发的东西：一批文件路径，或者一张位图（截图工具）。
 * 返回给页面的 JSON，页面据此决定"发送文件"按钮显示成什么。
 */
nlohmann::json collect_clipboard_items() {
    nlohmann::json message{{"t", "clipboard-files"}, {"items", nlohmann::json::array()},
                           {"total", "0 B"}};
    const auto files = read_clipboard_files();
    std::uintmax_t total = 0;
    for (const auto& file : files) {
        std::error_code ec;
        const auto size = fs::file_size(file, ec);
        if (!ec) total += size;
        message["items"].push_back(
            {{"name", utf16_to_utf8(file.filename().wstring())},
             {"path", utf16_to_utf8(file.wstring())},
             {"bytes", ec ? 0 : static_cast<std::uint64_t>(size)},
             {"size", ec ? "未知大小" : human_size(size)}});
    }
    if (!files.empty()) {
        message["total"] = human_size(total);
        return message;
    }

    // 没有文件清单，再看是不是一张剪贴板图片
    SYSTEMTIME now = {};
    GetLocalTime(&now);
    wchar_t name[80] = {};
    swprintf_s(name, L"截图 %04d-%02d-%02d %02d-%02d-%02d.png", now.wYear, now.wMonth, now.wDay,
               now.wHour, now.wMinute, now.wSecond);
    const fs::path image_path = g_base_dir / L"剪贴板截图" / name;
    std::error_code ec;
    fs::create_directories(image_path.parent_path(), ec);
    if (save_clipboard_image(image_path)) {
        prune_old_clipboard_images(image_path.parent_path());
        std::error_code size_ec;
        const auto bytes = fs::file_size(image_path, size_ec);
        message["items"].push_back(
            {{"name", utf16_to_utf8(image_path.filename().wstring())},
             {"path", utf16_to_utf8(image_path.wstring())},
             {"bytes", size_ec ? 0 : static_cast<std::uint64_t>(bytes)},
             {"size", size_ec ? "未知大小" : human_size(bytes)},
             {"kind", "image"}});
        message["total"] = size_ec ? "1 张图片" : human_size(bytes);
    }
    return message;
}


bool write_clipboard_text(const std::wstring& text) {
    if (!OpenClipboard(nullptr)) return false;
    EmptyClipboard();
    const size_t bytes = (text.size() + 1) * sizeof(wchar_t);
    if (HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes)) {
        if (void* target = GlobalLock(memory)) {
            std::memcpy(target, text.c_str(), bytes);
            GlobalUnlock(memory);
            SetClipboardData(CF_UNICODETEXT, memory);
        }
    }
    CloseClipboard();
    return true;
}

// ---- 托盘 ----

std::wstring tray_tip() {
    if (g_state.save_path.empty()) return L"请单击设置保存路径";
    if (IsWindowVisible(g_popup)) return L"在线互传 · 单击收起";
    return L"在线互传 · 单击查看";
}

void set_busy(bool busy) {
    if (busy == g_busy) return;
    g_busy = busy;
    if (!g_tray.installed()) return;
    if (busy) {
        g_anim_index = 0;
        g_tray.set_icon(g_anim[0] ? g_anim[0] : g_icon);
        SetTimer(g_msg, kAnimTimer, 90, nullptr);
        g_tray.set_tip(L"在线互传 · 正在传输");
    } else {
        KillTimer(g_msg, kAnimTimer);
        g_anim_index = 0;
        g_tray.set_icon(g_state.save_path.empty() ? g_icon_badge : g_icon);
        g_tray.set_tip(tray_tip());
    }
}

void refresh_tray_icon() {
    if (!g_tray.installed()) return;
    g_tray.set_icon(g_state.save_path.empty() ? g_icon_badge : g_icon);
    g_tray.set_tip(tray_tip());
}

/** 打开网页端：设置、历史这些放浏览器里。 */
void open_settings() {
    std::string url = proto::server_url();
    if (url.empty()) url = "https://p2p-share-web.pages.dev/";
    ShellExecuteW(nullptr, L"open", utf8_to_utf16(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

fs::path find_ui_dir() {
    if (const wchar_t* override = _wgetenv(L"P2P_UI_DIR")) {
        fs::path dir(override);
        if (fs::exists(dir / L"index.html")) return dir;
    }
    fs::path dir = exe_dir();
    for (int depth = 0; depth < 5; depth++) {
        // vite 的输出目录是 app/pages/dist；老的 app/dist 也认，方便换构建配置
        for (const wchar_t* relative : {L"app/pages/dist", L"app/dist"}) {
            const fs::path candidate = dir / relative;
            if (fs::exists(candidate / L"index.html")) return candidate;
        }
        if (!dir.has_parent_path() || dir.parent_path() == dir) break;
        dir = dir.parent_path();
    }
    return {};
}

void force_foreground(HWND hwnd) {
    // 从托盘点击过来时我们不是前台进程，直接 SetForegroundWindow 常常被系统忽略，
    // 结果小窗弹出来了却收不到键盘、点别处也不收起。挂到当前前台线程上再抢一次。
    const DWORD foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), nullptr);
    const DWORD this_thread = GetCurrentThreadId();
    if (foreground_thread && foreground_thread != this_thread) {
        AttachThreadInput(foreground_thread, this_thread, TRUE);
    }
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    SetActiveWindow(hwnd);
    if (foreground_thread && foreground_thread != this_thread) {
        AttachThreadInput(foreground_thread, this_thread, FALSE);
    }
}

void post_to_page(const std::string& json) {
    // 页面还没建/还没就绪时先存着。启动阶段会话线程会先发 contacts、state，
    // 那时 webview 可能还不存在；直接丢掉会让设备菜单一直是空的。
    if (!g_webview || !g_page_ready) {
        std::lock_guard<std::mutex> lock(g_outbox_mutex);
        g_outbox.push_back(json);
        return;
    }
    auto* text = new std::wstring(utf8_to_utf16(json));
    if (!PostMessageW(g_msg, kPostToPage, reinterpret_cast<WPARAM>(text), 0)) delete text;
}

/** 从任意线程请求界面线程弹一条气泡。 */
void post_notify(const std::wstring& title, const std::wstring& text,
                 shell::NotifySound sound, BalloonAction action) {
    if (!g_msg) return;
    auto* request = new NotifyRequest{title, text, sound, action};
    if (!PostMessageW(g_msg, kNotifyEvent, 0, reinterpret_cast<LPARAM>(request))) delete request;
}

// ---- 小窗 ----

RECT tray_icon_rect() {
    NOTIFYICONIDENTIFIER id = {};
    id.cbSize = sizeof(id);
    id.hWnd = g_msg;
    id.uID = 1;
    RECT rect = {};
    if (g_tray.installed() && SUCCEEDED(Shell_NotifyIconGetRect(&id, &rect))) return rect;

    // 退路：任务栏在右下角，按工作区右下角估一个位置
    RECT work = {};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    return RECT{work.right - 40, work.bottom - 40, work.right, work.bottom};
}

void place_popup() {
    const RECT icon = tray_icon_rect();
    HMONITOR monitor = MonitorFromRect(&icon, MONITOR_DEFAULTTONEAREST);
    MONITORINFO info = {};
    info.cbSize = sizeof(info);
    GetMonitorInfoW(monitor, &info);
    const RECT work = info.rcWork;

    const int width = static_cast<int>(kPopupWidthDip * g_scale);
    const int height = static_cast<int>(kPopupHeightDip * g_scale);
    const int gap = static_cast<int>(10 * g_scale);

    // 默认贴在图标上方、右边缘对齐图标右边；任务栏在别处时靠 clamp 兜住
    int x = icon.right - width + static_cast<int>(8 * g_scale);
    int y = icon.top - height - gap;
    if (y < work.top + gap) y = icon.bottom + gap;
    x = std::max<int>(work.left + gap, std::min<int>(x, work.right - width - gap));
    y = std::max<int>(work.top + gap, std::min<int>(y, work.bottom - height - gap));

    SetWindowPos(g_popup, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
}

void hide_popup() {
    if (!g_popup) return;
    g_ever_activated = false;
    g_hidden_at = GetTickCount64();
    KillTimer(g_msg, kWatchTimer);
    ShowWindow(g_popup, SW_HIDE);
    // 小窗收起来了就没人看得到码，继续每十秒向灯塔要一个只是白烧配额
    if (g_session) g_session->stop_advertise();
}

void show_popup(const std::string& highlight = {}) {
    if (!g_popup || !g_controller) return;
    place_popup();
    ShowWindow(g_popup, SW_SHOWNOACTIVATE);
    g_controller->put_IsVisible(TRUE);
    force_foreground(g_popup);
    g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    g_shown_at = GetTickCount64();
    SetTimer(g_msg, kWatchTimer, 250, nullptr);
    g_tray.set_tip(tray_tip());

    nlohmann::json message{{"t", "shown"}, {"clip", utf16_to_utf8(read_clipboard_text())}};
    if (!highlight.empty()) message["highlight"] = highlight;
    post_to_page(message.dump());

    post_to_page(collect_clipboard_items().dump());
}

void toggle_popup() {
    if (IsWindowVisible(g_popup)) {
        hide_popup();
    } else {
        show_popup();
    }
}

void reveal_path(const std::wstring& path) {
    const std::wstring params = L"/select,\"" + path + L"\"";
    if (reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", L"explorer.exe",
                                                params.c_str(), nullptr, SW_SHOWNORMAL)) <= 32) {
        post_to_page(R"({"t":"toast","text":"没能打开这个位置"})");
    }
}

void open_path(const std::wstring& path) {
    if (reinterpret_cast<INT_PTR>(
            ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) <= 32) {
        post_to_page(R"({"t":"toast","text":"打不开这份文件"})");
    }
}

/** 把收到的文件另存一份到用户选的位置；原文件不动。 */
void copy_file_as(const std::wstring& source, const std::wstring& suggested) {
    std::vector<wchar_t> target(32768, L'\0');
    std::wstring name = suggested;
    if (name.empty()) name = fs::path(source).filename().wstring();
    if (name.size() >= target.size()) name.resize(target.size() - 1);
    std::copy(name.begin(), name.end(), target.begin());

    OPENFILENAMEW dialog{};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = g_popup;
    dialog.lpstrFile = target.data();
    dialog.nMaxFile = static_cast<DWORD>(target.size());
    dialog.lpstrTitle = L"另存为";
    dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    g_in_dialog = true;
    const BOOL picked = GetSaveFileNameW(&dialog);
    g_in_dialog = false;
    if (IsWindowVisible(g_popup)) force_foreground(g_popup);
    if (!picked) return;
    if (!CopyFileW(source.c_str(), target.data(), FALSE)) {
        post_to_page(R"({"t":"toast","text":"复制失败，看看目标位置能不能写"})");
        return;
    }
    post_to_page(R"({"t":"toast","text":"已另存一份"})");
}

// ---- 发给页面的数据 ----

nlohmann::json file_entry(const fs::path& path) {
    std::error_code ec;
    const auto size = fs::file_size(path, ec);
    return {{"name", utf16_to_utf8(path.filename().wstring())},
            {"size", ec ? "未知大小" : human_size(size)},
            {"path", utf16_to_utf8(path.wstring())}};
}

void send_files_to_page(const std::vector<fs::path>& files, const std::string& intent) {
    nlohmann::json message{{"t", "files"}, {"intent", intent}, {"items", nlohmann::json::array()}};
    std::uintmax_t total = 0;
    for (const auto& file : files) {
        std::error_code ec;
        const auto size = fs::file_size(file, ec);
        total += ec ? 0 : size;
        message["items"].push_back(file_entry(file));
    }
    message["total"] = human_size(total);
    post_to_page(message.dump());
}

/**
 * 「发送到」可以选文件夹。传输层只认单个文件，所以这里把目录展开成文件列表，
 * 跳过没权限的项，并设个上限，免得误选 C:\ 把界面和队列撑爆。
 */
std::vector<fs::path> expand_send_paths(const std::vector<fs::path>& inputs) {
    constexpr size_t kMaxFiles = 2000;
    std::vector<fs::path> out;
    for (const auto& input : inputs) {
        std::error_code ec;
        if (fs::is_directory(input, ec)) {
            fs::recursive_directory_iterator it(
                input, fs::directory_options::skip_permission_denied, ec);
            const fs::recursive_directory_iterator end;
            while (!ec && it != end && out.size() < kMaxFiles) {
                std::error_code file_ec;
                if (it->is_regular_file(file_ec)) out.push_back(it->path());
                it.increment(ec);
            }
        } else if (fs::is_regular_file(input, ec)) {
            out.push_back(input);
        }
        if (out.size() >= kMaxFiles) break;
    }
    return out;
}

/** 第二个实例把命令行带过来的文件交给已经在跑的那个。 */
void forward_to_running_instance(const std::vector<fs::path>& files) {
    nlohmann::json payload{{"show", true}, {"files", nlohmann::json::array()}};
    for (const auto& file : files) {
        payload["files"].push_back(utf16_to_utf8(file.wstring()));
    }
    const std::string text = payload.dump();

    HWND target = nullptr;
    for (int attempt = 0; attempt < 20 && !target; attempt++) {
        target = FindWindowW(kPopupClass, nullptr);
        if (!target) Sleep(150);
    }
    if (!target) {
        if (!g_quiet) {
            MessageBoxW(nullptr, L"在线互传已经在运行，但它的窗口还没准备好。稍后再试。",
                        kAppName, MB_ICONINFORMATION | MB_OK);
        }
        return;
    }

    COPYDATASTRUCT data = {};
    data.dwData = 0x50545259;  // 'PTRY'
    data.cbData = static_cast<DWORD>(text.size());
    data.lpData = const_cast<char*>(text.data());
    DWORD_PTR result = 0;
    SendMessageTimeoutW(target, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&data),
                        SMTO_ABORTIFHUNG, 2000, &result);
}

/** 已经在跑的实例收到第二次启动的请求。只在界面线程调用。 */
void accept_forwarded_command(const std::string& json) {
    nlohmann::json message;
    try {
        message = nlohmann::json::parse(json);
    } catch (const std::exception&) {
        return;
    }
    std::vector<fs::path> files;
    for (const auto& item : message.value("files", nlohmann::json::array())) {
        if (item.is_string()) files.push_back(fs::path(utf8_to_utf16(item.get<std::string>())));
    }
    if (!files.empty()) {
        auto expanded = expand_send_paths(files);
        if (!expanded.empty()) {
            send_files_to_page(expanded, "send");
            log_line("[单实例] 收到 " + std::to_string(expanded.size()) + " 个文件");
        }
    }
    if (message.value("show", true)) show_popup();
}

/** 设置快照：init 和每次 state 回执都带上，页面只认这一份。 */
nlohmann::json settings_snapshot() {
    nlohmann::json message;
    message["savePath"] = utf16_to_utf8(g_state.save_path);
    message["deviceName"] = g_settings.device_name;
    message["notifySound"] = g_settings.notify_sound;
    message["autoSync"] = g_settings.auto_sync_clipboard;
    message["autostart"] = autostart_enabled();
    message["sendto"] = shell::sendto_installed(kSendToName);

    nlohmann::json sounds = nlohmann::json::array();
    size_t count = 0;
    const shell::SoundEntry* entries = shell::notify_sounds(&count);
    for (size_t i = 0; i < count; ++i) {
        sounds.push_back(
            {{"name", entries[i].name}, {"label", utf16_to_utf8(entries[i].label)}});
    }
    message["sounds"] = sounds;
    return message;
}

nlohmann::json init_message() {
    nlohmann::json message = settings_snapshot();
    message["t"] = "init";
    message["devices"] = nlohmann::json::array(
        {{{"name", "办公室电脑"}, {"online", true}}, {{"name", "我的手机"}, {"online", false}}});

    nlohmann::json transfers = nlohmann::json::array();
    std::error_code ec;
    const fs::path note = g_sample_dir / L"会议纪要-10月.txt";
    if (fs::exists(note, ec)) {
        transfers.push_back({{"name", "会议纪要-10月.txt"},
                             {"size", human_size(fs::file_size(note, ec))},
                             {"dir", "out"},
                             {"status", "done"},
                             {"time", "3 分钟前"},
                             {"path", utf16_to_utf8(note.wstring())}});
    }
    const fs::path image = g_sample_dir / L"产品图标.png";
    if (fs::exists(image, ec)) {
        transfers.push_back({{"name", "产品图标.png"},
                             {"size", human_size(fs::file_size(image, ec))},
                             {"dir", "in"},
                             {"status", "done"},
                             {"time", "昨天"},
                             {"path", utf16_to_utf8(image.wstring())}});
    }
    transfers.push_back({{"name", "产品演示.mp4"},
                         {"size", "68.2 MB"},
                         {"dir", "in"},
                         {"status", "active"},
                         {"progress", 62},
                         {"time", "正在接收"},
                         {"path", ""}});
    message["transfers"] = transfers;
    message["sampleDir"] = utf16_to_utf8(g_sample_dir.wstring());
    return message;
}

nlohmann::json state_message() {
    nlohmann::json message = settings_snapshot();
    message["t"] = "state";
    return message;
}

// ---- 选文件 / 选保存位置 ----

void choose_save_path() {
    g_in_dialog = true;
    const auto picked = shell::pick_folder(g_popup, L"选择接收文件的保存位置");
    g_in_dialog = false;
    if (picked.empty()) return;
    const std::wstring previous_path = g_state.save_path;
    const std::string previous_dir = g_settings.save_dir;
    g_state.save_path = picked.front().wstring();
    // settings.json 才是保存目录的唯一来源；state.json 里那份只是旧版本留下的。
    g_settings.save_dir = utf16_to_utf8(g_state.save_path);
    try {
        p2p::save_settings(g_session_dir, g_settings);
    } catch (const std::exception&) {
        // 写盘失败就当作没选过，否则界面会显示一个重启后就消失的目录。
        g_state.save_path = previous_path;
        g_settings.save_dir = previous_dir;
        post_to_page(R"({"t":"toast","text":"保存位置没能写进设置文件，还是用原来的"})");
        post_to_page(state_message().dump());
        log_line("[保存位置] 写盘失败，保持原值");
        return;
    }
    if (g_session) g_session->set_save_dir(g_settings.save_dir);
    save_state();
    refresh_tray_icon();
    post_to_page(state_message().dump());
    // 气泡会说清楚设到哪儿了，免得用户点完不知道有没有生效
    if (g_tray.installed()) {
        g_tray.notify(L"保存位置已设置", g_state.save_path, shell::NotifySound::Silent);
    }
    std::printf("[保存位置] %s\n", utf16_to_utf8(g_state.save_path).c_str());
    std::fflush(stdout);
}

void pick_and_send(bool link) {
    g_in_dialog = true;
    // 消息窗（HWND_MESSAGE）不能当对话框的 owner，必须给一个真窗口
    const auto files = expand_send_paths(shell::pick_files(g_popup));
    g_in_dialog = false;
    if (files.empty()) {
        // 取消也是正常路径；把焦点还给小窗，别让它因为失焦被收起
        if (IsWindowVisible(g_popup)) force_foreground(g_popup);
        return;
    }
    show_popup();
    send_files_to_page(files, link ? "link" : "send");
}

/** 选一个文件挂成公开链接。一次只挂一个：链接背后就是一个文件。 */
void pick_and_share() {
    std::string picked;
    if (!g_share_file_override.empty()) {
        picked = g_share_file_override;
    } else {
        g_in_dialog = true;
        const auto files = expand_send_paths(shell::pick_files(g_popup));
        g_in_dialog = false;
        if (IsWindowVisible(g_popup)) force_foreground(g_popup);
        if (files.empty()) {
            post_to_page(nlohmann::json{{"t", "share-cancelled"}}.dump());
            return;
        }
        picked = files.front().u8string();
    }
    if (!g_session) {
        post_to_page(nlohmann::json{{"t", "toast"}, {"text", "会话还没起来，稍后再试"}}.dump());
        return;
    }
    g_session->share_file(picked);
    log_line("[会话] 创建分享链接：" + picked);
}

// ---- 右键菜单 ----

std::wstring shorten_path(const std::wstring& path, size_t limit) {
    if (path.size() <= limit) return path;
    return path.substr(0, limit / 2 - 1) + L"…" + path.substr(path.size() - limit / 2);
}

HMENU build_menu() {
    HMENU menu = CreatePopupMenu();
    // 常用动作都搬到小窗里了，右键只留设置类的项
    AppendMenuW(menu, MF_STRING, kMenuSettings, L"设置…");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, kMenuSavePath, L"保存位置…");
    const std::wstring current =
        g_state.save_path.empty() ? L"　　尚未设置"
                                  : L"　　当前：" + shorten_path(g_state.save_path, 34);
    AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, current.c_str());
    AppendMenuW(menu, MF_STRING | (shell::sendto_installed(kSendToName) ? MF_CHECKED : 0),
                kMenuSendTo, L"加入「发送到」菜单");
    AppendMenuW(menu, MF_STRING | (g_settings.auto_sync_clipboard ? MF_CHECKED : 0),
                kMenuAutoSync, L"剪贴板自动同步");
    AppendMenuW(menu, MF_STRING | (autostart_enabled() ? MF_CHECKED : 0), kMenuAutostart,
                L"开机自启");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, kMenuOpenUi, L"打开完整界面");
    AppendMenuW(menu, MF_STRING, kMenuExit, L"退出");
    return menu;
}

void handle_menu(UINT command) {
    switch (command) {
        case kMenuSettings:
            post_to_page(nlohmann::json{{"t", "open-settings"}}.dump());
            show_popup();
            break;
        case kMenuSavePath:
            choose_save_path();
            break;
        case kMenuSendTo: {
            const bool installed = shell::sendto_installed(kSendToName);
            try {
                if (installed) {
                    shell::uninstall_sendto(kSendToName);
                } else {
                    shell::install_sendto(fs::path(current_exe_path()), kSendToName);
                }
                if (g_tray.installed()) {
                    g_tray.notify(L"发送到菜单",
                                  installed ? L"已从「发送到」移除" : L"已加入「发送到」菜单",
                                  shell::NotifySound::Silent);
                }
            } catch (const std::exception& error) {
                if (g_tray.installed()) {
                    g_tray.notify(L"发送到菜单",
                                  L"设置失败：" + utf8_to_utf16(error.what()),
                                  shell::NotifySound::Silent);
                }
            }
            break;
        }
        case kMenuOpenUi:
            open_settings();
            break;
        case kMenuAutoSync:
            g_settings.auto_sync_clipboard = !g_settings.auto_sync_clipboard;
            if (g_settings.auto_sync_clipboard) {
                AddClipboardFormatListener(g_msg);
            } else {
                RemoveClipboardFormatListener(g_msg);
            }
            try {
                p2p::save_settings(g_session_dir, g_settings);
            } catch (const std::exception&) {
            }
            post_to_page(
                nlohmann::json{{"t", "autosync"},
                               {"on", g_settings.auto_sync_clipboard}}
                    .dump());
            break;
        case kMenuAutostart: {
            const bool target = !autostart_enabled();
            const bool ok = set_autostart(target);
            if (g_tray.installed()) {
                g_tray.notify(L"开机自启",
                              ok ? (target ? L"已打开" : L"已关闭")
                                 : L"改不了注册表，可能是权限被限制了",
                              shell::NotifySound::Silent);
            }
            break;
        }
        case kMenuExit:
            DestroyWindow(g_msg);
            break;
        default:
            break;
    }
}

void show_context_menu() {
    POINT cursor = {};
    GetCursorPos(&cursor);
    HMENU menu = build_menu();
    g_menu_open = true;
    // 不先抢前台，菜单点外面关不掉（Win32 的老规矩）
    SetForegroundWindow(g_msg);
    const UINT command = TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                                        cursor.x, cursor.y, 0, g_msg, nullptr);
    DestroyMenu(menu);
    PostMessageW(g_msg, WM_NULL, 0, 0);
    g_menu_open = false;
    if (command) handle_menu(command);
}

// ---- 页面桥 ----

void on_page_message(const std::string& json) {
    nlohmann::json message;
    try {
        message = nlohmann::json::parse(json);
    } catch (const std::exception&) {
        return;
    }
    const std::string type = message.value("t", "");

    if (type == "ready") {
        g_page_ready = true;
        log_line("[界面] 页面就绪");
        // init 要先于积压事件：页面会拿 init 重置状态，反过来会把已经收到的
        // history/shares 清空，表现为重启后记录和分享链接全没了。
        post_to_page(init_message().dump());
        std::vector<std::string> pending;
        {
            std::lock_guard<std::mutex> lock(g_outbox_mutex);
            pending.swap(g_outbox);
        }
        for (const auto& item : pending) post_to_page(item);
        if (!g_launch_files.empty()) {
            // 从「发送到」或命令行带进来的文件：直接进"发送这些文件"的界面
            auto files = expand_send_paths(g_launch_files);
            g_launch_files.clear();
            if (!files.empty()) {
                send_files_to_page(files, "send");
                g_want_popup = true;
            }
        }
        if (g_want_popup) {
            g_want_popup = false;
            SetTimer(g_msg, kShowTimer, 400, nullptr);
        }
        if (g_shot_mode) {
            SetTimer(g_msg, kDumpWindows, 1500, nullptr);
            if (!g_shot_path.empty()) SetTimer(g_msg, kShotTimer, 900, nullptr);
        }
        return;
    }
    if (type == "close") {
        hide_popup();
        return;
    }
    if (type == "pick-files") {
        pick_and_send(false);
        return;
    }
    if (type == "pick-share-file") {
        pick_and_share();
        return;
    }
    if (type == "revoke-share") {
        const std::string token = message.value("token", "");
        if (g_session && !token.empty()) g_session->revoke_share(token);
        return;
    }
    if (type == "pick-save-path") {
        choose_save_path();
        if (IsWindowVisible(g_popup)) force_foreground(g_popup);
        return;
    }
    if (type == "copy") {
        write_clipboard_text(utf8_to_utf16(message.value("text", "")));
        return;
    }
    if (type == "advertise") {
        if (g_session) g_session->advertise();
        return;
    }
    if (type == "stop-advertise") {
        if (g_session) g_session->stop_advertise();
        return;
    }
    if (type == "join") {
        const std::string code = message.value("code", "");
        if (g_session && !code.empty()) g_session->join(code);
        return;
    }
    if (type == "connect") {
        const std::string id = message.value("id", "");
        if (g_session && !id.empty()) g_session->connect(id);
        return;
    }
    if (type == "pair-reply") {
        {
            std::lock_guard<std::mutex> lock(g_pair_reply.mutex);
            g_pair_reply.accepted = message.value("accepted", false);
            g_pair_reply.answered = true;
        }
        g_in_dialog = false;
        g_pair_reply.cv.notify_all();
        return;
    }
    if (type == "pair-cancel") {
        if (g_session) g_session->cancel_pairing();
        return;
    }
    if (type == "remove-contact") {
        const std::string id = message.value("id", "");
        if (g_session && !id.empty()) g_session->remove_contact(id);
        return;
    }
    if (type == "rename-contact") {
        const std::string id = message.value("id", "");
        const std::string name = message.value("name", "");
        if (g_session && !id.empty() && !name.empty()) g_session->rename_contact(id, name);
        return;
    }
    if (type == "set-device-name") {
        std::string name = message.value("name", "");
        const auto first = name.find_first_not_of(" \t\r\n");
        const auto last = name.find_last_not_of(" \t\r\n");
        name = first == std::string::npos ? "" : name.substr(first, last - first + 1);
        // 名字会出现在对方界面上，太长会破坏布局；换行之类的控制字符一并挡掉。
        // 按 UTF-8 字符数算，不按字节，否则一个中文名会被当成三个字符。
        size_t chars = 0;
        for (unsigned char byte : name) {
            if ((byte & 0xC0) != 0x80) ++chars;
        }
        if (chars == 0 || chars > 32) {
            post_to_page(nlohmann::json{{"t", "toast"}, {"text", "名字要 1 到 32 个字符"}}.dump());
            post_to_page(state_message().dump());
            return;
        }
        const std::string previous = g_settings.device_name;
        g_settings.device_name = name;
        bool saved = true;
        try {
            p2p::save_settings(g_session_dir, g_settings);
        } catch (const std::exception&) {
            saved = false;
            g_settings.device_name = previous;
        }
        if (!saved) {
            post_to_page(R"({"t":"toast","text":"名字没能写进设置文件，还是用原来的"})");
            post_to_page(state_message().dump());
            return;
        }
        if (g_session) g_session->set_device_name(name);
        log_line("[会话] 设备名改为 " + name);
        post_to_page(state_message().dump());
        return;
    }
    if (type == "disconnect") {
        if (g_session) g_session->disconnect_peer();
        return;
    }
    if (type == "cancel-transfer") {
        const std::string id = message.value("id", "");
        const bool incoming = message.value("incoming", false);
        if (g_session) g_session->cancel_transfer(id, incoming);
        log_line("[会话] 取消传输 " + id);
        return;
    }
    if (type == "send-text") {
        std::string text = message.value("text", "");
        const bool from_clipboard = message.value("fromClip", false);
        if (from_clipboard) {
            // 按下这一刻现读剪贴板：小窗可能已经开了一会儿，用户中途又复制了别的东西，
            // 用打开窗口时截下来的那份会发错内容。
            text = utf16_to_utf8(read_clipboard_text());
            if (text.empty()) {
                post_to_page(R"({"t":"toast","text":"这台电脑的剪贴板里没有文字"})");
                return;
            }
        }
        if (!text.empty()) {
            if (g_session) g_session->send_text(text);
            log_line("[会话] 发文字 " + std::to_string(text.size()) + " 字节");
            if (from_clipboard) {
                post_to_page(R"({"t":"toast","text":"已把剪贴板发给对方"})");
            }
        }
        return;
    }
    if (type == "send-files") {
        std::vector<std::string> paths;
        for (const auto& item : message.value("paths", nlohmann::json::array())) {
            if (item.is_string()) paths.push_back(item.get<std::string>());
        }
        if (!paths.empty() && g_session) g_session->send_files(paths);
        log_line("[会话] 发文件 " + std::to_string(paths.size()) + " 个");
        return;
    }
    if (type == "reveal") {
        reveal_path(utf8_to_utf16(message.value("path", "")));
        return;
    }
    if (type == "open-file") {
        open_path(utf8_to_utf16(message.value("path", "")));
        return;
    }
    if (type == "copy-file-as") {
        copy_file_as(utf8_to_utf16(message.value("path", "")),
                     utf8_to_utf16(message.value("name", "")));
        return;
    }
    if (type == "busy") {
        set_busy(message.value("on", false));
        return;
    }
    if (type == "set-sync") {
        g_settings.auto_sync_clipboard = message.value("on", false);
        if (g_settings.auto_sync_clipboard) {
            AddClipboardFormatListener(g_msg);
        } else {
            RemoveClipboardFormatListener(g_msg);
        }
        try {
            p2p::save_settings(g_session_dir, g_settings);
        } catch (const std::exception&) {
        }
        post_to_page(state_message().dump());
        return;
    }
    if (type == "set-notify-sound") {
        const std::string name = message.value("name", "");
        size_t count = 0;
        const shell::SoundEntry* entries = shell::notify_sounds(&count);
        bool known = false;
        for (size_t i = 0; i < count; ++i) {
            if (name == entries[i].name) {
                known = true;
                break;
            }
        }
        if (!known) return;
        g_settings.notify_sound = name;
        try {
            p2p::save_settings(g_session_dir, g_settings);
        } catch (const std::exception&) {
        }
        post_to_page(state_message().dump());
        return;
    }
    if (type == "set-autostart") {
        const bool on = message.value("on", false);
        if (!set_autostart(on)) {
            post_to_page(nlohmann::json{{"t", "toast"},
                                        {"text", "改不了注册表，可能是权限被限制了"}}
                             .dump());
        }
        post_to_page(state_message().dump());
        return;
    }
    if (type == "set-sendto") {
        const bool on = message.value("on", false);
        try {
            if (on) {
                shell::install_sendto(fs::path(current_exe_path()), kSendToName);
            } else {
                shell::uninstall_sendto(kSendToName);
            }
        } catch (const std::exception& error) {
            post_to_page(nlohmann::json{{"t", "toast"},
                                        {"text", std::string("设置失败：") + error.what()}}
                             .dump());
        }
        post_to_page(state_message().dump());
        return;
    }
    if (type == "open-full-ui") {
        open_settings();
        return;
    }
    if (type == "open-save-dialog") {
        choose_save_path();
        return;
    }
    if (type == "log") {
        std::printf("[页面] %s\n", message.value("text", "").c_str());
        std::fflush(stdout);
        return;
    }
}

// ---- 窗口过程 ----

LRESULT CALLBACK popup_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case WM_ERASEBKGND: {
            RECT rect = {};
            GetClientRect(hwnd, &rect);
            HBRUSH brush = CreateSolidBrush(g_window_bg);
            FillRect(reinterpret_cast<HDC>(wparam), &rect, brush);
            DeleteObject(brush);
            return 1;
        }
        case WM_SIZE:
            if (g_controller) {
                RECT rect = {};
                GetClientRect(hwnd, &rect);
                g_controller->put_Bounds(rect);
            }
            return 0;
        case WM_ACTIVATE:
            if (LOWORD(wparam) == WA_INACTIVE) {
                if (g_ever_activated && !g_menu_open && !g_in_dialog &&
                    GetTickCount64() - g_shown_at > 400) {
                    hide_popup();
                }
            } else {
                g_ever_activated = true;
            }
            return 0;
        case WM_DPICHANGED: {
            const UINT dpi = HIWORD(wparam);
            g_scale = dpi / 96.0;
            const RECT* suggested = reinterpret_cast<const RECT*>(lparam);
            const int width = static_cast<int>(kPopupWidthDip * g_scale);
            const int height = static_cast<int>(kPopupHeightDip * g_scale);
            SetWindowPos(hwnd, nullptr, suggested->left, suggested->top, width, height,
                         SWP_NOZORDER | SWP_NOACTIVATE);
            return 0;
        }
        case WM_CLOSE:
            hide_popup();
            return 0;
        case WM_COPYDATA: {
            auto* data = reinterpret_cast<const COPYDATASTRUCT*>(lparam);
            if (!data || !data->lpData || data->cbData == 0) return FALSE;
            const std::string text(static_cast<const char*>(data->lpData), data->cbData);
            accept_forwarded_command(text);
            return TRUE;
        }
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            break;
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
}

LRESULT CALLBACK msg_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case kTrayCallback:
            // 版本 4 把事件放在 LOWORD(lParam)：单击是 NIN_SELECT，
            // 右键是 WM_CONTEXTMENU，双击是 WM_LBUTTONDBLCLK。
            switch (LOWORD(lparam)) {
                case NIN_SELECT: {
                    // 快速双击时系统可能连发两次单击，防抖一下，免得开了又关
                    const ULONGLONG now = GetTickCount64();
                    if (now - g_last_left_click < 350) return 0;
                    g_last_left_click = now;
                    if (IsWindowVisible(g_popup)) {
                        hide_popup();
                        return 0;
                    }
                    // 点托盘时窗口会先因为失焦自动收起；这一下点击已经是"关"了，
                    // 不能再当成"开"，否则永远关不掉
                    if (now - g_hidden_at < 500) return 0;
                    show_popup();
                    return 0;
                }
                case WM_CONTEXTMENU:
                    show_context_menu();
                    return 0;
                case WM_LBUTTONDBLCLK:
                    // 双击不承载任何功能：它和"单击开、再单击关"会打架，容易误触
                    return 0;
                case NIN_BALLOONUSERCLICK:
                    // 收到文件的气泡点了就打开保存文件夹；其余气泡打开小窗
                    if (g_balloon_action == BalloonAction::OpenSaveDir) {
                        if (!g_state.save_path.empty()) {
                            ShellExecuteW(nullptr, L"open", g_state.save_path.c_str(), nullptr,
                                          nullptr, SW_SHOWNORMAL);
                        } else {
                            show_popup();
                        }
                    } else {
                        show_popup();
                    }
                    g_balloon_action = BalloonAction::None;
                    return 0;
                default:
                    return 0;
            }
        case WM_CLIPBOARDUPDATE: {
            // 只有开了自动同步才走到这里（没开不会注册监听）
            if (!g_settings.auto_sync_clipboard || !g_session) return 0;
            const std::string text = utf16_to_utf8(read_clipboard_text());
            static std::string last_sent;
            if (text.empty() || text == last_sent) return 0;
            last_sent = text;
            g_session->send_text(text);
            return 0;
        }
        case kPostToPage: {
            auto* text = reinterpret_cast<std::wstring*>(wparam);
            if (g_webview) g_webview->PostWebMessageAsJson(text->c_str());
            delete text;
            return 0;
        }
        case kNotifyEvent: {
            auto* request = reinterpret_cast<NotifyRequest*>(lparam);
            g_balloon_action = request->action;
            if (g_tray.installed()) {
                g_tray.notify(request->title, request->text, request->sound);
            }
            delete request;
            return 0;
        }
        case kFileReceived: {
            auto* path = reinterpret_cast<std::wstring*>(lparam);
            g_received_files.push_back(*path);
            delete path;
            if (g_tray.installed()) SetTimer(hwnd, kReceiveNotifyTimer, 700, nullptr);
            return 0;
        }
        case kErrorEvent: {
            auto* detail = reinterpret_cast<std::wstring*>(lparam);
            const bool popup_visible = IsWindowVisible(g_popup) != FALSE;
            if (!popup_visible && g_tray.installed()) {
                g_balloon_action = BalloonAction::ShowPopup;
                g_tray.notify(L"在线互传", *detail, shell::NotifySound::Silent);
            }
            delete detail;
            return 0;
        }
        case kPairAsk: {
            // 不再弹独立的系统对话框：小窗本身就有确认卡片，SAS 已在页面里。
            g_in_dialog = true;
            show_popup();
            return 0;
        }
        case kPairShow: {
            // 输码方只是核对，不阻塞；页面收到 pair-show 后自己画卡片。
            show_popup();
            return 0;
        }
        case kPairAskTimeout: {
            g_in_dialog = false;
            post_to_page(R"({"t":"pair-ask-timeout"})");
            return 0;
        }
        case WM_TIMER:
            if (wparam == kReceiveNotifyTimer) {
                KillTimer(hwnd, kReceiveNotifyTimer);
                if (!g_received_files.empty() && g_tray.installed()) {
                    const size_t count = g_received_files.size();
                    std::wstring title = count == 1
                                             ? L"收到一个文件"
                                             : L"收到 " + std::to_wstring(count) + L" 个文件";
                    std::wstring body = fs::path(g_received_files.back()).filename().wstring();
                    if (count > 1) body += L" 等";
                    if (!g_state.save_path.empty()) {
                        body += L"\n保存在 " + g_state.save_path;
                    }
                    g_balloon_action = BalloonAction::OpenSaveDir;
                    g_tray.notify(title, body,
                                  shell::sound_from_name(g_settings.notify_sound));
                    g_received_files.clear();
                }
                return 0;
            }
            if (wparam == kWatchTimer && IsWindowVisible(g_popup)) {
                // 失焦收起：靠 WM_ACTIVATE 有时收不到（焦点压根没抢过来），
                // 再拿一个定时器兜底，两种情况都能收
                if (!g_ever_activated) return 0;  // 还没被点过，先让它留在屏幕上
                if (GetTickCount64() - g_shown_at < 500 || g_menu_open || g_in_dialog) return 0;
                HWND foreground = GetForegroundWindow();
                DWORD pid = 0;
                if (foreground) GetWindowThreadProcessId(foreground, &pid);
                if (foreground && pid != GetCurrentProcessId()) hide_popup();
                return 0;
            }
            if (wparam == kAnimTimer) {
                if (!g_busy || !g_tray.installed()) {
                    KillTimer(hwnd, kAnimTimer);
                    return 0;
                }
                g_anim_index = (g_anim_index + 1) % 16;
                g_tray.set_icon(g_anim[g_anim_index] ? g_anim[g_anim_index] : g_icon);
                return 0;
            }
            if (wparam == kShowTimer) {
                KillTimer(hwnd, kShowTimer);
                show_popup();
                return 0;
            }
            if (wparam == 9) {
                KillTimer(hwnd, 9);
                log_line("[菜单] 准备弹出");
                const BOOL ok = SetForegroundWindow(g_popup);
                log_line(std::string("[菜单] 前台=") + (ok ? "是" : "否"));
                show_context_menu();
                log_line("[菜单] 已关闭");
                return 0;
            }
            if (wparam == kShotTimer || wparam == kDumpWindows) {
                if (wparam == kDumpWindows) {
                    KillTimer(hwnd, kDumpWindows);
                    EnumChildWindows(
                        g_popup,
                        [](HWND child, LPARAM) -> BOOL {
                            wchar_t cls[128] = {};
                            GetClassNameW(child, cls, 128);
                            RECT r = {};
                            GetWindowRect(child, &r);
                            log_line("[窗口] 子 " + utf16_to_utf8(cls) + " " +
                                     std::to_string(r.right - r.left) + "x" +
                                     std::to_string(r.bottom - r.top) + " @" +
                                     std::to_string(r.left) + "," + std::to_string(r.top) +
                                     (IsWindowVisible(child) ? " 可见" : " 隐藏"));
                            return TRUE;
                        },
                        0);
                    return 0;
                }
                KillTimer(hwnd, kShotTimer);
                if (g_webview && !g_shot_path.empty()) {
                    log_line("[截图] 开始 CapturePreview");
                    ComPtr<IStream> stream;
                    if (SUCCEEDED(SHCreateStreamOnFileEx(
                            g_shot_path.c_str(), STGM_CREATE | STGM_WRITE, FILE_ATTRIBUTE_NORMAL,
                            TRUE, nullptr, &stream))) {
                        g_webview->CapturePreview(
                            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream.Get(),
                            Callback<ICoreWebView2CapturePreviewCompletedHandler>(
                                [](HRESULT code) -> HRESULT {
                                    log_line("[截图] 回调 0x" + std::to_string(static_cast<unsigned long>(code)));
                                    std::printf("[截图] 已保存\n");
                                    std::fflush(stdout);
                                    PostQuitMessage(0);
                                    return S_OK;
                                })
                                .Get());
                        return 0;
                    }
                }
                PostQuitMessage(1);
                return 0;
            }
            if (wparam == kFirstRunTimer) {
                KillTimer(hwnd, kFirstRunTimer);
                if (!g_state.notice_shown && g_tray.installed()) {
                    g_state.notice_shown = true;
                    save_state();
                    g_balloon_action = BalloonAction::ShowPopup;
                    g_tray.notify(L"在线互传已在托盘运行",
                                  L"右键托盘图标可以改保存位置、开机自启",
                                  shell::NotifySound::Balloon);
                }
                return 0;
            }
            return 0;
        case WM_CLOSE:
            DestroyWindow(hwnd);
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            break;
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
}

// ---- WebView2 ----

void apply_webview_settings() {
    ComPtr<ICoreWebView2Settings> settings;
    if (FAILED(g_webview->get_Settings(&settings)) || !settings) return;
    // 这是一个应用的小窗，不是浏览器：不要右键菜单、不要缩放、不要状态栏
    settings->put_AreDefaultContextMenusEnabled(FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDevToolsEnabled(FALSE);
    settings->put_IsZoomControlEnabled(FALSE);
    settings->put_IsBuiltInErrorPageEnabled(FALSE);
    // 快捷键（Ctrl+R、Ctrl+滚轮之类）在 Settings3 上，老 SDK 没有就跳过
    ComPtr<ICoreWebView2Settings3> settings3;
    if (SUCCEEDED(settings.As(&settings3))) {
        settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
    }
}

void on_controller_ready(HRESULT result, ICoreWebView2Controller* controller) {
    std::printf("[界面] 控制器回调 0x%08lx\n", result);
    std::fflush(stdout);
    if (FAILED(result) || !controller) {
        std::fprintf(stderr, "[界面] WebView2 控制器没建起来：0x%08lx\n", result);
        return;
    }
    g_controller = controller;
    g_controller->get_CoreWebView2(&g_webview);
    if (!g_webview) return;

    RECT rect = {};
    GetClientRect(g_popup, &rect);
    g_controller->put_Bounds(rect);
    g_controller->put_IsVisible(TRUE);

    // 默认背景跟主题一致，页面加载前不会闪一块白
    ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(g_controller.As(&controller2))) {
        COREWEBVIEW2_COLOR color = g_dark ? COREWEBVIEW2_COLOR{255, 22, 24, 28}
                                          : COREWEBVIEW2_COLOR{255, 246, 247, 249};
        controller2->put_DefaultBackgroundColor(color);
    }

    apply_webview_settings();

    g_webview->add_WebMessageReceived(
        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                LPWSTR raw = nullptr;
                if (SUCCEEDED(args->get_WebMessageAsJson(&raw)) && raw) {
                    on_page_message(utf16_to_utf8(raw));
                    CoTaskMemFree(raw);
                }
                return S_OK;
            })
            .Get(),
        nullptr);

    g_webview->add_NewWindowRequested(
        Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                args->put_Handled(TRUE);
                return S_OK;
            })
            .Get(),
        nullptr);

    // 扫码要用摄像头。只给自家页面放行，别的权限仍然走默认询问。
    g_webview->add_PermissionRequested(
        Callback<ICoreWebView2PermissionRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                COREWEBVIEW2_PERMISSION_KIND kind =
                    COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                args->get_PermissionKind(&kind);
                LPWSTR raw = nullptr;
                args->get_Uri(&raw);
                const std::wstring uri = raw ? raw : L"";
                if (raw) CoTaskMemFree(raw);
                const bool ours = uri.rfind(L"https://app.local/", 0) == 0 ||
                                  uri.rfind(L"https://proto.local/", 0) == 0;
                if (kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA && ours) {
                    args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                }
                return S_OK;
            })
            .Get(),
        nullptr);

    // 开发时优先用源码目录（改完 HTML 重启就能看到）；发布时网页编在 exe 资源里，
    // 用 WebResourceRequested 拦下来自己返回，不需要旁边的 tray 目录。
    bool use_source_web = false;
    fs::path web_dir;
#ifdef TRAY_SOURCE_DIR
    const fs::path source_web = fs::path(utf8_to_utf16(TRAY_SOURCE_DIR)) / L"web";
    if (!g_force_embedded && fs::exists(source_web / L"popup.html")) {
        use_source_web = true;
        web_dir = source_web;
    }
#endif

    std::wstring base = L"https://app.local/";
    if (use_source_web) {
        base = L"https://proto.local/";
        ComPtr<ICoreWebView2_3> webview3;
        if (SUCCEEDED(g_webview.As(&webview3))) {
            webview3->SetVirtualHostNameToFolderMapping(
                L"proto.local", web_dir.c_str(),
                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
        }
        log_line("[界面] 网页来自源码目录 " + web_dir.u8string());
    } else {
        g_webview->AddWebResourceRequestedFilter(L"https://app.local/*",
                                                 COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        g_webview->add_WebResourceRequested(
            Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                    ComPtr<ICoreWebView2WebResourceRequest> request;
                    if (FAILED(args->get_Request(&request)) || !request) return S_OK;
                    LPWSTR raw_uri = nullptr;
                    request->get_Uri(&raw_uri);
                    std::wstring path = raw_uri ? raw_uri : L"";
                    if (raw_uri) CoTaskMemFree(raw_uri);
                    if (const auto query = path.find(L'?'); query != std::wstring::npos) {
                        path.resize(query);
                    }

                    int id = 0;
                    const wchar_t* content_type = L"text/plain";
                    const auto has_suffix = [&path](const wchar_t* suffix) {
                        const size_t len = wcslen(suffix);
                        return path.size() >= len && path.compare(path.size() - len, len, suffix) == 0;
                    };
                    if (has_suffix(L"/popup.html")) {
                        id = kResHtml;
                        content_type = L"text/html; charset=utf-8";
                    } else if (has_suffix(L"/popup.css")) {
                        id = kResCss;
                        content_type = L"text/css; charset=utf-8";
                    } else if (has_suffix(L"/popup.js")) {
                        id = kResJs;
                        content_type = L"text/javascript; charset=utf-8";
                    } else if (has_suffix(L"/qrcode.js")) {
                        id = kResQrCode;
                        content_type = L"text/javascript; charset=utf-8";
                    } else if (has_suffix(L"/jsqr.js")) {
                        id = kResJsqr;
                        content_type = L"text/javascript; charset=utf-8";
                    }

                    if (id == 0) {
                        ComPtr<ICoreWebView2WebResourceResponse> missing;
                        g_environment->CreateWebResourceResponse(nullptr, 404, L"Not Found",
                                                                 L"", &missing);
                        args->put_Response(missing.Get());
                        return S_OK;
                    }

                    const auto [bytes, length] = resource_bytes(id);
                    if (!bytes) {
                        ComPtr<ICoreWebView2WebResourceResponse> missing;
                        g_environment->CreateWebResourceResponse(nullptr, 500, L"Missing", L"",
                                                                 &missing);
                        args->put_Response(missing.Get());
                        return S_OK;
                    }
                    IStream* stream = SHCreateMemStream(bytes, static_cast<UINT>(length));
                    ComPtr<ICoreWebView2WebResourceResponse> response;
                    const std::wstring headers =
                        std::wstring(L"Content-Type: ") + content_type;
                    g_environment->CreateWebResourceResponse(stream, 200, L"OK", headers.c_str(),
                                                             &response);
                    if (stream) stream->Release();
                    args->put_Response(response.Get());
                    return S_OK;
                })
                .Get(),
            nullptr);
        log_line("[界面] 网页来自内嵌资源");
    }

    std::wstring url = base + L"popup.html";
    if (g_shot_mode) {
        url += L"?shot=1&state=" + utf8_to_utf16(g_shot_state);
        if (!g_shot_theme.empty()) url += L"&theme=" + utf8_to_utf16(g_shot_theme);
    }
    log_line("[界面] 打开 " + utf16_to_utf8(url));
    g_webview->Navigate(url.c_str());

    if (g_shot_mode) {
        place_popup();
        SetWindowPos(g_popup, HWND_TOPMOST, 60, 60, 0, 0,
                     SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        g_controller->put_IsVisible(TRUE);
        RECT check = {};
        GetWindowRect(g_popup, &check);
        log_line("[截图] 窗口可见=" + std::string(IsWindowVisible(g_popup) ? "是" : "否") +
                 " 位置=" + std::to_string(check.left) + "," + std::to_string(check.top) + " " +
                 std::to_string(check.right - check.left) + "x" +
                 std::to_string(check.bottom - check.top));
    }
}

void create_webview() {
    log_line("[界面] 进入 create_webview");
    // WebView2 一个用户目录只能给一个浏览器进程用。跟着状态目录走以后，
    // 用 --state-dir 开的两个实例各有各的界面，不会第二个直接起不来。
    const fs::path user_data = g_session_dir / L"webview2";
    std::error_code ec;
    fs::create_directories(user_data, ec);
    log_line("[界面] 目录就绪 " + ec.message());
    const std::wstring folder = user_data.wstring();
    log_line("[界面] 目录名 " + utf16_to_utf8(folder));
    std::printf("[界面] 用户目录 %s\n", utf16_to_utf8(folder).c_str());
    std::fflush(stdout);
    std::printf("[界面] 调 CreateCoreWebView2EnvironmentWithOptions\n");
    std::fflush(stdout);
    const HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, folder.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
                if (FAILED(result) || !environment) {
                    log_line("[界面] WebView2 环境起不来，可能没装 WebView2 运行时");
                    MessageBoxW(nullptr,
                                L"这台电脑缺少 Microsoft Edge WebView2 运行时，界面画不出来。"
                                L"装好之后重新打开就行："
                                L"https://developer.microsoft.com/microsoft-edge/webview2/",
                                L"在线互传", MB_ICONWARNING | MB_OK);
                    return S_OK;
                }
                g_environment = environment;
                environment->CreateCoreWebView2Controller(
                    g_popup,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [](HRESULT code, ICoreWebView2Controller* controller) -> HRESULT {
                            on_controller_ready(code, controller);
                            return S_OK;
                        })
                        .Get());
                return S_OK;
            })
            .Get());
    std::printf("[界面] 调用返回 0x%08lx\n", hr);
    std::fflush(stdout);
}

void create_windows(HINSTANCE instance) {
    WNDCLASSW msg_class = {};
    msg_class.lpfnWndProc = msg_proc;
    msg_class.hInstance = instance;
    msg_class.lpszClassName = kMsgClass;
    RegisterClassW(&msg_class);
    // 只收消息、不显示：托盘图标的 owner、菜单的 owner 都是它。
    // 注意不能用 HWND_MESSAGE 的消息窗：那种窗口不能被设为前台，
    // TrackPopupMenu 会弹不出来（菜单一闪或者干脆不出现）。
    g_msg = CreateWindowExW(WS_EX_TOOLWINDOW, kMsgClass, kAppName, WS_OVERLAPPEDWINDOW, -10000,
                            -10000, 200, 100, nullptr, nullptr, instance, nullptr);

    WNDCLASSW popup_class = {};
    popup_class.lpfnWndProc = popup_proc;
    popup_class.hInstance = instance;
    popup_class.lpszClassName = kPopupClass;
    popup_class.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
    popup_class.style = CS_DROPSHADOW;
    RegisterClassW(&popup_class);

    const int width = static_cast<int>(kPopupWidthDip * g_scale);
    const int height = static_cast<int>(kPopupHeightDip * g_scale);
    g_popup = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, kPopupClass, kAppName,
                              WS_POPUP | WS_CLIPCHILDREN, 0, 0, width, height, nullptr, nullptr,
                              instance, nullptr);
    if (!g_popup) {
        std::fprintf(stderr, "[界面] 小窗建不起来\n");
        return;
    }

    const DWORD dark = g_dark ? TRUE : FALSE;
    DwmSetWindowAttribute(g_popup, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
    const DWORD corner = DWMWCP_ROUND;
    DwmSetWindowAttribute(g_popup, DWMWA_WINDOW_CORNER_PREFERENCE, &corner, sizeof(corner));
    // 不画窗口边线：深色小窗外面套一圈浅色边很跳
    const DWORD border_none = 0xFFFFFFFE;  // DWMWA_COLOR_NONE
    DwmSetWindowAttribute(g_popup, 34 /* DWMWA_BORDER_COLOR */, &border_none, sizeof(border_none));
}

void install_tray(HINSTANCE instance) {
    const int cx = GetSystemMetrics(SM_CXSMICON);
    const int cy = GetSystemMetrics(SM_CYSMICON);
    // 图标从 exe 旁边的 assets 目录读。编进资源里也不是不行，但资源那条路
    // 在这台机器上 LoadImage 直接失败过，文件路径更好查、也方便换图。
    // 开发时从源码目录读图标（换图不用重编）；发布时用编进 exe 的资源
    bool use_source_assets = false;
    fs::path icon_dir;
#ifdef TRAY_SOURCE_DIR
    const fs::path source_assets = fs::path(utf8_to_utf16(TRAY_SOURCE_DIR)) / L"assets";
    if (!g_force_embedded && fs::exists(source_assets / L"tray.ico")) {
        use_source_assets = true;
        icon_dir = source_assets;
    }
#endif
    if (g_stock_icon) {
        g_icon = LoadIconW(nullptr, IDI_APPLICATION);
        g_icon_badge = g_icon;
        log_line("[托盘] 用系统默认图标");
    } else if (use_source_assets) {
        const UINT load_flags = LR_LOADFROMFILE | LR_DEFAULTCOLOR;
        g_icon = static_cast<HICON>(LoadImageW(nullptr, (icon_dir / L"tray.ico").c_str(),
                                              IMAGE_ICON, cx, cy, load_flags));
        g_icon_badge = static_cast<HICON>(LoadImageW(
            nullptr, (icon_dir / L"tray-badge.ico").c_str(), IMAGE_ICON, cx, cy, load_flags));
        g_anim[0] = g_icon;
        for (int frame = 1; frame < 16; frame++) {
            const std::wstring name = L"tray-" + std::to_wstring(frame) + L".ico";
            g_anim[frame] = static_cast<HICON>(
                LoadImageW(nullptr, (icon_dir / name).c_str(), IMAGE_ICON, cx, cy, load_flags));
        }
        log_line("[托盘] 图标来自源码目录");
    } else {
        g_icon = embedded_icon(kResIconStatic, cx);
        g_icon_badge = embedded_icon(kResIconBadge, cx);
        g_anim[0] = g_icon;
        for (int frame = 1; frame < 16; frame++) {
            g_anim[frame] = embedded_icon(kResIconFrame1 + frame - 1, cx);
        }
        log_line("[托盘] 图标来自内嵌资源");
    }
    bool frames_ok = true;
    for (int frame = 1; frame < 16; frame++) {
        if (!g_anim[frame]) frames_ok = false;
    }
    log_line(std::string("[托盘] 主图标 ") + (g_icon ? "ok" : "失败") + "，动画帧 " +
             (frames_ok ? "16 帧 ok" : "缺帧"));
    if (!g_icon) g_icon = LoadIconW(nullptr, IDI_APPLICATION);
    if (!g_icon_badge) g_icon_badge = g_icon;

    const HICON initial = g_state.save_path.empty() ? g_icon_badge : g_icon;
    log_line("[托盘] 调 install");
    if (g_skip_tray_install) {
        log_line("[托盘] 已跳过（调试）");
    } else if (g_tray.install(g_msg, kTrayCallback, tray_tip(), initial)) {
        std::printf("[托盘] 图标已就位\n");
        std::fflush(stdout);
    } else {
        // 托盘没起来就别装作没事：原型继续跑，但得让人看见
        const DWORD error = GetLastError();
        log_line("[托盘] 图标装不上，错误 " + std::to_string(error));
        g_want_popup = !g_quiet;
        const std::wstring message =
            L"系统托盘图标没注册上（错误码 " + std::to_wstring(error) +
            L"）。原型会继续运行，并直接弹出小窗。" +
            std::wstring(2, static_cast<wchar_t>(10)) + L"日志：" +
            (g_base_dir / L"run.log").wstring();
        MessageBoxW(nullptr, message.c_str(), L"在线互传 · 托盘没有起来",
                    MB_OK | MB_ICONWARNING);
    }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
    // 这是个窗口子系统的程序，双击不会开黑框；但从终端启动时把输出接到父控制台，
    // 调试和截图脚本就能看到日志。接不上就算了，不报错。
    if (AttachConsole(ATTACH_PARENT_PROCESS)) {
        FILE* ignore = nullptr;
        freopen_s(&ignore, "CONOUT$", "w", stdout);
        freopen_s(&ignore, "CONOUT$", "w", stderr);
    }
    Gdiplus::GdiplusStartupInput gdiplus_input;
    ULONG_PTR gdiplus_token = 0;
    Gdiplus::GdiplusStartup(&gdiplus_token, &gdiplus_input, nullptr);
    if (!g_no_dpi) enable_dpi_awareness();
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    // 显式给进程一个身份：任务栏分组、快捷方式和以后的通知都用得上
    SetCurrentProcessExplicitAppUserModelID(kAumid);

    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    bool reset = false;
    for (int i = 1; i < argc; i++) {
        const std::wstring flag = argv[i];
        if (flag == L"--shot" && i + 1 < argc) {
            g_shot_mode = true;
            g_shot_path = argv[++i];
        } else if (flag == L"--state" && i + 1 < argc) {
            g_shot_state = utf16_to_utf8(argv[++i]);
        } else if (flag == L"--theme" && i + 1 < argc) {
            g_shot_theme = utf16_to_utf8(argv[++i]);
        } else if (flag == L"--probe-clipboard") {
            g_base_dir = pick_base_dir();
            const auto items = collect_clipboard_items();
            std::ofstream probe(g_base_dir / L"clipboard-probe.json", std::ios::binary);
            probe << items.dump(2);
            return 0;
        } else if (flag == L"--state-dir" && i + 1 < argc) {
            g_state_dir_override = argv[++i];
        } else if (flag == L"--send-text" && i + 1 < argc) {
            g_pending_text = utf16_to_utf8(argv[++i]);
        } else if (flag == L"--send-file" && i + 1 < argc) {
            g_pending_files.push_back(utf16_to_utf8(argv[++i]));
        } else if (flag == L"--share-file" && i + 1 < argc) {
            g_share_file_override = utf16_to_utf8(argv[++i]);
        } else if (flag == L"--join" && i + 1 < argc) {
            g_auto_join = utf16_to_utf8(argv[++i]);
        } else if (flag == L"--connect" && i + 1 < argc) {
            g_auto_connect = utf16_to_utf8(argv[++i]);
        } else if (flag == L"--advertise") {
            g_auto_advertise = true;
        } else if (flag == L"--embedded") {
            g_force_embedded = true;
        } else if (flag == L"--quiet") {
            g_quiet = true;
        } else if (flag == L"--no-dpi") {
            g_no_dpi = true;
        } else if (flag == L"--skip-tray") {
            g_skip_tray_install = true;
        } else if (flag == L"--stock-icon") {
            g_stock_icon = true;
        } else if (flag == L"--menu") {
            g_show_menu_on_start = true;
            g_show_on_start = true;
        } else if (flag == L"--demo") {
            // 只看不截图：窗口停在那儿，方便手动体验或外部截图
            g_shot_mode = true;
        } else if (flag == L"--show") {
            g_show_on_start = true;
        } else if (flag == L"--reset") {
            reset = true;
        } else if (flag == L"--log" && i + 1 < argc) {
            g_log_flag_path = argv[++i];
        } else if (flag == L"--auto-accept") {
            g_auto_accept = true;
        } else if (!flag.empty() && flag[0] != L'-') {
            // SendTo / 资源管理器把选中的文件作为参数传进来。
            // 不存在的路径直接忽略，免得把参数里的杂项当成文件。
            std::error_code ec;
            if (fs::exists(fs::path(flag), ec)) g_launch_files.push_back(fs::path(flag));
        }
    }
    if (argv) LocalFree(argv);

    g_dark = is_dark_mode();
    g_window_bg = g_dark ? RGB(22, 24, 28) : RGB(246, 247, 249);

    g_base_dir = pick_base_dir();
    {
        // 总是留一份日志：托盘起不来的现场只看屏幕是查不出来的
        const fs::path log_path =
            g_log_flag_path.empty() ? (g_base_dir / L"run.log") : fs::path(g_log_flag_path);
        g_log = _wfopen(log_path.c_str(), L"a");
        log_line("---- 启动 " + utf16_to_utf8(log_path.wstring()) + " ----");
    }
    if (!g_pending_text.empty() || !g_pending_files.empty()) {
        log_line("[启动] 待发送：文字 " + std::to_string(g_pending_text.size()) + " 字节，文件 " +
                 std::to_string(g_pending_files.size()) + " 个");
        for (const auto& file : g_pending_files) log_line("[启动] 待发送文件 " + file);
    }

    // 同一份数据目录只跑一个实例。否则第二个进程会用同一个设备号再连一次灯塔，
    // 把第一个顶下线，还会多出一个托盘图标。名字带目录哈希，托盘↔托盘联调
    // （两边各用 --state-dir）仍可同时跑。
    if (!g_shot_mode) {
        const fs::path instance_dir =
            g_state_dir_override.empty() ? p2p::default_app_dir() : fs::path(g_state_dir_override);
        const size_t hash = std::hash<std::wstring>{}(instance_dir.wstring());
        const std::wstring mutex_name = L"Local\\P2PTray-" + std::to_wstring(hash);
        g_instance_mutex = CreateMutexW(nullptr, FALSE, mutex_name.c_str());
        if (g_instance_mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
            log_line("[单实例] 已有实例在跑，把请求转过去");
            forward_to_running_instance(g_launch_files);
            return 0;
        }
    }
    if (reset) {
        std::error_code ec;
        fs::remove(g_base_dir / L"state.json", ec);
        std::printf("[状态] 已清除，下次启动就是第一次\n");
    }
    const fs::path ui_dir = find_ui_dir();
    if (!ui_dir.empty()) {
        proto::start_server(ui_dir, 47123);
    } else {
        log_line("[界面] 没找到 app/dist，设置页会退回线上站点");
    }

    load_state();
    if (g_legacy_autostart) {
        // 旧版本只把开关记在 state.json 里，从没真的写注册表。升级时补上这一次。
        if (!autostart_enabled()) set_autostart(true);
        save_state();
    }
    // 原型每次启动都把小窗弹出来。真实产品里它应该安静待在托盘，
    // 但现在还没有托盘图标可靠可言，不弹就真的什么都看不到。
    g_want_popup = !g_quiet;
    g_sample_dir = ensure_samples();

    // 真正的传输会话：身份、设置、历史都放在原生端自己的数据目录里，
    // 和 p2p-shell 共用同一份身份（同一台设备不该有两个设备号）。
    g_session_dir =
        g_state_dir_override.empty() ? p2p::default_app_dir() : fs::path(g_state_dir_override);
    try {
        const auto loaded = p2p::load_or_create_identity(g_session_dir);
        g_settings = p2p::load_settings(g_session_dir);
        // 旧版本的保存位置在 state.json 里。第一次升级时迁到 settings.json，
        // 之后就只认 settings.json，避免两套配置各说各话。
        // 只有在用户还没自定义过保存目录时才迁移，别覆盖 settings.json 里的明确设置。
        if (!g_state.save_path.empty()) {
            const std::string legacy = utf16_to_utf8(g_state.save_path);
            const bool using_default = g_settings.save_dir == p2p::default_save_dir().u8string();
            if (legacy != g_settings.save_dir && using_default) {
                g_settings.save_dir = legacy;
                try {
                    p2p::save_settings(g_session_dir, g_settings);
                } catch (const std::exception&) {
                }
            }
            g_state.save_path = utf8_to_utf16(g_settings.save_dir);
        } else {
            g_state.save_path = utf8_to_utf16(g_settings.save_dir);
        }
        log_line("[会话] 保存目录 " + g_settings.save_dir);
        log_line("[会话] 设备号 " + loaded.identity.device_id().substr(0, 8));
        g_session = std::make_unique<shell::Session>(
            loaded.identity, g_settings, g_session_dir, [](const nlohmann::json& msg) {
                log_line("[会话] " + msg.dump());
                const std::string type = msg.value("t", "");
                if (type == "pair-show") {
                    // 输码方：把核对码显示出来，同时把小窗叫到前台
                    PostMessageW(g_msg, kPairShow, 0, 0);
                    post_to_page(msg.dump());
                    return;
                }
                if (type == "text") {
                    nlohmann::json copy = msg;
                    copy["autoCopy"] = g_settings.auto_sync_clipboard;
                    post_to_page(copy.dump());
                    return;
                }
                if (type == "file-done") {
                    // 气泡和界面各自处理；先在界面线程攒一下再弹，避免连收几个文件弹一串气泡
                    auto* path = new std::wstring(
                        utf8_to_utf16(msg.value("path", "")));
                    if (!PostMessageW(g_msg, kFileReceived, 0, reinterpret_cast<LPARAM>(path))) {
                        delete path;
                    }
                    post_to_page(msg.dump());
                    return;
                }
                if (type == "state" && msg.value("value", "") == "error") {
                    // 小窗开着的时候页面自己会 toast；没开就用气泡说一声，
                    // 不然发送失败这类事用户完全看不见。
                    auto* detail = new std::wstring(
                        utf8_to_utf16(msg.value("detail", "连接出错了")));
                    if (!PostMessageW(g_msg, kErrorEvent, 0, reinterpret_cast<LPARAM>(detail))) {
                        delete detail;
                    }
                }
                if (msg.value("t", "") == "state" && msg.value("value", "") == "connected" &&
                    g_session) {
                    log_line("[测试] 已连接，自动发送：文字 " +
                             std::to_string(g_pending_text.size()) + " 字节，文件 " +
                             std::to_string(g_pending_files.size()) + " 个");
                    if (!g_pending_text.empty()) {
                        g_session->send_text(g_pending_text);
                        g_pending_text.clear();
                    }
                    if (!g_pending_files.empty()) {
                        auto files = g_pending_files;
                        g_pending_files.clear();
                        g_session->send_files(files);
                    }
                }
                post_to_page(msg.dump());
            });
    } catch (const std::exception& error) {
        log_line(std::string("[会话] 身份读取失败：") + error.what());
    }

    if (g_session) {
        // 码主必须核对 SAS：灯塔能换公钥，但换不出两边一致的六位数字。
        // 自动化测试用 --auto-accept 跳过这一步。
        g_session->set_pair_confirmer([](const std::string& name, const std::string& sas) {
            if (g_auto_accept) {
                post_to_page(R"({"t":"pair-ask-cancel"})");
                return true;
            }
            return ask_pair_confirmation(name, sas);
        });
    }

    // 先按系统 DPI 定尺寸再建窗，避免先按 100% 建一次再被缩回来
    g_scale = GetDpiForSystem() / 96.0;
    std::printf("[启动] 建窗\n");
    std::fflush(stdout);
    create_windows(instance);
    if (!g_msg || !g_popup) return 1;
    std::printf("[启动] 窗已建好\n");
    std::fflush(stdout);

    g_scale = GetDpiForWindow(g_popup) / 96.0;
    SetWindowPos(g_popup, nullptr, 0, 0, static_cast<int>(kPopupWidthDip * g_scale),
                 static_cast<int>(kPopupHeightDip * g_scale),
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);

    if (!g_shot_mode) {
        install_tray(instance);
        // 第一次启动：给一条通知说清楚"我在这儿、下一步做什么"
        SetTimer(g_msg, kFirstRunTimer, 1200, nullptr);
    } else {
        std::printf("[截图] 状态 %s，主题 %s\n", g_shot_state.c_str(),
                    g_shot_theme.empty() ? "跟随系统" : g_shot_theme.c_str());
    }
    if (g_show_on_start) g_want_popup = true;

    std::printf("[启动] 建 WebView2\n");
    std::fflush(stdout);
    create_webview();

    // 会话线程最后起：页面随时可能收到状态，消息会先进 outbox
    if (g_session) {
        if (g_settings.auto_sync_clipboard) AddClipboardFormatListener(g_msg);
        g_session->start();
        if (g_auto_advertise) g_session->advertise();
        if (!g_auto_join.empty()) g_session->join(g_auto_join);
        if (!g_auto_connect.empty()) g_session->connect(g_auto_connect);
    }

    if (g_show_menu_on_start) {
        SetCursorPos(300, 300);
        SetTimer(g_msg, 9, 1500, nullptr);
    }

    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0)) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    if (g_session) g_session->stop();
    if (g_tray.installed()) g_tray.remove();
    if (g_controller) g_controller->Close();
    if (g_popup) DestroyWindow(g_popup);
    Gdiplus::GdiplusShutdown(gdiplus_token);
    CoUninitialize();
    return 0;
}
