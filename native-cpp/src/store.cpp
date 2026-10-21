#include "store.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <fstream>
#include <cstdlib>
#include <stdexcept>
#include <system_error>

#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>
#include <objbase.h>
#endif

namespace p2p {
namespace {

using json = nlohmann::json;

#ifdef _WIN32
/** 把 Known Folder 的宽字符路径转成 UTF-8 的 std::filesystem::path */
std::filesystem::path known_folder(REFKNOWNFOLDERID id) {
    PWSTR raw = nullptr;
    if (FAILED(SHGetKnownFolderPath(id, 0, nullptr, &raw)) || !raw) {
        if (raw) CoTaskMemFree(raw);
        return {};
    }
    std::filesystem::path out = std::filesystem::path(raw);
    CoTaskMemFree(raw);
    return out;
}
#endif

std::filesystem::path utf8_path(const std::string& text) {
    // Windows 上 std::filesystem::path 的窄字符构造按本地代码页解释，
    // 中文路径会直接找不到文件。必须走 u8path。
    return std::filesystem::u8path(text);
}

}  // namespace

std::filesystem::path default_app_dir() {
#ifdef _WIN32
    const auto base = known_folder(FOLDERID_LocalAppData);
    if (base.empty()) return utf8_path(".");
    return base / L"P2PLighthouse";
#else
    const char* home = std::getenv("HOME");
    return utf8_path(home ? home : ".") / ".local/share/p2p-lighthouse";
#endif
}

std::filesystem::path default_save_dir() {
#ifdef _WIN32
    auto dir = known_folder(FOLDERID_Downloads);
    if (dir.empty()) dir = default_app_dir();
    return dir / L"P2P";
#else
    return utf8_path(std::getenv("HOME") ? std::getenv("HOME") : ".") / "Downloads/P2P";
#endif
}

Settings load_settings(const std::filesystem::path& dir) {
    Settings out;
    out.save_dir = default_save_dir().u8string();
    const auto file = dir / L"settings.json";
    std::error_code ec;
    if (!std::filesystem::exists(file, ec)) return out;

    std::ifstream in(file, std::ios::binary);
    if (!in) return out;
    json node;
    try {
        in >> node;
    } catch (const std::exception&) {
        // 设置文件坏了不值得拦住启动，用默认值继续。
        return out;
    }
    out.device_name = node.value("deviceName", out.device_name);
    out.save_dir = node.value("saveDir", out.save_dir);
    out.lighthouse = node.value("lighthouse", out.lighthouse);
    out.auto_accept_paired = node.value("autoAcceptPaired", out.auto_accept_paired);
    out.notify_sound = node.value("notifySound", out.notify_sound);
    out.auto_sync_clipboard = node.value("autoSyncClipboard", out.auto_sync_clipboard);
    return out;
}

void save_settings(const std::filesystem::path& dir, const Settings& settings) {
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    const json node{{"version", 1},
                    {"deviceName", settings.device_name},
                    {"saveDir", settings.save_dir},
                    {"lighthouse", settings.lighthouse},
                    {"autoAcceptPaired", settings.auto_accept_paired},
                    {"notifySound", settings.notify_sound},
                    {"autoSyncClipboard", settings.auto_sync_clipboard}};
    std::ofstream out(dir / L"settings.json", std::ios::binary | std::ios::trunc);
    if (!out) throw std::runtime_error("设置写不进去");
    out << node.dump(2) << "\n";
}

LoadedIdentity load_or_create_identity(const std::filesystem::path& dir) {
    // Identity 没有默认构造函数（它必须握着一把真钥匙），所以这里不能先声明
    // 一个 LoadedIdentity 再赋值，只能把身份先算出来，最后一次性聚合构造。
    const std::filesystem::path file = dir / L"identity.pem";
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);

    if (std::filesystem::exists(file, ec)) {
        std::ifstream in(file, std::ios::binary);
        if (!in) throw std::runtime_error("身份文件打不开");
        const std::string pem((std::istreambuf_iterator<char>(in)),
                              std::istreambuf_iterator<char>());
        return LoadedIdentity{Identity::from_private_pem(pem), false, file};
    }

    Identity identity = Identity::generate();
    const std::string pem = identity.private_pem();
    // 先写临时文件再改名：中途断电也不会留下半个私钥文件，那会导致
    // 下次启动读不出来，等于身份丢了。
    const auto temp = file.parent_path() / L"identity.pem.tmp";
    {
        std::ofstream out(temp, std::ios::binary | std::ios::trunc);
        if (!out) throw std::runtime_error("身份文件写不进去");
        out << pem;
        out.flush();
        if (!out) throw std::runtime_error("身份文件写失败");
    }
    std::filesystem::rename(temp, file, ec);
    if (ec) {
        std::filesystem::remove(temp, ec);
        throw std::runtime_error("身份文件改名失败");
    }
    return LoadedIdentity{std::move(identity), true, file};
}

nlohmann::json HistoryEntry::to_json() const {
    return json{{"direction", direction}, {"name", name},   {"path", path}, {"peer", peer},
                {"size", size},           {"at", at_ms}};
}

HistoryEntry HistoryEntry::from_json(const nlohmann::json& node) {
    HistoryEntry out;
    out.direction = node.value("direction", "");
    out.name = node.value("name", "");
    out.path = node.value("path", "");
    out.peer = node.value("peer", "");
    out.size = node.value("size", 0ULL);
    out.at_ms = node.value("at", 0LL);
    return out;
}

void append_history(const std::filesystem::path& dir, const HistoryEntry& entry) {
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    // app 模式：每写一行就落到系统缓冲，进程崩了也只丢最后一行
    std::ofstream out(dir / L"history.jsonl", std::ios::binary | std::ios::app);
    if (!out) return;
    out << entry.to_json().dump() << "\n";
}

std::vector<HistoryEntry> load_history(const std::filesystem::path& dir, size_t limit) {
    std::vector<HistoryEntry> out;
    std::ifstream in(dir / L"history.jsonl", std::ios::binary);
    if (!in) return out;
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty()) continue;
        try {
            out.push_back(HistoryEntry::from_json(json::parse(line)));
        } catch (const std::exception&) {
            // 一行坏了就跳过这一行。追加写的文件里出现半行是可能的
            // （写的时候断电），不能让一行坏掉整个历史都读不出来。
            continue;
        }
    }
    // 新的在前
    std::reverse(out.begin(), out.end());
    if (out.size() > limit) out.resize(limit);
    return out;
}

}  // namespace p2p
