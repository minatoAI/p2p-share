#include "pairing.h"

#include <chrono>

namespace p2p {

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::vector<unsigned char> challenge_bytes(const Challenge& ctx) {
    // 和浏览器端、Rust 端逐字符一致。dtls 那一行始终要拼（没有指纹时是空串），
    // 少一行就是签的另一段字节，验签必然失败。
    std::string text = "p2p-lighthouse-challenge-v1";
    text += "\nfrom:" + ctx.from;
    text += "\nto:" + ctx.to;
    text += "\nnonce:" + ctx.nonce;
    text += "\nissuedAt:" + std::to_string(ctx.issued_at);
    text += "\ndtls:";
    return utf8(text);
}

std::string short_authentication_string(const PublicKeyJwk& a, const PublicKeyJwk& b) {
    std::string fa = a.fingerprint();
    std::string fb = b.fingerprint();
    // 先排序再算，谁先发起都得同一个数
    std::string x = fa < fb ? fa : fb;
    std::string y = fa < fb ? fb : fa;
    auto digest = sha256(utf8("sas-v1|" + x + "|" + y));
    uint32_t value = (static_cast<uint32_t>(digest[0]) << 24) |
                     (static_cast<uint32_t>(digest[1]) << 16) |
                     (static_cast<uint32_t>(digest[2]) << 8) | digest[3];
    uint32_t six = value % 1000000;
    std::string out = std::to_string(six);
    while (out.size() < 6) out.insert(out.begin(), '0');
    return out;
}

bool build_response(const Identity& identity, const std::string& my_id, const Challenge& ctx,
                    long long at, std::vector<unsigned char>* signature, std::string* reason) {
    long long delta = at - ctx.issued_at;
    if (delta < 0) delta = -delta;
    if (delta > kChallengeTtlMs) {
        if (reason) *reason = "挑战已过期";
        return false;
    }
    if (ctx.to != my_id) {
        if (reason) *reason = "这个挑战不是发给我的";
        return false;
    }
    *signature = identity.sign(challenge_bytes(ctx));
    return true;
}

bool verify_response(const Challenge& ctx, const std::vector<unsigned char>& signature,
                     const PublicKeyJwk& responder, long long at, std::string* reason) {
    long long delta = at - ctx.issued_at;
    if (delta < 0) delta = -delta;
    if (delta > kChallengeTtlMs) {
        if (reason) *reason = "挑战已过期";
        return false;
    }
    if (!verify(responder, challenge_bytes(ctx), signature)) {
        if (reason) *reason = "签名验不过";
        return false;
    }
    return true;
}

}  // namespace p2p
