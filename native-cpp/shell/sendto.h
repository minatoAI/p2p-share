#pragma once
// 「发送到」菜单的安装与卸载。
//
// 原理只有一句话：往 %APPDATA%\Microsoft\Windows\SendTo 里放一个快捷方式。
// 资源管理器右键 -> 发送到 里列的就是这个文件夹里的东西，所以不需要注册表、
// 不需要管理员、不需要 COM 扩展，放进去就出现，删掉就消失。
//
// 快捷方式的目标是本程序自己。资源管理器会把选中的文件作为命令行参数传进来，
// 所以外壳启动时要能接住"被一堆路径叫起来"这种情况。
#include <filesystem>
#include <string>
#include <vector>

namespace shell {

/** %APPDATA%\Microsoft\Windows\SendTo */
std::filesystem::path sendto_dir();

/** 菜单里显示的名字，同时也是快捷方式的文件名 */
std::wstring sendto_shortcut_name();

/**
 * 建快捷方式。exe_path 留空就用旁边的 p2p-send.exe。
 * display_name 是 SendTo 菜单里显示的名字，也是 .lnk 的文件名。
 * 返回快捷方式的完整路径；失败抛异常。
 */
std::filesystem::path install_sendto(const std::filesystem::path& exe_path = {},
                                     const std::wstring& display_name = sendto_shortcut_name());

/** 删掉快捷方式。本来就不在也算成功。 */
void uninstall_sendto(const std::wstring& display_name = sendto_shortcut_name());

/** 快捷方式在不在。用来在界面上显示"已集成 / 未集成"。 */
bool sendto_installed(const std::wstring& display_name = sendto_shortcut_name());

}  // namespace shell
