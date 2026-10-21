#pragma once
// 桌面顶部的悬浮小组件。
//
// 干什么用的：正在传东西的时候，在桌面顶部显示进度，并且接受拖进来的文件。
// 空闲时收起来，常驻一个悬浮窗在桌面上是骚扰。
//
// 为什么不用 WebView2 再开一个：这是长期挂在桌面上的东西，为它常驻一个
// Chromium 实例（几十 MB 内存 + 一组进程）不划算。自绘多写点代码，但轻。
//
// 三个窗口样式各有原因：
//   WS_EX_TOPMOST    一直在最前，不被人挡住
//   WS_EX_TOOLWINDOW 不出现在 Alt+Tab 里
//   WS_EX_NOACTIVATE 鼠标点它不抢焦点，否则用户正在别处打字会被打断
#include <windows.h>

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

namespace shell {

class Overlay {
public:
    /** 拖文件进来时回调。参数是拖进来的路径。 */
    using DropHandler = std::function<void(const std::vector<std::filesystem::path>&)>;

    ~Overlay();

    bool create(HINSTANCE instance, DropHandler on_drop);
    void destroy();

    /** 更新一条传输的进度。完成后会自己安排收起。 */
    void update(const std::string& id, const std::string& name, uint64_t done, uint64_t total,
                bool incoming);
    /** 一句话提示（比如"已收到 3 个文件"），显示几秒后收起 */
    void flash(const std::wstring& text);
    /** 顶部那行字，通常是"拖到这里发给 XXX" */
    void set_hint(const std::wstring& text);

    bool visible() const { return visible_; }

private:
    struct Row {
        std::string id;
        std::string name;
        uint64_t done = 0;
        uint64_t total = 0;
        bool incoming = false;
        bool finished = false;
    };

    static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam);
    LRESULT handle(UINT message, WPARAM wparam, LPARAM lparam);
    void layout();
    void paint(HDC dc);
    void schedule_hide(int after_ms);

    HWND window_ = nullptr;
    HINSTANCE instance_ = nullptr;
    DropHandler on_drop_;
    std::vector<Row> rows_;
    std::wstring hint_ = L"拖到这里发送";
    std::wstring flash_;
    bool visible_ = false;
    int dpi_ = 96;
};

}  // namespace shell
