// 在线互传 安装程序。
//
// 设计取舍：
//   - 按用户安装到 %LOCALAPPDATA%\p2p-share，不弹 UAC，不需要管理员；
//   - 托盘 exe 作为 RCDATA 编进来，安装包只有一个文件，没有额外运行库；
//   - 卸载复用同一个 exe（--uninstall），注册表里那一项指向安装目录里的副本；
//   - 卸载时默认保留身份和配对记录，只有 --purge（或界面上明确选"是"）才删。
//
// 没上 Inno Setup / NSIS：这条线一直是单文件绿色版，装个编译器只为打一个包
// 不划算；这里用到的都是系统自带的 shell/registry API。
#include <windows.h>
#include <commctrl.h>
#include <uxtheme.h>
#include <windowsx.h>

// 任务对话框和视觉样式需要 Common Controls v6。没有这份依赖，安装向导会退回
// Win95 风格，正好是这次要修掉的“很原始”的观感。
#pragma comment(linker, "\"/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

#include <propsys.h>
#include <propkey.h>
#include <propvarutil.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wrl.h>

#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "resource.h"
#include "sendto.h"

using namespace Microsoft::WRL;
namespace fs = std::filesystem;

namespace {

constexpr wchar_t kAppName[] = L"在线互传";
constexpr wchar_t kVersion[] = L"0.1.0";
constexpr wchar_t kAumid[] = L"P2PShare.Tray";
constexpr wchar_t kRunKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kRunValue[] = L"P2PShareTray";
constexpr wchar_t kUninstallKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\P2PShare";
constexpr wchar_t kShortcutName[] = L"在线互传.lnk";
constexpr wchar_t kSendToName[] = L"在线互传.lnk";

constexpr int kIdInstall = 1001;
constexpr int kIdCancel = 1002;
constexpr int kIdDesktop = 1010;
constexpr int kIdAutostart = 1011;
constexpr int kIdSendTo = 1012;
constexpr int kIdOpen = 1020;
constexpr int kIdFinish = 1021;
constexpr int kIdRetry = 1022;
constexpr int kIdClose = 1023;
constexpr int kIdProgress = 1030;

constexpr COLORREF kInk = RGB(26, 35, 32);
constexpr COLORREF kMuted = RGB(105, 117, 112);
constexpr COLORREF kAccent = RGB(18, 122, 92);
constexpr COLORREF kAccentDark = RGB(13, 96, 72);
constexpr COLORREF kAccentSoft = RGB(228, 243, 236);
constexpr COLORREF kPage = RGB(246, 248, 247);
constexpr COLORREF kCard = RGB(255, 255, 255);
constexpr COLORREF kLine = RGB(222, 229, 225);
constexpr COLORREF kDanger = RGB(184, 62, 51);

enum class Screen { options, working, success, error };

HINSTANCE g_instance = nullptr;
HWND g_window = nullptr;
HWND g_desktop_check = nullptr;
HWND g_autostart_check = nullptr;
HWND g_sendto_check = nullptr;
HWND g_progress = nullptr;
HWND g_button_primary = nullptr;
HWND g_button_secondary = nullptr;
HFONT g_font = nullptr;
HFONT g_title_font = nullptr;
HFONT g_section_font = nullptr;
HFONT g_small_font = nullptr;
HFONT g_button_font = nullptr;
HBRUSH g_page_brush = nullptr;
HBRUSH g_card_brush = nullptr;
UINT g_dpi = 96;
Screen g_screen = Screen::options;
int g_hover_button = 0;
std::wstring g_install_error;
bool g_tracking_leave = false;

bool g_silent = false;
bool g_uninstall_mode = false;
bool g_purge = false;
bool g_desktop = true;
bool g_autostart = false;
bool g_sendto = true;
fs::path g_dir_override;
fs::path g_log_path;

std::wstring utf8_to_utf16(const std::string& text) {
    if (text.empty()) return {};
    const int need = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                         nullptr, 0);
    if (need <= 0) return {};
    std::wstring out(static_cast<size_t>(need), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), need);
    return out;
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

void log_line(const std::wstring& text) {
    if (g_log_path.empty()) return;
    std::ofstream out(g_log_path, std::ios::app | std::ios::binary);
    if (!out) return;
    const std::string utf8 = utf16_to_utf8(text);
    out.write(utf8.data(), static_cast<std::streamsize>(utf8.size()));
    out.put('\n');
}

fs::path known_folder(REFKNOWNFOLDERID id) {
    PWSTR raw = nullptr;
    if (FAILED(SHGetKnownFolderPath(id, 0, nullptr, &raw)) || !raw) {
        if (raw) CoTaskMemFree(raw);
        return {};
    }
    fs::path out(raw);
    CoTaskMemFree(raw);
    return out;
}

fs::path exe_path() {
    wchar_t buffer[MAX_PATH] = {};
    const DWORD len = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    return len == 0 ? fs::path() : fs::path(std::wstring(buffer, len));
}

fs::path default_install_dir() {
    return known_folder(FOLDERID_LocalAppData) / L"p2p-share";
}

fs::path install_dir() { return g_dir_override.empty() ? default_install_dir() : g_dir_override; }

bool reg_set_string(HKEY key, const wchar_t* name, const std::wstring& value) {
    return RegSetValueExW(key, name, 0, REG_SZ,
                          reinterpret_cast<const BYTE*>(value.c_str()),
                          static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS;
}

bool reg_set_dword(HKEY key, const wchar_t* name, DWORD value) {
    return RegSetValueExW(key, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value),
                          sizeof(value)) == ERROR_SUCCESS;
}

bool set_autostart(bool enabled, const fs::path& tray) {
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kRunKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key,
                        nullptr) != ERROR_SUCCESS) {
        return false;
    }
    LSTATUS status = ERROR_SUCCESS;
    if (enabled) {
        const std::wstring command = L"\"" + tray.wstring() + L"\" --quiet";
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

void stop_running_tray() {
    HWND target = FindWindowW(L"P2PTrayProto.Popup", nullptr);
    if (!target) return;
    log_line(L"关闭正在运行的托盘程序");
    PostMessageW(target, WM_CLOSE, 0, 0);
    for (int i = 0; i < 30; ++i) {
        if (!IsWindow(target)) return;
        Sleep(100);
    }
}

bool extract_tray(const fs::path& target, std::wstring* error) {
    HRSRC resource = FindResourceW(nullptr, MAKEINTRESOURCEW(IDR_TRAY_EXE), RT_RCDATA);
    if (!resource) {
        *error = L"安装包不完整：找不到内嵌的托盘程序。";
        return false;
    }
    const DWORD size = SizeofResource(nullptr, resource);
    HGLOBAL loaded = LoadResource(nullptr, resource);
    const void* bytes = loaded ? LockResource(loaded) : nullptr;
    if (!bytes || size == 0) {
        *error = L"安装包不完整：托盘程序是空的。";
        return false;
    }
    std::ofstream out(target, std::ios::binary | std::ios::trunc);
    if (!out) {
        *error = L"写不进安装目录：" + target.wstring();
        return false;
    }
    out.write(static_cast<const char*>(bytes), size);
    out.close();
    if (!out) {
        *error = L"托盘程序写到一半失败了：" + target.wstring();
        return false;
    }
    return true;
}

bool create_shortcut(const fs::path& link_path, const fs::path& target,
                     const std::wstring& description) {
    ComPtr<IShellLinkW> link;
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&link)))) {
        return false;
    }
    link->SetPath(target.c_str());
    link->SetWorkingDirectory(target.parent_path().c_str());
    link->SetIconLocation(target.c_str(), 0);
    link->SetDescription(description.c_str());

    // 任务栏分组和以后的通知都靠这个身份；快捷方式上的 AUMID 要和进程里设的一致
    ComPtr<IPropertyStore> store;
    if (SUCCEEDED(link.As(&store))) {
        PROPVARIANT value;
        PropVariantInit(&value);
        value.vt = VT_LPWSTR;
        value.pwszVal = const_cast<wchar_t*>(kAumid);
        store->SetValue(PKEY_AppUserModel_ID, value);
        store->Commit();
    }

    ComPtr<IPersistFile> file;
    if (FAILED(link.As(&file))) return false;
    std::error_code ec;
    fs::create_directories(link_path.parent_path(), ec);
    return SUCCEEDED(file->Save(link_path.c_str(), TRUE));
}

void remove_file(const fs::path& path) {
    std::error_code ec;
    fs::remove(path, ec);
}

void write_uninstall_key(const fs::path& dir, const fs::path& tray) {
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kUninstallKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr,
                        &key, nullptr) != ERROR_SUCCESS) {
        log_line(L"卸载注册项写不进去");
        return;
    }
    const fs::path setup = dir / L"p2p-setup.exe";
    reg_set_string(key, L"DisplayName", kAppName);
    reg_set_string(key, L"DisplayVersion", kVersion);
    reg_set_string(key, L"Publisher", L"P2P Share");
    reg_set_string(key, L"DisplayIcon", tray.wstring());
    reg_set_string(key, L"InstallLocation", dir.wstring());
    reg_set_string(key, L"UninstallString", L"\"" + setup.wstring() + L"\" --uninstall");
    reg_set_string(key, L"QuietUninstallString", L"\"" + setup.wstring() + L"\" --uninstall --silent");
    std::error_code ec;
    std::uintmax_t size = fs::file_size(tray, ec);
    size += fs::file_size(setup, ec);
    reg_set_dword(key, L"EstimatedSize", static_cast<DWORD>(size / 1024));
    reg_set_dword(key, L"NoModify", 1);
    reg_set_dword(key, L"NoRepair", 1);
    RegCloseKey(key);
}

bool install(std::wstring* error) {
    const fs::path dir = install_dir();
    std::error_code ec;
    fs::create_directories(dir, ec);
    if (ec) {
        *error = L"建不了安装目录：" + dir.wstring();
        return false;
    }
    stop_running_tray();

    const fs::path tray = dir / L"p2p-tray.exe";
    if (!extract_tray(tray, error)) return false;
    log_line(L"释放托盘程序 → " + tray.wstring());

    const fs::path self = exe_path();
    const fs::path uninstaller = dir / L"p2p-setup.exe";
    if (lstrcmpiW(self.c_str(), uninstaller.c_str()) != 0) {
        if (!CopyFileW(self.c_str(), uninstaller.c_str(), FALSE)) {
            *error = L"复制卸载程序失败（错误码 " + std::to_wstring(GetLastError()) + L"）。";
            return false;
        }
    }

    const fs::path start_menu = known_folder(FOLDERID_Programs) / kShortcutName;
    if (!create_shortcut(start_menu, tray, L"在线互传")) {
        *error = L"开始菜单快捷方式建不了：" + start_menu.wstring();
        return false;
    }
    log_line(L"开始菜单快捷方式 → " + start_menu.wstring());

    const fs::path desktop = known_folder(FOLDERID_Desktop) / kShortcutName;
    if (g_desktop && !create_shortcut(desktop, tray, L"在线互传")) {
        log_line(L"桌面快捷方式没建成，继续安装");
    }
    if (!g_desktop) remove_file(desktop);

    if (g_sendto) {
        try {
            shell::install_sendto(tray, kSendToName);
            log_line(L"已加入「发送到」菜单");
        } catch (const std::exception& ex) {
            log_line(L"加入「发送到」失败：" + utf8_to_utf16(ex.what()));
        }
    } else {
        shell::uninstall_sendto(kSendToName);
    }

    if (!set_autostart(g_autostart, tray)) {
        log_line(L"开机自启设置失败");
    }

    write_uninstall_key(dir, tray);
    log_line(L"安装完成：" + dir.wstring());
    return true;
}

fs::path registered_install_dir() {
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kUninstallKey, 0, KEY_READ, &key) != ERROR_SUCCESS) {
        return install_dir();
    }
    wchar_t buffer[1024] = {};
    DWORD size = sizeof(buffer);
    DWORD type = 0;
    fs::path out;
    if (RegQueryValueExW(key, L"InstallLocation", nullptr, &type,
                         reinterpret_cast<LPBYTE>(buffer), &size) == ERROR_SUCCESS &&
        type == REG_SZ) {
        out = fs::path(buffer);
    }
    RegCloseKey(key);
    return out.empty() ? install_dir() : out;
}

void schedule_remove_dir(const fs::path& dir) {
    if (!dir.has_parent_path()) return;
    // 自己正在这个目录里运行，只能等进程退出后让 cmd 来删。
    const std::wstring command =
        L"cmd.exe /c ping -n 2 127.0.0.1 >nul & rmdir /s /q \"" + dir.wstring() + L"\"";
    std::wstring mutable_command = command;
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION process = {};
    if (CreateProcessW(nullptr, mutable_command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                       nullptr, nullptr, &startup, &process)) {
        CloseHandle(process.hProcess);
        CloseHandle(process.hThread);
    }
}

void remove_user_data() {
    std::error_code ec;
    fs::remove_all(known_folder(FOLDERID_LocalAppData) / L"P2PLighthouse", ec);
    fs::remove_all(known_folder(FOLDERID_LocalAppData) / L"p2ptray-proto", ec);
    log_line(L"已删除本机身份、配对记录和界面状态");
}

bool uninstall(std::wstring* error) {
    const fs::path dir = registered_install_dir();
    stop_running_tray();

    remove_file(known_folder(FOLDERID_Programs) / kShortcutName);
    remove_file(known_folder(FOLDERID_Desktop) / kShortcutName);
    shell::uninstall_sendto(kSendToName);
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_SET_VALUE, &key) == ERROR_SUCCESS) {
        RegDeleteValueW(key, kRunValue);
        RegCloseKey(key);
    }
    RegDeleteKeyW(HKEY_CURRENT_USER, kUninstallKey);
    if (g_purge) remove_user_data();

    schedule_remove_dir(dir);
    log_line(L"卸载完成：" + dir.wstring());
    (void)error;
    return true;
}

// ---- 安装界面 ----

int px(int value) { return MulDiv(value, static_cast<int>(g_dpi), 96); }

void fill_rect(HDC dc, const RECT& rect, COLORREF color) {
    HBRUSH brush = CreateSolidBrush(color);
    FillRect(dc, &rect, brush);
    DeleteObject(brush);
}

void fill_round(HDC dc, const RECT& rect, int radius, COLORREF fill, COLORREF border) {
    HBRUSH brush = CreateSolidBrush(fill);
    HPEN pen = CreatePen(PS_SOLID, 1, border);
    HGDIOBJ old_brush = SelectObject(dc, brush);
    HGDIOBJ old_pen = SelectObject(dc, pen);
    RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    DeleteObject(pen);
    DeleteObject(brush);
}

void draw_text(HDC dc, const wchar_t* text, RECT rect, HFONT font, COLORREF color, UINT flags) {
    HGDIOBJ old_font = SelectObject(dc, font);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, color);
    DrawTextW(dc, text, -1, &rect, flags | DT_NOPREFIX);
    SelectObject(dc, old_font);
}

void draw_header(HDC dc, const RECT& client) {
    TRIVERTEX vertex[2] = {
        {0, 0, static_cast<COLOR16>(9 << 8), static_cast<COLOR16>(61 << 8),
         static_cast<COLOR16>(49 << 8), 0xff00},
        {client.right, px(122), static_cast<COLOR16>(13 << 8), static_cast<COLOR16>(94 << 8),
         static_cast<COLOR16>(72 << 8), 0xff00},
    };
    GRADIENT_RECT gradient = {0, 1};
    GradientFill(dc, vertex, 2, &gradient, 1, GRADIENT_FILL_RECT_V);

    HICON icon = LoadIconW(g_instance, MAKEINTRESOURCEW(IDI_SETUP));
    if (icon) DrawIconEx(dc, px(28), px(34), icon, px(54), px(54), 0, nullptr, DI_NORMAL);

    RECT title{px(98), px(28), px(528), px(68)};
    draw_text(dc, L"在线互传", title, g_title_font, RGB(255, 255, 255),
              DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    RECT subtitle{px(100), px(70), px(528), px(98)};
    draw_text(dc, L"两台设备之间直接传文件，内容不经过服务器。", subtitle, g_font,
              RGB(214, 235, 226), DT_LEFT | DT_SINGLELINE | DT_VCENTER);

    RECT line{0, px(119), client.right, px(122)};
    fill_rect(dc, line, kAccent);
}

void draw_check(HDC dc, int cx, int cy, int radius, bool ok) {
    const COLORREF color = ok ? kAccent : kDanger;
    HBRUSH brush = CreateSolidBrush(color);
    HPEN pen = CreatePen(PS_SOLID, 1, color);
    HGDIOBJ old_brush = SelectObject(dc, brush);
    HGDIOBJ old_pen = SelectObject(dc, pen);
    Ellipse(dc, cx - radius, cy - radius, cx + radius, cy + radius);
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    DeleteObject(pen);
    DeleteObject(brush);

    HPEN white = CreatePen(PS_SOLID, px(3), RGB(255, 255, 255));
    HGDIOBJ old = SelectObject(dc, white);
    if (ok) {
        MoveToEx(dc, cx - radius / 2, cy, nullptr);
        LineTo(dc, cx - radius / 8, cy + radius / 2);
        LineTo(dc, cx + radius / 2, cy - radius / 2);
    } else {
        const int d = radius / 2;
        MoveToEx(dc, cx - d, cy - d, nullptr);
        LineTo(dc, cx + d, cy + d);
        MoveToEx(dc, cx + d, cy - d, nullptr);
        LineTo(dc, cx - d, cy + d);
    }
    SelectObject(dc, old);
    DeleteObject(white);
}

void draw_button(const DRAWITEMSTRUCT* item) {
    const bool primary = item->CtlID == kIdInstall || item->CtlID == kIdOpen ||
                         item->CtlID == kIdRetry;
    RECT rect = item->rcItem;
    HDC dc = item->hDC;
    fill_rect(dc, rect, kPage);

    POINT cursor = {};
    GetCursorPos(&cursor);
    ScreenToClient(item->hwndItem, &cursor);
    const bool hover = PtInRect(&rect, cursor) != FALSE;
    const bool pressed = (item->itemState & ODS_SELECTED) != 0;
    const bool disabled = (item->itemState & ODS_DISABLED) != 0;

    COLORREF fill = primary ? kAccent : kCard;
    COLORREF border = primary ? kAccentDark : kLine;
    COLORREF text = primary ? RGB(255, 255, 255) : kInk;
    if (primary && hover) fill = kAccentDark;
    if (!primary && hover) fill = kAccentSoft;
    if (pressed) fill = primary ? RGB(10, 78, 59) : RGB(217, 235, 226);
    if (disabled) {
        fill = RGB(236, 240, 238);
        border = RGB(224, 230, 227);
        text = RGB(150, 160, 155);
    }

    RECT body = rect;
    InflateRect(&body, -1, -1);
    fill_round(dc, body, px(10), fill, border);

    wchar_t label[64] = {};
    GetWindowTextW(item->hwndItem, label, static_cast<int>(std::size(label)));
    HGDIOBJ old = SelectObject(dc, g_button_font);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, text);
    DrawTextW(dc, label, -1, &rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SelectObject(dc, old);
    if ((item->itemState & ODS_FOCUS) && !disabled) {
        RECT focus = body;
        InflateRect(&focus, -px(4), -px(4));
        DrawFocusRect(dc, &focus);
    }
}

void draw_checkbox(const DRAWITEMSTRUCT* item) {
    HDC dc = item->hDC;
    RECT rect = item->rcItem;
    fill_rect(dc, rect, kCard);

    const bool checked = item->CtlID == kIdDesktop
                             ? g_desktop
                             : (item->CtlID == kIdAutostart ? g_autostart : g_sendto);
    POINT cursor = {};
    GetCursorPos(&cursor);
    ScreenToClient(item->hwndItem, &cursor);
    const bool hover = PtInRect(&rect, cursor) != FALSE;
    const int box = px(18);
    RECT mark{rect.left + px(4), rect.top + (rect.bottom - rect.top - box) / 2,
              rect.left + px(4) + box, rect.top + (rect.bottom - rect.top + box) / 2};
    fill_round(dc, mark, px(5), checked ? kAccent : kCard,
               checked ? kAccent : (hover ? kAccent : kLine));
    if (checked) {
        HPEN pen = CreatePen(PS_SOLID, px(2), RGB(255, 255, 255));
        HGDIOBJ old = SelectObject(dc, pen);
        const int cx = mark.left + box / 2;
        const int cy = mark.top + box / 2;
        MoveToEx(dc, cx - px(4), cy, nullptr);
        LineTo(dc, cx - px(1), cy + px(4));
        LineTo(dc, cx + px(5), cy - px(4));
        SelectObject(dc, old);
        DeleteObject(pen);
    }

    wchar_t label[128] = {};
    GetWindowTextW(item->hwndItem, label, static_cast<int>(std::size(label)));
    RECT text{mark.right + px(12), rect.top, rect.right - px(4), rect.bottom};
    HGDIOBJ old = SelectObject(dc, g_font);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, kInk);
    DrawTextW(dc, label, -1, &text, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SelectObject(dc, old);
    if (item->itemState & ODS_FOCUS) {
        RECT focus = mark;
        InflateRect(&focus, px(2), px(2));
        DrawFocusRect(dc, &focus);
    }
}

void toggle_check(int id) {
    if (id == kIdDesktop) {
        g_desktop = !g_desktop;
        InvalidateRect(g_desktop_check, nullptr, TRUE);
    } else if (id == kIdAutostart) {
        g_autostart = !g_autostart;
        InvalidateRect(g_autostart_check, nullptr, TRUE);
    } else if (id == kIdSendTo) {
        g_sendto = !g_sendto;
        InvalidateRect(g_sendto_check, nullptr, TRUE);
    }
}

LRESULT CALLBACK button_subclass(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam,
                                 UINT_PTR, DWORD_PTR) {
    if (message == WM_MOUSEMOVE || message == WM_MOUSELEAVE || message == WM_SETFOCUS ||
        message == WM_KILLFOCUS) {
        InvalidateRect(hwnd, nullptr, TRUE);
        if (message == WM_MOUSEMOVE) {
            TRACKMOUSEEVENT track = {sizeof(track), TME_LEAVE, hwnd, 0};
            TrackMouseEvent(&track);
        }
    }
    return DefSubclassProc(hwnd, message, wparam, lparam);
}

void layout_controls() {
    const bool options = g_screen == Screen::options;
    const bool working = g_screen == Screen::working;
    for (HWND check : {g_desktop_check, g_autostart_check, g_sendto_check}) {
        ShowWindow(check, options ? SW_SHOW : SW_HIDE);
    }
    ShowWindow(g_progress, working ? SW_SHOW : SW_HIDE);
    if (working) {
        ShowWindow(g_button_primary, SW_HIDE);
        ShowWindow(g_button_secondary, SW_HIDE);
        return;
    }

    ShowWindow(g_button_primary, SW_SHOW);
    ShowWindow(g_button_secondary, SW_SHOW);
    if (options) {
        SetWindowLongPtrW(g_button_primary, GWLP_ID, kIdInstall);
        SetWindowTextW(g_button_primary, L"安装");
        SetWindowLongPtrW(g_button_secondary, GWLP_ID, kIdCancel);
        SetWindowTextW(g_button_secondary, L"取消");
        SetWindowPos(g_button_primary, nullptr, px(404), px(376), px(132), px(40),
                     SWP_NOZORDER | SWP_NOACTIVATE);
        SetWindowPos(g_button_secondary, nullptr, px(288), px(376), px(104), px(40),
                     SWP_NOZORDER | SWP_NOACTIVATE);
    } else if (g_screen == Screen::success) {
        SetWindowLongPtrW(g_button_primary, GWLP_ID, kIdOpen);
        SetWindowTextW(g_button_primary, L"打开在线互传");
        SetWindowLongPtrW(g_button_secondary, GWLP_ID, kIdFinish);
        SetWindowTextW(g_button_secondary, L"完成");
        SetWindowPos(g_button_primary, nullptr, px(372), px(376), px(164), px(40),
                     SWP_NOZORDER | SWP_NOACTIVATE);
        SetWindowPos(g_button_secondary, nullptr, px(256), px(376), px(104), px(40),
                     SWP_NOZORDER | SWP_NOACTIVATE);
    } else {
        SetWindowLongPtrW(g_button_primary, GWLP_ID, kIdRetry);
        SetWindowTextW(g_button_primary, L"重试");
        SetWindowLongPtrW(g_button_secondary, GWLP_ID, kIdClose);
        SetWindowTextW(g_button_secondary, L"关闭");
        SetWindowPos(g_button_primary, nullptr, px(432), px(376), px(104), px(40),
                     SWP_NOZORDER | SWP_NOACTIVATE);
        SetWindowPos(g_button_secondary, nullptr, px(316), px(376), px(104), px(40),
                     SWP_NOZORDER | SWP_NOACTIVATE);
    }
    InvalidateRect(g_button_primary, nullptr, TRUE);
    InvalidateRect(g_button_secondary, nullptr, TRUE);
    SetFocus(g_button_primary);
}

void paint_window(HWND window) {
    PAINTSTRUCT paint = {};
    HDC dc = BeginPaint(window, &paint);
    RECT client = {};
    GetClientRect(window, &client);
    fill_rect(dc, client, kPage);
    draw_header(dc, client);

    RECT card{px(24), px(140), px(536), px(340)};
    fill_round(dc, card, px(14), kCard, kLine);

    if (g_screen == Screen::options) {
        RECT section{px(44), px(156), px(516), px(178)};
        draw_text(dc, L"安装选项", section, g_section_font, kMuted,
                  DT_LEFT | DT_SINGLELINE | DT_VCENTER);

        RECT box{px(40), px(282), px(520), px(330)};
        fill_round(dc, box, px(10), RGB(247, 250, 248), RGB(232, 238, 234));
        RECT label{px(54), px(288), px(506), px(306)};
        draw_text(dc, L"安装位置", label, g_small_font, kMuted,
                  DT_LEFT | DT_SINGLELINE | DT_VCENTER);
        RECT path{px(54), px(306), px(506), px(326)};
        const std::wstring target = install_dir().wstring();
        draw_text(dc, target.c_str(), path, g_font, kInk,
                  DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

        RECT status{px(24), px(350), px(536), px(370)};
        draw_text(dc, L"点「安装」开始。安装到当前用户目录，不需要管理员权限。", status,
                  g_small_font, kMuted, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    } else if (g_screen == Screen::working) {
        RECT title{px(24), px(196), px(536), px(230)};
        draw_text(dc, L"正在安装…", title, g_title_font, kInk,
                  DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        RECT body{px(60), px(236), px(500), px(280)};
        draw_text(dc, L"正在释放程序、创建快捷方式和登记卸载信息。", body, g_font, kMuted,
                  DT_CENTER | DT_WORDBREAK);
    } else if (g_screen == Screen::success) {
        draw_check(dc, px(280), px(182), px(26), true);
        RECT title{px(24), px(220), px(536), px(252)};
        draw_text(dc, L"安装完成", title, g_title_font, kInk,
                  DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        RECT body{px(56), px(258), px(504), px(290)};
        draw_text(dc, L"在线互传已准备好，可以开始配对和传文件了。", body, g_font, kMuted,
                  DT_CENTER | DT_WORDBREAK);
        RECT path{px(56), px(298), px(504), px(320)};
        const std::wstring target = L"安装位置：" + install_dir().wstring();
        draw_text(dc, target.c_str(), path, g_small_font, kMuted,
                  DT_CENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
    } else {
        draw_check(dc, px(280), px(182), px(26), false);
        RECT title{px(24), px(220), px(536), px(252)};
        draw_text(dc, L"安装没有完成", title, g_title_font, kInk,
                  DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        RECT body{px(56), px(258), px(504), px(324)};
        draw_text(dc, g_install_error.empty() ? L"未知错误。请重试，或查看安装日志。" :
                                                   g_install_error.c_str(),
                  body, g_font, kMuted, DT_CENTER | DT_WORDBREAK | DT_END_ELLIPSIS);
    }

    RECT footer{px(24), px(424), px(536), px(442)};
    draw_text(dc, L"v0.1.0  ·  当前用户安装  ·  不需要管理员权限", footer, g_small_font, kMuted,
              DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    EndPaint(window, &paint);
}

void start_install(HWND window) {
    g_screen = Screen::working;
    g_install_error.clear();
    layout_controls();
    InvalidateRect(window, nullptr, TRUE);
    UpdateWindow(window);

    std::wstring error;
    const bool ok = install(&error);
    if (!ok && (error.find(L"建不了安装目录") != std::wstring::npos ||
                error.find(L"写不进") != std::wstring::npos)) {
        error += L"\n请换一个有写入权限的位置，或关闭后用默认目录重试。";
    }
    g_install_error = error;
    g_screen = ok ? Screen::success : Screen::error;
    layout_controls();
    InvalidateRect(window, nullptr, TRUE);
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT:
            paint_window(window);
            return 0;
        case WM_CTLCOLORBTN: {
            HDC dc = reinterpret_cast<HDC>(wparam);
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, kInk);
            SetBkColor(dc, kCard);
            return reinterpret_cast<LRESULT>(g_card_brush);
        }
        case WM_DRAWITEM: {
            const auto* item = reinterpret_cast<const DRAWITEMSTRUCT*>(lparam);
            if (item && item->CtlType == ODT_BUTTON) {
                if (item->CtlID == kIdDesktop || item->CtlID == kIdAutostart ||
                    item->CtlID == kIdSendTo) {
                    draw_checkbox(item);
                } else {
                    draw_button(item);
                }
            }
            return TRUE;
        }
        case WM_COMMAND: {
            if (HIWORD(wparam) != BN_CLICKED) return 0;
            switch (LOWORD(wparam)) {
                case kIdDesktop:
                    toggle_check(kIdDesktop);
                    return 0;
                case kIdAutostart:
                    toggle_check(kIdAutostart);
                    return 0;
                case kIdSendTo:
                    toggle_check(kIdSendTo);
                    return 0;
                case kIdInstall:
                    start_install(window);
                    return 0;
                case kIdCancel:
                case kIdFinish:
                case kIdClose:
                    DestroyWindow(window);
                    return 0;
                case kIdRetry:
                    g_screen = Screen::options;
                    g_install_error.clear();
                    layout_controls();
                    InvalidateRect(window, nullptr, TRUE);
                    return 0;
                case kIdOpen: {
                    const fs::path tray = install_dir() / L"p2p-tray.exe";
                    ShellExecuteW(nullptr, L"open", tray.c_str(), L"--show",
                                  install_dir().c_str(), SW_SHOWNORMAL);
                    DestroyWindow(window);
                    return 0;
                }
                default:
                    return 0;
            }
        }
        case WM_CLOSE:
            if (g_screen == Screen::working) return 0;
            DestroyWindow(window);
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            break;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

void create_fonts() {
    g_dpi = GetDpiForSystem();
    const auto face = L"Microsoft YaHei UI";
    const auto make = [face](int height, int weight) {
        return CreateFontW(-height, 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                           OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_DONTCARE, face);
    };
    g_font = make(px(14), FW_NORMAL);
    g_title_font = make(px(27), FW_SEMIBOLD);
    g_section_font = make(px(12), FW_SEMIBOLD);
    g_small_font = make(px(11), FW_NORMAL);
    g_button_font = make(px(14), FW_SEMIBOLD);
    g_page_brush = CreateSolidBrush(kPage);
    g_card_brush = CreateSolidBrush(kCard);
}

HWND make_check(HWND parent, const wchar_t* text, int id, int x, int y, int w, int h,
                bool checked) {
    HWND control = CreateWindowExW(0, L"BUTTON", text, WS_CHILD | WS_VISIBLE | BS_OWNERDRAW,
                                   x, y, w, h, parent,
                                   reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), g_instance,
                                   nullptr);
    SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(g_font), TRUE);
    SendMessageW(control, BM_SETCHECK, checked ? BST_CHECKED : BST_UNCHECKED, 0);
    SetWindowSubclass(control, button_subclass, 3, 0);
    return control;
}

bool show_installer() {
    WNDCLASSW cls = {};
    cls.lpfnWndProc = window_proc;
    cls.hInstance = g_instance;
    cls.lpszClassName = L"P2PShareSetup";
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    cls.hIcon = LoadIconW(g_instance, MAKEINTRESOURCEW(IDI_SETUP));
    cls.hbrBackground = nullptr;
    RegisterClassW(&cls);
    create_fonts();

    const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;
    RECT frame = {0, 0, px(560), px(450)};
    AdjustWindowRectEx(&frame, style, FALSE, WS_EX_APPWINDOW);
    const int width = frame.right - frame.left;
    const int height = frame.bottom - frame.top;
    RECT work = {};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    const int x = work.left + ((work.right - work.left) - width) / 2;
    const int y = work.top + ((work.bottom - work.top) - height) / 2;

    g_window = CreateWindowExW(WS_EX_APPWINDOW, cls.lpszClassName, L"在线互传 安装程序", style,
                               x, y, width, height, nullptr, nullptr, g_instance, nullptr);
    if (!g_window) return false;

    g_desktop_check = make_check(g_window, L"创建桌面快捷方式", kIdDesktop, px(44), px(188),
                                 px(460), px(26), g_desktop);
    g_autostart_check = make_check(g_window, L"开机时自动启动（安静驻留托盘）", kIdAutostart,
                                   px(44), px(218), px(460), px(26), g_autostart);
    g_sendto_check = make_check(g_window, L"加入资源管理器「发送到」菜单", kIdSendTo, px(44),
                                px(248), px(460), px(26), g_sendto);

    g_progress = CreateWindowExW(0, PROGRESS_CLASSW, nullptr, WS_CHILD | PBS_MARQUEE, px(24),
                                 px(356), px(512), px(6), g_window, nullptr, g_instance, nullptr);
    SendMessageW(g_progress, PBM_SETMARQUEE, TRUE, 30);
    ShowWindow(g_progress, SW_HIDE);

    g_button_primary = CreateWindowExW(
        0, L"BUTTON", L"安装", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, g_window,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(kIdInstall)), g_instance, nullptr);
    g_button_secondary = CreateWindowExW(
        0, L"BUTTON", L"取消", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, g_window,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(kIdCancel)), g_instance, nullptr);
    SendMessageW(g_button_primary, WM_SETFONT, reinterpret_cast<WPARAM>(g_button_font), TRUE);
    SendMessageW(g_button_secondary, WM_SETFONT, reinterpret_cast<WPARAM>(g_button_font), TRUE);
    SetWindowSubclass(g_button_primary, button_subclass, 1, 0);
    SetWindowSubclass(g_button_secondary, button_subclass, 2, 0);

    layout_controls();
    ShowWindow(g_window, SW_SHOW);
    UpdateWindow(g_window);

    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0)) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return true;
}

int show_task_dialog(const wchar_t* main_instruction, const wchar_t* content,
                     const TASKDIALOG_BUTTON* buttons, UINT button_count, UINT common_buttons,
                     PCWSTR icon, DWORD extra_flags = 0) {
    TASKDIALOGCONFIG config = {};
    config.cbSize = sizeof(config);
    config.hwndParent = g_window;
    config.hInstance = g_instance;
    config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW |
                     extra_flags;
    config.dwCommonButtons = common_buttons;
    config.pszWindowTitle = kAppName;
    config.pszMainInstruction = main_instruction;
    config.pszContent = content;
    config.pszFooter = L"P2P Share  ·  当前用户安装，不需要管理员权限";
    config.pszMainIcon = icon;
    config.pButtons = buttons;
    config.cButtons = button_count;
    config.nDefaultButton = button_count > 0 ? buttons[0].nButtonID : IDOK;
    int pressed = 0;
    if (FAILED(TaskDialogIndirect(&config, &pressed, nullptr, nullptr))) return 0;
    return pressed;
}

void show_task_error(const wchar_t* main_instruction, const std::wstring& detail) {
    TASKDIALOG_BUTTON close[] = {{IDOK, L"关闭"}};
    show_task_dialog(main_instruction, detail.c_str(), close, 1, 0, TD_ERROR_ICON);
}

void uninstall_interactive() {
    TASKDIALOG_BUTTON confirm[] = {{100, L"卸载"}, {IDCANCEL, L"取消"}};
    int choice = show_task_dialog(
        L"卸载在线互传？",
        L"程序会从这台电脑移除。配对身份和传输记录默认保留，重新安装后还能继续用。",
        confirm, 2, 0, TD_WARNING_ICON);
    if (choice != 100) return;

    TASKDIALOG_BUTTON data[] = {
        {200, L"保留数据（推荐）\n重新安装后还能继续用原有的身份和配对关系"},
        {201, L"一并删除\n身份、联系人和传输记录都会清掉，无法恢复"},
    };
    choice = show_task_dialog(
        L"要删除本机数据吗？",
        L"这些数据只保存在这台电脑上，不会上传到服务器。",
        data, 2, 0, TD_INFORMATION_ICON, TDF_USE_COMMAND_LINKS);
    if (choice == 0 || choice == IDCANCEL) return;
    g_purge = choice == 201;

    std::wstring error;
    if (!uninstall(&error)) {
        show_task_error(L"卸载没有完成", error);
        return;
    }
    TASKDIALOG_BUTTON done[] = {{IDOK, L"完成"}};
    show_task_dialog(L"已卸载", L"在线互传已从这台电脑移除。", done, 1, 0,
                     TD_INFORMATION_ICON);
}

}  // namespace

int wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
    g_instance = instance;
    using DpiFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
    if (HMODULE user32 = GetModuleHandleW(L"user32.dll")) {
        if (auto fn = reinterpret_cast<DpiFn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"))) {
            fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }
    INITCOMMONCONTROLSEX controls = {sizeof(controls),
                                     ICC_STANDARD_CLASSES | ICC_PROGRESS_CLASS | ICC_WIN95_CLASSES};
    InitCommonControlsEx(&controls);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    wchar_t temp[MAX_PATH] = {};
    const DWORD temp_len = GetTempPathW(MAX_PATH, temp);
    g_log_path = fs::path(std::wstring(temp, temp_len)) / L"p2p-setup.log";
    log_line(L"---- 安装器启动 ----");

    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i < argc; ++i) {
        const std::wstring flag = argv[i];
        if (flag == L"--silent") {
            g_silent = true;
        } else if (flag == L"--uninstall") {
            g_uninstall_mode = true;
        } else if (flag == L"--purge") {
            g_purge = true;
        } else if (flag == L"--dir" && i + 1 < argc) {
            g_dir_override = fs::path(argv[++i]);
        } else if (flag == L"--desktop") {
            g_desktop = true;
        } else if (flag == L"--no-desktop") {
            g_desktop = false;
        } else if (flag == L"--autostart") {
            g_autostart = true;
        } else if (flag == L"--sendto") {
            g_sendto = true;
        } else if (flag == L"--no-sendto") {
            g_sendto = false;
        }
    }
    if (argv) LocalFree(argv);

    if (g_silent) {
        // 静默安装的默认值更保守：不建桌面图标、不开自启
        if (!g_uninstall_mode) {
            g_desktop = false;
            g_autostart = false;
        }
        std::wstring error;
        const bool ok = g_uninstall_mode ? uninstall(&error) : install(&error);
        if (!ok) {
            log_line(L"静默失败：" + error);
            CoUninitialize();
            return 1;
        }
        CoUninitialize();
        return 0;
    }

    if (g_uninstall_mode) {
        uninstall_interactive();
        CoUninitialize();
        return 0;
    }

    if (!show_installer()) {
        show_task_error(L"安装界面没有起来", L"请重新运行安装包；如果仍然失败，查看 %TEMP%\\p2p-setup.log。");
        CoUninitialize();
        return 1;
    }
    CoUninitialize();
    return 0;
}
