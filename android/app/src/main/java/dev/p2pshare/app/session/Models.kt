package dev.p2pshare.app.session

import dev.p2pshare.app.core.Direction
import dev.p2pshare.app.core.SignalLinkState
import dev.p2pshare.app.core.TransferStatus
import dev.p2pshare.app.data.ContactRecord
import dev.p2pshare.app.data.HistoryEntry

enum class PairingRole { OWNER, JOINER }

data class PairingUi(
    val peerId: String,
    val peerName: String,
    val sas: String,
    val role: PairingRole,
    val peerPlatform: String = "",
)

enum class SessionPhase { IDLE, SIGNALING, ICE, AUTH, READY, FAILED }

data class PeerUi(
    val phase: SessionPhase,
    val message: String? = null,
    /** 失败后正在自动重连：按钮要变成「取消重连」 */
    val autoRetrying: Boolean = false,
)

data class TransferItem(
    val id: String,
    val peerId: String,
    val direction: Direction,
    val name: String,
    val size: Long,
    val mime: String = "",
    val transferred: Long = 0,
    val status: TransferStatus = TransferStatus.PENDING,
    val message: String? = null,
    val uri: String? = null,
    val at: Long = System.currentTimeMillis(),
    /** 第一片到达的时间，用来算平均速率 */
    val startedAt: Long = 0,
    val speed: Long = 0,
)

data class TextItem(
    val id: String,
    val peerId: String,
    val direction: Direction,
    val text: String,
    val at: Long = System.currentTimeMillis(),
)

data class UiError(val id: Long, val message: String)

data class AppState(
    val deviceId: String = "",
    val fingerprint: String = "",
    val deviceName: String = "",
    val signal: SignalLinkState = SignalLinkState.Closed,
    val contacts: List<ContactRecord> = emptyList(),
    val presence: Map<String, Boolean> = emptyMap(),
    val presenceNames: Map<String, String> = emptyMap(),
    val advertising: Boolean = false,
    val code: String? = null,
    val codeExpiresAt: Long = 0,
    /** 当前配对码对应的完整链接，二维码用它 */
    val pairLink: String? = null,
    val joining: Boolean = false,
    val pairing: PairingUi? = null,
    val activePeerId: String? = null,
    val peers: Map<String, PeerUi> = emptyMap(),
    val transfers: List<TransferItem> = emptyList(),
    /** 整体传输记录，落盘，侧边菜单用它 */
    val history: List<HistoryEntry> = emptyList(),
    val texts: List<TextItem> = emptyList(),
    val shares: List<ShareUi> = emptyList(),
    val visit: VisitUi? = null,
    val shareBusy: Boolean = false,
    val error: UiError? = null,
    val logs: List<String> = emptyList(),
) {
    fun displayName(peerId: String): String =
        presenceNames[peerId]
            ?: contacts.firstOrNull { it.peerId == peerId }?.peerName
            ?: peerId.take(6)
}
