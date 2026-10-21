#include "picker.h"

#include <shobjidl.h>
#include <wrl.h>

namespace shell {
namespace {

using namespace Microsoft::WRL;

/** 把 IShellItem 转成文件系统路径 */
std::filesystem::path path_of(IShellItem* item) {
    PWSTR raw = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &raw)) || !raw) {
        if (raw) CoTaskMemFree(raw);
        return {};
    }
    std::filesystem::path out(raw);
    CoTaskMemFree(raw);
    return out;
}

std::vector<std::filesystem::path> run_dialog(HWND owner, bool folders, const wchar_t* title) {
    std::vector<std::filesystem::path> out;

    ComPtr<IFileOpenDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&dialog)))) {
        return out;
    }

    DWORD options = 0;
    dialog->GetOptions(&options);
    options |= folders ? FOS_PICKFOLDERS : (FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST);
    dialog->SetOptions(options);

    // 显示出来的标题随场合变，用户能分清是在选文件还是在选文件夹
    dialog->SetTitle(title ? title : (folders ? L"选择要发送的文件夹" : L"选择要发送的文件"));

    // Show 会返回 HRESULT_FROM_WIN32(ERROR_CANCELLED) 表示用户取消了，
    // 这是正常路径，不要当错误报出来
    if (FAILED(dialog->Show(owner))) return out;

    ComPtr<IShellItemArray> items;
    if (FAILED(dialog->GetResults(&items))) return out;

    DWORD count = 0;
    items->GetCount(&count);
    for (DWORD i = 0; i < count; i++) {
        ComPtr<IShellItem> item;
        if (FAILED(items->GetItemAt(i, &item))) continue;
        const auto path = path_of(item.Get());
        if (!path.empty()) out.push_back(path);
    }
    return out;
}

}  // namespace

std::vector<std::filesystem::path> pick_files(HWND owner) { return run_dialog(owner, false, nullptr); }

std::vector<std::filesystem::path> pick_folder(HWND owner, const wchar_t* title) {
    return run_dialog(owner, true, title);
}

}  // namespace shell
