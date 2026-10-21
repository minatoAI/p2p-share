// 身份持久化的自检。
//
// 验的是四件事，缺一件这个特性就是假的：
//   1. 第一次跑：没有文件，新建一个，created 为真
//   2. 再跑一次：文件在，读出来的设备号必须和上次一模一样
//   3. 读出来的私钥必须还能签名，而且能被第一次的公钥验通（不是读了个壳）
//   4. 设置文件存了能读回来
//
// 用法：identity-test [目录]。不传目录就用一个临时目录，跑完不清理，
// 方便肉眼看文件长什么样。
#include <cstdio>
#include <filesystem>
#include <iostream>
#include <fstream>
#include <string>

#include "crypto.h"
#include "store.h"

using namespace p2p;

int main(int argc, char** argv) {
    std::filesystem::path dir;
    if (argc > 1) {
        dir = std::filesystem::u8path(argv[1]);
    } else {
        dir = std::filesystem::temp_directory_path() / L"p2p-identity-test";
        std::error_code ec;
        std::filesystem::remove_all(dir, ec);
    }
    std::cout << "测试目录 " << dir.u8string() << std::endl;

    int failed = 0;
    auto check = [&failed](bool ok, const char* what) {
        std::cout << (ok ? "  通过  " : "  失败  ") << what << std::endl;
        if (!ok) failed++;
    };

    // 1. 第一次：应该是新建
    const auto first = load_or_create_identity(dir);
    check(first.created, "第一次调用是新建身份");
    check(std::filesystem::exists(first.file), "身份文件已经落到盘上");
    std::cout << "       设备号 " << first.identity.device_id() << std::endl;
    std::cout << "       文件   " << first.file.u8string() << std::endl;

    // 2. 第二次：应该读出来，设备号和指纹都不变
    const auto second = load_or_create_identity(dir);
    check(!second.created, "第二次调用是从文件读的");
    check(second.identity.device_id() == first.identity.device_id(), "两次的设备号一致");
    check(second.identity.fingerprint() == first.identity.fingerprint(), "两次的指纹一致");

    // 3. 读出来的钥匙得真能用：签名，再拿第一次的公钥验
    const std::string message = "身份持久化自检\nsecond run signs, first run verifies";
    const auto signature = second.identity.sign(utf8(message));
    check(signature.size() == 64, "签名是 64 字节的 r||s");
    check(verify(first.identity.public_jwk(), utf8(message), signature),
          "第二次的签名能被第一次的公钥验通");

    // 顺便确认坏掉的签名验不过（不然上面那条可能是永远返回真）
    auto broken = signature;
    broken[0] ^= 0x01;
    check(!verify(first.identity.public_jwk(), utf8(message), broken), "改过的签名验不过");

    // 4. 设置
    Settings settings;
    settings.device_name = "书房台式机";
    settings.save_dir = "E:\\收件";
    save_settings(dir, settings);
    const auto loaded = load_settings(dir);
    check(loaded.device_name == settings.device_name, "设备名存得回来（含中文）");
    check(loaded.save_dir == settings.save_dir, "保存目录存得回来");

    // 5. 传输记录：追加写、按新到旧读回、坏行不能带坏整份
    {
        p2p::HistoryEntry a;
        a.direction = "in";
        a.name = "报告.pdf";
        a.path = "D:/收/报告.pdf";
        a.peer = "书房台式机";
        a.size = 2048;
        a.at_ms = 1000;
        p2p::HistoryEntry b = a;
        b.direction = "out";
        b.name = "b.zip";
        b.at_ms = 2000;
        p2p::append_history(dir, a);
        p2p::append_history(dir, b);

        // 故意插一行坏的：追加写的文件里出现半行是可能的，
        // 那一行该被跳过，不能把整份历史带坏
        {
            std::ofstream bad(dir / L"history.jsonl", std::ios::binary | std::ios::app);
            bad << "{ this is not json\n";
        }

        const auto items = p2p::load_history(dir, 50);
        check(items.size() == 2, "坏行被跳过，好行都读出来了");
        check(!items.empty() && items[0].name == "b.zip", "最近的一条排在最前");
        check(items.size() > 1 && items[1].name == "报告.pdf", "较早的一条排在后面");
        check(!items.empty() && items[0].peer == "书房台式机", "对端名字存得回来（含中文）");
        check(!items.empty() && items[0].size == 2048, "大小存得回来");

        const auto limited = p2p::load_history(dir, 1);
        check(limited.size() == 1, "limit 生效");
    }

    // 目录里的文件列一下，方便确认没多出垃圾
    std::cout << "目录内容：" << std::endl;
    for (const auto& entry : std::filesystem::directory_iterator(dir)) {
        std::cout << "  " << entry.path().filename().u8string() << "  "
                  << std::filesystem::file_size(entry.path()) << " 字节" << std::endl;
    }

    std::cout << (failed == 0 ? "[自检] 身份持久化通过" : "[自检] 有失败项") << std::endl;
    return failed == 0 ? 0 : 1;
}
