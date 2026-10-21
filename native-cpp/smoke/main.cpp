// 最小验证：能不能编译、能不能链接。能跑通就说明传输层的地基就位了。
#include <rtc/rtc.hpp>
#include <iostream>
#include <memory>

int main() {
    rtc::Configuration config;
    config.iceServers.emplace_back("stun:stun.cloudflare.com:3478");
    auto pc = std::make_shared<rtc::PeerConnection>(config);
    std::cout << "libdatachannel 就位，PeerConnection 建起来了" << std::endl;
    pc->close();
    return 0;
}
