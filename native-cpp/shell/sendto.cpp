#include "sendto.h"

#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <objbase.h>
#include <wrl.h>

#include <stdexcept>

using namespace Microsoft::WRL;

namespace shell {
namespace {

std::filesystem::path utf8_path(const std::string& text) {
    return std::filesystem::u8path(text);
}

}  // namespace

std::filesystem::path sendto_dir() {
    PWSTR raw = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_SendTo, 0, nullptr, &raw)) || !raw) {
        if (raw) CoTaskMemFree(raw);
        throw std::runtime_error("找不到「发送到」目录");
    }
    std::filesystem::path out(raw);
    CoTaskMemFree(raw);
    return out;
}

std::wstring sendto_shortcut_name() { return L"设备互传.lnk"; }

std::filesystem::path install_sendto(const std::filesystem::path& exe_path,
                                     const std::wstring& display_name) {
    std::filesystem::path target = exe_path;
    if (target.empty()) {
        // 默认指向旁边的 p2p-send.exe，而不是自己（p2p-shell.exe）。
        // 外壳是控制台子系统，从资源管理器启动会闪一下黑框；转发器是窗口子系统，
        // 不会闪，而且它会把文件交给已经在跑的外壳，不会开出第二个实例。
        wchar_t buffer[MAX_PATH] = {};
        const DWORD len = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
        if (len == 0 || len >= MAX_PATH) throw std::runtime_error("拿不到自己的路径");
        target = std::filesystem::path(buffer).parent_path() / L"p2p-send.exe";
    }
    std::error_code ec;
    if (!std::filesystem::exists(target, ec)) {
        throw std::runtime_error("找不到要放进「发送到」的 exe");
    }

    const std::filesystem::path link = sendto_dir() / display_name;

    ComPtr<IShellLinkW> shell_link;
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&shell_link)))) {
        throw std::runtime_error("建不了 ShellLink");
    }
    shell_link->SetPath(target.c_str());
    shell_link->SetWorkingDirectory(target.parent_path().c_str());
    // 图标沿用 exe 自己的
    shell_link->SetIconLocation(target.c_str(), 0);
    shell_link->SetDescription(L"用设备互传发送选中的文件");

    ComPtr<IPersistFile> file;
    if (FAILED(shell_link.As(&file)) || FAILED(file->Save(link.c_str(), TRUE))) {
        throw std::runtime_error("快捷方式写不进去");
    }
    return link;
}

void uninstall_sendto(const std::wstring& display_name) {
    std::error_code ec;
    std::filesystem::remove(sendto_dir() / display_name, ec);
}

bool sendto_installed(const std::wstring& display_name) {
    std::error_code ec;
    return std::filesystem::exists(sendto_dir() / display_name, ec);
}

}  // namespace shell
