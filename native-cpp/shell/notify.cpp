#include "notify.h"

#include <shellapi.h>
#include <shlobj.h>
#include <mmsystem.h>

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <vector>

namespace shell {
namespace {

/**
 * 可选提示音。顺序就是界面上显示的顺序。
 *
 * 只挑系统自带的那几个：自己塞一个 wav 进包里当然也行，但那样就得考虑
 * 版权和包体积，而且用户换了一台机器听到的还是同一份；用系统的文件反而
 * 让"这一声听起来像 Windows"这件事保持自然。
 */
const SoundEntry kSounds[] = {
    {NotifySound::Balloon, "balloon", L"Windows Balloon.wav", L"老式气泡（默认）"},
    {NotifySound::Ding, "ding", L"ding.wav", L"叮（最短）"},
    {NotifySound::Popup, "popup", L"Windows Pop-up Blocked.wav", L"轻弹"},
    {NotifySound::Background, "background", L"Windows Background.wav", L"轻背景音"},
    {NotifySound::Notify, "notify", L"Windows Notify.wav", L"旧版通知"},
    {NotifySound::System, "system", nullptr, L"跟随系统设置"},
    {NotifySound::Silent, "silent", nullptr, L"静音"},
};

/** 系统自带的音效文件都在 %SystemRoot%\Media 下 */
std::wstring media_file(const wchar_t* name) {
    if (!name) return {};
    wchar_t root[MAX_PATH] = {};
    const DWORD len = GetWindowsDirectoryW(root, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return {};
    std::filesystem::path path(root);
    path /= L"Media";
    path /= name;
    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) return {};
    return path.wstring();
}

/**
 * 读 wav 头算时长。
 *
 * 界面上要标出"这一声多长"，因为有人就是嫌默认那声太长。与其写死一个
 * 数字（换台机器就对不上了），不如读文件头算：data 块大小除以字节率。
 * 只处理标准 PCM 的 RIFF 布局，别的格式返回 0，界面那边显示成"—"。
 */
double wav_seconds(const std::wstring& path) {
    FILE* file = _wfopen(path.c_str(), L"rb");
    if (!file) return 0;
    unsigned char header[12] = {};
    if (fread(header, 1, sizeof(header), file) != sizeof(header) ||
        std::memcmp(header, "RIFF", 4) != 0 || std::memcmp(header + 8, "WAVE", 4) != 0) {
        fclose(file);
        return 0;
    }
    double seconds = 0;
    unsigned char chunk[8] = {};
    while (fread(chunk, 1, sizeof(chunk), file) == sizeof(chunk)) {
        const DWORD size = static_cast<DWORD>(chunk[4]) | (static_cast<DWORD>(chunk[5]) << 8) |
                           (static_cast<DWORD>(chunk[6]) << 16) |
                           (static_cast<DWORD>(chunk[7]) << 24);
        if (std::memcmp(chunk, "fmt ", 4) == 0 && size >= 16) {
            unsigned char fmt[16] = {};
            if (fread(fmt, 1, sizeof(fmt), file) != sizeof(fmt)) break;
            const DWORD byte_rate = static_cast<DWORD>(fmt[8]) |
                                    (static_cast<DWORD>(fmt[9]) << 8) |
                                    (static_cast<DWORD>(fmt[10]) << 16) |
                                    (static_cast<DWORD>(fmt[11]) << 24);
            if (byte_rate > 0) {
                // 只记下字节率，等读到 data 块再算
                fseek(file, static_cast<long>(size) - 16 + (size % 2), SEEK_CUR);
                unsigned char next[8] = {};
                while (fread(next, 1, sizeof(next), file) == sizeof(next)) {
                    const DWORD inner = static_cast<DWORD>(next[4]) |
                                        (static_cast<DWORD>(next[5]) << 8) |
                                        (static_cast<DWORD>(next[6]) << 16) |
                                        (static_cast<DWORD>(next[7]) << 24);
                    if (std::memcmp(next, "data", 4) == 0) {
                        seconds = static_cast<double>(inner) / static_cast<double>(byte_rate);
                        break;
                    }
                    fseek(file, static_cast<long>(inner) + (inner % 2), SEEK_CUR);
                }
            }
            break;
        }
        fseek(file, static_cast<long>(size) + (size % 2), SEEK_CUR);
    }
    fclose(file);
    return seconds;
}

/**
 * 现在方不方便出声。
 *
 * 必须自己判断：我们是用 PlaySound 自己放的，绕过了通知平台，所以用户在
 * 专注助手里关掉通知、或者正在全屏放演示，我们照样会响，那就很讨厌了。
 * 系统这一层的开关只有 SHQueryUserNotificationState 能问到。
 */
bool noise_is_welcome() {
    QUERY_USER_NOTIFICATION_STATE state = QUNS_ACCEPTS_NOTIFICATIONS;
    if (FAILED(SHQueryUserNotificationState(&state))) return true;
    // QUNS_APP 是"当前前台应用自己发的通知"，也算可以出声。
    // 其余（专注助手、演示模式、全屏独占、忙碌）一律安静。
    return state == QUNS_ACCEPTS_NOTIFICATIONS || state == QUNS_APP;
}

}  // namespace

const SoundEntry* notify_sounds(size_t* count) {
    if (count) *count = sizeof(kSounds) / sizeof(kSounds[0]);
    return kSounds;
}

const SoundEntry& sound_entry(NotifySound sound) {
    for (const auto& entry : kSounds) {
        if (entry.id == sound) return entry;
    }
    return kSounds[0];
}

NotifySound sound_from_name(const std::string& name) {
    for (const auto& entry : kSounds) {
        if (name == entry.name) return entry.id;
    }
    return NotifySound::Balloon;
}

const char* sound_name(NotifySound sound) { return sound_entry(sound).name; }

double sound_seconds(NotifySound sound) {
    const auto& entry = sound_entry(sound);
    if (!entry.file) return 0;
    const std::wstring path = media_file(entry.file);
    return path.empty() ? 0 : wav_seconds(path);
}

void play(NotifySound sound) {
    if (sound == NotifySound::Silent) return;
    // 我们这一声是自己放的，绕过了通知平台，所以专注助手、演示模式、全屏独占
    // 都得自己让路，否则用户在开会或者放幻灯片的时候会被我们打断。
    if (!noise_is_welcome()) return;
    if (sound == NotifySound::System) {
        MessageBeep(MB_ICONASTERISK);
        return;
    }

    const std::wstring path = media_file(sound_entry(sound).file);
    if (path.empty()) {
        // 文件不在了（精简版系统会删掉 Media 目录），退化成系统提示音。
        // 不放声音不该让调用方失败，所以这里不抛异常。
        MessageBeep(MB_ICONASTERISK);
        return;
    }
    // SND_ASYNC：不能阻塞调用线程，通知是顺手做的事。
    // SND_NODEFAULT：文件读不出来时保持安静，不要替我放系统默认那声。
    // SND_SYSTEM：把这一声归到"系统通知声音"那个音频会话，音量合成器里
    //             调系统声音就能控制它，不会混进应用自己的音量里。
    PlaySoundW(path.c_str(), nullptr, SND_FILENAME | SND_ASYNC | SND_NODEFAULT | SND_SYSTEM);
}

bool Tray::install(HWND owner, UINT callback_message, const std::wstring& tip, HICON icon) {
    owner_ = owner;
    callback_ = callback_message;
    tip_ = tip;
    icon_ = icon ? icon : LoadIconW(nullptr, IDI_APPLICATION);
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = owner;
    data.uID = id_;
    data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    data.uCallbackMessage = callback_message;
    data.hIcon = icon_;
    // szTip 定长 128，超出会被截断，先截好再拷
    const std::wstring trimmed = tip.size() > 120 ? tip.substr(0, 120) : tip;
    lstrcpynW(data.szTip, trimmed.c_str(), ARRAYSIZE(data.szTip));

    installed_ = Shell_NotifyIconW(NIM_ADD, &data) != FALSE;
    if (installed_) {
        // 版本 4 才会把鼠标坐标和事件分开放在 wParam/lParam 里，
        // 也才会有 NIN_BALLOONSHOW 这类气泡生命周期事件。
        data.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &data);
    }
    return installed_;
}

bool Tray::reinstall() {
    if (!owner_) return false;
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = owner_;
    data.uID = id_;
    data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    data.uCallbackMessage = callback_;
    data.hIcon = icon_ ? icon_ : LoadIconW(nullptr, IDI_APPLICATION);
    const std::wstring trimmed = tip_.size() > 120 ? tip_.substr(0, 120) : tip_;
    lstrcpynW(data.szTip, trimmed.c_str(), ARRAYSIZE(data.szTip));
    installed_ = Shell_NotifyIconW(NIM_ADD, &data) != FALSE;
    if (installed_) {
        data.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &data);
    }
    return installed_;
}

void Tray::remove() {
    if (!installed_) return;
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = owner_;
    data.uID = id_;
    Shell_NotifyIconW(NIM_DELETE, &data);
    installed_ = false;
}

void Tray::set_tip(const std::wstring& tip) {
    tip_ = tip;
    if (!installed_) return;
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = owner_;
    data.uID = id_;
    data.uFlags = NIF_TIP;
    const std::wstring trimmed = tip.size() > 120 ? tip.substr(0, 120) : tip;
    lstrcpynW(data.szTip, trimmed.c_str(), ARRAYSIZE(data.szTip));
    Shell_NotifyIconW(NIM_MODIFY, &data);
}

void Tray::set_icon(HICON icon) {
    if (!installed_ || !icon) return;
    icon_ = icon;
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = owner_;
    data.uID = id_;
    data.uFlags = NIF_ICON;
    data.hIcon = icon;
    Shell_NotifyIconW(NIM_MODIFY, &data);
}

bool Tray::send_balloon(const std::wstring& title, const std::wstring& text,
                        bool play_system_sound) {
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = owner_;
    data.uID = id_;
    data.uFlags = NIF_INFO;
    // szInfo 上限 256、szInfoTitle 上限 64（含结尾的 \0），先自己截断
    lstrcpynW(data.szInfo, (text.size() > 240 ? text.substr(0, 240) : text).c_str(),
              ARRAYSIZE(data.szInfo));
    lstrcpynW(data.szInfoTitle, (title.size() > 56 ? title.substr(0, 56) : title).c_str(),
              ARRAYSIZE(data.szInfoTitle));
    // uTimeout 和 uVersion 是同一个 union！装图标时写的是 uVersion，这里必须
    // 重新写 uTimeout。留着 0 全靠系统"当默认 10 秒处理"，有些环境下 0 会被
    // 当成无效值，气泡直接不显示——这就是"只听到声音、看不到通知"的常见原因。
    data.uTimeout = 10000;
    // 刻意不加 NIIF_RESPECT_QUIET_TIME：那一档会在免打扰时段（Windows 默认
    // 22:00-07:00 就属于免打扰）把气泡整条压掉，而我们的提示音是绕过通知平台
    // 自己 PlaySound 放的。结果就是"半夜收到文件只有一声响、什么都没有"——
    // 这正是用户报的那个问题。宁可在免打扰时段也弹出来，也不要让它悄悄消失：
    // 声音那侧已经由 noise_is_welcome() 把关了。
    data.dwInfoFlags = 0;
    // NIIF_USER 表示用 hBalloonIcon。不带 NIIF_LARGE_ICON：那一位要求图标是
    // SM_CXICON 的大图标，而我们手上只有 SM_CXSMICON 的，尺寸对不上时
    // Win10/11 会干脆不弹这个气泡。
    if (icon_) {
        data.dwInfoFlags |= NIIF_USER;
        data.hBalloonIcon = icon_;
    }
    if (!play_system_sound) data.dwInfoFlags |= NIIF_NOSOUND;
    return Shell_NotifyIconW(NIM_MODIFY, &data) != FALSE;
}

bool Tray::balloon(const std::wstring& title, const std::wstring& text,
                   bool play_system_sound) {
    if (!installed_) return false;
    if (send_balloon(title, text, play_system_sound)) return true;
    // 走到这里说明图标不在托盘里了：最常见的是资源管理器重启过（图标全没了，
    // 但 installed_ 还是 true）。重装一次再发，还失败就承认失败，让调用方去记日志。
    if (!reinstall()) return false;
    return send_balloon(title, text, play_system_sound);
}

bool Tray::notify(const std::wstring& title, const std::wstring& text, NotifySound sound) {
    // 系统那声一律压掉，声音由我们自己放。不压的话会出现两声：
    // 先是系统按它自己的方案放的那声，紧接着才是我们的。
    const bool ok = balloon(title, text, false);
    play(sound);
    return ok;
}

}  // namespace shell
