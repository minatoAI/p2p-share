#include "crypto.h"

#include <openssl/bn.h>
#include <openssl/core_names.h>
#include <openssl/param_build.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/obj_mac.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <openssl/x509.h>

#include <algorithm>
#include <cstdint>
#include <stdexcept>

namespace p2p {
namespace {

const char* kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 从 0x04||x||y 的未压缩点还原公钥 */
EvpKey key_from_point(const std::vector<unsigned char>& point) {
    if (point.size() != 65 || point[0] != 0x04) return nullptr;
    OSSL_PARAM params[3];
    params[0] = OSSL_PARAM_construct_utf8_string(OSSL_PKEY_PARAM_GROUP_NAME,
                                                 const_cast<char*>("prime256v1"), 0);
    params[1] = OSSL_PARAM_construct_octet_string(
        OSSL_PKEY_PARAM_PUB_KEY, const_cast<unsigned char*>(point.data()), point.size());
    params[2] = OSSL_PARAM_construct_end();

    EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new_from_name(nullptr, "EC", nullptr);
    if (!ctx) return nullptr;
    EVP_PKEY* key = nullptr;
    if (EVP_PKEY_fromdata_init(ctx) <= 0 ||
        EVP_PKEY_fromdata(ctx, &key, EVP_PKEY_PUBLIC_KEY, params) <= 0) {
        EVP_PKEY_CTX_free(ctx);
        return nullptr;
    }
    EVP_PKEY_CTX_free(ctx);
    return EvpKey(key, EvpKeyDeleter{});
}

std::vector<unsigned char> point_from_jwk(const PublicKeyJwk& jwk) {
    auto x = b64url_decode(jwk.x);
    auto y = b64url_decode(jwk.y);
    if (x.size() != 32 || y.size() != 32) return {};
    std::vector<unsigned char> point(65);
    point[0] = 0x04;
    std::copy(x.begin(), x.end(), point.begin() + 1);
    std::copy(y.begin(), y.end(), point.begin() + 33);
    return point;
}

std::vector<unsigned char> spki_of(const EvpKey& key) {
    int len = i2d_PUBKEY(key.get(), nullptr);
    if (len <= 0) throw std::runtime_error("公钥编码失败");
    std::vector<unsigned char> der(static_cast<size_t>(len));
    unsigned char* p = der.data();
    i2d_PUBKEY(key.get(), &p);
    return der;
}

std::string hash_prefix_hex(const std::vector<unsigned char>& spki, size_t bytes) {
    auto digest = sha256(spki);
    return hex(std::vector<unsigned char>(digest.begin(), digest.begin() + bytes));
}

}  // namespace

std::string hex(const std::vector<unsigned char>& bytes) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    out.reserve(bytes.size() * 2);
    for (auto b : bytes) {
        out.push_back(digits[b >> 4]);
        out.push_back(digits[b & 0x0f]);
    }
    return out;
}

std::vector<unsigned char> sha256(const std::vector<unsigned char>& data) {
    std::vector<unsigned char> out(SHA256_DIGEST_LENGTH);
    SHA256(data.data(), data.size(), out.data());
    return out;
}

std::vector<unsigned char> utf8(const std::string& text) {
    return std::vector<unsigned char>(text.begin(), text.end());
}

std::string b64url(const std::vector<unsigned char>& bytes) {
    std::string out;
    size_t i = 0;
    for (; i + 3 <= bytes.size(); i += 3) {
        uint32_t n = (static_cast<uint32_t>(bytes[i]) << 16) |
                     (static_cast<uint32_t>(bytes[i + 1]) << 8) | bytes[i + 2];
        out.push_back(kB64[(n >> 18) & 63]);
        out.push_back(kB64[(n >> 12) & 63]);
        out.push_back(kB64[(n >> 6) & 63]);
        out.push_back(kB64[n & 63]);
    }
    size_t rem = bytes.size() - i;
    if (rem == 1) {
        uint32_t n = static_cast<uint32_t>(bytes[i]) << 16;
        out.push_back(kB64[(n >> 18) & 63]);
        out.push_back(kB64[(n >> 12) & 63]);
    } else if (rem == 2) {
        uint32_t n = (static_cast<uint32_t>(bytes[i]) << 16) |
                     (static_cast<uint32_t>(bytes[i + 1]) << 8);
        out.push_back(kB64[(n >> 18) & 63]);
        out.push_back(kB64[(n >> 12) & 63]);
        out.push_back(kB64[(n >> 6) & 63]);
    }
    return out;
}

std::vector<unsigned char> b64url_decode(const std::string& text) {
    auto value = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '-') return 62;
        if (c == '_') return 63;
        return -1;
    };
    std::vector<unsigned char> out;
    uint32_t buffer = 0;
    int bits = 0;
    for (char c : text) {
        int v = value(c);
        if (v < 0) continue;
        buffer = (buffer << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<unsigned char>((buffer >> bits) & 0xff));
        }
    }
    return out;
}

std::vector<unsigned char> PublicKeyJwk::spki() const {
    auto key = key_from_point(point_from_jwk(*this));
    if (!key) throw std::runtime_error("公钥格式不对");
    return spki_of(key);
}

std::string PublicKeyJwk::device_id() const { return hash_prefix_hex(spki(), 10); }

std::string PublicKeyJwk::fingerprint() const { return hash_prefix_hex(spki(), 8); }

Identity Identity::generate() {
    EVP_PKEY* key = EVP_EC_gen("P-256");
    if (!key) throw std::runtime_error("生成密钥失败");
    return Identity(EvpKey(key, EvpKeyDeleter{}));
}

Identity Identity::from_secret(const std::vector<unsigned char>& secret) {
    // 从裸私钥还原密钥。两条路都试过，结论是这条最省事：
    //   EVP_PKEY_fromdata 只给私钥的话，OpenSSL 不会替你推导公钥，
    //   后面取公钥点会失败。所以这里显式做一次点乘把公钥算出来。
    // （EC_KEY 这套接口在 OpenSSL 3 里标了 deprecated，但只是警告，功能正常。）
    BIGNUM* priv = BN_bin2bn(secret.data(), static_cast<int>(secret.size()), nullptr);
    if (!priv) throw std::runtime_error("私钥格式不对");

    EC_KEY* ec = EC_KEY_new_by_curve_name(NID_X9_62_prime256v1);
    if (!ec || EC_KEY_set_private_key(ec, priv) != 1) {
        if (ec) EC_KEY_free(ec);
        BN_free(priv);
        throw std::runtime_error("私钥格式不对");
    }
    const EC_GROUP* group = EC_KEY_get0_group(ec);
    EC_POINT* pub = EC_POINT_new(group);
    if (!pub || EC_POINT_mul(group, pub, priv, nullptr, nullptr, nullptr) != 1 ||
        EC_KEY_set_public_key(ec, pub) != 1) {
        if (pub) EC_POINT_free(pub);
        EC_KEY_free(ec);
        BN_free(priv);
        throw std::runtime_error("算不出公钥");
    }
    EC_POINT_free(pub);
    BN_free(priv);

    EVP_PKEY* key = EVP_PKEY_new();
    if (!key || EVP_PKEY_assign_EC_KEY(key, ec) != 1) {
        if (key) EVP_PKEY_free(key);
        else EC_KEY_free(ec);
        throw std::runtime_error("组装密钥失败");
    }
    return Identity(EvpKey(key, EvpKeyDeleter{}));
}

Identity Identity::from_secret_hex(const std::string& text) {
    std::vector<unsigned char> bytes;
    for (size_t i = 0; i + 1 < text.size(); i += 2) {
        bytes.push_back(static_cast<unsigned char>(std::stoi(text.substr(i, 2), nullptr, 16)));
    }
    return from_secret(bytes);
}

std::string Identity::private_pem() const {
    BIO* bio = BIO_new(BIO_s_mem());
    if (!bio) throw std::runtime_error("内存 BIO 建不起来");
    // PKCS#8（PKCS8_PRIVATEKEY），无加密。不加密是有意的：加密要么带口令
    // （没人愿意每次启动输口令），要么用平台自己的密钥库（Windows 上是 DPAPI，
    // Android 上又是另一套），两边不通用。纯 PEM 加目录权限是同类项目
    // （Syncthing、KDE Connect）通行的做法。
    const int ok = PEM_write_bio_PKCS8PrivateKey(bio, key_.get(), nullptr, nullptr, 0, nullptr,
                                                 nullptr);
    char* data = nullptr;
    const long len = BIO_get_mem_data(bio, &data);
    std::string out = (ok == 1 && data && len > 0) ? std::string(data, static_cast<size_t>(len))
                                                   : std::string();
    BIO_free(bio);
    if (out.empty()) throw std::runtime_error("私钥导出失败");
    return out;
}

Identity Identity::from_private_pem(const std::string& pem) {
    BIO* bio = BIO_new_mem_buf(pem.data(), static_cast<int>(pem.size()));
    if (!bio) throw std::runtime_error("内存 BIO 建不起来");
    EVP_PKEY* key = PEM_read_bio_PrivateKey(bio, nullptr, nullptr, nullptr);
    BIO_free(bio);
    if (!key) throw std::runtime_error("私钥文件读不出来");
    if (EVP_PKEY_get_base_id(key) != EVP_PKEY_EC) {
        EVP_PKEY_free(key);
        throw std::runtime_error("私钥不是 EC 类型");
    }
    return Identity(EvpKey(key, EvpKeyDeleter{}));
}

std::vector<unsigned char> Identity::secret() const {    BIGNUM* bn = nullptr;
    if (EVP_PKEY_get_bn_param(key_.get(), OSSL_PKEY_PARAM_PRIV_KEY, &bn) <= 0 || !bn) {
        throw std::runtime_error("取不到私钥");
    }
    std::vector<unsigned char> out(32, 0);
    BN_bn2binpad(bn, out.data(), 32);
    BN_free(bn);
    return out;
}

PublicKeyJwk Identity::public_jwk() const {
    // 统一走 EC_KEY 这一套：它对"生成出来的密钥"和"从裸私钥还原出来的密钥"
    // 都管用，而 OSSL_PKEY_PARAM_PUB_KEY 那条路对旧式密钥拿到的不是未压缩点。
    EC_KEY* ec = EVP_PKEY_get1_EC_KEY(key_.get());
    if (!ec) throw std::runtime_error("取不到 EC 密钥");
    const EC_GROUP* group = EC_KEY_get0_group(ec);
    const EC_POINT* pub = EC_KEY_get0_public_key(ec);
    if (!group || !pub) {
        EC_KEY_free(ec);
        throw std::runtime_error("取不到公钥点");
    }
    std::vector<unsigned char> point(65);
    const size_t len = EC_POINT_point2oct(group, pub, POINT_CONVERSION_UNCOMPRESSED, point.data(),
                                          point.size(), nullptr);
    EC_KEY_free(ec);
    if (len != 65 || point[0] != 0x04) throw std::runtime_error("公钥不是未压缩点");

    PublicKeyJwk jwk;
    jwk.kty = "EC";
    jwk.crv = "P-256";
    jwk.x = b64url(std::vector<unsigned char>(point.begin() + 1, point.begin() + 33));
    jwk.y = b64url(std::vector<unsigned char>(point.begin() + 33, point.begin() + 65));
    return jwk;
}

std::string Identity::device_id() const { return public_jwk().device_id(); }

std::string Identity::fingerprint() const { return public_jwk().fingerprint(); }

std::vector<unsigned char> Identity::sign(const std::vector<unsigned char>& data) const {
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (!ctx) throw std::runtime_error("签名上下文建不起来");
    size_t derlen = 0;
    std::vector<unsigned char> der;
    if (EVP_DigestSignInit(ctx, nullptr, EVP_sha256(), nullptr, key_.get()) <= 0 ||
        EVP_DigestSign(ctx, nullptr, &derlen, data.data(), data.size()) <= 0) {
        EVP_MD_CTX_free(ctx);
        throw std::runtime_error("签名失败");
    }
    der.resize(derlen);
    if (EVP_DigestSign(ctx, der.data(), &derlen, data.data(), data.size()) <= 0) {
        EVP_MD_CTX_free(ctx);
        throw std::runtime_error("签名失败");
    }
    EVP_MD_CTX_free(ctx);
    der.resize(derlen);

    // DER 转成 64 字节的 r||s。这一步不做，浏览器那边验不过。
    const unsigned char* p = der.data();
    ECDSA_SIG* sig = d2i_ECDSA_SIG(nullptr, &p, static_cast<long>(der.size()));
    if (!sig) throw std::runtime_error("签名解不出来");
    const BIGNUM* r = nullptr;
    const BIGNUM* s = nullptr;
    ECDSA_SIG_get0(sig, &r, &s);
    std::vector<unsigned char> raw(64, 0);
    BN_bn2binpad(r, raw.data(), 32);
    BN_bn2binpad(s, raw.data() + 32, 32);
    ECDSA_SIG_free(sig);
    return raw;
}

bool verify(const PublicKeyJwk& jwk, const std::vector<unsigned char>& data,
            const std::vector<unsigned char>& signature) {
    if (signature.size() != 64) return false;
    auto key = key_from_point(point_from_jwk(jwk));
    if (!key) return false;

    BIGNUM* r = BN_bin2bn(signature.data(), 32, nullptr);
    BIGNUM* s = BN_bin2bn(signature.data() + 32, 32, nullptr);
    if (!r || !s) {
        BN_free(r);
        BN_free(s);
        return false;
    }
    ECDSA_SIG* sig = ECDSA_SIG_new();
    ECDSA_SIG_set0(sig, r, s);
    int derlen = i2d_ECDSA_SIG(sig, nullptr);
    std::vector<unsigned char> der(static_cast<size_t>(derlen));
    unsigned char* p = der.data();
    i2d_ECDSA_SIG(sig, &p);
    ECDSA_SIG_free(sig);

    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (!ctx) return false;
    bool ok = false;
    if (EVP_DigestVerifyInit(ctx, nullptr, EVP_sha256(), nullptr, key.get()) > 0) {
        ok = EVP_DigestVerify(ctx, der.data(), der.size(), data.data(), data.size()) == 1;
    }
    EVP_MD_CTX_free(ctx);
    return ok;
}

}  // namespace p2p
