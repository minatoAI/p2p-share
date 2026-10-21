// p2p-send：给「发送到」菜单用的小转发器。
//
// 为什么不直接让快捷方式指向 p2p-shell.exe：
//   1. 外壳是控制台子系统（要打印自检结果），从资源管理器启动会闪一下黑框。
//      这个工具是窗口子系统的，没有控制台，不会闪。
//   2. 外壳已经有实例在跑的时候不该再开一个，否则托盘两个图标、身份打架。
//      这个工具只做"交给已经在跑的那个"。
//
// 所以它的全部逻辑就是：拿到路径 -> 找到外壳 -> 交出去；找不到就自己启动一个。
#include <windows.h>
#include <shellapi.h>

#include "ipc.h"

int APIENTRY wWinMain(HINSTANCE, HINSTANCE, LPWSTR, int) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return 1;

    std::vector<std::filesystem::path> paths;
    for (int i = 1; i < argc; i++) {
        if (argv[i][0] == L'\0') continue;
        paths.emplace_back(argv[i]);
    }
    LocalFree(argv);

    if (paths.empty()) return 2;
    if (shell::deliver_to_running_instance(paths)) return 0;

    // 没有实例在跑，那就起一个，并把路径原样转交（外壳的 wmain 认识这种调用）。
    wchar_t exe[MAX_PATH] = {};
    if (GetModuleFileNameW(nullptr, exe, MAX_PATH) == 0) return 1;
    std::wstring shell_exe(exe);
    const size_t cut = shell_exe.find_last_of(L"\\/");
    if (cut != std::wstring::npos) shell_exe = shell_exe.substr(0, cut + 1);
    shell_exe += L"p2p-shell.exe";

    std::wstring command = L"\"" + shell_exe + L"\"";
    for (const auto& path : paths) command += L" \"" + path.wstring() + L"\"";

    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION info = {};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &info)) {
        return 1;
    }
    CloseHandle(info.hThread);
    CloseHandle(info.hProcess);
    return 0;
}
