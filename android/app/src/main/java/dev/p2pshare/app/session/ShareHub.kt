package dev.p2pshare.app.session

import dev.p2pshare.app.core.Direction
import dev.p2pshare.app.core.Identity
import dev.p2pshare.app.core.RegistryClient
import dev.p2pshare.app.core.ShareConnect
import dev.p2pshare.app.core.ShareCreateRequest
import dev.p2pshare.app.core.ShareLeave
import dev.p2pshare.app.core.ShareRevoked
import dev.p2pshare.app.core.ShareStatusResponse
import dev.p2pshare.app.core.SignalMessage
import dev.p2pshare.app.core.TransferStatus
import dev.p2pshare.app.core.TransferUpdate
import dev.p2pshare.app.core.parseShareToken
import dev.p2pshare.app.core.shareLink
import dev.p2pshare.app.data.OutgoingShareRecord
import dev.p2pshare.app.data.ShareStore
import dev.p2pshare.app.data.UriSendFile
import kotlinx.coroutines.delay
import java.io.IOException

interface ShareSessions {
    fun registerSharePeer(peerId: String, share: SharePeer)
    suspend fun serveSharePeer(peerId: String)
    fun closeSharePeer(peerId: String, reason: String)
    suspend fun sendShareFile(peerId: String, file: UriSendFile)
    fun noteSharePeer(peerId: String, name: String)
    fun sendSignal(message: SignalMessage)
    /** 会话层自己的协程 scope；分享逻辑不能在信令回调里直接挂起。 */
    fun launchShare(block: suspend () -> Unit)
    /** 等灯塔连上。冷启动点链接时信令还没开，这时发 share-connect 会被丢掉。 */
    suspend fun awaitSignaling(): Boolean
}

class ShareHub(
    private val identity: Identity,
    private val registry: RegistryClient,
    private val sessions: ShareSessions,
    private val shareStore: ShareStore,
    private val fileFactory: (String, String) -> UriSendFile,
    private val deviceName: () -> String,
    private val origin: String,
    private val events: Events,
) {
    interface Events {
        fun onShares(list: List<ShareUi>)
        fun onVisit(state: VisitUi?)
        fun onBusy(busy: Boolean)
        fun log(line: String)
        fun error(message: String)
    }

    private data class TrackedVisitor(
        val deviceId: String,
        var name: String,
        var phase: ShareVisitorPhase,
        var note: String? = null,
    )

    private data class LocalShare(
        val token: String,
        val name: String,
        val size: Long,
        val mime: String,
        val createdAt: Long,
        val expiresAt: Long,
        val file: UriSendFile,
        val visitors: MutableMap<String, TrackedVisitor> = mutableMapOf(),
    )

    private val outgoing = linkedMapOf<String, LocalShare>()
    private var visitState: VisitUi? = null
    private var visiting: Pair<String, String>? = null
    private var visitProgressAt = 0L
    /** 每次 visit 自增，用来作废旧连接的超时看门狗 */
    private var visitGeneration = 0

    init {
        restore()
    }

    private fun restore() {
        for (record in shareStore.list()) {
            val file = runCatching { fileFactory(record.uri, record.mime) }.getOrNull() ?: continue
            outgoing[record.token] = LocalShare(
                token = record.token,
                name = record.name,
                size = record.size,
                mime = record.mime,
                createdAt = record.createdAt,
                expiresAt = record.expiresAt,
                file = file,
            )
        }
        if (outgoing.isNotEmpty()) {
            events.log("恢复了 ${outgoing.size} 条还在有效期内的分享链接")
        }
        emitShares()
    }

    /* ---------------------------------------------------------- 分享者 */

    suspend fun createShare(file: UriSendFile): ShareUi? {
        if (file.size < 0) {
            events.error("读不出「${file.name}」的大小，换一个文件试试")
            return null
        }
        events.onBusy(true)
        return try {
            val created = registry.create(
                ShareCreateRequest(
                    deviceId = identity.deviceId,
                    deviceName = deviceName(),
                    publicKey = identity.publicJwk,
                    name = file.name,
                    size = file.size,
                    mime = file.mime.ifBlank { "application/octet-stream" },
                ),
            )
            val share = LocalShare(
                token = created.token,
                name = file.name,
                size = file.size,
                mime = file.mime.ifBlank { "application/octet-stream" },
                createdAt = System.currentTimeMillis(),
                expiresAt = created.expiresAt,
                file = file,
            )
            outgoing[share.token] = share
            shareStore.add(
                OutgoingShareRecord(
                    token = share.token,
                    name = share.name,
                    size = share.size,
                    mime = share.mime,
                    createdAt = share.createdAt,
                    expiresAt = share.expiresAt,
                    uri = file.uriString,
                ),
            )
            events.log("已生成链接：${share.name}")
            emitShares()
            viewOf(share.token)
        } catch (t: Throwable) {
            events.error("生成链接失败：${t.message ?: "未知错误"}")
            null
        } finally {
            events.onBusy(false)
        }
    }

    suspend fun revoke(token: String) {
        val share = outgoing.remove(token)
        shareStore.remove(token)
        share?.file?.deleteLocalCopy()
        val reason = "分享已撤销"
        share?.visitors?.values?.forEach { visitor ->
            if (visitor.phase == ShareVisitorPhase.CONNECTING || visitor.phase == ShareVisitorPhase.SENDING) {
                sessions.sendSignal(
                    ShareRevoked(identity.deviceId, visitor.deviceId, token, "revoked"),
                )
                sessions.closeSharePeer(visitor.deviceId, reason)
            }
        }
        runCatching { registry.revoke(token, identity.deviceId) }
            .onFailure { events.log("⚠ 注册表撤销没成功：${it.message}，链接会自己到期") }
        events.log("已撤销链接：${share?.name ?: token}")
        emitShares()
    }

    fun list(): List<ShareUi> = outgoing.keys.mapNotNull(::viewOf)

    private fun viewOf(token: String): ShareUi? {
        val share = outgoing[token] ?: return null
        return ShareUi(
            token = share.token,
            link = shareLink(origin, share.token),
            name = share.name,
            size = share.size,
            mime = share.mime,
            createdAt = share.createdAt,
            expiresAt = share.expiresAt,
            visitors = share.visitors.values.map {
                ShareVisitorUi(it.deviceId, it.name, it.phase, it.note)
            },
        )
    }

    private fun emitShares() {
        events.onShares(list())
    }

    /* ---------------------------------------------------------- 访客请求 */

    fun onSignal(message: SignalMessage) {
        when (message) {
            is ShareConnect -> onVisitorConnect(message)
            is ShareRevoked -> onToldRevoked(message)
            is ShareLeave -> onVisitorLeft(message)
            else -> Unit
        }
    }

    private fun onVisitorConnect(message: ShareConnect) {
        if (message.to != identity.deviceId) return
        val share = outgoing[message.token]
        val refuse = { reason: String ->
            sessions.sendSignal(
                ShareRevoked(identity.deviceId, message.from, message.token, reason),
            )
        }
        if (share == null) return refuse("not-here")
        if (share.expiresAt < System.currentTimeMillis()) return refuse("expired")
        val derived = identity.deviceIdFromKey(message.publicKey)
        if (derived != message.from) {
            events.log("⚠ 拒绝一个访客：设备号和送来的公钥对不上")
            return
        }
        val active = share.visitors[message.from]
        if (active?.phase == ShareVisitorPhase.CONNECTING ||
            active?.phase == ShareVisitorPhase.SENDING
        ) {
            return
        }
        if (share.visitors.values.count {
                it.phase == ShareVisitorPhase.CONNECTING || it.phase == ShareVisitorPhase.SENDING
            } >= 1
        ) {
            events.log("正给别的访客发文件，挡住一个：${message.name}")
            return refuse("busy")
        }
        val visitor = active ?: TrackedVisitor(
            deviceId = message.from,
            name = message.name,
            phase = ShareVisitorPhase.CONNECTING,
        )
        visitor.name = message.name
        share.visitors[message.from] = visitor
        events.log("有访客来取件：${message.name}")
        emitShares()

        sessions.noteSharePeer(message.from, message.name)
        sessions.registerSharePeer(
            message.from,
            SharePeer(
                token = share.token,
                seeder = true,
                peerKey = message.publicKey,
                peerName = message.name,
            ),
        )
        sessions.launchShare { serve(share, visitor) }
    }

    /** 建通道、认证、把文件交给这个访客的传输引擎。 */
    private suspend fun serve(share: LocalShare, visitor: TrackedVisitor) {
        visitor.phase = ShareVisitorPhase.CONNECTING
        emitShares()
        try {
            sessions.serveSharePeer(visitor.deviceId)
            visitor.phase = ShareVisitorPhase.SENDING
            emitShares()
            sessions.sendShareFile(visitor.deviceId, share.file)
        } catch (t: Throwable) {
            visitor.phase = ShareVisitorPhase.FAILED
            visitor.note = t.message ?: "发送失败"
            events.error("给 ${visitor.name} 发送失败：${visitor.note}")
            emitShares()
            sessions.closeSharePeer(visitor.deviceId, visitor.note ?: "失败")
        }
    }

    private fun onVisitorLeft(message: ShareLeave) {
        if (message.to != identity.deviceId) return
        val share = outgoing[message.token] ?: return
        val visitor = share.visitors[message.from] ?: return
        visitor.phase = ShareVisitorPhase.LEFT
        sessions.closeSharePeer(message.from, "访客离开了")
        events.log("${visitor.name} 离开了")
        emitShares()
    }

    fun onTransferStatus(update: TransferUpdate) {
        val peerId = update.peerId ?: return
        val visitor = findVisitor(peerId)
        if (visitor != null) {
            if (update.status == TransferStatus.DONE) {
                visitor.phase = ShareVisitorPhase.DONE
                emitShares()
                sessions.closeSharePeer(peerId, "传完了")
            } else if (update.status == TransferStatus.ERROR) {
                visitor.phase = ShareVisitorPhase.FAILED
                visitor.note = update.message ?: "传输失败"
                emitShares()
                sessions.closeSharePeer(peerId, visitor.note ?: "传输失败")
            }
        }

        val current = visitState
        if (current != null && visiting?.first == peerId) {
            when (update.status) {
                TransferStatus.DONE -> setVisit(current.copy(phase = VisitPhase.DONE))
                TransferStatus.ERROR -> setVisit(
                    current.copy(phase = VisitPhase.FAILED, note = update.message ?: "传输失败"),
                )
                TransferStatus.ACTIVE -> if (update.direction == Direction.IN) {
                    setVisit(current.copy(phase = VisitPhase.DOWNLOADING))
                }
                else -> Unit
            }
        }
    }

    fun onProgress(direction: Direction, transferred: Long, size: Long) {
        val current = visitState ?: return
        if (direction != Direction.IN || visiting == null) return
        val now = System.currentTimeMillis()
        if (visitProgressAt == 0L) visitProgressAt = now
        val elapsed = (now - visitProgressAt).coerceAtLeast(1)
        setVisit(
            current.copy(
                phase = if (current.phase == VisitPhase.DONE) VisitPhase.DONE else VisitPhase.DOWNLOADING,
                progress = if (size > 0) (transferred.toFloat() / size).coerceIn(0f, 1f) else 1f,
                speed = if (transferred > 0 && elapsed >= 250) {
                    transferred * 1000 / elapsed
                } else {
                    current.speed
                },
            ),
        )
    }

    private fun findVisitor(peerId: String): TrackedVisitor? {
        for (share in outgoing.values) {
            share.visitors[peerId]?.let { return it }
        }
        return null
    }

    /* ---------------------------------------------------------- 访客侧 */

    fun currentVisit(): VisitUi? = visitState

    suspend fun visit(input: String) {
        visitGeneration += 1
        val token = parseShareToken(input)
        if (token == null) {
            visitState = null
            visiting = null
            setVisit(
                VisitUi(
                    token = input.trim(),
                    phase = VisitPhase.NOT_FOUND,
                    note = "这里面没有有效的分享编号",
                ),
            )
            return
        }
        visitState = null
        visiting = null
        visitProgressAt = 0L
        setVisit(VisitUi(token = token, phase = VisitPhase.CHECKING))

        events.onBusy(true)
        val found = try {
            registry.status(token)
        } catch (t: Throwable) {
            events.onBusy(false)
            setVisit(
                VisitUi(
                    token = token,
                    phase = VisitPhase.FAILED,
                    note = "问不到这条分享：${t.message ?: "网络错误"}",
                ),
            )
            return
        }
        events.onBusy(false)
        if (found == null) {
            setVisit(VisitUi(token = token, phase = VisitPhase.NOT_FOUND))
            return
        }
        val meta = VisitUi(
            token = token,
            phase = VisitPhase.CHECKING,
            name = found.name,
            size = found.size,
            mime = found.mime,
            deviceName = found.deviceName,
        )
        when (found.status) {
            "revoked" -> return setVisit(meta.copy(phase = VisitPhase.REVOKED))
            "expired" -> return setVisit(meta.copy(phase = VisitPhase.EXPIRED))
            "offline" -> return setVisit(meta.copy(phase = VisitPhase.OFFLINE))
        }
        val key = found.publicKey
        if (key == null || key.kty == "none") {
            return setVisit(
                meta.copy(
                    phase = VisitPhase.FAILED,
                    note = "这条分享没有登记公钥，没办法确认连过去的是不是它",
                ),
            )
        }
        if (identity.deviceIdFromKey(key) != found.deviceId) {
            return setVisit(
                meta.copy(
                    phase = VisitPhase.FAILED,
                    note = "注册表里的公钥和设备号对不上，可能有人在中间",
                ),
            )
        }
        if (!sessions.awaitSignaling()) {
            return setVisit(
                meta.copy(
                    phase = VisitPhase.FAILED,
                    note = "还没连上灯塔，稍后再试一次",
                ),
            )
        }
        visiting = found.deviceId to token
        sessions.noteSharePeer(found.deviceId, found.deviceName)
        sessions.registerSharePeer(
            found.deviceId,
            SharePeer(
                token = token,
                seeder = false,
                peerKey = key,
                peerName = found.deviceName,
            ),
        )
        sessions.sendSignal(
            ShareConnect(
                from = identity.deviceId,
                to = found.deviceId,
                token = token,
                name = deviceName(),
                publicKey = identity.publicJwk,
            ),
        )
        setVisit(meta.copy(phase = VisitPhase.CONNECTING))
        armVisitTimeout(token, visitGeneration)
    }

    /**
     * 分享者可能已经被系统冻结，注册表还显示在线，但 offer 永远不会来。
     * 只收拾还停在 CONNECTING 的那一次，已经在收或已经结束的不动。
     */
    private fun armVisitTimeout(token: String, generation: Int) {
        sessions.launchShare {
            delay(45_000)
            if (generation != visitGeneration) return@launchShare
            val current = visitState ?: return@launchShare
            if (current.token != token || current.phase != VisitPhase.CONNECTING) return@launchShare
            visiting?.let { sessions.closeSharePeer(it.first, "对方没有响应") }
            visiting = null
            setVisit(current.copy(phase = VisitPhase.FAILED, note = "对方一直没有回应，过一会儿再试"))
        }
    }

    fun leave() {
        val state = visitState ?: return
        val current = visiting
        if (current != null) {
            sessions.sendSignal(
                ShareLeave(identity.deviceId, current.first, state.token),
            )
            sessions.closeSharePeer(current.first, "访客取消")
        }
        visiting = null
        setVisit(state.copy(phase = VisitPhase.LEFT, note = "已取消"))
    }

    private fun onToldRevoked(message: ShareRevoked) {
        if (message.to != identity.deviceId) return
        val current = visitState ?: return
        if (current.token != message.token) return
        visiting?.let { sessions.closeSharePeer(it.first, "对方不再服务这条分享") }
        visiting = null
        val phase = when (message.reason) {
            "revoked" -> VisitPhase.REVOKED
            "expired" -> VisitPhase.EXPIRED
            "busy" -> VisitPhase.BUSY
            else -> VisitPhase.FAILED
        }
        setVisit(current.copy(phase = phase, note = reasonText(message.reason)))
    }

    private fun reasonText(reason: String): String = when (reason) {
        "revoked" -> "分享者撤销了这条链接"
        "expired" -> "这条链接到期了"
        "busy" -> "对方一次只给一个人发文件，等一下再试"
        "not-here" -> "分享者那一侧已经不认得这条链接了，多半是重启过"
        else -> reason
    }

    private fun setVisit(state: VisitUi) {
        visitState = state
        events.onVisit(state)
    }
}
