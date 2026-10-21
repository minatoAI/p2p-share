// 跨语言验收：拿 Rust 和浏览器那边产出的样本，检查 C++ 实现算出的值是否一致。
//
// 样本是 native/examples/fixture.rs 用写死的私钥生成的，而 app 那边有 7 条断言
// 用浏览器的实现验证同一份样本。所以只要这里也全过，就说明三边（Rust、C++、浏览器）
// 在设备号、指纹、签名格式、六位数字、挑战字节这几处完全一致。
//
// 用法：fixture app/tests/core/fixtures/native-interop.json

#include <nlohmann/json.hpp>

#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "crypto.h"
#include "pairing.h"
#include "protocol.h"

using json = nlohmann::json;
using namespace p2p;

namespace {

int failures = 0;

void check(const std::string& name, bool ok, const std::string& detail = "") {
    std::cout << (ok ? "  [通过] " : "  [失败] ") << name;
    if (!ok && !detail.empty()) std::cout << "　" << detail;
    std::cout << std::endl;
    if (!ok) failures++;
}

PublicKeyJwk read_jwk(const json& node) {
    PublicKeyJwk jwk;
    jwk.kty = node.at("kty").get<std::string>();
    jwk.crv = node.at("crv").get<std::string>();
    jwk.x = node.at("x").get<std::string>();
    jwk.y = node.at("y").get<std::string>();
    return jwk;
}

}  // namespace

int main(int argc, char** argv) {
    const std::string path = argc > 1 ? argv[1] : "app/tests/core/fixtures/native-interop.json";
    std::ifstream in(path);
    if (!in) {
        std::cerr << "读不到样本：" << path << std::endl;
        return 2;
    }
    json fixture;
    in >> fixture;
    try {

    const auto jwkA = read_jwk(fixture.at("a").at("publicKey"));
    const auto jwkB = read_jwk(fixture.at("b").at("publicKey"));

    std::cout << "样本 " << path << std::endl;

    // 1. 设备号 = SPKI 的 SHA-256 前 10 字节。SPKI 差一个字节这里就全错。
    check("设备号和浏览器一致", jwkA.device_id() == fixture.at("a").at("deviceId").get<std::string>(),
          "算出 " + jwkA.device_id());

    // 2. 指纹
    check("指纹和浏览器一致",
          jwkA.fingerprint() == fixture.at("a").at("fingerprint").get<std::string>(),
          "算出 " + jwkA.fingerprint());

    // 3. 浏览器（经由 Rust）签的名，C++ 得验得过。
    //    这条要是挂了，多半是签名格式不对：应该是 64 字节的 r||s，不是 DER。
    const auto message = utf8(fixture.at("message").get<std::string>());
    const auto signature = b64url_decode(fixture.at("signature").get<std::string>());
    check("能验通对面的签名（64 字节 r||s）", verify(jwkA, message, signature),
          "签名长度 " + std::to_string(signature.size()));

    // 4. 六位数字
    const std::string sas = short_authentication_string(jwkA, jwkB);
    check("六位数字和浏览器一致", sas == fixture.at("sas").get<std::string>(),
          "算出 " + sas + "，样本 " + fixture.at("sas").get<std::string>());

    // 5. 挑战的规范化字节。分隔符、字段顺序、结尾那个空的 dtls 行，一字不能差。
    Challenge ctx;
    ctx.from = fixture.at("a").at("deviceId").get<std::string>();
    ctx.to = fixture.at("b").at("deviceId").get<std::string>();
    ctx.nonce = "MDEyMzQ1Njc4OWFiY2RlZg";
    ctx.issued_at = 1700000000000LL;
    const auto bytes = challenge_bytes(ctx);
    const std::string got(bytes.begin(), bytes.end());
    check("挑战字节逐字符一致", got == fixture.at("challengeBytes").get<std::string>());

    // 6. 自己签一个，自己验回来（确认签名路径本身是通的）
    Identity identity = Identity::from_secret(std::vector<unsigned char>(32, 7));
    check("固定私钥能还原出同一把公钥", identity.device_id() == jwkA.device_id(),
          "算出 " + identity.device_id());
    const auto mine = identity.sign(message);
    check("自己签自己验", verify(identity.public_jwk(), message, mine));

    // 7. 分片头的字节序
    const std::vector<unsigned char> payload{0xaa, 0xbb};
    const auto frame = encode_chunk(1, 3, payload.data(), payload.size());
    check("分片头是小端八字节",
          frame.size() == 10 && frame[0] == 1 && frame[4] == 3 && frame[8] == 0xaa,
          "头 " + hex(std::vector<unsigned char>(frame.begin(), frame.begin() + 8)));

    } catch (const std::exception& e) {
        std::cerr << "异常：" << e.what() << std::endl;
        return 3;
    }
    std::cout << (failures == 0 ? "全部通过" : std::to_string(failures) + " 项失败") << std::endl;
    return failures == 0 ? 0 : 1;
}
