#pragma once
// 界面用的会话。
//
// 命令行那套是"一条直线走到底"：配对、建连、发文件、退出。界面不能这样，
// 它要一直活着，随时能配对、随时能收、随时能发，而且所有事都不能卡住界面线程。
//
// 所以这里拆成三条线程：
//   信令线程  连灯塔、报码、配对、建连、认证，之后转成命令循环
//   接收线程  认证完之后一直守着，收对方发来的一切；顺便把 ack 记进确认表
//   发送线程  从队列里取文件挨个发
//
// 为什么要单独一条接收线程：收消息那条循环独占消息队列，发送侧不能也去抢，
// 否则会互相把对方的帧吃掉（发送侧等 ack 时可能吞掉一个 meta）。
//
// 所有对外的东西都通过 emit 回调发出去，内容是 JSON，界面直接照着渲染。
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>
#include <rtc/rtc.hpp>

#include "crypto.h"
#include "flow.h"
#include "peer.h"
#include "signal.h"
#include "store.h"

namespace shell {

class ShareHub;

/** 在线设备，界面上就是一行 */
struct DeviceEntry {
    std::string id;
    std::string name;
    bool online = false;
};

class Session {
public:
    /** 往界面发一条消息。可以从任意线程调，实现里会转到界面线程去。 */
    using Emit = std::function<void(const nlohmann::json&)>;
    /**
     * 码主收到配对请求时先让人核对 SAS。返回 false 就拒绝这次配对。
     * 不设置时直接接受（命令行端沿用原来的行为）。
     */
    using PairConfirmer = std::function<bool(const std::string& peer_name,
                                             const std::string& sas)>;

    Session(p2p::Identity identity, p2p::Settings settings,
            std::filesystem::path state_dir, Emit emit);
    ~Session();

    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    /** 起线程，开始连灯塔 */
    void start();
    /** 收尾，等线程退出。析构里也会调。 */
    void stop();

    /** 向灯塔要一个配对码给人念 */
    void advertise();
    /** 不再报码（小窗收起、配对完成时） */
    void stop_advertise();
    /** 设置配对确认回调，必须在 start() 之前调。 */
    void set_pair_confirmer(PairConfirmer confirmer);
    /** 用别人给的配对码连过去 */
    void join(const std::string& code);
    /** 连一台已经配对过的设备（重启后靠通讯录） */
    void connect(const std::string& peer_id);
    /** 从通讯录里删掉一台设备。正在连着的话会先断开。 */
    void remove_contact(const std::string& peer_id);
    /** 给一台设备改个本地名字（只影响这台机器的显示）。 */
    void rename_contact(const std::string& peer_id, const std::string& name);
    /**
     * 改这台电脑在灯塔和对方那边显示的名字。会重连一次信令把新名字报上去，
     * 已经建好的点对点链路不受影响。
     */
    void set_device_name(const std::string& name);
    /** 把一个文件挂成公开链接，成功后会发 share-created。 */
    void share_file(const std::string& path);
    /** 撤销一条分享链接。 */
    void revoke_share(const std::string& token);
    /** 发给当前对端。没配对过就报错。 */
    void send_files(const std::vector<std::string>& paths);
    void send_text(const std::string& text);
    /**
     * 取消一次正在进行的传输。incoming 表示是收进来的还是发出去的。
     * id 是进度事件里那个 id；对不上（已经结束了）就什么也不做。
     */
    void cancel_transfer(const std::string& id, bool incoming);
    /** 断开当前对端，回到"能再配一次"的状态 */
    void disconnect_peer();
    /**
     * 改接收文件的保存目录。接收线程每轮都读一次，改完下一轮就生效；
     * 目录不存在时接收侧会自己建。
     */
    void set_save_dir(const std::string& dir);

    std::vector<DeviceEntry> devices() const;

private:
    enum class Command {
        Advertise,
        Join,
        Connect,
        SendFiles,
        SendText,
        Disconnect,
        RemoveContact,
        RenameContact,
        SetDeviceName,
        ShareFile,
        RevokeShare
    };

    struct Request {
        Command command;
        std::string text;
        std::string value;
        std::vector<std::string> paths;
    };

    void signal_loop();
    void receive_loop(std::shared_ptr<rtc::DataChannel> channel, uint64_t generation,
                      std::string peer_id);
    void send_loop();
    void push(Request request);
    /**
     * 取一条命令。send_only=true 只取发送类，false 只取信令类——
     * 两个线程共用一个队列，各取各的，谁也不能把对方的命令顺手弹掉。
     */
    bool pop_request(Request* out, int timeout_ms, bool send_only);
    /** 等当前这条信令连接打开，成功后重新报到。失败返回 false。 */
    bool connect_lighthouse();
    /** 退避等待。返回 false 表示等的时候会话被停掉了。 */
    bool wait_backoff(int delay_ms);
    void emit_state(const std::string& value, const std::string& detail);
    /** 排查用的内部事件，页面会忽略，但会进 run.log。 */
    void emit_debug(const std::string& text);
    /** 把历史记录整个发给界面 */
    void emit_history();
    /** 追加一条记录并发给界面 */
    void record(const std::string& direction, const std::string& path, uint64_t size,
                const std::string& transfer_id = "");
    void emit_devices();
    /** 把配对过的设备整个发给界面（重启后也在） */
    void emit_contacts();
    void handle_presence(const nlohmann::json& msg);
    /** 配对 + 建连 + 认证。成功返回 true，之后 channel_ 可用。 */
    bool pair_and_connect(const std::string& peer_id, const std::string& peer_name,
                          const p2p::PublicKeyJwk& peer_key);
    void teardown_peer(const std::string& reason);
    bool setup_peer_channel(const std::string& peer_id, const p2p::PublicKeyJwk& peer_key,
                            int wait_ms = 30000);

    /**
     * 配过对的设备。存在 state_dir/contacts.json，重启后还能连回去，
     * 不用每次重新输码。只有信令线程读写（构造时加载一次）。
     */
    struct Contact {
        std::string id;
        std::string name;
        p2p::PublicKeyJwk public_key;
        /** web / native；旧记录没有这一项，空串表示不知道 */
        std::string platform;
    };
    void load_contacts();
    /// 写成功返回 true；失败时调用方负责回滚内存里的改动
    bool save_contacts();
    void add_contact(const Contact& contact);
    /**
     * 重发完整的 watch 列表。
     *
     * 灯塔对 watch 是**整体替换**，不是增量：只发当前对端，别的联系人的
     * presence 就停了。配对、加入、删除设备、重连之后都必须整表重发一次。
     * extra 用来把还没进通讯录、但正在配对的设备也带上。
     */
    void send_watch_all(const std::string& extra = "");
    const Contact* find_contact(const std::string& id) const;

    p2p::Identity identity_;
    p2p::Settings settings_;
    /** 记录和设置放哪 */
    std::filesystem::path state_dir_;
    Emit emit_;

    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<Request> requests_;
    std::map<std::string, DeviceEntry> devices_;
    bool stopping_ = false;

    /** 接收目录可能被界面线程改，接收线程每轮加锁读一次。 */
    std::mutex save_dir_mutex_;
    std::string save_dir_;

    /** 对端信息。只有信令线程写，界面通过 emit 拿。 */
    std::string peer_id_;
    std::string peer_name_;
    bool paired_ = false;
    /** 配对过的设备。重启后从 contacts.json 恢复，用来直接重连。 */
    std::vector<Contact> contacts_;
    /**
     * 对端先发来的 offer。收到时信令线程还没建 Peer，先存住，
     * 等 setup_peer_channel 建好会话再喂进去。
     */
    nlohmann::json pending_offer_;
    std::string pending_offer_from_;
    bool has_pending_offer_ = false;
    /**
     * 查码拿到、还没用上的对端公钥。
     *
     * 配对分两步走：先查码（code-owner，这里带回对端公钥），再发配对请求，
     * 等对方回 pair-response 才能开始建连。中间这一步必须把公钥存住，
     * 否则建连的时候没有公钥可以拿去认证。
     */
    p2p::PublicKeyJwk pending_peer_key_;
    bool has_pending_key_ = false;
    /**
     * 用哪个码去查的对方。
     *
     * pair-request 必须带上它：码主（网页端）拿它证明"来找我的这个人确实
     * 拿到了我屏幕上的码"。不带的话码主会直接拒绝，界面上只看到"对方拒绝"。
     */
    std::string outgoing_code_;
    /** 用户要过码，重连之后要重新要一个（旧码可能已经过期）。 */
    std::atomic<bool> advertising_{false};
    /** 码主这侧发出去的码和过期时间。只有信令线程读写。 */
    std::map<std::string, int64_t> issued_codes_;
    int64_t last_code_request_ms_ = 0;
    /** 输码方等 pair-response 的截止时间，0 表示没在等。 */
    int64_t join_deadline_ms_ = 0;
    PairConfirmer confirm_pair_;
    /**
     * 掉线后要等它上线的设备。原生端不做重试倒计时：保持离线，
     * 等 lighthouse 报对方上线，再从这里静默建连。
     * 只在 mutex_ 下读写。
     */
    std::string waiting_peer_;
    /** 静默建连时不要把失败做成错误气泡：对方可能只是又掉线了。 */
    bool quiet_setup_ = false;

    std::unique_ptr<p2p::SignalLink> link_;
    std::unique_ptr<ShareHub> share_hub_;
    std::unique_ptr<p2p::Peer> peer_;
    std::shared_ptr<rtc::DataChannel> channel_;
    p2p::MessageQueue inbox_;
    p2p::AckTracker acks_;
    /**
     * 传输取消。发送和接收各一个标记，互相独立：双向同时传的时候
     * 取消一边不能把另一边也停掉。正在传的 id 用来核对界面点的确实是这一条。
     */
    std::mutex transfer_mutex_;
    std::string send_active_id_;
    std::string recv_active_id_;
    /** 对端 cancel 帧里带来的取消原因，发送等待被唤醒后据此生成提示，受 transfer_mutex_ 保护。 */
    std::string send_cancel_reason_;
    std::atomic<bool> send_cancel_{false};
    std::atomic<bool> recv_cancel_{false};
    std::atomic<bool> channel_ready_{false};
    /**
     * 每建一次通道就加一。收线程退出时拿它判断自己守的还是不是当前那条：
     * 换连时旧线程会跟着旧通道一起结束，不能让它把新连接的状态改成"已断开"。
     */
    std::atomic<uint64_t> channel_gen_{0};

    std::thread signal_thread_;
    std::thread receive_thread_;
    std::thread send_thread_;
};

}  // namespace shell
