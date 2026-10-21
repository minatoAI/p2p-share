#include "overlay.h"

#include <shellapi.h>

#include <algorithm>
#include <cstdio>

namespace shell {
namespace {

constexpr wchar_t kOverlayClass[] = L"P2PLighthouseOverlay";
constexpr int kHideTimer = 1;
constexpr int kFlashTimer = 2;
constexpr size_t kMaxRows = 5;
constexpr int kBaseWidth = 360;
constexpr int kRowHeight = 30;
constexpr int kHeaderHeight = 44;
constexpr int kPad = 14;

int scale(int value, int dpi) { return MulDiv(value, dpi, 96); }

std::wstring widen_utf8(const std::string& text) {
    if (text.empty()) return {};
    const int need = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                         nullptr, 0);
    if (need <= 0) return {};
    std::wstring out(static_cast<size_t>(need), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), need);
    return out;
}

/** 0.5 秒的人话版本：3.2 MB/s、12 秒 */
std::wstring human_bytes(uint64_t bytes) {
    wchar_t buffer[64] = {};
    if (bytes >= 1024ull * 1024 * 1024) {
        swprintf(buffer, 64, L"%.1f GB", static_cast<double>(bytes) / (1024.0 * 1024 * 1024));
    } else if (bytes >= 1024 * 1024) {
        swprintf(buffer, 64, L"%.1f MB", static_cast<double>(bytes) / (1024.0 * 1024));
    } else if (bytes >= 1024) {
        swprintf(buffer, 64, L"%.0f KB", static_cast<double>(bytes) / 1024.0);
    } else {
        swprintf(buffer, 64, L"%llu B", static_cast<unsigned long long>(bytes));
    }
    return buffer;
}

/** 过长的文件名从中间截断，尾部（扩展名那一段）留住 */
std::wstring elide(const std::wstring& text, size_t limit) {
    if (text.size() <= limit) return text;
    const size_t head = limit / 2;
    const size_t tail = limit - head - 1;
    return text.substr(0, head) + L"…" + text.substr(text.size() - tail);
}

}  // namespace

Overlay::~Overlay() { destroy(); }

bool Overlay::create(HINSTANCE instance, DropHandler on_drop) {
    instance_ = instance;
    on_drop_ = std::move(on_drop);

    WNDCLASSW wc = {};
    wc.lpfnWndProc = &Overlay::window_proc;
    wc.hInstance = instance;
    wc.lpszClassName = kOverlayClass;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = nullptr;  // 自己画，不要系统刷背景（会闪）
    RegisterClassW(&wc);

    // WS_POPUP：没有标题栏。剩下的样式见头文件里的说明。
    window_ = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kOverlayClass,
                              L"", WS_POPUP, 0, 0, kBaseWidth, kHeaderHeight, nullptr, nullptr,
                              instance, this);
    if (!window_) {
        // 建不起来的时候把系统给的原因说出来，不然只有一个"没成"没法查
        std::fprintf(stderr, "[悬浮] CreateWindowEx 失败，GetLastError=%lu\n", GetLastError());
        return false;
    }
    DragAcceptFiles(window_, TRUE);
    set_hint(hint_);
    return true;
}

void Overlay::destroy() {
    if (!window_) return;
    DragAcceptFiles(window_, FALSE);
    DestroyWindow(window_);
    window_ = nullptr;
}

void Overlay::set_hint(const std::wstring& text) {
    hint_ = text;
    if (window_ && visible_) {
        layout();
        InvalidateRect(window_, nullptr, FALSE);
    }
}

void Overlay::layout() {
    if (!window_) return;
    dpi_ = 96;
    // GetDpiForWindow 是 Win10 1607+ 的，拿不到就按 96 算
    if (HMODULE user32 = GetModuleHandleW(L"user32.dll")) {
        using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
        if (auto fn = reinterpret_cast<GetDpiForWindowFn>(
                GetProcAddress(user32, "GetDpiForWindow"))) {
            const UINT value = fn(window_);
            if (value >= 72) dpi_ = static_cast<int>(value);
        }
    }

    const size_t count = std::min(rows_.size(), kMaxRows);
    const int width = scale(kBaseWidth, dpi_);
    const int height = scale(kHeaderHeight, dpi_) +
                       (count ? static_cast<int>(count) * scale(kRowHeight, dpi_) : 0) +
                       scale(kPad, dpi_);

    // 位置：右下角，贴着工作区右下，也就是系统通知弹出来的那一带。
    //
    // 注意「置顶」和「位置」是两件事：置顶说的是重叠次序（WS_EX_TOPMOST 和
    // HWND_TOPMOST 管的就是这个），和摆在屏幕哪个角没有关系。
    RECT work = {};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    const int margin = scale(12, dpi_);
    const int x = work.right - width - margin;
    const int y = work.bottom - height - margin;
    SetWindowPos(window_, HWND_TOPMOST, x, y, width, height,
                 SWP_NOACTIVATE | SWP_NOOWNERZORDER);
}

void Overlay::update(const std::string& id, const std::string& name, uint64_t done, uint64_t total,
                     bool incoming) {
    if (!window_) return;
    auto it = std::find_if(rows_.begin(), rows_.end(),
                           [&](const Row& row) { return row.id == id; });
    if (it == rows_.end()) {
        Row row;
        row.id = id;
        row.name = name;
        row.incoming = incoming;
        row.done = done;
        row.total = total;
        row.finished = total > 0 && done >= total;
        rows_.insert(rows_.begin(), row);  // 新的排最上面
    } else {
        it->done = done;
        if (!name.empty()) it->name = name;
        it->total = total;
        it->finished = total > 0 && done >= total;
    }

    // 传完的留一会儿再走，别一完成就整条消失，用户看不到结果
    const bool any_active = std::any_of(rows_.begin(), rows_.end(),
                                        [](const Row& row) { return !row.finished; });
    if (!visible_) {
        visible_ = true;
        layout();
        ShowWindow(window_, SW_SHOWNOACTIVATE);
    } else {
        layout();
    }
    InvalidateRect(window_, nullptr, FALSE);
    if (!any_active) schedule_hide(3000);
}

void Overlay::flash(const std::wstring& text) {
    if (!window_) return;
    flash_ = text;
    visible_ = true;
    layout();
    ShowWindow(window_, SW_SHOWNOACTIVATE);
    InvalidateRect(window_, nullptr, FALSE);
    SetTimer(window_, kFlashTimer, 3000, nullptr);
}

void Overlay::schedule_hide(int after_ms) { SetTimer(window_, kHideTimer, after_ms, nullptr); }

void Overlay::paint(HDC target) {
    RECT client = {};
    GetClientRect(window_, &client);
    const int width = client.right;
    const int height = client.bottom;
    if (width <= 0 || height <= 0) return;
    const int pad = scale(kPad, dpi_);

    // 双缓冲：直接画到窗口上会闪，尤其是每次进度都在重绘
    HDC memory = CreateCompatibleDC(target);
    HBITMAP bitmap = CreateCompatibleBitmap(target, width, height);
    HGDIOBJ old_bitmap = SelectObject(memory, bitmap);

    // 深色底，和任务栏那种观感一致
    HBRUSH background = CreateSolidBrush(RGB(32, 34, 38));
    RECT full = {0, 0, width, height};
    FillRect(memory, &full, background);
    DeleteObject(background);

    SetBkMode(memory, TRANSPARENT);

    HFONT font = CreateFontW(-scale(13, dpi_), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    HFONT bold = CreateFontW(-scale(13, dpi_), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    HGDIOBJ old_font = SelectObject(memory, bold);

    SetTextColor(memory, RGB(235, 238, 242));
    RECT header = {pad, scale(10, dpi_), width - pad, scale(34, dpi_)};
    const std::wstring title = flash_.empty() ? hint_ : flash_;
    DrawTextW(memory, title.c_str(), -1, &header, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

    SelectObject(memory, font);
    int y = scale(kHeaderHeight, dpi_);
    const size_t count = std::min(rows_.size(), kMaxRows);
    for (size_t i = 0; i < count; i++) {
        const Row& row = rows_[i];
        const int row_h = scale(kRowHeight, dpi_);

        // 左边一个箭头表示方向
        SetTextColor(memory, row.finished ? RGB(120, 200, 140) : RGB(150, 200, 255));
        RECT arrow = {pad, y, pad + scale(16, dpi_), y + row_h};
        DrawTextW(memory, row.incoming ? L"↓" : L"↑", -1, &arrow,
                  DT_LEFT | DT_SINGLELINE | DT_VCENTER);

        const int bar_width = scale(96, dpi_);
        const int text_right = width - pad - bar_width - scale(10, dpi_);

        SetTextColor(memory, RGB(228, 232, 238));
        RECT name = {pad + scale(18, dpi_), y, text_right, y + row_h};
        const std::wstring shown = elide(widen_utf8(row.name), 34);
        DrawTextW(memory, shown.c_str(), -1, &name,
                  DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

        // 进度条：底槽 + 填充
        const int bar_y = y + (row_h - scale(5, dpi_)) / 2;
        RECT track = {width - pad - bar_width, bar_y, width - pad, bar_y + scale(5, dpi_)};
        HBRUSH track_brush = CreateSolidBrush(RGB(62, 66, 72));
        FillRect(memory, &track, track_brush);
        DeleteObject(track_brush);

        if (row.total > 0) {
            const double ratio = std::min(1.0, static_cast<double>(row.done) /
                                                  static_cast<double>(row.total));
            RECT fill = track;
            fill.right = track.left + static_cast<int>((track.right - track.left) * ratio);
            HBRUSH fill_brush =
                CreateSolidBrush(row.finished ? RGB(70, 170, 100) : RGB(76, 141, 255));
            FillRect(memory, &fill, fill_brush);
            DeleteObject(fill_brush);
        }

        y += row_h;
    }

    SelectObject(memory, old_font);
    DeleteObject(font);
    DeleteObject(bold);

    // 一圈细边框，纯黑底在深色桌面上会糊成一片
    HPEN pen = CreatePen(PS_SOLID, 1, RGB(72, 76, 84));
    HGDIOBJ old_pen = SelectObject(memory, pen);
    HGDIOBJ old_brush = SelectObject(memory, GetStockObject(NULL_BRUSH));
    Rectangle(memory, 0, 0, width, height);
    SelectObject(memory, old_pen);
    SelectObject(memory, old_brush);
    DeleteObject(pen);

    BitBlt(target, 0, 0, width, height, memory, 0, 0, SRCCOPY);
    SelectObject(memory, old_bitmap);
    DeleteObject(bitmap);
    DeleteDC(memory);
}

LRESULT CALLBACK Overlay::window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_NCCREATE) {
        auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
        // 这里必须先把窗口句柄存下来。CreateWindowEx 要等这个过程返回之后才把
        // 句柄交给我们，在那之前成员还是空的，而 handle() 里转发给 DefWindowProc
        // 用的是成员。传一个空句柄过去会让 CreateWindowEx 直接失败（错误 1400），
        // 表现成"窗口建不起来"，看不出真正原因。
        if (auto* self = reinterpret_cast<Overlay*>(create->lpCreateParams)) {
            self->window_ = window;
        }
    }
    auto* self = reinterpret_cast<Overlay*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (self) return self->handle(message, wparam, lparam);
    return DefWindowProcW(window, message, wparam, lparam);
}

LRESULT Overlay::handle(UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case WM_ERASEBKGND:
            // 自己在 WM_PAINT 里整块画，别让系统再刷一次
            return 1;
        case WM_PAINT: {
            PAINTSTRUCT ps = {};
            HDC dc = BeginPaint(window_, &ps);
            paint(dc);
            EndPaint(window_, &ps);
            return 0;
        }
        case WM_DROPFILES: {
            HDROP drop = reinterpret_cast<HDROP>(wparam);
            const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
            std::vector<std::filesystem::path> paths;
            for (UINT i = 0; i < count; i++) {
                wchar_t buffer[MAX_PATH] = {};
                if (DragQueryFileW(drop, i, buffer, MAX_PATH)) paths.emplace_back(buffer);
            }
            DragFinish(drop);
            if (on_drop_ && !paths.empty()) on_drop_(paths);
            return 0;
        }
        case WM_TIMER:
            if (wparam == kHideTimer) {
                KillTimer(window_, kHideTimer);
                rows_.clear();
                flash_.clear();
                visible_ = false;
                ShowWindow(window_, SW_HIDE);
            } else if (wparam == kFlashTimer) {
                KillTimer(window_, kFlashTimer);
                if (rows_.empty()) {
                    flash_.clear();
                    visible_ = false;
                    ShowWindow(window_, SW_HIDE);
                } else {
                    flash_.clear();
                    InvalidateRect(window_, nullptr, FALSE);
                }
            }
            return 0;
        case WM_NCHITTEST:
            // 让整个窗口都能拖动（返回 HTCAPTION），但因为是 NOACTIVATE，
            // 拖它不会把焦点从用户正在用的窗口抢走
            return HTCAPTION;
        default:
            return DefWindowProcW(window_, message, wparam, lparam);
    }
}

}  // namespace shell
