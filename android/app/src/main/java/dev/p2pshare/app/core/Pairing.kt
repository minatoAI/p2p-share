package dev.p2pshare.app.core

import java.nio.charset.StandardCharsets
import kotlin.math.abs

/**
 * 配对码与六位短认证串。规则和 app/src/core/pairing.ts 完全一致，
 * 两边算出来的数字必须一模一样，否则用户看到的核对结果没有意义。
 */
object Pairing {
    const val CODE_DIGITS = 6
    /** 二十秒换一次。十秒时用户读到码再输完经常刚好撞上轮换，放宽到二十秒。 */
    const val CODE_ROTATE_MS = 20_000L
    /** 三十秒有效，比一个轮换周期多十秒；轮换后旧码还能再用十秒。 */
    const val CODE_TTL_MS = 30_000L
    const val MAX_CODES_PER_DEVICE = 2
    const val CHALLENGE_TTL_MS = 2 * 60 * 1000L

    fun normalizeCode(text: String): String? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        val fromLink = Regex("[#&?]c=(\\d{4,})", RegexOption.IGNORE_CASE).find(trimmed)
        val bare = Regex("^c=(\\d{4,})$", RegexOption.IGNORE_CASE).find(trimmed)
        val matched = fromLink ?: bare
        if (matched == null && Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
            return null
        }
        val digits = (matched?.groupValues?.get(1) ?: trimmed).filter { it.isDigit() }
        return if (digits.length == CODE_DIGITS) digits else null
    }

    fun formatCode(code: String): String =
        if (code.length == CODE_DIGITS) "${code.take(3)} ${code.drop(3)}" else code

    data class Challenge(
        val from: String,
        val to: String,
        val nonce: String,
        val issuedAt: Long,
        val dtlsFingerprint: String = "",
    )

    fun newChallenge(identity: Identity, from: String, to: String, now: Long = System.currentTimeMillis()): Challenge =
        Challenge(
            from = from,
            to = to,
            nonce = Base64Url.encode(identity.randomBytes(16)),
            issuedAt = now,
        )

    fun challengeBytes(challenge: Challenge): ByteArray = listOf(
        "p2p-lighthouse-challenge-v1",
        "from:${challenge.from}",
        "to:${challenge.to}",
        "nonce:${challenge.nonce}",
        "issuedAt:${challenge.issuedAt}",
        "dtls:${challenge.dtlsFingerprint}",
    ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

    /**
     * 六位短认证串：双方公钥指纹排序后拼接再哈希。
     * 灯塔换掉任意一方的公钥，两边算出来的数字就会不同。
     */
    fun sas(identity: Identity, keyA: PublicKeyJwk, keyB: PublicKeyJwk): String {
        val fa = identity.fingerprintOf(keyA)
        val fb = identity.fingerprintOf(keyB)
        val (x, y) = if (fa < fb) fa to fb else fb to fa
        val digest = identity.digest("sas-v1|$x|$y".toByteArray(StandardCharsets.UTF_8))
        val value = ((digest[0].toLong() and 0xff) shl 24) or
            ((digest[1].toLong() and 0xff) shl 16) or
            ((digest[2].toLong() and 0xff) shl 8) or
            (digest[3].toLong() and 0xff)
        return (value % 1_000_000L).toString().padStart(6, '0')
    }

    /** 应答方：先确认挑战确实是发给我的，再签名。 */
    fun responseSignature(
        identity: Identity,
        myId: String,
        peerId: String,
        nonce: String,
        issuedAt: Long,
        now: Long = System.currentTimeMillis(),
    ): Result<ByteArray> {
        if (abs(now - issuedAt) > CHALLENGE_TTL_MS) {
            return Result.failure(IllegalArgumentException("挑战已过期"))
        }
        val challenge = Challenge(from = peerId, to = myId, nonce = nonce, issuedAt = issuedAt)
        return Result.success(identity.signRaw(challengeBytes(challenge)))
    }

    /**
     * 挑战方：验证对方对自己发出的挑战的签名。
     * 不检查 from/to——这个挑战本来就是自己构造的。
     */
    fun verifyResponse(
        identity: Identity,
        challenge: Challenge,
        rawSignature: ByteArray,
        peerKey: PublicKeyJwk,
        now: Long = System.currentTimeMillis(),
    ): String? {
        if (abs(now - challenge.issuedAt) > CHALLENGE_TTL_MS) return "挑战已过期"
        val key = identity.keyFromJwk(peerKey) ?: return "对方公钥格式不对"
        return if (identity.verifyRaw(key, challengeBytes(challenge), rawSignature)) null else "签名验证不通过"
    }
}
