// 原生端原型。命令行版本，先把配对跑通，再往上加数据通道和传文件。
//
// 用法：
//   报码等对方：  p2p advertise --name "我的 Windows" [--auto-accept]
//   用码连过去：  p2p join 12345678 --name "我的 Windows"
//
// 灯塔地址默认本地，--lighthouse 可以换成线上。

#include <atomic>
#include <chrono>

#ifdef _WIN32
#include <windows.h>
#endif
#include <iostream>
#include <thread>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "crypto.h"
#include "pairing.h"
#include "flow.h"
#include "peer.h"
#include "signal.h"

using json = nlohmann::json;
using namespace p2p;

namespace {

const char* kDefaultLighthouse = "ws://127.0.0.1:8787/ws/presence";

struct Args {
    std::string command;
    std::string code;
    std::string name = "原生端";
    std::string lighthouse = kDefaultLighthouse;
    bool auto_accept = false;
    std::string send_file;
    std::string text;
    std::string save_dir = ".";
};

struct Paired {
    std::string peer_id;
    std::string peer_name;
    PublicKeyJwk peer_key;
    std::string sas;
};

PublicKeyJwk read_jwk(const json& node) {
    PublicKeyJwk jwk;
    jwk.kty = node.at("kty").get<std::string>();
    jwk.crv = node.at("crv").get<std::string>();
    jwk.x = node.at("x").get<std::string>();
    jwk.y = node.at("y").get<std::string>();
    return jwk;
}

json write_jwk(const PublicKeyJwk& jwk) {
    return json{{"kty", jwk.kty}, {"crv", jwk.crv}, {"x", jwk.x}, {"y", jwk.y}};
}

void usage() {
    std::cout << "用法：p2p advertise|join <配对码> [--name 名字] [--lighthouse 地址] "
                 "[--auto-accept]\n";
}

bool parse_args(int argc, char** argv, Args* out) {
    if (argc < 2) return false;
    out->command = argv[1];
    int i = 2;
    if (out->command == "join") {
        if (i >= argc) return false;
        out->code = argv[i++];
    } else if (out->command != "advertise") {
        return false;
    }
    for (; i < argc; i++) {
        const std::string flag = argv[i];
        if (flag == "--auto-accept") {
            out->auto_accept = true;
        } else if (flag == "--name" && i + 1 < argc) {
            out->name = argv[++i];
        } else if (flag == "--lighthouse" && i + 1 < argc) {
            out->lighthouse = argv[++i];
        } else if (flag == "--send" && i + 1 < argc) {
            out->send_file = argv[++i];
        } else if (flag == "--text" && i + 1 < argc) {
            out->text = argv[++i];
        } else if (flag == "--save-dir" && i + 1 < argc) {
            out->save_dir = argv[++i];
        } else {
            return false;
        }
    }
    return true;
}

/** 报码等对方来连。拿到码立刻打出来，对方要拿它来连我。 */
bool advertise(SignalLink* link, const Identity& identity, bool auto_accept, Paired* out) {
    link->send(json{{"t", "new-code"}});

    std::string code;
    json msg;
    while (link->next(&msg, 10000)) {
        if (msg.value("t", "") == "code") {
            code = msg.value("code", "");
            std::cout << "配对码 " << code << "　（在浏览器端或另一台原生端输入它）" << std::endl;
            break;
        }
    }
    if (code.empty()) {
        std::cerr << "灯塔没给配对码，是不是没连上" << std::endl;
        return false;
    }

    while (link->next(&msg, 120000)) {
        if (msg.value("t", "") != "pair-request") continue;
        const std::string from = msg.value("from", "");
        const std::string peer_name = msg.value("name", "");
        const PublicKeyJwk peer_key = read_jwk(msg.at("publicKey"));
        // 六位数字由双方公钥推出。灯塔要是替换了公钥，两边就对不上。
        const std::string sas = short_authentication_string(identity.public_jwk(), peer_key);
        std::cout << "配对请求来自 " << peer_name << "（" << from << "）" << std::endl;
        std::cout << "六位数字：" << sas << "　请和对方屏幕上的一致再确认" << std::endl;

        link->send(json{{"t", "pair-response"},
                        {"from", identity.device_id()},
                        {"to", from},
                        {"accepted", auto_accept},
                        {"platform", "native"}});
        if (!auto_accept) {
            std::cerr << "没有自动接受，配对中止（原型阶段用 --auto-accept）" << std::endl;
            return false;
        }
        link->send(json{{"t", "watch"}, {"ids", json::array({from})}});
        out->peer_id = from;
        out->peer_name = peer_name;
        out->peer_key = peer_key;
        out->sas = sas;
        return true;
    }
    std::cerr << "等配对请求超时" << std::endl;
    return false;
}

/** 用配对码去连对方 */
bool join(SignalLink* link, const Identity& identity, const std::string& my_name,
          const std::string& code, Paired* out) {
    link->send(json{{"t", "lookup-code"}, {"code", code}});

    std::string peer_id;
    std::string peer_name;
    PublicKeyJwk peer_key;
    json msg;
    while (link->next(&msg, 10000)) {
        const std::string t = msg.value("t", "");
        if (t == "code-owner") {
            peer_id = msg.value("deviceId", "");
            peer_name = msg.value("name", "");
            peer_key = read_jwk(msg.at("publicKey"));
            // 设备号必须由公钥推导，否则"自称是谁"没有约束
            if (peer_key.device_id() != peer_id) {
                std::cerr << "对方的公钥和它的设备号对不上，可能有人在中间" << std::endl;
                return false;
            }
            break;
        }
        if (t == "code-miss") {
            std::cerr << "这个配对码没找到：" << msg.value("reason", "") << std::endl;
            return false;
        }
    }
    if (peer_id.empty()) {
        std::cerr << "查码超时" << std::endl;
        return false;
    }

    const std::string sas = short_authentication_string(identity.public_jwk(), peer_key);
    std::cout << "对方是 " << peer_name << "（" << peer_id << "）" << std::endl;
    std::cout << "六位数字：" << sas << "　请和对方屏幕上的一致" << std::endl;

    link->send(json{{"t", "pair-request"},
                    {"from", identity.device_id()},
                    {"to", peer_id},
                    {"code", code},
                    {"name", my_name},
                    {"platform", "native"},
                    {"publicKey", write_jwk(identity.public_jwk())}});

    while (link->next(&msg, 120000)) {
        const std::string t = msg.value("t", "");
        if (t == "pair-response") {
            if (!msg.value("accepted", false)) {
                std::cerr << "对方拒绝了配对" << std::endl;
                return false;
            }
            link->send(json{{"t", "watch"}, {"ids", json::array({peer_id})}});
            out->peer_id = peer_id;
            out->peer_name = peer_name;
            out->peer_key = peer_key;
            out->sas = sas;
            return true;
        }
    }
    std::cerr << "等配对确认超时" << std::endl;
    return false;
}

}  // namespace

int run(int argc, char** argv) {
    Args args;
    if (!parse_args(argc, argv, &args)) {
        usage();
        return 2;
    }

    try {
        // 原型的身份每次都是新的。真实产品里私钥要持久化，
        // 否则设备号每次都变，通讯录就白记了。
        const Identity identity = Identity::generate();
        std::cout << "本机设备号 " << identity.device_id() << "（名字 " << args.name << "）"
                  << std::endl;
        std::cout << "灯塔 " << args.lighthouse << std::endl;

        SignalLink link(args.lighthouse, identity.device_id(), args.name);
        // WebSocket 是异步连的，等它打开
        for (int i = 0; i < 100 && !link.connected() && !link.closed(); i++) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        if (!link.connected()) {
            std::cerr << "连不上灯塔 " << args.lighthouse << std::endl;
            return 1;
        }
        std::cout << "灯塔已连接" << std::endl;
        // 必须先自报家门：灯塔要靠这条消息记住我的公钥，否则别人查我的配对码时
        // 它答不出 code-owner（"对方还没报上公钥"就是这么来的）。
        link.send(json{{"t", "hello"},
                       {"deviceId", identity.device_id()},
                       {"name", args.name},
                       {"publicKey", write_jwk(identity.public_jwk())}});

        Paired paired;
        const bool ok = args.command == "advertise"
                            ? advertise(&link, identity, args.auto_accept, &paired)
                            : join(&link, identity, args.name, args.code, &paired);
        if (!ok) return 1;

        std::cout << "配对完成：" << paired.peer_name << " " << paired.peer_id << "，六位数字 "
                  << paired.sas << std::endl;

        // ---- 建数据通道 ----
        const std::string my_id = identity.device_id();
        const bool initiator = owns_channel(my_id, paired.peer_id);
        std::cout << "开始建连（" << (initiator ? "我这侧建通道" : "请对方建通道") << "）" << std::endl;

        Peer peer(my_id, paired.peer_id, initiator, &link);
        MessageQueue inbox;
        peer.on_message([&inbox](rtc::message_variant msg) { inbox.push(std::move(msg)); });
        peer.on_open([]() { std::cout << "数据通道已打开" << std::endl; });

        if (!initiator) {
            // 通道不是我这侧建的，请对方发起。这样"谁发起"只有一答案。
            link.send(json{{"t", "connect-request"}, {"from", my_id}, {"to", paired.peer_id}});
        }

        const auto deadline =
            std::chrono::steady_clock::now() + std::chrono::seconds(30);
        bool opened = false;
        while (!opened && std::chrono::steady_clock::now() < deadline && !peer.failed()) {
            json msg;
            if (link.next(&msg, 300)) {
                const std::string t = msg.value("t", "");
                if (t == "sdp" || t == "ice") {
                    peer.handle(msg);
                } else if (t == "connect-request") {
                    // 对方在请我发起连接，多半是没收到我先前的 offer。
                    //
                    // 试过在这里重发 offer，**结果更糟**：128 次里失败从 6 涨到 43，
                    // 而且扩散到原本从不失败的方向。原因是对方发这条请求时可能
                    // 已经在用第一份 offer 建连了，我一重发，它就 adoptOffer ->
                    // resetConn，把正在建立的会话拆掉重建，自己制造了 glare。
                    //
                    // 所以这里只记一条，不重发。要修得先让双方对"同一条连接只
                    // 协商一次"有共识，那是另一个改动，不能凭猜。
                    std::cout << "对方请求我发起连接（已发过 offer，不重发）" << std::endl;
                } else if (t == "error") {
                    // 灯塔回的错必须报出来。以前这里只认 sdp/ice，其他一律丢掉，
                    // 于是"对方不在线"这种明确的错和"什么都没发生"长得一模一样，
                    // 只能干等到 30 秒超时，排查时完全没有线索。
                    std::cerr << "信令出错：" << msg.value("code", "") << " "
                              << msg.value("message", "") << std::endl;
                }
            }
            auto dc = peer.channel();
            opened = dc && dc->isOpen();
        }
        if (!opened) {
            std::cerr << "等数据通道打开超时" << std::endl;
            // 失败时把信令历史倒出来。平时只记在内存里，就是为了这一刻：
            // 实时打印会改变时序，反而复现不出来。
            link.dump_recent("等数据通道打开超时");
            return 1;
        }
        auto channel = peer.channel();

        // ---- 双向认证 ----
        if (!authenticate(channel, identity, paired.peer_id, paired.peer_key, &inbox, 20000)) {
            return 1;
        }

        // ---- 传东西 ----
        // 发送期间得有东西把 ack 从消息队列里捞出来记进 AckTracker，否则 send_file
        // 会一直等一个永远没人收的确认。界面那边这条循环是常驻的接收循环，
        // 命令行是发完就走，只能临时起一个。
        AckTracker acks;
        std::atomic<bool> pumping{true};
        std::thread pump([&inbox, &acks, &pumping]() {
            while (pumping.load()) {
                rtc::message_variant msg;
                if (!inbox.pop(&msg, 100)) continue;
                if (!std::holds_alternative<rtc::string>(msg)) continue;
                try {
                    const auto parsed = json::parse(std::string(std::get<rtc::string>(msg)));
                    if (parsed.value("t", "") == "ack") {
                        acks.on_ack(parsed.value("id", ""), parsed.value("received", 0ULL));
                    }
                } catch (const std::exception&) {
                }
            }
        });
        auto stop_pump = [&pumping, &pump]() {
            pumping = false;
            if (pump.joinable()) pump.join();
        };

        bool did_something = false;
        if (!args.send_file.empty()) {
            if (!send_file(channel, identity, args.send_file, &acks)) {
                stop_pump();
                return 1;
            }
            did_something = true;
        }
        if (!args.text.empty()) {
            if (!send_text(channel, identity, args.text)) {
                stop_pump();
                return 1;
            }
            did_something = true;
        }
        stop_pump();
        if (!did_something) {
            bool got_text = false;
            std::string saved;
            if (!receive_once(channel, &inbox, args.save_dir, 60000, &got_text, &saved)) return 1;
            if (!saved.empty()) std::cout << "文件已保存到 " << saved << std::endl;
        } else {
            // 发完多留一会儿，让对面把最后的确认发完
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "出错：" << e.what() << std::endl;
        return 1;
    }
}

#ifdef _WIN32
namespace {

/** Windows 控制台按本地代码页（这里是 GBK）传命令行参数，程序内部一律用 UTF-8。 */
std::string utf16_to_utf8(const wchar_t* text) {
    if (!text) return {};
    const int need = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (need <= 1) return {};
    std::string out(static_cast<size_t>(need - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), need, nullptr, nullptr);
    return out;
}

}  // namespace

int wmain(int argc, wchar_t** wargv) {
    std::vector<std::string> storage;
    storage.reserve(static_cast<size_t>(argc));
    for (int i = 0; i < argc; i++) storage.push_back(utf16_to_utf8(wargv[i]));
    std::vector<char*> argv;
    argv.reserve(storage.size());
    for (auto& item : storage) argv.push_back(item.data());
    return run(static_cast<int>(argv.size()), argv.data());
}
#else
int main(int argc, char** argv) { return run(argc, argv); }
#endif
