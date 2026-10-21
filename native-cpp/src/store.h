#pragma once
// 落盘的那点东西：身份、设置。
//
// 分成两层是为了将来好移植：这一层只管"在给定目录里怎么放文件"，和平台无关；
// 具体目录在哪由 default_app_dir() 决定，那里才是 Windows 特有的代码。
//
// 目录选 LocalAppData 而不是 AppData（Roaming），理由就一条：身份是"这台设备"
// 的身份，跟着用户漫游到另一台机器上就会出现两台机器同一个设备号，配对关系
// 全乱。微软自己的文档也是这么分的：跟着用户走的设置放 Roaming，跟机器绑的
// 放 Local。
#include <filesystem>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "crypto.h"

namespace p2p {

/** 数据目录。Windows 上是 %LOCALAPPDATA%\P2PLighthouse */
std::filesystem::path default_app_dir();
/** 下载目录下的 P2P 子目录，作为默认保存位置 */
std::filesystem::path default_save_dir();

struct Settings {
    std::string device_name = "我的 Windows";
    std::string save_dir;
    /** 线上灯塔；本地 wrangler 联调时在 settings.json 里覆盖 */
    std::string lighthouse = "wss://p2p-share-web.pages.dev/ws/presence";
    /** 自动接收：对已经配对过的设备免确认 */
    bool auto_accept_paired = true;
    /** 通知提示音，取值见 shell/notify.h 里的名字 */
    std::string notify_sound = "balloon";
    /**
     * 剪贴板自动同步。默认关：复制之后不会自己发出去，要用户点一下。
     * 关着的时候，对方发来的文字也不会自动写进剪贴板。
     */
    bool auto_sync_clipboard = false;
};

Settings load_settings(const std::filesystem::path& dir);
void save_settings(const std::filesystem::path& dir, const Settings& settings);

struct LoadedIdentity {
    Identity identity;
    /** 这次是新建的还是从文件读出来的。界面上"第一次启动"的引导靠它区分。 */
    bool created = false;
    std::filesystem::path file;
};

/**
 * 读身份，读不到就生成一个并存下来。
 *
 * 文件存在但读坏了，这里不静默重建：静默重建会让设备号无声无息地变掉，
 * 对方那边看着就是"一台新设备"，比直接报错更难查。所以抛异常，由上层决定
 * 是提示用户还是备份旧文件后重来。
 */
LoadedIdentity load_or_create_identity(const std::filesystem::path& dir);

/**
 * 一条传输记录。
 *
 * 落盘是为了"关了窗口再打开还在"，所以字段要够看重放：什么时候、哪个方向、
 * 什么文件、多大、对方是谁、成没成。
 */
struct HistoryEntry {
    /** "in" 收进来的，"out" 发出去的 */
    std::string direction;
    /** 文件名（只有名字，不是完整路径） */
    std::string name;
    /** 落盘的完整路径（收）或者源路径（发） */
    std::string path;
    /** 对端名字 */
    std::string peer;
    uint64_t size = 0;
    /** Unix 毫秒 */
    int64_t at_ms = 0;

    nlohmann::json to_json() const;
    static HistoryEntry from_json(const nlohmann::json& node);
};

/**
 * 追加一条记录。
 *
 * 用 JSONL（一行一条 JSON）追加写，不用数据库也不用整个数组重写：
 * 追加是原子的（一行一次 write），中途断电最多丢掉最后一行，
 * 不会把整个历史弄坏。这正是它比"读全部、加一条、写全部"强的地方。
 */
void append_history(const std::filesystem::path& dir, const HistoryEntry& entry);

/** 读最近 limit 条，新的在前。文件不存在或读坏了都返回空的，不抛。 */
std::vector<HistoryEntry> load_history(const std::filesystem::path& dir, size_t limit);

}  // namespace p2p
