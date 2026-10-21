#pragma once
// 公开链接分享（分享者一侧）。
//
// 和配对那条路刻意分开：
//   - 不走通讯录，也不核对六位数字，准入凭据就是"手里有链接"；
//   - 永远是分享者发 offer（访客多少、先后是运行时才定的，名额在分享者手里）；
//   - 访客的公钥来自 share-connect，只做"设备号确实由这把公钥推导"的自洽检查。
//
// 独立于 Session 的已配对连接：分享一个文件不能把当前配对的那台设备挤掉。
// 信令仍然走 Session 的那条 SignalLink，由 Session 把 share-* 和访客的 sdp/ice 转进来。
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>
#include <rtc/rtc.hpp>

#include "crypto.h"
#include "flow.h"
#include "peer.h"
#include "signal.h"

namespace shell {

class ShareHub {
public:
    using Emit = std::function<void(const nlohmann::json&)>;

    ShareHub(p2p::Identity identity, std::string state_dir, p2p::SignalLink* link,
             std::string lighthouse, std::function<std::string()> device_name, Emit emit);
    ~ShareHub();

    ShareHub(const ShareHub&) = delete;
    ShareHub& operator=(const ShareHub&) = delete;

    /** 从注册表要一个 token 并挂出文件。会阻塞在网络请求上，只在信令线程上调。 */
    void create(const std::string& path);
    /** 撤销：先改本地，再通知注册表和正在取件的访客。 */
    void revoke(const std::string& token);
    /** 把当前所有分享整个发给界面 */
    void emit_shares();
    /** 这条信令是不是这个分享访客的（sdp/ice 路由用） */
    bool is_active_peer(const std::string& device_id) const;
    /** 处理 share-* / 分享访客的 sdp、ice。只在信令线程上调。 */
    void handle_signal(const nlohmann::json& msg);
    /** 收尾：中止正在发送的访客连接并等线程退出。 */
    void stop();

private:
    struct Share {
        std::string token;
        std::string path;
        std::string name;
        std::string mime;
        uint64_t size = 0;
        int64_t expires_at = 0;
        std::string phase = "idle";
        std::string visitor_name;
    };

    void load();
    void save_locked();
    Share* find_locked(const std::string& token);
    void start_serve(const Share& share, const std::string& visitor_id,
                     const p2p::PublicKeyJwk& visitor_key, const std::string& visitor_name);
    void serve(std::string visitor_id, p2p::PublicKeyJwk visitor_key,
               std::string visitor_name, std::string token, std::string path);
    void finish_serve(const std::string& token, const std::string& visitor_name, bool ok,
                      const std::string& note);
    void refuse(const std::string& to, const std::string& token, const std::string& reason);
    void set_visitor_phase(const std::string& token, const std::string& phase,
                           const std::string& visitor_name);

    p2p::Identity identity_;
    std::string state_dir_;
    p2p::SignalLink* link_ = nullptr;
    std::string origin_;
    std::function<std::string()> device_name_;
    Emit emit_;

    mutable std::mutex mutex_;
    std::vector<Share> shares_;
    std::atomic<bool> stopping_{false};
    bool active_ = false;
    std::string active_token_;
    std::string active_visitor_;
    std::shared_ptr<p2p::Peer> peer_;
    std::shared_ptr<rtc::DataChannel> channel_;
    std::shared_ptr<p2p::MessageQueue> inbox_;
    std::shared_ptr<std::atomic<bool>> cancel_;
    std::thread serve_thread_;
};

}  // namespace shell
