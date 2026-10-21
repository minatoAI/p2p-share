#pragma once
// 外壳和外部小工具之间那点约定。
//
// 场景：资源管理器通过「发送到」启动 p2p-send.exe，把文件路径当命令行参数给它。
// p2p-send 不做正事，它只负责把路径塞给已经在跑的外壳。已经有一个实例在跑的时候
// 再开一个外壳是错的：托盘会出现两个图标，身份也会冲突。
//
// 用 WM_COPYDATA 而不是命名管道或者 COM：数据量小、要跨进程、还要能被阻塞住的
// 消息循环接住，WM_COPYDATA 正好干这个，而且不用注册任何东西。
#include <windows.h>

#include <filesystem>
#include <string>
#include <vector>

namespace shell {

/** 主窗口的窗口类名。找"已经在跑的那个实例"靠它。 */
inline constexpr wchar_t kWindowClass[] = L"P2PLighthouseShellClass";
inline constexpr wchar_t kWindowTitle[] = L"设备互传";

/** WM_COPYDATA 的 dwData 标识，用来区分是谁发来的 */
inline constexpr ULONG_PTR kCopyDataPaths = 0x50325031;  // 'P2P1'

/** 把路径拼成 WM_COPYDATA 的载荷：宽字符路径，各自以 \0 结尾，最后再补一个 \0 */
inline std::vector<wchar_t> pack_paths(const std::vector<std::filesystem::path>& paths) {
    std::vector<wchar_t> out;
    for (const auto& path : paths) {
        const std::wstring text = path.wstring();
        out.insert(out.end(), text.begin(), text.end());
        out.push_back(L'\0');
    }
    out.push_back(L'\0');
    return out;
}

/** 拆开载荷。遇到空字符串就认为列表结束。 */
inline std::vector<std::filesystem::path> unpack_paths(const wchar_t* data, size_t count) {
    std::vector<std::filesystem::path> out;
    if (!data || count == 0) return out;
    size_t index = 0;
    while (index < count) {
        const std::wstring item(data + index);
        if (item.empty()) break;
        out.emplace_back(item);
        index += item.size() + 1;
    }
    return out;
}

/**
 * 把路径交给已经在跑的外壳。
 * 返回 true 表示确实交出去了；false 表示没有实例在跑（调用方该自己启动一个）。
 */
inline bool deliver_to_running_instance(const std::vector<std::filesystem::path>& paths) {
    HWND target = FindWindowW(kWindowClass, nullptr);
    if (!target) return false;
    auto payload = pack_paths(paths);
    COPYDATASTRUCT data = {};
    data.dwData = kCopyDataPaths;
    data.cbData = static_cast<DWORD>(payload.size() * sizeof(wchar_t));
    data.lpData = payload.data();
    // SendMessageTimeout 而不是 SendMessage：对方要是卡住了，不能把我们一起卡死
    DWORD_PTR result = 0;
    const LRESULT ok = SendMessageTimeoutW(target, WM_COPYDATA, 0,
                                           reinterpret_cast<LPARAM>(&data), SMTO_ABORTIFHUNG,
                                           5000, &result);
    return ok != 0;
}

}  // namespace shell
