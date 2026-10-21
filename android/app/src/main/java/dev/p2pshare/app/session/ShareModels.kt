package dev.p2pshare.app.session

import dev.p2pshare.app.core.PublicKeyJwk

enum class ShareVisitorPhase { CONNECTING, SENDING, DONE, FAILED, LEFT }

enum class VisitPhase {
    CHECKING,
    CONNECTING,
    DOWNLOADING,
    DONE,
    OFFLINE,
    REVOKED,
    EXPIRED,
    NOT_FOUND,
    BUSY,
    FAILED,
    LEFT,
}

data class ShareVisitorUi(
    val deviceId: String,
    val name: String,
    val phase: ShareVisitorPhase,
    val note: String? = null,
)

data class ShareUi(
    val token: String,
    val link: String,
    val name: String,
    val size: Long,
    val mime: String,
    val createdAt: Long,
    val expiresAt: Long,
    val visitors: List<ShareVisitorUi> = emptyList(),
)

data class VisitUi(
    val token: String,
    val phase: VisitPhase,
    val name: String? = null,
    val size: Long? = null,
    val mime: String? = null,
    val deviceName: String? = null,
    val progress: Float? = null,
    /** 平均速率，字节/秒；刚起步的那一小段还不足以计算时为 0 */
    val speed: Long = 0,
    val note: String? = null,
)

data class SharePeer(
    val token: String,
    val seeder: Boolean,
    val peerKey: PublicKeyJwk,
    val peerName: String,
)
