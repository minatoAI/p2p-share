// 这几个流式/文件系统头必须排在项目头前面：nlohmann 的 json.hpp 会按
// __cpp_lib_filesystem 决定要不要生成 filesystem 的转换代码，头序颠倒时
// 它会在 path 还没声明的时候就去引用，报一堆看起来毫不相干的错。
#include <filesystem>
#include <fstream>
#include <istream>

#include "session.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <iostream>

#include "pairing.h"
#include "share_link.h"

using namespace std::chrono;
using nlohmann::json;

namespace shell {
namespace {

json write_jwk(const p2p::PublicKeyJwk& jwk) {
    return json{{"kty", jwk.kty}, {"crv", jwk.crv}, {"x", jwk.x}, {"y", jwk.y}};
}

p2p::PublicKeyJwk read_jwk(const json& node) {
    p2p::PublicKeyJwk jwk;
    jwk.kty = node.at("kty").get<std::string>();
    jwk.crv = node.at("crv").get<std::string>();
    jwk.x = node.at("x").get<std::string>();
    jwk.y = node.at("y").get<std::string>();
    return jwk;
}

/** 手输的码可能带空格（"482 139"），灯塔只认六位数字 */
std::string normalize_code(const std::string& text) {
    std::string digits;
    for (const char c : text) {
        if (c >= '0' && c <= '9') digits.push_back(c);
    }
    return digits.size() == 6 ? digits : text;
}

/** 灯塔掉线后的重连阶梯：先快后慢，封顶十秒 */
int reconnect_delay_ms(int failures) {
    constexpr int kDelays[] = {1000, 2000, 5000, 10000};
    const int index = std::min(failures - 1, 3);
    return kDelays[std::max(index, 0)];
}

std::string trim(std::string text) {
    const auto not_space = [](unsigned char c) { return !std::isspace(c); };
    text.erase(text.begin(), std::find_if(text.begin(), text.end(), not_space));
    text.erase(std::find_if(text.rbegin(), text.rend(), not_space).base(), text.end());
    return text;
}

/**
 * 取消原因到用户可见文案。docs/36 第 3 节要求三端显示同一句话：
 * screen-off / user / peer-offline，不认识的 reason 和缺失一律按「已取消」。
 */
std::string cancel_message(const std::string& reason) {
    if (reason == "screen-off") return "已取消（屏幕关闭）";
    if (reason == "peer-offline") return "已取消（对方离线）";
    return "已取消";
}

}  // namespace

Session::Session(p2p::Identity identity, p2p::Settings settings,
                 std::filesystem::path state_dir, Emit emit)
    : identity_(std::move(identity)),
      settings_(std::move(settings)),
      state_dir_(std::move(state_dir)),
      emit_(std::move(emit)) {
    save_dir_ = settings_.save_dir;
    load_contacts();
    // 配对一次就记住：重启后等最近配对的那台上线，直接连回去。
    if (!contacts_.empty()) waiting_peer_ = contacts_.front().id;
}

Session::~Session() { stop(); }

void Session::set_save_dir(const std::string& dir) {
    {
        std::lock_guard<std::mutex> lock(save_dir_mutex_);
        save_dir_ = dir;
    }
    std::printf("[会话] 保存目录改为 %s\n", dir.c_str());
    std::fflush(stdout);
}

void Session::load_contacts() {
    const auto path = state_dir_ / "contacts.json";
    std::ifstream in(path, std::ios::binary);
    if (!in) return;
    try {
        json root;
        in >> root;
        for (const auto& item : root.at("contacts")) {
            Contact contact;
            contact.id = item.at("id").get<std::string>();
            contact.name = item.value("name", "");
            contact.platform = item.value("platform", "");
            contact.public_key = read_jwk(item.at("publicKey"));
            // 设备号必须由公钥推导，对不上就当这条记录坏了
            if (contact.public_key.device_id() != contact.id) continue;
            contacts_.push_back(std::move(contact));
        }
        std::printf("[会话] 读到 %zu 台配对过的设备\n", contacts_.size());
        std::fflush(stdout);
    } catch (const std::exception& e) {
        std::cerr << "[会话] contacts.json 读不了，按空的算：" << e.what() << std::endl;
        contacts_.clear();
    }
}

bool Session::save_contacts() {
    json items = json::array();
    for (const auto& contact : contacts_) {
        items.push_back({{"id", contact.id},
                         {"name", contact.name},
                         {"platform", contact.platform},
                         {"publicKey", write_jwk(contact.public_key)}});
    }
    std::error_code ec;
    std::filesystem::create_directories(state_dir_, ec);
    const auto path = state_dir_ / "contacts.json";
    const auto tmp = state_dir_ / "contacts.json.tmp";
    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) {
            std::cerr << "[会话] contacts.json 写不进去" << std::endl;
            return false;
        }
        out << json{{"contacts", items}}.dump(2);
        if (!out) {
            std::cerr << "[会话] contacts.json 写到一半失败" << std::endl;
            return false;
        }
    }
    std::filesystem::copy_file(tmp, path, std::filesystem::copy_options::overwrite_existing,
                               ec);
    std::filesystem::remove(tmp, ec);
    if (ec) {
        std::cerr << "[会话] contacts.json 替换失败：" << ec.message() << std::endl;
        return false;
    }
    return true;
}

void Session::add_contact(const Contact& contact) {
    for (auto& existing : contacts_) {
        if (existing.id == contact.id) {
            existing.name = contact.name;
            if (!contact.platform.empty()) existing.platform = contact.platform;
            existing.public_key = contact.public_key;
            save_contacts();
            emit_contacts();
            return;
        }
    }
    contacts_.insert(contacts_.begin(), contact);
    // 网页端每次开新会话可能换身份，配对记录会一直攒；留最近 20 台够了
    if (contacts_.size() > 20) contacts_.resize(20);
    save_contacts();
    emit_contacts();
}

const Session::Contact* Session::find_contact(const std::string& id) const {
    for (const auto& contact : contacts_) {
        if (contact.id == id) return &contact;
    }
    return nullptr;
}

void Session::send_watch_all(const std::string& extra) {
    if (!link_ || !link_->connected()) return;
    json ids = json::array();
    std::vector<std::string> seen;
    auto add = [&](const std::string& id) {
        if (id.empty()) return;
        if (std::find(seen.begin(), seen.end(), id) != seen.end()) return;
        seen.push_back(id);
        ids.push_back(id);
    };
    for (const auto& contact : contacts_) add(contact.id);
    if (paired_) add(peer_id_);
    add(extra);
    // 空列表也要发：灯塔的 watch 是整体替换，删掉最后一台设备时只有发
    // `{"ids":[]}` 才能把旧订阅清掉，否则那台设备上下线还会继续推过来。
    link_->send(json{{"t", "watch"}, {"ids", ids}});
}

void Session::connect(const std::string& peer_id) {
    Request request;
    request.command = Command::Connect;
    request.text = peer_id;
    push(std::move(request));
}

void Session::remove_contact(const std::string& peer_id) {
    Request request;
    request.command = Command::RemoveContact;
    request.text = peer_id;
    push(std::move(request));
}

void Session::rename_contact(const std::string& peer_id, const std::string& name) {
    Request request;
    request.command = Command::RenameContact;
    request.text = peer_id;
    request.value = name;
    push(std::move(request));
}

void Session::set_device_name(const std::string& name) {
    if (trim(name).empty()) return;
    Request request;
    request.command = Command::SetDeviceName;
    request.text = trim(name);
    push(std::move(request));
}

void Session::share_file(const std::string& path) {
    if (path.empty()) return;
    Request request;
    request.command = Command::ShareFile;
    request.text = path;
    push(std::move(request));
}

void Session::revoke_share(const std::string& token) {
    if (token.empty()) return;
    Request request;
    request.command = Command::RevokeShare;
    request.text = token;
    push(std::move(request));
}

void Session::start() {
    if (signal_thread_.joinable()) return;
    // 对象本身在会话存活期间不换：Peer 持有它的指针，断线重连只换里面的 socket
    link_ = std::make_unique<p2p::SignalLink>(settings_.lighthouse, identity_.device_id(),
                                             settings_.device_name);
    share_hub_ = std::make_unique<ShareHub>(
        identity_, state_dir_.u8string(), link_.get(), settings_.lighthouse,
        [this]() { return settings_.device_name; },
        [this](const json& msg) { emit_(msg); });
    signal_thread_ = std::thread([this]() { signal_loop(); });
    // 发送单独一条线程：它会阻塞在等确认上，不能占着信令线程
    send_thread_ = std::thread([this]() { send_loop(); });
}

void Session::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopping_) return;
        stopping_ = true;
    }
    cv_.notify_all();
    if (link_) link_->close();
    inbox_.close();
    if (send_thread_.joinable()) send_thread_.join();
    if (receive_thread_.joinable()) receive_thread_.join();
    if (signal_thread_.joinable()) signal_thread_.join();
    if (share_hub_) {
        share_hub_->stop();
        share_hub_.reset();
    }
}

void Session::push(Request request) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        requests_.push_back(std::move(request));
    }
    cv_.notify_all();
}

bool Session::pop_request(Request* out, int timeout_ms, bool send_only) {
    std::unique_lock<std::mutex> lock(mutex_);
    auto matches = [send_only](const Request& request) {
        const bool is_send = request.command == Command::SendFiles ||
                             request.command == Command::SendText;
        return send_only ? is_send : !is_send;
    };
    auto find = [&]() { return std::find_if(requests_.begin(), requests_.end(), matches); };
    if (!cv_.wait_for(lock, milliseconds(timeout_ms),
                      [&]() { return stopping_ || find() != requests_.end(); })) {
        return false;
    }
    auto it = find();
    if (it == requests_.end()) return false;
    *out = std::move(*it);
    requests_.erase(it);
    return true;
}

void Session::emit_state(const std::string& value, const std::string& detail) {
    if (!emit_) return;
    json msg{{"t", "state"}, {"value", value}};
    if (!detail.empty()) msg["detail"] = detail;
    emit_(msg);
}

void Session::emit_debug(const std::string& text) {
    if (emit_) emit_(json{{"t", "debug"}, {"text", text}});
}

void Session::emit_devices() {
    if (!emit_) return;
    json items = json::array();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [id, entry] : devices_) {
            items.push_back({{"id", entry.id}, {"name", entry.name}, {"online", entry.online}});
        }
    }
    emit_(json{{"t", "presence"}, {"items", items}});
}

void Session::emit_contacts() {
    if (!emit_) return;
    json items = json::array();
    for (const auto& contact : contacts_) {
        items.push_back({{"id", contact.id},
                         {"name", contact.name},
                         {"platform", contact.platform}});
    }
    emit_(json{{"t", "contacts"}, {"items", items}});
}

void Session::emit_history() {
    if (!emit_) return;
    json items = json::array();
    for (const auto& entry : p2p::load_history(state_dir_, 50)) {
        items.push_back(entry.to_json());
    }
    emit_(json{{"t", "history"}, {"items", items}});
}

void Session::record(const std::string& direction, const std::string& path, uint64_t size,
                     const std::string& transfer_id) {
    p2p::HistoryEntry entry;
    entry.direction = direction;
    entry.path = path;
    const size_t cut = path.find_last_of("/\\");
    entry.name = cut == std::string::npos ? path : path.substr(cut + 1);
    entry.peer = peer_name_;
    entry.size = size;
    entry.at_ms = p2p::now_ms();
    p2p::append_history(state_dir_, entry);
    if (emit_) {
        json item = entry.to_json();
        // 只随事件发给界面，用来把"进行中"那一行原地收尾；历史文件格式不动。
        // 接收落盘会自动改名，光靠文件名对不上原来的进度行。
        if (!transfer_id.empty()) item["id"] = transfer_id;
        emit_(json{{"t", "history"}, {"items", json::array({item})}, {"append", true}});
    }
}

std::vector<DeviceEntry> Session::devices() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<DeviceEntry> out;
    out.reserve(devices_.size());
    for (const auto& [id, entry] : devices_) out.push_back(entry);
    return out;
}

void Session::advertise() {
    advertising_ = true;
    Request request;
    request.command = Command::Advertise;
    push(std::move(request));
}

void Session::stop_advertise() {
    advertising_ = false;
}

void Session::set_pair_confirmer(PairConfirmer confirmer) {
    confirm_pair_ = std::move(confirmer);
}

void Session::join(const std::string& code) {
    Request request;
    request.command = Command::Join;
    request.text = normalize_code(code);
    push(std::move(request));
}

void Session::send_files(const std::vector<std::string>& paths) {
    Request request;
    request.command = Command::SendFiles;
    request.paths = paths;
    push(std::move(request));
}

void Session::send_text(const std::string& text) {
    Request request;
    request.command = Command::SendText;
    request.text = text;
    push(std::move(request));
}

void Session::cancel_transfer(const std::string& id, bool incoming) {
    bool matched = false;
    {
        std::lock_guard<std::mutex> lock(transfer_mutex_);
        const std::string& active = incoming ? recv_active_id_ : send_active_id_;
        matched = !active.empty() && (id.empty() || id == active);
        if (matched) {
            if (incoming) {
                recv_cancel_.store(true);
            } else {
                send_cancel_.store(true);
            }
        }
    }
    if (!matched) {
        // 已经传完了或者不是这一条，安静地忽略：界面上那条进度也该消失了
        emit_debug("取消请求没有对应的传输");
    }
}

void Session::disconnect_peer() {
    Request request;
    request.command = Command::Disconnect;
    push(std::move(request));
}

void Session::cancel_pairing() {
    Request request;
    request.command = Command::CancelPair;
    push(std::move(request));
}

void Session::handle_presence(const json& msg) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (msg.contains("id") && msg["id"].is_string()) {
            // 单条更新
            DeviceEntry entry;
            entry.id = msg.value("id", "");
            entry.online = msg.value("online", false);
            auto it = devices_.find(entry.id);
            if (it != devices_.end()) entry.name = it->second.name;
            if (msg.contains("name") && msg["name"].is_string()) entry.name = msg["name"];
            devices_[entry.id] = entry;
        } else if (msg.contains("items") && msg["items"].is_array()) {
            for (const auto& item : msg["items"]) {
                DeviceEntry entry;
                entry.id = item.value("id", "");
                entry.name = item.value("name", "");
                entry.online = item.value("online", false);
                devices_[entry.id] = entry;
            }
        }
    }
    emit_devices();

    // 掉线后不重试；等这里报对方上线，再静默连一次。
    std::string wanted;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!channel_ready_) wanted = waiting_peer_;
    }
    if (wanted.empty()) return;
    const Contact* contact = find_contact(wanted);
    if (!contact) return;
    bool online = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = devices_.find(wanted);
        online = it != devices_.end() && it->second.online;
    }
    if (!online) return;
    // 已经连着就别再建一条
    if (channel_ready_ && peer_id_ == wanted) return;

    emit_debug("对方上线，静默建连 " + wanted);
    peer_name_ = contact->name;
    quiet_setup_ = true;
    emit_state("connecting", "对方上线，正在连接 " + contact->name);
    const bool ok = setup_peer_channel(wanted, contact->public_key, 10000);
    quiet_setup_ = false;
    if (!ok) emit_state("offline", "等 " + contact->name + " 上线");
}

void Session::teardown_peer(const std::string& reason) {
    channel_ready_ = false;
    // 让还在跑的收线程知道它守的通道已经作废，别把状态改回"已断开"
    ++channel_gen_;
    // 连接都没了，还在传的那条赶紧停，别让发送线程干等到确认超时
    {
        std::lock_guard<std::mutex> lock(transfer_mutex_);
        send_cancel_.store(true);
        recv_cancel_.store(true);
    }
    if (channel_) channel_->close();
    channel_.reset();
    peer_.reset();
    acks_.clear();
    paired_ = false;
    peer_id_.clear();
    peer_name_.clear();
    has_pending_key_ = false;
    has_pending_offer_ = false;
    pending_offer_from_.clear();
    if (!reason.empty()) emit_state("ready", reason);
}

bool Session::setup_peer_channel(const std::string& peer_id, const p2p::PublicKeyJwk& peer_key,
                                 int wait_ms) {
    const std::string my_id = identity_.device_id();
    const bool initiator = p2p::owns_channel(my_id, peer_id);
    emit_debug("建连开始 " + peer_id + (initiator ? " 我方建通道" : " 等对方建通道") +
               " 等待上限 " + std::to_string(wait_ms / 1000) + " 秒");
    std::printf("[会话] 开始建连 %s（%s，等待上限 %d 秒）\n", peer_id.c_str(),
                initiator ? "我方建通道" : "等对方建通道", wait_ms / 1000);
    std::fflush(stdout);
    // 对端已经发来 offer 的话，这侧就是接的一方，不用再发 connect-request。
    // 要在 teardown 之前取出来：teardown 会清掉挂起的 offer。
    const bool adopting = has_pending_offer_ && pending_offer_from_ == peer_id;
    const json adopt_offer = adopting ? pending_offer_ : json::object();
    // 换连时先把上一条收尾干净，避免两条 PeerConnection 同时在跑
    if (channel_ || peer_) {
        emit_debug("清理上一条连接");
        teardown_peer("");
        emit_debug("上一条连接已清理");
    }
    std::cout << "[会话] 建连，" << (initiator ? "我这侧建通道" : "等对方建通道") << std::endl;

    peer_ = std::make_unique<p2p::Peer>(my_id, peer_id, initiator, link_.get());
    peer_->on_message([this](rtc::message_variant msg) { inbox_.push(std::move(msg)); });
    emit_debug("Peer 已创建，开始等通道");

    if (adopting) {
        peer_->handle(adopt_offer);
        has_pending_offer_ = false;
        pending_offer_from_.clear();
    } else if (!initiator) {
        link_->send(json{{"t", "connect-request"}, {"from", my_id}, {"to", peer_id}});
    }

    // 等通道打开。信令线程在这里要一边等一边转信令。
    // 灯塔断了就立刻收手：这条握手已经没有中继可用，等满超时只会拖住信令。
    const auto deadline = steady_clock::now() + milliseconds(wait_ms);
    while (steady_clock::now() < deadline && !stopping_ && !link_->closed()) {
        json msg;
        if (link_->next(&msg, 200)) {
            const std::string t = msg.value("t", "");
            if (t == "sdp" || t == "ice") {
                if (peer_) peer_->handle(msg);
            }
        }
        auto channel = peer_ ? peer_->channel() : nullptr;
        if (channel && channel->isOpen()) {
            channel_ = channel;
            break;
        }
        if (peer_ && peer_->failed()) break;
    }
    std::printf("[会话] 等待结束，通道%s\n", channel_ ? "已打开" : "没打开");
    std::fflush(stdout);

    if (!channel_) {
        emit_debug("等通道超时 " + std::to_string(wait_ms / 1000) + " 秒");
        if (!quiet_setup_) emit_state("error", "数据通道没建起来");
        teardown_peer("");
        return false;
    }
    std::cout << "[会话] 数据通道已打开，开始认证" << std::endl;
    if (!p2p::authenticate(channel_, identity_, peer_id, peer_key, &inbox_, 20000)) {
        if (!quiet_setup_) emit_state("error", "双向认证没通过");
        teardown_peer("");
        return false;
    }

    peer_id_ = peer_id;
    paired_ = true;
    // 配对已经完成，屏幕上的码不再需要了
    advertising_ = false;
    channel_ready_ = true;
    {
        // 配对一次就记住对方：掉线后保持离线，等它上线再静默连回
        std::lock_guard<std::mutex> lock(mutex_);
        waiting_peer_ = peer_id;
    }

    // 接收线程必须在宣布"已连接"之前起来。
    // 反过来的话有个真实的竞态：界面一收到 connected 就立刻开始发，而对端回的
    // ack 落进队列时这条循环还没跑起来，发送侧就一直等一个已经躺在队列里
    // 却没人取的确认。顺序换一下，这个窗口就没了。
    if (receive_thread_.joinable()) receive_thread_.join();
    const uint64_t generation = ++channel_gen_;
    receive_thread_ = std::thread([this, channel = channel_, generation, peer_id]() {
        receive_loop(channel, generation, peer_id);
    });

    emit_(json{{"t", "peer"}, {"id", peer_id}, {"name", peer_name_}});
    emit_state("connected", peer_name_);
    std::cout << "[会话] 已连接 " << peer_name_ << " " << peer_id << std::endl;
    return true;
}

bool Session::pair_and_connect(const std::string& peer_id, const std::string& peer_name,
                               const p2p::PublicKeyJwk& peer_key) {
    peer_name_ = peer_name;
    return setup_peer_channel(peer_id, peer_key);
}

bool Session::connect_lighthouse() {
    emit_debug("等待灯塔连接");
    const auto deadline = steady_clock::now() + seconds(8);
    while (steady_clock::now() < deadline && !stopping_) {
        if (link_->connected()) break;
        if (link_->closed()) {
            emit_debug("灯塔连接已关闭");
            return false;
        }
        std::this_thread::sleep_for(milliseconds(50));
    }
    emit_debug(std::string("灯塔连接结果 open=") + (link_->connected() ? "1" : "0") +
               " closed=" + (link_->closed() ? "1" : "0"));
    if (!link_->connected()) return false;

    link_->send(json{{"t", "hello"},
                     {"deviceId", identity_.device_id()},
                     {"name", settings_.device_name},
                     {"publicKey", write_jwk(identity_.public_jwk())}});
    std::cout << "[会话] 灯塔已连接" << std::endl;

    // 重启后灯塔那边没有订阅记录了，把配对过的设备全登记一遍，
    // 对方上线/掉线才能收到 presence。当前对端也在通讯录里。
    send_watch_all();

    if (channel_ready_) {
        // 界面回到"已连接"：点对点链路在灯塔掉线期间一直没断。
        emit_state("connected", peer_name_);
    } else {
        emit_state("ready", "");
        // 用户正停在配对页的话，旧码多半已经过期，重新要一个
        if (advertising_) {
            link_->send(json{{"t", "new-code"}});
            last_code_request_ms_ = p2p::now_ms();
        }
    }
    return true;
}

bool Session::wait_backoff(int delay_ms) {
    std::unique_lock<std::mutex> lock(mutex_);
    // 请求入队也会通知 cv_，但谓词只认停止，所以会接着把剩下的时间等完
    cv_.wait_for(lock, milliseconds(delay_ms), [this]() { return stopping_; });
    return !stopping_;
}

void Session::signal_loop() {
    const std::string my_id = identity_.device_id();
    std::cout << "[会话] 连灯塔 " << settings_.lighthouse << std::endl;
    emit_state("lighthouse-connecting", "");
    emit_contacts();
    if (share_hub_) share_hub_->emit_shares();

    int failures = 0;
    bool first_attempt = true;
    bool history_sent = false;
    while (!stopping_) {
        if (!first_attempt) link_->reconnect();
        first_attempt = false;

        if (!connect_lighthouse()) {
            if (stopping_) break;
            ++failures;
            emit_debug("灯塔没连上，第 " + std::to_string(failures) + " 次失败");
            const int delay = reconnect_delay_ms(failures);
            std::printf("[会话] 灯塔没连上，%d 秒后重试（第 %d 次）\n", delay / 1000, failures);
            std::fflush(stdout);
            // 有对端在的时候不要把界面拉回"连灯塔中"：链路还活着，
            // 灯塔掉线只影响再次配对，不影响已经建好的连接。
            if (!paired_) {
                emit_state("lighthouse-connecting",
                           "灯塔没连上，" + std::to_string(delay / 1000) + " 秒后重试（第 " +
                               std::to_string(failures) + " 次）");
            }
            if (!wait_backoff(delay)) break;
            continue;
        }

        failures = 0;
        if (!history_sent) {
            emit_history();  // 界面一就绪就把历史铺上去
            history_sent = true;
        }

        while (!stopping_ && !link_->closed()) {
            // 码的寿命只有二十秒，不主动换的话用户看两眼就过期了。
            // 和网页端、安卓端一致，每十秒要一个新的；服务端保留最近两个。
            if (advertising_) {
                const int64_t now = p2p::now_ms();
                if (last_code_request_ms_ == 0 || now - last_code_request_ms_ >= 10000) {
                    link_->send(json{{"t", "new-code"}});
                    last_code_request_ms_ = now;
                }
            }
            if (join_deadline_ms_ > 0 && p2p::now_ms() > join_deadline_ms_) {
                join_deadline_ms_ = 0;
                outgoing_code_.clear();
                emit_state("error", "对方一直没回应，重新要个码再试");
            }

            Request request;
            if (pop_request(&request, 0, false)) {
                switch (request.command) {
                    case Command::Advertise:
                        {
                            std::lock_guard<std::mutex> lock(mutex_);
                            waiting_peer_.clear();
                        }
                        std::printf("[会话] 向灯塔要码\n");
                        std::fflush(stdout);
                        emit_state("pairing", "已向灯塔要码");
                        last_code_request_ms_ = 0;  // 下一轮立刻发
                        break;
                    case Command::Join: {
                        {
                            std::lock_guard<std::mutex> lock(mutex_);
                            waiting_peer_.clear();
                        }
                        std::printf("[会话] 查码 %s\n", request.text.c_str());
                        std::fflush(stdout);
                        emit_state("pairing", "正在查码");
                        // 等 code-owner 回来发 pair-request 时要带上它
                        outgoing_code_ = request.text;
                        join_deadline_ms_ = p2p::now_ms() + 15000;
                        link_->send(json{{"t", "lookup-code"}, {"code", request.text}});
                        break;
                    }
                    case Command::Connect: {
                        const Contact* contact = find_contact(request.text);
                        if (!contact) {
                            emit_state("error", "这台设备没配对过，先用码配一次");
                            break;
                        }
                        if (channel_ready_ && peer_id_ == contact->id) {
                            emit_state("connected", peer_name_);
                            break;
                        }
                        {
                            std::lock_guard<std::mutex> lock(mutex_);
                            waiting_peer_ = contact->id;
                        }
                        bool online = false;
                        {
                            std::lock_guard<std::mutex> lock(mutex_);
                            auto it = devices_.find(contact->id);
                            online = it != devices_.end() && it->second.online;
                        }
                        send_watch_all(contact->id);
                        peer_name_ = contact->name;
                        if (!online) {
                            // 对方现在不在线：不重试，只等 lighthouse 报它上线
                            emit_state("offline", "等 " + contact->name + " 上线");
                            break;
                        }
                        std::printf("[会话] 连回 %s（%s）\n", contact->name.c_str(),
                                    contact->id.c_str());
                        std::fflush(stdout);
                        emit_state("connecting", "正在连接 " + contact->name);
                        setup_peer_channel(contact->id, contact->public_key, 10000);
                        break;
                    }
                    case Command::SendFiles:
                    case Command::SendText:
                        // 发送由发送线程做，这里不掺和
                        break;
                    case Command::Disconnect: {
                        {
                            std::lock_guard<std::mutex> lock(mutex_);
                            waiting_peer_.clear();
                        }
                        teardown_peer("已断开");
                        break;
                    }
                    case Command::CancelPair: {
                        has_pending_key_ = false;
                        outgoing_code_.clear();
                        join_deadline_ms_ = 0;
                        emit_(json{{"t", "pair-hide"}});
                        emit_state("ready", "已取消配对");
                        break;
                    }
                    case Command::RemoveContact: {
                        const auto it = std::find_if(
                            contacts_.begin(), contacts_.end(),
                            [&](const Contact& contact) { return contact.id == request.text; });
                        if (it == contacts_.end()) break;
                        const std::string id = it->id;
                        contacts_.erase(it);
                        save_contacts();
                        emit_contacts();
                        {
                            std::lock_guard<std::mutex> lock(mutex_);
                            if (waiting_peer_ == id) waiting_peer_.clear();
                        }
                        if (peer_id_ == id) teardown_peer("已删除这台设备");
                        // watch 是整体替换：删掉一台之后也要重新登记剩下的，
                        // 否则被删的那台再上线/掉线还会推过来。
                        send_watch_all();
                        break;
                    }
                    case Command::RenameContact: {
                        const std::string name = trim(request.value);
                        if (name.empty()) break;
                        bool found = false;
                        bool saved = false;
                        for (auto& contact : contacts_) {
                            if (contact.id != request.text) continue;
                            found = true;
                            // 写盘失败就把内存里的名字改回去，别让界面和磁盘各说各话
                            const std::string previous = contact.name;
                            contact.name = name;
                            saved = save_contacts();
                            if (!saved) contact.name = previous;
                            break;
                        }
                        if (emit_) {
                            // 页面按这条回执决定要不要提示"已改名"，不再自己先报成功
                            emit_(json{{"t", "contact-renamed"},
                                       {"id", request.text},
                                       {"name", saved ? name : std::string()},
                                       {"ok", saved}});
                        }
                        if (saved) {
                            if (peer_id_ == request.text) peer_name_ = name;
                        } else if (!found) {
                            emit_debug("通讯录里没有这台设备，改名没生效");
                        } else {
                            emit_debug("通讯录写盘失败，名字改回去了");
                        }
                        // 失败时也发一次：页面乐观改过的名字要靠它回滚
                        emit_contacts();
                        break;
                    }
                    case Command::SetDeviceName: {
                        const std::string name = trim(request.text);
                        if (name.empty()) break;
                        settings_.device_name = name;
                        if (link_) {
                            link_->set_name(name);
                            // 断一次，让外层重连和 hello 用上新名字；
                            // 点对点通道不动，界面不会掉回"等待对方"
                            link_->drop();
                        }
                        emit_debug("设备名改为 " + name + "，正在向灯塔重新报到");
                        std::printf("[会话] 设备名改为 %s\n", name.c_str());
                        std::fflush(stdout);
                        break;
                    }
                    case Command::ShareFile:
                        if (share_hub_) share_hub_->create(request.text);
                        break;
                    case Command::RevokeShare:
                        if (share_hub_) share_hub_->revoke(request.text);
                        break;
                }
                continue;
            }

            json msg;
            if (!link_->next(&msg, 100)) continue;
            const std::string t = msg.value("t", "");

            // 分享的访客不在通讯录里，走单独一条路：share-* 全部交给分享服务；
            // 访客的 sdp/ice 也只在这个访客正被服务时才截下来。
            if (share_hub_) {
                const bool share_message = t.rfind("share-", 0) == 0;
                const bool share_media =
                    (t == "sdp" || t == "ice") &&
                    share_hub_->is_active_peer(msg.value("from", ""));
                if (share_message || share_media) {
                    share_hub_->handle_signal(msg);
                    continue;
                }
            }

            if (t == "sdp" || t == "ice") {
                // 只有当前这条会话还在使用时才转给它。对端重启后我们这边
                // 可能还留着一条已经死掉的 Peer，不能把新 offer 喂进死连接。
                if (peer_ && channel_ready_.load()) {
                    peer_->handle(msg);
                    continue;
                }
                // 没在握手却收到 offer：对方从通讯录里连回来了。
                // 先把 offer 存住，等 PeerConnection 建好再喂进去。
                if (t == "sdp" &&
                    msg.value("description", json::object()).value("type", "") == "offer") {
                    const std::string from = msg.value("from", "");
                    const Contact* contact = find_contact(from);
                    if (contact) {
                        std::printf("[会话] %s 主动连过来，接住 offer\n", contact->name.c_str());
                        std::fflush(stdout);
                        if (channel_ || peer_ || paired_) teardown_peer("");
                        pending_offer_ = msg;
                        pending_offer_from_ = from;
                        has_pending_offer_ = true;
                        peer_name_ = contact->name;
                        setup_peer_channel(from, contact->public_key);
                    }
                }
                continue;
            }
            if (t == "presence") {
                handle_presence(msg);
                continue;
            }
            if (t == "code") {
                const std::string code = msg.value("code", "");
                const int64_t expires = msg.value("expiresAt", 0LL);
                const int64_t now = p2p::now_ms();
                if (!code.empty()) issued_codes_[code] = expires;
                for (auto it = issued_codes_.begin(); it != issued_codes_.end();) {
                    it = it->second < now ? issued_codes_.erase(it) : std::next(it);
                }
                // 和网页端一致：服务端只保留最近两个码，旧的还能用但迟早会过期
                while (issued_codes_.size() > 2) {
                    auto oldest = issued_codes_.begin();
                    for (auto it = issued_codes_.begin(); it != issued_codes_.end(); ++it) {
                        if (it->second < oldest->second) oldest = it;
                    }
                    issued_codes_.erase(oldest);
                }
                emit_(json{{"t", "code"},
                           {"code", code},
                           {"link", p2p::http_origin(settings_.lighthouse) + "/#c=" + code}});
                continue;
            }
            if (t == "code-owner") {
                const std::string peer_id = msg.value("deviceId", "");
                const std::string peer_name = msg.value("name", "");
                std::printf("[会话] 查到码主 %s（%s）\n", peer_name.c_str(), peer_id.c_str());
                std::fflush(stdout);
                // 缺字段要说话，不能悄悄 continue：这里的静默跳过让一次真实的
                // 配对失败查了很久，因为界面上什么都不会显示。
                if (!msg.contains("publicKey")) {
                    std::printf("[会话] 灯塔没带回对端公钥，配不了\n");
                    std::fflush(stdout);
                    emit_state("error", "灯塔没带回对方的公钥");
                    continue;
                }
                const auto peer_key = read_jwk(msg["publicKey"]);
                // 设备号必须由公钥推导，否则"自称是谁"没有约束
                if (peer_key.device_id() != peer_id) {
                    emit_state("error", "对方的公钥和设备号对不上，可能有中间人");
                    continue;
                }
                const std::string join_sas =
                    p2p::short_authentication_string(identity_.public_jwk(), peer_key);
                emit_(json{{"t", "pair-show"},
                           {"id", peer_id},
                           {"name", peer_name},
                           {"sas", join_sas}});
                link_->send(json{{"t", "pair-request"},
                                 {"from", my_id},
                                 {"to", peer_id},
                                 {"code", outgoing_code_},
                                 {"name", settings_.device_name},
                                 {"platform", "native"},
                                 {"publicKey", write_jwk(identity_.public_jwk())}});
                peer_name_ = peer_name;
                // 公钥先存住，等 pair-response 回来建连时要用
                pending_peer_key_ = peer_key;
                has_pending_key_ = true;
                continue;
            }
            // 灯塔会用它自己的 error 帧回话，最常见的是 peer-offline（对方不在线）。
            // 这个分支以前没有，于是"对方不在线"变成了一条什么都不显示的死等，
            // 查了很久才看出来。凡是灯塔说的错都要说出来。
            if (t == "error") {
                emit_(json{{"t", "pair-hide"}});
                const std::string message = msg.value("message", "灯塔报了个错");
                std::printf("[会话] 灯塔报错：%s（%s）\n", message.c_str(),
                            msg.value("code", "").c_str());
                std::fflush(stdout);
                emit_state("error", message);
                continue;
            }
            if (t == "code-miss") {
                emit_(json{{"t", "pair-hide"}});
                const std::string reason = msg.value("reason", "");
                const int64_t retry = msg.value("retryAfterMs", 0LL);
                std::printf("[会话] 配对码没找到：%s\n", reason.c_str());
                std::fflush(stdout);
                outgoing_code_.clear();
                join_deadline_ms_ = 0;
                std::string text = "这个配对码没找到";
                if (!reason.empty()) text += "：" + reason;
                if (retry > 0) text += "（" + std::to_string((retry + 999) / 1000) + " 秒后再试）";
                emit_state("error", text);
                continue;
            }
            if (t == "pair-request") {
                // 有人用我的码来配对了。先证明它确实拿到了我屏幕上的码，
                // 再让用户核对 SAS——这两步少一步，"配对"就只是自报家门。
                const std::string from = msg.value("from", "");
                const std::string name = msg.value("name", "");
                const std::string peer_platform = msg.value("platform", "");
                auto reject = [&](const std::string& reason) {
                    link_->send(json{{"t", "pair-response"},
                                     {"from", my_id},
                                     {"to", from},
                                     {"accepted", false},
                                     {"reason", reason},
                                     {"platform", "native"}});
                    emit_state("error", reason);
                };
                if (!msg.contains("publicKey")) {
                    reject("配对请求里没有公钥");
                    continue;
                }
                const auto peer_key = read_jwk(msg["publicKey"]);
                if (peer_key.device_id() != from) {
                    reject("对方的公钥和设备号对不上");
                    continue;
                }
                const std::string code = msg.value("code", "");
                const auto issued = issued_codes_.find(code);
                const int64_t now = p2p::now_ms();
                if (issued == issued_codes_.end()) {
                    reject("这个配对码不是我发出去的");
                    continue;
                }
                if (issued->second < now) {
                    issued_codes_.erase(issued);
                    reject("配对码已经换过了，让对方用屏幕上新的那个");
                    continue;
                }

                const std::string sas =
                    p2p::short_authentication_string(identity_.public_jwk(), peer_key);
                emit_(json{{"t", "pair-ask"}, {"id", from}, {"name", name}, {"sas", sas}});
                if (confirm_pair_ && !confirm_pair_(name, sas)) {
                    reject("对方拒绝了配对");
                    continue;
                }
                issued_codes_.erase(code);
                advertising_ = false;
                link_->send(json{{"t", "pair-response"},
                                 {"from", my_id},
                                 {"to", from},
                                 {"accepted", true},
                                 {"platform", "native"}});
                send_watch_all(from);
                add_contact(Contact{from, name, peer_key, peer_platform});
                peer_name_ = name;
                setup_peer_channel(from, peer_key);
                continue;
            }
            if (t == "pair-response") {
                emit_(json{{"t", "pair-hide"}});
                join_deadline_ms_ = 0;
                if (!msg.value("accepted", false)) {
                    const std::string reason = msg.value("reason", "");
                    has_pending_key_ = false;
                    outgoing_code_.clear();
                    if (reason.empty() || reason == "对方拒绝了配对") {
                        emit_state("error", "对方没有确认，重新要个码再试");
                    } else {
                        emit_state("error", "对方拒绝了配对：" + reason);
                    }
                    continue;
                }
                outgoing_code_.clear();
                const std::string from = msg.value("from", "");
                const std::string peer_platform = msg.value("platform", "");
                send_watch_all(from);
                // 用码连过去的那一侧也要自己建一份 PeerConnection。
                // 少了这一步，两端都以为对方会建通道，谁都不建，最后双双超时。
                if (has_pending_key_) {
                    const auto peer_key = pending_peer_key_;
                    add_contact(Contact{from, peer_name_, peer_key, peer_platform});
                    setup_peer_channel(from, peer_key);
                    has_pending_key_ = false;
                } else {
                    emit_state("error", "没拿到对方的公钥，建不了连");
                }
                continue;
            }
            if (t == "connect-request") {
                // 对端让我建通道。通道只有设备号大的那侧建，
                // 发这个请求的必然是没建通道权的一侧。
                const std::string from = msg.value("from", "");
                if (channel_ready_ && peer_id_ == from) continue;
                const Contact* contact = find_contact(from);
                if (!contact) continue;
                if (!p2p::owns_channel(my_id, from)) continue;
                std::printf("[会话] %s 请求重连\n", contact->name.c_str());
                std::fflush(stdout);
                if (channel_ || paired_) teardown_peer("");
                peer_name_ = contact->name;
                setup_peer_channel(from, contact->public_key);
                continue;
            }
            if (t == "watch") {
                continue;
            }
        }

        if (stopping_) break;
        std::printf("[会话] 灯塔连接断了，开始重连\n");
        std::fflush(stdout);
        // 掉线后的第一档就是 1 秒；之后按重试次数往上走
        failures = 1;
        if (!paired_) emit_state("lighthouse-connecting", "灯塔掉线，1 秒后重连");
        if (!wait_backoff(reconnect_delay_ms(failures))) break;
    }
    emit_state("stopped", "");
}

void Session::receive_loop(std::shared_ptr<rtc::DataChannel> channel, uint64_t generation,
                           std::string peer_id) {
    p2p::ReceiveOptions options;
    {
        std::lock_guard<std::mutex> lock(save_dir_mutex_);
        options.save_dir = save_dir_;
    }
    // 空转久一点：这个是常驻循环，不是一次性的
    options.idle_timeout_ms = 3000;
    // 常驻循环：空转是常态，不是错
    options.idle_is_error = false;

    /**
     * 应用层心跳。
     *
     * 对端进程被直接杀掉时，SCTP 要几十秒才会把链路判死，界面会一直停在
     * "已连接"。这里空闲 5 秒发一个 ping，4 秒没 pong 就当链路已断。
     * 顺带也回应网页端的 ping——网页的连接测试用的是同一套控制帧。
     */
    std::atomic<int64_t> last_rx{p2p::now_ms()};
    std::atomic<uint64_t> ping_seq{0};
    std::atomic<uint64_t> pending_ping{0};
    int64_t ping_sent_at = 0;
    auto touch = [&last_rx]() { last_rx.store(p2p::now_ms()); };

    options.on_text = [this, &touch](const std::string& text) {
        touch();
        emit_(json{{"t", "text"}, {"text", text}});
    };
    options.on_file_done = [this, &touch](const std::string& path) {
        touch();
        std::string finished_id;
        {
            std::lock_guard<std::mutex> lock(transfer_mutex_);
            finished_id = recv_active_id_;
            recv_active_id_.clear();
            recv_cancel_.store(false);
        }
        emit_(json{{"t", "file-done"}, {"path", path}});
        uint64_t size = 0;
        std::error_code ec;
        size = std::filesystem::file_size(std::filesystem::u8path(path), ec);
        record("in", path, ec ? 0 : size, finished_id);
    };
    options.on_progress = [this, &touch](const p2p::TransferProgress& progress) {
        touch();
        if (progress.incoming) {
            std::lock_guard<std::mutex> lock(transfer_mutex_);
            recv_active_id_ = progress.id;
        }
        emit_(json{{"t", "progress"},
                   {"id", progress.id},
                   {"name", progress.name},
                   {"done", progress.done},
                   {"total", progress.total},
                   {"incoming", progress.incoming}});
    };
    options.on_canceled = [this](const std::string& id, const std::string& name,
                                 const std::string& reason) {
        {
            std::lock_guard<std::mutex> lock(transfer_mutex_);
            recv_active_id_.clear();
            recv_cancel_.store(false);
        }
        emit_(json{{"t", "canceled"},
                   {"id", id},
                   {"name", name},
                   {"incoming", true},
                   {"message", cancel_message(reason)}});
    };
    options.cancel = &recv_cancel_;
    options.on_debug = [this](const std::string& text) { emit_debug("接收：" + text); };
    // ack 是发送侧在等的，交给确认表；ping/pong 是链路存活检测；
    // cancel 是对方取消他们那条发送，得把这边等待确认的发送也停下来
    options.on_control = [this, &touch, &pending_ping, &channel](const json& frame) {
        touch();
        const std::string t = frame.value("t", "");
        if (t == "ack") {
            acks_.on_ack(frame.value("id", ""), frame.value("received", 0ULL));
            return true;
        }
        if (t == "cancel") {
            const std::string id = frame.value("id", "");
            const std::string reason = frame.value("reason", "");
            std::lock_guard<std::mutex> lock(transfer_mutex_);
            if (!send_active_id_.empty() && (id.empty() || id == send_active_id_)) {
                // 发送循环被唤醒后用这句话收尾，别让用户只看到「对方离线」。
                send_cancel_reason_ = reason;
                send_cancel_.store(true);
            }
            return true;
        }
        if (t == "ping") {
            const std::string id = frame.value("id", "");
            try {
                channel->send(json{{"t", "pong"}, {"id", id}}.dump());
            } catch (const std::exception&) {
                // 发不回去就算了，对端会自己判超时
            }
            return true;
        }
        if (t == "pong") {
            if (std::to_string(pending_ping.load()) == frame.value("id", "")) {
                pending_ping.store(0);
            }
            return true;
        }
        return false;
    };

    bool link_dead = false;
    while (!stopping_ && channel_ready_.load()) {
        const int64_t now = p2p::now_ms();
        if (pending_ping.load() == 0 && now - last_rx.load() >= 5000) {
            const uint64_t id = ++ping_seq;
            pending_ping.store(id);
            ping_sent_at = now;
            try {
                channel->send(json{{"t", "ping"}, {"id", std::to_string(id)}}.dump());
            } catch (const std::exception&) {
                link_dead = true;
                break;
            }
        } else if (pending_ping.load() != 0 && now - ping_sent_at >= 4000) {
            std::cerr << "[会话] 心跳超时，链路当作已断" << std::endl;
            link_dead = true;
            channel_ready_ = false;
            break;
        }

        p2p::ReceiveResult result;
        options.error.clear();
        options.stop_after_first = false;
        options.idle_timeout_ms = 3000;
        {
            std::lock_guard<std::mutex> lock(save_dir_mutex_);
            options.save_dir = save_dir_;
        }
        // 上一轮的取消已经消费掉了；新一轮从头开始
        recv_cancel_.store(false);
        const bool ok = p2p::receive(channel, &inbox_, &options, &result);
        if (!ok) {
            if (!options.error.empty()) {
                std::cerr << "[会话] 接收出错：" << options.error << std::endl;
                emit_state("error", "接收出错：" + options.error);
            }
            break;
        }
        if (!channel->isOpen()) break;
    }

    // 只有自己还是当前那条通道时才宣布断开。换连时旧线程也会走到这里，
    // 那时新连接可能已经好了，不能被旧的盖回"已断开"。
    if (!stopping_ && channel_gen_.load() == generation) {
        channel_ready_ = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            waiting_peer_ = peer_id;
        }
        // 原生端不做重试倒计时：保持离线，等 lighthouse 报对方上线再静默建连。
        emit_state("offline", link_dead ? "对方没有响应，已离线" : "对方已离线，等它上线");
    }
}

void Session::send_loop() {
    while (!stopping_) {
        Request request;
        if (!pop_request(&request, 200, true)) {
            if (stopping_) break;
            continue;
        }

        if (!channel_ready_.load() || !channel_) {
            emit_state("error", "还没连上设备，发不了");
            continue;
        }
        if (request.command == Command::SendText) {
            p2p::send_text(channel_, identity_, request.text);
            continue;
        }
        for (const auto& path : request.paths) {
            // 每条传输有自己的取消标记，别把上一条留下的带进来
            {
                std::lock_guard<std::mutex> lock(transfer_mutex_);
                send_active_id_.clear();
                send_cancel_reason_.clear();
                send_cancel_.store(false);
            }
            const bool ok = p2p::send_file(
                channel_, identity_, path, &acks_, 60000,
                [this](const p2p::TransferProgress& progress) {
                    if (!progress.incoming) {
                        std::lock_guard<std::mutex> lock(transfer_mutex_);
                        send_active_id_ = progress.id;
                    }
                    emit_(json{{"t", "progress"},
                               {"id", progress.id},
                               {"name", progress.name},
                               {"done", progress.done},
                               {"total", progress.total},
                               {"incoming", progress.incoming}});
                },
                &send_cancel_);
            bool canceled = false;
            std::string finished_id;
            std::string cancel_reason;
            {
                std::lock_guard<std::mutex> lock(transfer_mutex_);
                canceled = send_cancel_.load();
                finished_id = send_active_id_;
                cancel_reason = send_cancel_reason_;
                send_active_id_.clear();
                send_cancel_reason_.clear();
                send_cancel_.store(false);
            }
            if (ok) {
                emit_(json{{"t", "sent"}, {"path", path}});
                std::error_code ec;
                const auto size = std::filesystem::file_size(std::filesystem::u8path(path), ec);
                record("out", path, ec ? 0 : size, finished_id);
            } else if (canceled) {
                emit_(json{{"t", "canceled"},
                           {"id", finished_id},
                           {"incoming", false},
                           {"message", cancel_message(cancel_reason)}});
                std::printf("[会话] 发送已取消：%s\n", path.c_str());
                std::fflush(stdout);
            } else {
                const std::string name =
                    std::filesystem::u8path(path).filename().u8string();
                emit_state("error", "发送失败：" + name);
            }
        }
    }
}

}  // namespace shell
