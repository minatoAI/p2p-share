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
    /**
     * 静默恢复中：息屏、无网、应用不在前台，或者自动重连还没到该露脸的次数。
     * 这期间不显示失败横幅，只在头栏留一个不打扰人的状态。
     */
    val quiet: Boolean = false,
    /** 已经自动重连到第几次，横幅上显示进度用 */
    val retryAttempt: Int = 0,
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

/** 自己发出的文字走到哪一步了。收到的文字不看这个字段。 */
enum class TextDelivery {
    /** 连接没就绪，排在待发队列里 */
    QUEUED,
    /** 已经写进数据通道，等对方的 text-ack */
    SENDING,
    /** 对方回了 text-ack */
    DELIVERED,
    /** 8 秒没等到确认；老版本对端不会回 ack，也走这里 */
    UNCONFIRMED,
}

data class TextItem(
    val id: String,
    val peerId: String,
    val direction: Direction,
    val text: String,
    val at: Long = System.currentTimeMillis(),
    /** 发送状态：排队/等确认/已送达/未确认。收到的文字这个值没有意义 */
    val delivery: TextDelivery = TextDelivery.SENDING,
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
    /**
     * 最近一条收到的文字。界面拿它判断要不要自动跳到对应会话页；
     * 用消息 id 做 key，同一条消息不会触发第二次跳转。
     */
    val incomingText: TextItem? = null,
    val shares: List<ShareUi> = emptyList(),
    val visit: VisitUi? = null,
    val shareBusy: Boolean = false,
    val error: UiError? = null,
    val logs: List<String> = emptyList(),
) {
    fun displayName(peerId: String): String {
        val base = presenceNames[peerId]
            ?: contacts.firstOrNull { it.peerId == peerId }?.peerName
            ?: return peerId.take(6)
        // 旧版本可能留下多条同名设备；名字相同的时候补一小段设备号，
        // 至少让人能在列表里分清点的是哪一台。
        val duplicate = contacts.count { it.peerName == base } > 1
        return if (duplicate && !base.endsWith(peerId.take(6))) "$base · ${peerId.take(6)}" else base
    }
}
