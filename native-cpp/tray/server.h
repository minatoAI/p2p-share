#pragma once
// 只读静态服务：把网页端界面托管在 127.0.0.1 上，右键菜单的「设置与历史」打开它。
#include <filesystem>
#include <string>

namespace proto {

bool start_server(const std::filesystem::path& root, int first_port);
std::string server_url();

}  // namespace proto
