#pragma once
// 系统文件选择框。
//
// 为什么不在网页里用 <input type="file">：那个拿到的只有文件名和内容，
// 拿不到**路径**（浏览器出于安全不给）。而我们要的是路径，因为发送是原生侧
// 按路径读文件的。所以要弹系统的选择框，走 IFileOpenDialog。
#include <windows.h>

#include <filesystem>
#include <vector>

namespace shell {

/** 弹出选择框。用户取消就返回空。 */
std::vector<std::filesystem::path> pick_files(HWND owner);

/**
 * 选一个文件夹（用来选"发整个文件夹"的场合）。
 * title 为空就沿用默认说法；托盘端选"保存位置"时传自己的标题，用户才知道在选什么。
 */
std::vector<std::filesystem::path> pick_folder(HWND owner, const wchar_t* title = nullptr);

}  // namespace shell
