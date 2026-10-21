package dev.p2pshare.app.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 两类消息，两条通道：
 *   SignalMessage 走灯塔 WebSocket，只负责碰头和交换 SDP/ICE；
 *   ControlMessage 走数据通道，认证、文本、文件控制帧都在这里。
 *
 * 字段名必须和 app/src/core/protocol.ts 一模一样。序列化器的判别字段是 `t`。
 */
val WireJson = Json {
    classDiscriminator = "t"
    ignoreUnknownKeys = true
}

@Serializable
data class PublicKeyJwk(
    val kty: String,
    val crv: String? = null,
    val x: String? = null,
    val y: String? = null,
)

@Serializable
data class SessionDescription(val type: String, val sdp: String)

@Serializable
data class IceCandidateInit(
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int? = null,
    val usernameFragment: String? = null,
)

@Serializable
data class PresenceEntry(val id: String, val online: Boolean, val name: String? = null)

@Serializable
sealed interface SignalMessage

@Serializable
@SerialName("hello")
data class Hello(
    val deviceId: String,
    val name: String,
    val publicKey: PublicKeyJwk,
) : SignalMessage

@Serializable
@SerialName("watch")
data class Watch(val ids: List<String>) : SignalMessage

@Serializable
@SerialName("presence")
data class Presence(val id: String, val online: Boolean, val name: String? = null) : SignalMessage

@Serializable
@SerialName("presence-list")
data class PresenceList(val entries: List<PresenceEntry>) : SignalMessage

@Serializable
@SerialName("new-code")
data object NewCode : SignalMessage

@Serializable
@SerialName("code")
data class Code(val code: String, val expiresAt: Long) : SignalMessage

@Serializable
@SerialName("lookup-code")
data class LookupCode(val code: String) : SignalMessage

@Serializable
@SerialName("code-owner")
data class CodeOwner(
    val code: String,
    val deviceId: String,
    val name: String,
    val publicKey: PublicKeyJwk,
) : SignalMessage

@Serializable
@SerialName("code-miss")
data class CodeMiss(
    val code: String,
    val reason: String,
    val retryAfterMs: Long? = null,
) : SignalMessage

/**
 * 对端跑在什么环境里。网页端的身份只活在页面里，刷新就换一台设备，
 * 所以这条配对记录本质上是一次性的；原生端身份存在密钥库里，可以长期保留。
 *
 * 新版本各端会明确发 android / windows。旧版 Windows 端只会发 "native"，
 * 界面按电脑端处理；旧版配对完全没有这个字段，读出来是空串，按「端未知」显示。
 */
const val PLATFORM_WEB = "web"
const val PLATFORM_ANDROID = "android"
const val PLATFORM_WINDOWS = "windows"
/** 旧版本 Windows 端发的标记，保留兼容 */
const val PLATFORM_NATIVE = "native"

@Serializable
@SerialName("pair-request")
data class PairRequest(
    val from: String,
    val to: String,
    val code: String,
    val name: String,
    val publicKey: PublicKeyJwk,
    val platform: String = "",
) : SignalMessage

@Serializable
@SerialName("pair-response")
data class PairResponse(
    val from: String,
    val to: String,
    val accepted: Boolean,
    val reason: String? = null,
    val platform: String = "",
) : SignalMessage

@Serializable
@SerialName("share-connect")
data class ShareConnect(
    val from: String,
    val to: String,
    val token: String,
    val name: String,
    val publicKey: PublicKeyJwk,
) : SignalMessage

@Serializable
@SerialName("share-revoked")
data class ShareRevoked(
    val from: String,
    val to: String,
    val token: String,
    val reason: String,
) : SignalMessage

@Serializable
@SerialName("share-leave")
data class ShareLeave(val from: String, val to: String, val token: String) : SignalMessage

@Serializable
@SerialName("connect-request")
data class ConnectRequest(val from: String, val to: String) : SignalMessage

@Serializable
@SerialName("sdp")
data class Sdp(
    val from: String,
    val to: String,
    val description: SessionDescription,
    val sig: String = "",
) : SignalMessage

@Serializable
@SerialName("ice")
data class Ice(
    val from: String,
    val to: String,
    val candidate: IceCandidateInit,
) : SignalMessage

@Serializable
@SerialName("bye")
data class Bye(val from: String) : SignalMessage

@Serializable
@SerialName("error")
data class SignalError(val code: String, val message: String) : SignalMessage

fun encodeSignal(message: SignalMessage): String =
    WireJson.encodeToString(SignalMessage.serializer(), message)

fun decodeSignal(raw: String): SignalMessage? = runCatching {
    WireJson.decodeFromString(SignalMessage.serializer(), raw)
}.getOrNull()

/* ------------------------------------------------------------ 数据通道控制帧 */

@Serializable
sealed interface ControlMessage

@Serializable
@SerialName("meta")
data class Meta(val id: String, val name: String, val size: Long, val mime: String) : ControlMessage

@Serializable
@SerialName("done")
data class Done(val id: String, val size: Long) : ControlMessage

@Serializable
@SerialName("ack")
data class Ack(val id: String, val received: Long) : ControlMessage

/**
 * 对端主动取消。id 省略表示这条链路上的进行中传输全部取消；
 * reason 省略是旧版本的行为，按 user 处理。旧版收到不认识的帧会忽略。
 */
@Serializable
@SerialName("cancel")
data class Cancel(val id: String? = null, val reason: String? = null) : ControlMessage

@Serializable
@SerialName("text")
data class TextMessage(val id: String, val text: String) : ControlMessage

/**
 * 文字送达确认。
 *
 * 收到 text 的对端回一条同样 id 的 text-ack；发送方收到才算送达。老版本对端
 * 不认识这个帧会忽略，发送方按 8 秒超时标成「未确认」，不当作错误。
 */
@Serializable
@SerialName("text-ack")
data class TextAck(val id: String) : ControlMessage

@Serializable
@SerialName("error")
data class ControlError(val id: String? = null, val message: String) : ControlMessage

@Serializable
@SerialName("auth-challenge")
data class AuthChallenge(val nonce: String, val issuedAt: Long) : ControlMessage

@Serializable
@SerialName("auth-response")
data class AuthResponse(val sig: String) : ControlMessage

@Serializable
@SerialName("auth-result")
data class AuthResult(val ok: Boolean, val reason: String? = null) : ControlMessage

@Serializable
@SerialName("ping")
data class Ping(val id: String) : ControlMessage

@Serializable
@SerialName("pong")
data class Pong(val id: String) : ControlMessage

fun encodeControl(message: ControlMessage): String =
    WireJson.encodeToString(ControlMessage.serializer(), message)

fun decodeControl(raw: String): ControlMessage? = runCatching {
    WireJson.decodeFromString(ControlMessage.serializer(), raw)
}.getOrNull()

/* ------------------------------------------------------------ 二进制分片 */

const val CHUNK_HEADER_BYTES = 8

/** 8 字节头：分片序号、分片总数，两个 uint32 小端。和网页端一致。 */
fun encodeChunk(index: Int, total: Int, payload: ByteArray): ByteArray {
    val out = ByteArray(CHUNK_HEADER_BYTES + payload.size)
    out[0] = (index and 0xff).toByte()
    out[1] = ((index ushr 8) and 0xff).toByte()
    out[2] = ((index ushr 16) and 0xff).toByte()
    out[3] = ((index ushr 24) and 0xff).toByte()
    out[4] = (total and 0xff).toByte()
    out[5] = ((total ushr 8) and 0xff).toByte()
    out[6] = ((total ushr 16) and 0xff).toByte()
    out[7] = ((total ushr 24) and 0xff).toByte()
    payload.copyInto(out, CHUNK_HEADER_BYTES)
    return out
}

data class Chunk(val index: Int, val total: Int, val payload: ByteArray)

fun decodeChunk(bytes: ByteArray): Chunk {
    require(bytes.size >= CHUNK_HEADER_BYTES) { "分片太短：${bytes.size} 字节" }
    val index = (bytes[0].toInt() and 0xff) or
        ((bytes[1].toInt() and 0xff) shl 8) or
        ((bytes[2].toInt() and 0xff) shl 16) or
        ((bytes[3].toInt() and 0xff) shl 24)
    val total = (bytes[4].toInt() and 0xff) or
        ((bytes[5].toInt() and 0xff) shl 8) or
        ((bytes[6].toInt() and 0xff) shl 16) or
        ((bytes[7].toInt() and 0xff) shl 24)
    return Chunk(index, total, bytes.copyOfRange(CHUNK_HEADER_BYTES, bytes.size))
}
