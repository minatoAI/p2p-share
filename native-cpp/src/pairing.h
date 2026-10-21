#pragma once
// 配对与认证：挑战的规范化字节、六位短认证串。
//
// 六位数字是这套信任模型唯一的锚点。两端各拿一份对方和自己的公钥算出同一个数，
// 灯塔替换任何一方的公钥都会让两边对不上。
#include <string>
#include <vector>

#include "crypto.h"

namespace p2p {

struct Challenge {
    std::string from;   // 发起方
    std::string to;     // 被挑战方
    std::string nonce;
    long long issued_at = 0;
};

/** 挑战的有效窗口 */
inline constexpr long long kChallengeTtlMs = 2 * 60 * 1000;

/**
 * 配对帧里自报的平台名。
 *
 * 以前 Windows 和安卓都报 "native"，两边都一样，界面上说不清对面是台手机还是
 * 电脑，日志里也分不开。现在各报各的：Windows 报 "windows"，安卓报 "android"。
 * 读的一侧不能只看新值——升级一半的时候对面还是 "native"，所以统一过一遍
 * normalize_platform，别让旧设备变成"平台未知"。
 */
inline constexpr const char* kPlatformWindows = "windows";

/**
 * 把对端自报的平台名归一成小写、去空白。
 *
 * "native" 原样保留：它是旧版本的叫法，两台旧设备互相看不出来谁是谁。
 * 这里不把它猜成 "windows"——旧版安卓也报这个名字，猜错比不猜更糟。
 */
std::string normalize_platform(const std::string& raw);

long long now_ms();

/** 待签名的规范化字节。换行分隔，结尾不带换行，字段名和顺序都不能动。 */
std::vector<unsigned char> challenge_bytes(const Challenge& ctx);

/** 六位短认证串。和浏览器端、Rust 端必须算出同一个数。 */
std::string short_authentication_string(const PublicKeyJwk& a, const PublicKeyJwk& b);

/** 应答方：确认挑战是发给我的，再决定签名。 */
bool build_response(const Identity& identity, const std::string& my_id, const Challenge& ctx,
                    long long at, std::vector<unsigned char>* signature, std::string* reason);

/** 挑战方：验证对方对我发出的那个挑战的签名。 */
bool verify_response(const Challenge& ctx, const std::vector<unsigned char>& signature,
                     const PublicKeyJwk& responder, long long at, std::string* reason);

}  // namespace p2p
