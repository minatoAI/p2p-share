#pragma once
// 托盘图标与气泡通知。
//
// 为什么用 Shell_NotifyIcon 的 NIF_INFO 气泡而不是 WinRT 的 Toast：
//   1. 免注册。Toast 要求先注册一个 AppUserModelID，还要往开始菜单放一个带
//      该属性的快捷方式，系统才认这个应用；气泡什么都不用，有窗口句柄就行。
//   2. 声音可控。dwInfoFlags 里加 NIIF_NOSOUND 就把系统那声压掉了，
//      然后自己用 PlaySound 放指定的 wav，放什么完全由我们定。
//      Toast 那条路只能填 ms-winsoundevent 里固定那几个系统事件；
//      想放自己的音效文件（ms-appx:///）必须有 MSIX 包标识，未打包应用做不到。
//   3. 发的时机简单，设备上线、文件收完，一句话的事。
//
// 代价是 Win11 上气泡是"临时横幅"，消失后不进通知中心。对这个产品够了。
// 实测：本机 Win11 25H2（26200）上气泡能正常弹出，声音也是我们自己放的那个。
#include <windows.h>

#include <string>

namespace shell {

/** 提示音。每一项对应一个系统自带的 wav，或者静音、跟随系统。 */
enum class NotifySound {
    Silent,
    Balloon,
    Ding,
    Popup,
    Background,
    Notify,
    System,
};

struct SoundEntry {
    NotifySound id;
    /** 配置文件里存的名字 */
    const char* name;
    /** 音效文件名，在 %SystemRoot%\Media 下。空表示不用文件（静音或跟随系统） */
    const wchar_t* file;
    /** 界面上显示的中文名 */
    const wchar_t* label;
};

/** 所有可选的提示音。界面上的列表就用它，免得两边各写一份对不上。 */
const SoundEntry* notify_sounds(size_t* count);

const SoundEntry& sound_entry(NotifySound sound);
NotifySound sound_from_name(const std::string& name);
const char* sound_name(NotifySound sound);
/** 这个音效实际有多长（秒）。文件不在或读不出头就返回 0。 */
double sound_seconds(NotifySound sound);

/** 放一声。找不到 wav 文件就退化成系统提示音，不放声音不该让流程出错。 */
void play(NotifySound sound);

class Tray {
public:
    /** 装图标。callback_message 是图标上鼠标事件发回 owner 的消息号。 */
    bool install(HWND owner, UINT callback_message, const std::wstring& tip, HICON icon);
    void remove();
    void set_tip(const std::wstring& tip);
    /** 换图标（比如加一个"还没配置完"的小圆点）。不换提示文字。 */
    void set_icon(HICON icon);

    /**
     * 弹一个气泡。
     *
     * play_system_sound 为 false 时加 NIIF_NOSOUND，把系统那声压掉，
     * 由调用方自己决定放不放、放哪一声（见 play）。
     * 默认同时带上 NIIF_RESPECT_QUIET_TIME，不要在别人刚装完系统的那一小时里
     * 跳出来。
     */
    bool balloon(const std::wstring& title, const std::wstring& text, bool play_system_sound);

    /**
     * 一次到位：弹气泡并按设置放声音。
     *
     * 声音不是交给系统播的，是我们自己压掉系统声音再放自己的，
     * 这样同一个通知在别人机器上听起来的差别只有 wav 文件本身。
     */
    bool notify(const std::wstring& title, const std::wstring& text, NotifySound sound);

    bool installed() const { return installed_; }

private:
    /** 真去发一次 NIF_INFO。boot 的是 balloon() 的重试逻辑，不是它的调用方。 */
    bool send_balloon(const std::wstring& title, const std::wstring& text,
                      bool play_system_sound);
    /** 图标丢了就按记下来的参数重装一次。资源管理器重启之后要靠它。 */
    bool reinstall();

    HWND owner_ = nullptr;
    HICON icon_ = nullptr;
    UINT id_ = 1;
    /** 装图标时用的回调消息和提示文字，重装时要原样再传一遍 */
    UINT callback_ = 0;
    std::wstring tip_;
    bool installed_ = false;
};

}  // namespace shell
