package dev.p2pshare.app.core

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

/**
 * 设备身份。
 *
 * 私钥放在 Android Keystore 里，不可导出；应用只持有签名句柄。
 * 设备号 = SHA-256(公钥 SPKI) 的前 10 字节，和网页端 webcrypto.ts 的推导一致。
 *
 * 注意签名格式：WebCrypto 的 ECDSA 输出是 raw r‖s，Java 的 SHA256withECDSA
 * 输出 DER。两个方向都要转换，见 Der。
 */
class Identity {
    private companion object {
        const val ALIAS = "p2p-share-identity-v1"
        const val CURVE = "secp256r1"
    }

    private val keyStore: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val random = SecureRandom()
    private val ecParams: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec(CURVE)) }
            .getParameterSpec(ECParameterSpec::class.java)
    }

    private val privateKey: PrivateKey
    val publicKey: PublicKey
    val publicJwk: PublicKeyJwk
    val deviceId: String
    val fingerprint: String

    init {
        val entry = ensureEntry()
        privateKey = entry.privateKey
        publicKey = entry.certificate.publicKey
        val digest = MessageDigest.getInstance("SHA-256").digest(publicKey.encoded)
        deviceId = digest.copyOfRange(0, 10).toHex()
        fingerprint = digest.copyOfRange(0, 8).toHex()
        publicJwk = jwkOf(publicKey)
    }

    private fun ensureEntry(): KeyStore.PrivateKeyEntry {
        (keyStore.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry)?.let { return it }
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
        return keyStore.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
    }

    fun signRaw(data: ByteArray): ByteArray {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(privateKey)
        signature.update(data)
        return Der.toRaw(signature.sign())
    }

    fun verifyRaw(peerKey: PublicKey, data: ByteArray, raw: ByteArray): Boolean = runCatching {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initVerify(peerKey)
        signature.update(data)
        signature.verify(Der.fromRaw(raw))
    }.getOrDefault(false)

    fun digest(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun randomBytes(size: Int): ByteArray = ByteArray(size).also { random.nextBytes(it) }

    fun deviceIdFromKey(jwk: PublicKeyJwk): String {
        val key = keyFromJwk(jwk) ?: return ""
        return digest(key.encoded).copyOfRange(0, 10).toHex()
    }

    fun fingerprintOf(jwk: PublicKeyJwk): String {
        val key = keyFromJwk(jwk) ?: return ""
        return digest(key.encoded).copyOfRange(0, 8).toHex()
    }

    fun keyFromJwk(jwk: PublicKeyJwk): PublicKey? = runCatching {
        val x = jwk.x ?: return null
        val y = jwk.y ?: return null
        if (jwk.kty != "EC" || jwk.crv != "P-256") return null
        val point = ECPoint(
            BigInteger(1, Base64Url.decode(x)),
            BigInteger(1, Base64Url.decode(y)),
        )
        KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, ecParams))
    }.getOrNull()

    private fun jwkOf(key: PublicKey): PublicKeyJwk {
        val ec = key as ECPublicKey
        return PublicKeyJwk(
            kty = "EC",
            crv = "P-256",
            x = Base64Url.encode(fixed32(ec.w.affineX)),
            y = Base64Url.encode(fixed32(ec.w.affineY)),
        )
    }

    private fun fixed32(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        val copy = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
        val out = ByteArray(32)
        copy.copyInto(out, 32 - copy.size)
        return out
    }
}

/** DER ↔ WebCrypto 的 raw r‖s。P-256 两个整数各 32 字节。 */
object Der {
    fun toRaw(der: ByteArray): ByteArray {
        require(der.size > 8 && der[0] == 0x30.toByte()) { "不是 DER 签名" }
        var index = 1
        val (_, afterSeq) = readLength(der, index)
        index = afterSeq
        require(index < der.size && der[index] == 0x02.toByte())
        index += 1
        val (rLength, rStart) = readLength(der, index)
        val r = der.copyOfRange(rStart, rStart + rLength)
        index = rStart + rLength
        require(index < der.size && der[index] == 0x02.toByte())
        index += 1
        val (sLength, sStart) = readLength(der, index)
        val s = der.copyOfRange(sStart, sStart + sLength)
        val out = ByteArray(64)
        writePadded(r, out, 0)
        writePadded(s, out, 32)
        return out
    }

    fun fromRaw(raw: ByteArray): ByteArray {
        require(raw.size == 64) { "raw 签名必须是 64 字节" }
        val r = positiveInteger(raw.copyOfRange(0, 32))
        val s = positiveInteger(raw.copyOfRange(32, 64))
        val body = ByteArray(4 + r.size + s.size)
        var index = 0
        body[index++] = 0x02
        body[index++] = r.size.toByte()
        r.copyInto(body, index)
        index += r.size
        body[index++] = 0x02
        body[index++] = s.size.toByte()
        s.copyInto(body, index)
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun readLength(buf: ByteArray, at: Int): Pair<Int, Int> {
        var index = at
        val first = buf[index++].toInt() and 0xff
        if (first and 0x80 == 0) return first to index
        val count = first and 0x7f
        var length = 0
        repeat(count) { length = (length shl 8) or (buf[index++].toInt() and 0xff) }
        return length to index
    }

    private fun writePadded(src: ByteArray, dst: ByteArray, offset: Int) {
        var start = 0
        while (start < src.size - 1 && src[start] == 0.toByte()) start++
        val length = src.size - start
        require(length <= 32) { "签名整数超过 32 字节" }
        src.copyInto(dst, offset + 32 - length, start, src.size)
    }

    private fun positiveInteger(value: ByteArray): ByteArray {
        var start = 0
        while (start < value.size - 1 && value[start] == 0.toByte()) start++
        val trimmed = value.copyOfRange(start, value.size)
        return if (trimmed[0].toInt() and 0x80 != 0) byteArrayOf(0) + trimmed else trimmed
    }
}

internal fun ByteArray.toHex(): String {
    val table = "0123456789abcdef"
    val out = StringBuilder(size * 2)
    for (byte in this) {
        val value = byte.toInt() and 0xff
        out.append(table[value ushr 4])
        out.append(table[value and 15])
    }
    return out.toString()
}
