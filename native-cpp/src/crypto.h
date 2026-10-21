#pragma once
// 身份与编码：P-256 密钥、设备号、指纹、签名。
//
// 和浏览器端对齐的三件事（和 Rust 版一致）：
//   设备号 = 公钥 SPKI 的 SHA-256 取前 10 字节，写成 20 位十六进制
//   指纹   = 同一个哈希取前 8 字节
//   签名   = 64 字节的 r||s，不是 DER（WebCrypto 输出的就是这个格式）
#include <memory>
#include <string>
#include <vector>
#include <openssl/evp.h>

namespace p2p {

std::string hex(const std::vector<unsigned char>& bytes);
std::string b64url(const std::vector<unsigned char>& bytes);
std::vector<unsigned char> b64url_decode(const std::string& text);
std::vector<unsigned char> sha256(const std::vector<unsigned char>& data);
std::vector<unsigned char> utf8(const std::string& text);

/** 公钥的 JWK 表示，字段名和 WebCrypto 的 exportKey('jwk') 对齐 */
struct PublicKeyJwk {
    std::string kty;
    std::string crv;
    std::string x;
    std::string y;

    std::vector<unsigned char> spki() const;
    std::string device_id() const;
    std::string fingerprint() const;
};

struct EvpKeyDeleter {
    void operator()(EVP_PKEY* key) const { EVP_PKEY_free(key); }
};
using EvpKey = std::shared_ptr<EVP_PKEY>;

class Identity {
public:
    static Identity generate();
    static Identity from_secret(const std::vector<unsigned char>& secret);
    static Identity from_secret_hex(const std::string& hex);

    /**
     * PKCS#8 的 PEM。选它是因为它是最通行的私钥文本格式：OpenSSL、Android
     * 的 KeyStore（PKCS#8 DER 再包一层）、Java、Go 都直接认，将来几端共用
     * 一份身份文件不用转换。
     */
    static Identity from_private_pem(const std::string& pem);
    std::string private_pem() const;

    const EvpKey& key() const { return key_; }
    std::vector<unsigned char> secret() const;
    PublicKeyJwk public_jwk() const;
    std::string device_id() const;
    std::string fingerprint() const;
    std::vector<unsigned char> sign(const std::vector<unsigned char>& data) const;

private:
    explicit Identity(EvpKey key) : key_(std::move(key)) {}
    EvpKey key_;
};

bool verify(const PublicKeyJwk& jwk, const std::vector<unsigned char>& data,
            const std::vector<unsigned char>& signature);

}  // namespace p2p
