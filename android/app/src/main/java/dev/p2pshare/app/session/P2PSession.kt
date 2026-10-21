package dev.p2pshare.app.session

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import dev.p2pshare.app.core.Ack
import dev.p2pshare.app.core.AuthChallenge
import dev.p2pshare.app.core.AuthResponse
import dev.p2pshare.app.core.AuthResult
import dev.p2pshare.app.core.Base64Url
import dev.p2pshare.app.core.Bye
import dev.p2pshare.app.core.Code
import dev.p2pshare.app.core.CodeMiss
import dev.p2pshare.app.core.CodeOwner
import dev.p2pshare.app.core.ConnectRequest
import dev.p2pshare.app.core.ControlError
import dev.p2pshare.app.core.ControlMessage
import dev.p2pshare.app.core.Direction
import dev.p2pshare.app.core.Done
import dev.p2pshare.app.core.Hello
import dev.p2pshare.app.core.Ice
import dev.p2pshare.app.core.IceCandidateInit
import dev.p2pshare.app.core.Identity
import dev.p2pshare.app.core.LookupCode
import dev.p2pshare.app.core.Meta
import dev.p2pshare.app.core.NewCode
import dev.p2pshare.app.core.PLATFORM_NATIVE
import dev.p2pshare.app.core.PairRequest
import dev.p2pshare.app.core.PairResponse
import dev.p2pshare.app.core.Pairing
import dev.p2pshare.app.core.PeerLink
import dev.p2pshare.app.core.PeerState
import dev.p2pshare.app.core.Ping
import dev.p2pshare.app.core.Pong
import dev.p2pshare.app.core.Presence
import dev.p2pshare.app.core.PresenceList
import dev.p2pshare.app.core.PublicKeyJwk
import dev.p2pshare.app.core.RegistryClient
import dev.p2pshare.app.core.Rtc
import dev.p2pshare.app.core.RtcSession
import dev.p2pshare.app.core.Sdp
import dev.p2pshare.app.core.ShareConnect
import dev.p2pshare.app.core.ShareLeave
import dev.p2pshare.app.core.ShareRevoked
import dev.p2pshare.app.core.SignalError
import dev.p2pshare.app.core.SignalLinkState
import dev.p2pshare.app.core.SignalMessage
import dev.p2pshare.app.core.SignalingClient
import dev.p2pshare.app.core.TextMessage
import dev.p2pshare.app.core.TransferEngine
import dev.p2pshare.app.core.TransferHandlers
import dev.p2pshare.app.core.TransferStatus
import dev.p2pshare.app.core.TransferUpdate
import dev.p2pshare.app.core.Watch
import dev.p2pshare.app.core.decodeControl
import dev.p2pshare.app.core.encodeControl
import dev.p2pshare.app.core.toHex
import dev.p2pshare.app.data.AndroidFileSink
import dev.p2pshare.app.data.ContactRecord
import dev.p2pshare.app.data.ContactStore
import dev.p2pshare.app.data.DiagnosticsStore
import dev.p2pshare.app.data.HistoryEntry
import dev.p2pshare.app.data.HistoryStore
import dev.p2pshare.app.data.SettingsStore
import dev.p2pshare.app.data.ShareStore
import dev.p2pshare.app.data.UriSendFile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

/**
 * 把核心层按网页端 session.ts 的顺序串起来。
 *
 * 所有状态只在主线程改；信令回调、WebRTC 回调、传输回调都先切回主线程。
 * 这样不需要在状态机里到处加锁，代价是回调多一次调度，对这几个页面的量级无所谓。
 */
class P2PSession(context: Context) : ShareSessions {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())
    private val identity = Identity()
    private val settings = SettingsStore(appContext)
    private val contacts = ContactStore(appContext)
    private val historyStore = HistoryStore(appContext)
    private val shareStore = ShareStore(appContext)
    private val diagnostics = DiagnosticsStore(appContext)
    private val registry = RegistryClient(settings.httpBaseUrl)
    private val sink = AndroidFileSink(appContext)

    private val shareHub: ShareHub by lazy {
        ShareHub(
            identity = identity,
            registry = registry,
            sessions = this,
            shareStore = shareStore,
            fileFactory = { uri, mime ->
                UriSendFile(appContext, Uri.parse(uri), mime)
            },
            deviceName = { settings.deviceName },
            origin = settings.httpBaseUrl,
            events = object : ShareHub.Events {
                override fun onShares(list: List<ShareUi>) {
                    _state.update { it.copy(shares = list) }
                }

                override fun onVisit(state: VisitUi?) {
                    _state.update { it.copy(visit = state) }
                }

                override fun onBusy(busy: Boolean) {
                    _state.update { it.copy(shareBusy = busy) }
                }

                override fun log(line: String) = this@P2PSession.log(line)

                override fun error(message: String) = emitError(message)
            },
        )
    }

    private val _state = MutableStateFlow(
        AppState(
            deviceId = identity.deviceId,
            fingerprint = identity.fingerprint,
            deviceName = settings.deviceName,
            contacts = contacts.list(),
            history = historyStore.list(),
            logs = diagnostics.load(),
        ),
    )
    val state: StateFlow<AppState> = _state.asStateFlow()

    private val signalListener = object : SignalingClient.Listener {
        override fun onOpen() {
            scope.launch { handleSignalOpen() }
        }

        override fun onMessage(message: SignalMessage) {
            scope.launch { handleSignal(message) }
        }

        override fun onState(state: SignalLinkState) {
            scope.launch {
                _state.update { it.copy(signal = state) }
                when (state) {
                    is SignalLinkState.Connecting -> log("灯塔：正在连接")
                    is SignalLinkState.Open -> log("灯塔：已连接")
                    is SignalLinkState.Waiting ->
                        log("灯塔：第 ${state.attempt} 次重连，${state.delayMs / 1000} 秒后")
                    is SignalLinkState.Closed -> log("灯塔：已断开")
                }
            }
        }
    }
    private val signal = SignalingClient(
        baseUrl = settings.lighthouseUrl,
        deviceId = identity.deviceId,
        deviceName = settings.deviceName,
        scope = scope,
        listener = signalListener,
    )

    private val conns = mutableMapOf<String, Conn>()
    private val buffered = mutableMapOf<String, BufferedSignals>()
    private val pendingIce = mutableMapOf<String, MutableList<IceCandidateInit>>()
    private var started = false
    private var activePeerId: String? = null
    private var transferSeq = 0

    private var advertising = false
    private var advertisingJob: Job? = null
    private val issuedCodes = mutableMapOf<String, Long>()
    private var outgoingCode: String? = null
    private var outgoingPair: OutgoingPair? = null
    private var incomingPair: IncomingPair? = null
    private var pairTimeout: Job? = null
    private var joinTimeout: Job? = null
    private var pruneJob: Job? = null
    /** 息屏或锁屏期间按离线处理；亮屏解锁后恢复 */
    private var screenOffline = false
    private var screenReceiverRegistered = false
    private val logClock = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> goOffline("屏幕已关闭")
                // 亮屏那一瞬间锁屏通常还在，USER_PRESENT 也不一定发（没有锁屏时），
                // 所以隔一会儿再看几次，确认屏幕亮着且已经解锁才恢复上线
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> scheduleOnlineCheck()
            }
        }
    }

    private fun scheduleOnlineCheck() {
        scope.launch {
            repeat(6) {
                if (!screenOffline) return@launch
                if (screenUsable()) {
                    goOnline()
                    return@launch
                }
                delay(500)
            }
        }
    }

    private val myId: String get() = identity.deviceId

    init {
        // 原生库加载要几百毫秒，放在应用启动时做，别等用户第一次点发送。
        Rtc.initialize(appContext)
        // 触发一次，把上次没到期的分享链接从本地恢复出来。
        shareHub
    }

    fun start() {
        if (started) return
        started = true
        // 先把上次退出后已经过期的网页端联系人清掉，再连灯塔。
        // 这时还没收到 presence，只能按 lastSeenAt / pairedAt 估离线起点。
        pruneContacts(includeNeverSeenOffline = true)
        registerScreenReceiver()
        signal.start()
        scope.launch(Dispatchers.IO) { pruneSharedCopies() }
        // 光靠启动和 presence 变化，界面上一直没人动的时候过期记录会一直留着。
        // 定时扫一遍，间隔不超过窗口的一半，验收时把窗口改小也能按时看到效果。
        val sweep = minOf(WEB_CONTACT_SWEEP_MS, WEB_CONTACT_TTL_MS / 2)
        pruneJob = scope.launch {
            while (true) {
                delay(sweep)
                pruneContacts()
            }
        }
    }

    fun close() {
        unregisterScreenReceiver()
        pruneJob?.cancel()
        pruneJob = null
        signal.close()
        for (conn in conns.values.toList()) resetConn(conn, "应用已关闭", keepWaiter = false)
        conns.clear()
        scope.cancel()
    }

    /* ---------------------------------------------------------- 息屏下线 */

    private fun registerScreenReceiver() {
        if (screenReceiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                appContext.registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                appContext.registerReceiver(screenReceiver, filter)
            }
            screenReceiverRegistered = true
        }.onFailure { log("监听息屏失败：${it.message ?: "未知原因"}") }
    }

    private fun unregisterScreenReceiver() {
        if (!screenReceiverRegistered) return
        runCatching { appContext.unregisterReceiver(screenReceiver) }
        screenReceiverRegistered = false
    }

    private fun screenUsable(): Boolean {
        val power = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val keyguard = appContext.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        val awake = power?.isInteractive ?: true
        val locked = keyguard?.isKeyguardLocked ?: false
        return awake && !locked
    }

    /**
     * 息屏或锁屏等于下线：停止报码、断开数据通道、关掉灯塔连接。
     *
     * 灯塔的连接一断，watcher 立刻收到离线推送；分享链接因此变成「对方不在线」。
     * 正在传的文件标成「已取消（屏幕关闭）」，不做续传。
     */
    private fun goOffline(reason: String) {
        if (screenOffline) return
        screenOffline = true
        log("$reason，按离线处理")
        stopAdvertising()
        pairTimeout?.cancel()
        pairTimeout = null
        joinTimeout?.cancel()
        joinTimeout = null
        incomingPair = null
        outgoingPair = null
        outgoingCode = null
        _state.update { it.copy(pairing = null, joining = false) }
        for (conn in conns.values.toList()) {
            // 先发取消原因再拆链路；数据通道和 RTC 晚 400ms 关，给取消帧留出上路时间。
            val engine = conn.engine
            val link = conn.link
            val rtc = conn.rtc
            conn.engine = null
            engine?.notifyCancel("screen-off")
            engine?.detach(CANCELLED_BY_SCREEN_OFF)
            scope.launch {
                delay(400)
                engine?.close()
                link?.close()
                rtc?.close()
            }
            resetConn(conn, reason, keepWaiter = false, closeTransport = false)
        }
        // 离线期间收不到 presence；把已知状态按离线算，
        // 解锁后灯塔重新推 online 时才会被当成「刚上线」触发自动重连
        _state.update { state ->
            state.copy(presence = state.presence.mapValues { false })
        }
        signal.close()
    }

    /** 亮屏并解锁：重新连灯塔。对端还在线的话，presence 回来时会自动连回会话页。 */
    private fun goOnline() {
        if (!screenOffline) return
        screenOffline = false
        log("屏幕已解锁，重新上线")
        signal.start()
    }

    /* ---------------------------------------------------------- 设置 */

    fun setDeviceName(name: String) {
        val clean = name.trim().take(24)
        if (clean.isEmpty()) return
        settings.deviceName = clean
        _state.update { it.copy(deviceName = clean) }
        sendHello()
    }

    fun clearError(id: Long) {
        _state.update { if (it.error?.id == id) it.copy(error = null) else it }
    }

    /* ---------------------------------------------------------- 配对码 */

    fun startAdvertising() {
        if (advertising) return
        advertising = true
        log("开始报码")
        _state.update { it.copy(advertising = true) }
        advertisingJob?.cancel()
        advertisingJob = scope.launch {
            requestCode()
            while (isActive) {
                delay(Pairing.CODE_ROTATE_MS)
                if (!advertising) break
                requestCode()
            }
        }
    }

    fun stopAdvertising() {
        if (advertising) log("停止报码")
        advertising = false
        advertisingJob?.cancel()
        advertisingJob = null
        issuedCodes.clear()
        _state.update {
            it.copy(advertising = false, code = null, codeExpiresAt = 0, pairLink = null)
        }
    }

    fun refreshCode() {
        requestCode()
    }

    private fun requestCode() {
        if (!advertising) return
        signal.send(NewCode)
    }

    fun joinWithCode(text: String) {
        val code = Pairing.normalizeCode(text)
        if (code == null) {
            emitError("配对码是 6 位数字，也可以直接粘整条链接")
            return
        }
        if (signal.state !is SignalLinkState.Open) {
            emitError("还没连上灯塔，稍等一下再试")
            return
        }
        outgoingCode = code
        log("查找配对码（6 位）")
        _state.update { it.copy(joining = true) }
        joinTimeout?.cancel()
        joinTimeout = scope.launch {
            delay(15_000)
            if (outgoingCode == code && outgoingPair == null) {
                outgoingCode = null
                _state.update { it.copy(joining = false) }
                emitError("灯塔没有回应，稍后再试一次")
            }
        }
        signal.send(LookupCode(code))
    }

    fun cancelJoin() {
        joinTimeout?.cancel()
        joinTimeout = null
        outgoingCode = null
        _state.update { it.copy(joining = false) }
    }

    fun confirmPairing(accept: Boolean) {
        val incoming = incomingPair ?: return
        log("${if (accept) "接受" else "拒绝"}配对（${shortId(incoming.from)}）")
        pairTimeout?.cancel()
        pairTimeout = null
        if (!accept) {
            signal.send(
                PairResponse(
                    myId,
                    incoming.from,
                    false,
                    "对方拒绝了配对",
                    platform = PLATFORM_NATIVE,
                ),
            )
            incomingPair = null
            // 拒绝之后把码收掉：留着一个已经被人试过的码没有意义。
            stopAdvertising()
            _state.update { it.copy(pairing = null) }
            return
        }
        issuedCodes.remove(incoming.code)
        incomingPair = null
        stopAdvertising()
        val record = ContactRecord(
            peerId = incoming.from,
            peerName = incoming.name,
            publicKey = incoming.publicKey,
            fingerprint = identity.fingerprintOf(incoming.publicKey),
            pairedAt = System.currentTimeMillis(),
            peerPlatform = incoming.platform,
        )
        contacts.add(record)
        updatePresence(incoming.from, true, incoming.name)
        refreshContacts()
        _state.update { it.copy(pairing = null) }
        // 顺序和网页端一致：先写通讯录、先订阅，再回 pair-response。
        // 灯塔的 watch 是整体替换，不能只发新对端，否则其他联系人的在线状态不再更新。
        sendWatch()
        signal.send(PairResponse(myId, incoming.from, true, platform = PLATFORM_NATIVE))
        flushPending(incoming.from)
        connectPeer(incoming.from)
    }

    fun dismissPairing() {
        if (incomingPair != null) {
            confirmPairing(false)
            return
        }
        outgoingPair = null
        outgoingCode = null
        joinTimeout?.cancel()
        joinTimeout = null
        pairTimeout?.cancel()
        pairTimeout = null
        _state.update { it.copy(pairing = null, joining = false) }
    }

    /* ---------------------------------------------------------- 连接 */

    fun connect(peerId: String) {
        // 用户自己点了这台设备，就把自动重连的计数清掉，免得下一次失败直接放弃
        val conn = conns[peerId]
        conn?.autoRetryJob?.cancel()
        conn?.autoRetryJob = null
        conn?.autoRetries = 0
        connectPeer(peerId)
    }

    /** 回首页但不断开：连接和正在进行的传输留在后台。 */
    fun background(peerId: String) {
        if (activePeerId == peerId) setActive(null)
    }

    fun disconnect(peerId: String) {
        val conn = conns[peerId] ?: return
        conn.autoRetryJob?.cancel()
        conn.autoRetryJob = null
        conn.autoRetries = 0
        resetConn(conn, "已断开", keepWaiter = false)
        if (activePeerId == peerId) setActive(null)
    }

    fun forget(peerId: String) {
        disconnect(peerId)
        contacts.remove(peerId)
        refreshContacts()
        _state.update {
            it.copy(
                presence = it.presence - peerId,
                presenceNames = it.presenceNames - peerId,
                peers = it.peers - peerId,
            )
        }
        // 通讯录变了，订阅也要跟着缩小
        sendWatch()
    }

    private fun connectPeer(peerId: String): CompletableDeferred<Unit> {
        val conn = conn(peerId)
        conn.waiter?.takeIf { !it.isCompleted }?.let { return it }
        val waiter = CompletableDeferred<Unit>()
        conn.waiter = waiter

        if (conn.phase == SessionPhase.READY && conn.link?.state == PeerState.CONNECTED) {
            // 已经连着也要把界面带到会话页，否则首页点联系人没有任何反应。
            setActive(peerId)
            waiter.complete(Unit)
            return waiter
        }
        if (contacts.get(peerId) == null) {
            conn.waiter = null
            waiter.completeExceptionally(IOException("这台设备还没有配对记录"))
            return waiter
        }
        if (_state.value.presence[peerId] == false) {
            conn.waiter = null
            waiter.completeExceptionally(IOException("对方不在线"))
            return waiter
        }

        setActive(peerId)

        // 对端的 offer 可能刚刚先到一步，已经接管成了会话。offer 是一次性的，
        // 这里再重置等于把它作废，两边会一起等到超时（网页端 session.ts 同理）。
        val handshaking = conn.rtc != null
        if (!handshaking) {
            resetConn(conn, "重新连接", keepWaiter = true)
            setPhase(conn, SessionPhase.SIGNALING)
            armConnectTimeout(conn)
        } else {
            log("已有握手在跑，继续等 ${shortId(peerId)}")
            if (conn.timer == null) armConnectTimeout(conn)
        }

        val offer = buffered.remove(peerId)?.let { entry ->
            if (System.currentTimeMillis() - entry.at <= BUFFER_TTL_MS) {
                entry.messages.filterIsInstance<Sdp>().lastOrNull { it.description.type == "offer" }
            } else {
                null
            }
        }
        if (offer != null) {
            log("接管 ${shortId(peerId)} 先发来的 offer")
            if (conn.rtc == null) startRtc(conn, initiator = false)
            conn.rtc?.handleRemoteDescription("offer", offer.description.sdp)
        } else if (!handshaking) {
            if (ownsChannel(peerId)) {
                log("开始连接 ${shortId(peerId)}：我发起")
                startRtc(conn, initiator = true)
            } else {
                log("开始连接 ${shortId(peerId)}：等对方发起")
                signal.send(ConnectRequest(myId, peerId))
            }
        }
        return waiter
    }

    private suspend fun ensureConnected(peerId: String) {
        if (conns[peerId]?.phase == SessionPhase.READY) return
        connectPeer(peerId).await()
    }

    private fun armConnectTimeout(conn: Conn) {
        conn.timer?.cancel()
        conn.timer = scope.launch {
            delay(CONNECT_TIMEOUT_MS)
            if (conn.phase != SessionPhase.READY) {
                conn.timer = null
                failConn(conn, "连不上对方：20 秒内没打通")
            }
        }
    }

    private fun startRtc(conn: Conn, initiator: Boolean) {
        if (conn.rtc != null) return
        log("建立 WebRTC（${if (initiator) "我发 offer" else "我应答"}）")
        val generation = conn.generation
        val rtc = RtcSession(
            factory = Rtc.factory(),
            initiator = initiator,
            onLocalDescription = { type, sdp ->
                scope.launch {
                    if (generation != conn.generation) return@launch
                    log("→ sdp $type 给 ${shortId(conn.peerId)}")
                    signal.send(
                        Sdp(myId, conn.peerId, dev.p2pshare.app.core.SessionDescription(type, sdp)),
                    )
                    if (conn.phase == SessionPhase.SIGNALING) setPhase(conn, SessionPhase.ICE)
                }
            },
            onLocalCandidate = { candidate ->
                scope.launch {
                    if (generation == conn.generation) {
                        signal.send(Ice(myId, conn.peerId, candidate))
                    }
                }
            },
            onLink = { link ->
                scope.launch { attachLink(conn, link, generation) }
            },
            onFailure = { reason ->
                scope.launch {
                    if (generation == conn.generation) failConn(conn, reason)
                }
            },
        )
        conn.rtc = rtc
        // offer 和最初几个 host candidate 是两条异步回调，谁先到不保证。
        // 先把早到的候选收着，等这里有了会话再补进去。
        pendingIce.remove(conn.peerId)?.forEach(rtc::addRemoteCandidate)
        if (conn.phase == SessionPhase.SIGNALING) setPhase(conn, SessionPhase.ICE)
    }

    private fun attachLink(conn: Conn, link: PeerLink, generation: Int) {
        if (generation != conn.generation) {
            link.close()
            return
        }
        if (conn.link != null) return
        conn.link = link
        log("数据通道已建立")
        link.onText { raw ->
            scope.launch {
                if (generation == conn.generation) handleControl(conn, raw)
            }
        }
        link.onStateChange { peerState ->
            scope.launch {
                if (generation != conn.generation) return@launch
                when (peerState) {
                    PeerState.CONNECTED -> startAuth(conn, link, generation)
                    PeerState.CLOSED, PeerState.FAILED -> {
                        if (conn.phase != SessionPhase.IDLE) failConn(conn, "点对点连接断了")
                    }
                    else -> Unit
                }
            }
        }
        // 传输引擎在通道一开就挂上，不等认证走完。对端收到我们的 AuthResult 那一刻
        // 就可能开始发文件，而引擎晚挂一步就会把最前面的 meta 和分片当成不认识的控制帧
        // 丢掉：发送端显示「发送失败」，接收端连一条传输记录都没有。
        ensureEngine(conn, link)
        if (link.state == PeerState.CONNECTED) startAuth(conn, link, generation)
    }

    /** 挂传输引擎；重复调用无副作用，重连时 resetConn 会把它清掉再挂新的 */
    private fun ensureEngine(conn: Conn, link: PeerLink) {
        if (conn.engine != null) return
        val engine = TransferEngine(
            sink = sink,
            handlers = transferHandlers(conn.peerId),
            newTransferId = { newTransferId() },
            peerId = conn.peerId,
        )
        engine.attach(link)
        conn.engine = engine
    }

    private fun startAuth(conn: Conn, link: PeerLink, generation: Int) {
        if (conn.authStarted || generation != conn.generation || conn.phase == SessionPhase.READY) return
        conn.authStarted = true
        setPhase(conn, SessionPhase.AUTH)
        log("开始认证")
        scope.launch {
            // 给对端一点时间挂上消息处理；通道 open 和观察者就绪之间有一个很窄的窗口。
            delay(40)
            if (generation != conn.generation || conn.link !== link) return@launch
            val challenge = Pairing.newChallenge(identity, myId, conn.peerId)
            conn.myChallenge = challenge
            link.sendText(encodeControl(AuthChallenge(challenge.nonce, challenge.issuedAt)))
        }
    }

    private fun handleControl(conn: Conn, raw: String) {
        when (val message = decodeControl(raw) ?: return) {
            is AuthChallenge -> handleAuthChallenge(conn, message)
            is AuthResponse -> handleAuthResponse(conn, message)
            is AuthResult -> handleAuthResult(conn, message)
            is Ping -> conn.link?.sendText(encodeControl(Pong(message.id)))
            else -> Unit
        }
    }

    private fun handleAuthChallenge(conn: Conn, message: AuthChallenge) {
        val result = Pairing.responseSignature(
            identity = identity,
            myId = myId,
            peerId = conn.peerId,
            nonce = message.nonce,
            issuedAt = message.issuedAt,
        )
        if (result.isFailure) {
            val reason = result.exceptionOrNull()?.message ?: "挑战无效"
            conn.link?.sendText(encodeControl(AuthResult(false, reason)))
            failConn(conn, "拒绝了这个挑战：$reason")
            return
        }
        conn.link?.sendText(encodeControl(AuthResponse(Base64Url.encode(result.getOrThrow()))))
    }

    private fun handleAuthResponse(conn: Conn, message: AuthResponse) {
        val challenge = conn.myChallenge ?: return
        val peerKey = conn.share?.peerKey ?: contacts.get(conn.peerId)?.publicKey
        if (peerKey == null) {
            conn.link?.sendText(encodeControl(AuthResult(false, "没有这台的身份记录")))
            failConn(conn, "对端既不在通讯录里，也不是哪条分享的访客")
            return
        }
        val signature = runCatching { Base64Url.decode(message.sig) }.getOrNull()
        if (signature == null) {
            conn.link?.sendText(encodeControl(AuthResult(false, "签名格式不对")))
            failConn(conn, "认证失败：签名格式不对")
            return
        }
        val reason = Pairing.verifyResponse(identity, challenge, signature, peerKey)
        if (reason != null) {
            conn.link?.sendText(encodeControl(AuthResult(false, reason)))
            failConn(conn, "认证失败：$reason")
            return
        }
        conn.iVerifiedPeer = true
        log("已验明对方身份")
        conn.link?.sendText(encodeControl(AuthResult(true)))
        maybeReady(conn)
    }

    private fun handleAuthResult(conn: Conn, message: AuthResult) {
        if (!message.ok) {
            failConn(conn, "对方拒绝了认证：${message.reason ?: "未说明原因"}")
            return
        }
        conn.peerVerifiedMe = true
        log("对方已验明我的身份")
        maybeReady(conn)
    }

    private fun maybeReady(conn: Conn) {
        if (!conn.iVerifiedPeer || !conn.peerVerifiedMe) return
        if (conn.phase == SessionPhase.READY) return
        val link = conn.link ?: return
        if (link.state != PeerState.CONNECTED) return
        conn.timer?.cancel()
        conn.timer = null
        // 连上了就把自动重连额度还回去，下次掉线还能再试
        conn.autoRetryJob?.cancel()
        conn.autoRetryJob = null
        conn.autoRetries = 0
        setPhase(conn, SessionPhase.READY)
        log("连接就绪：${shortId(conn.peerId)}")
        ensureEngine(conn, link)
        if (conn.share == null) {
            setActive(conn.peerId)
            contacts.touch(conn.peerId, System.currentTimeMillis())
            refreshContacts()
        }
        conn.waiter?.let { waiter ->
            if (!waiter.isCompleted) waiter.complete(Unit)
        }
        conn.waiter = null
    }

    private fun failConn(conn: Conn, reason: String) {
        val waiter = conn.waiter
        conn.waiter = null
        conn.timer?.cancel()
        conn.timer = null
        resetConn(conn, reason, keepWaiter = true)
        // 自动重连的次数用完了，就把失败文案换成用户能执行的下一步
        val hint = if (conn.autoRetries >= MAX_AUTO_RETRIES && _state.value.presence[conn.peerId] == true) {
            "对方已上线，点重试"
        } else {
            reason
        }
        setPhase(conn, SessionPhase.FAILED, hint)
        waiter?.completeExceptionally(IOException(reason))
        // 会话页自己会写原因和「重试」；只有用户不在这一页时才弹提示
        if (activePeerId != conn.peerId) emitError(reason)
    }

    /** 拆掉一个对端的所有连接资源。generation 一变，旧链路的迟到回调就全部作废。 */
    private fun resetConn(
        conn: Conn,
        reason: String,
        keepWaiter: Boolean,
        closeTransport: Boolean = true,
    ) {
        conn.generation += 1
        conn.timer?.cancel()
        conn.timer = null
        conn.engine?.close()
        conn.engine = null
        if (closeTransport) {
            conn.link?.close()
            conn.rtc?.close()
        }
        conn.link = null
        conn.rtc = null
        conn.myChallenge = null
        conn.iVerifiedPeer = false
        conn.peerVerifiedMe = false
        conn.authStarted = false
        pendingIce.remove(conn.peerId)
        if (!keepWaiter) {
            conn.waiter?.completeExceptionally(IOException(reason))
            conn.waiter = null
        }
        setPhase(conn, SessionPhase.IDLE)
    }

    /* ---------------------------------------------------------- 发送 */

    fun sendFiles(peerId: String, uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            val files = uris.map { UriSendFile(appContext, it) }
            val unreadable = files.firstOrNull { it.size < 0 }
            if (unreadable != null) {
                emitError("读不出「${unreadable.name}」的大小，换一个文件试试")
                return@launch
            }
            setActive(peerId)
            val items = files.map { file ->
                val id = newTransferId()
                addTransfer(
                    TransferItem(
                        id = id,
                        peerId = peerId,
                        direction = Direction.OUT,
                        name = file.name,
                        size = file.size,
                        mime = file.mime,
                    ),
                )
                id to file
            }
            try {
                ensureConnected(peerId)
                val engine = conns[peerId]?.engine ?: throw IOException("连接还没有准备好")
                for ((id, file) in items) engine.enqueue(id, file)
            } catch (t: Throwable) {
                val reason = t.message ?: "发送失败"
                for ((id, _) in items) {
                    updateTransfer(id) {
                        it.copy(status = TransferStatus.ERROR, message = reason)
                    }
                }
                emitError(reason)
            }
        }
    }

    fun sendText(peerId: String, text: String) {
        val clean = text.trim()
        if (clean.isEmpty()) return
        scope.launch {
            setActive(peerId)
            try {
                ensureConnected(peerId)
                val engine = conns[peerId]?.engine ?: throw IOException("连接还没有准备好")
                if (!engine.sendText(clean)) throw IOException("连接已关闭")
                addText(
                    TextItem(
                        id = newTransferId(),
                        peerId = peerId,
                        direction = Direction.OUT,
                        text = clean,
                    ),
                )
            } catch (t: Throwable) {
                emitError(t.message ?: "发送失败")
            }
        }
    }

    /* ---------------------------------------------------------- 公开链接 */

    fun createShare(uri: Uri) {
        scope.launch {
            shareHub.createShare(UriSendFile(appContext, uri))
        }
    }

    /**
     * 从系统分享面板进来的文件。
     *
     * SAF 的文件可以拿到持久读权限，直接引用；相册和大部分文件管理器只给
     * 临时权限，进程一重来链接就断了，所以这类要先复制进应用目录。
     */
    fun shareSharedFiles(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            _state.update { it.copy(shareBusy = true) }
            try {
                for (uri in uris) {
                    val file = try {
                        prepareSharedFile(uri)
                    } catch (t: Throwable) {
                        emitError("读不了分享进来的文件：${t.message ?: "未知错误"}")
                        continue
                    }
                    shareHub.createShare(file)
                }
            } finally {
                _state.update { it.copy(shareBusy = false) }
            }
        }
    }

    private suspend fun prepareSharedFile(uri: Uri): UriSendFile = withContext(Dispatchers.IO) {
        val persisted = runCatching {
            appContext.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
            true
        }.getOrDefault(false)
        if (persisted) return@withContext UriSendFile(appContext, uri)

        val source = UriSendFile(appContext, uri)
        if (source.size < 0) throw IOException("读不出「${source.name}」的大小")
        val dir = File(appContext.filesDir, "shared").apply { mkdirs() }
        val dest = uniqueFile(dir, source.name)
        appContext.contentResolver.openInputStream(uri)?.use { input ->
            dest.outputStream().use { output -> input.copyTo(output, 256 * 1024) }
        } ?: throw IOException("打不开「${source.name}」")
        UriSendFile(appContext, Uri.fromFile(dest), source.mime)
    }

    private fun uniqueFile(dir: File, name: String): File {
        var file = File(dir, name)
        if (!file.exists()) return file
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var index = 2
        while (file.exists()) {
            file = File(dir, "$base ($index)$ext")
            index += 1
        }
        return file
    }

    /** 分享过期或撤销之后，把应用目录里的副本清掉。 */
    private fun pruneSharedCopies() {
        val referenced = shareStore.list()
            .mapNotNull { record ->
                Uri.parse(record.uri).takeIf { it.scheme == "file" }?.path
            }
            .toSet()
        val dir = File(appContext.filesDir, "shared")
        dir.listFiles()?.forEach { file ->
            if (file.absolutePath !in referenced) runCatching { file.delete() }
        }
    }

    fun revokeShare(token: String) {
        scope.launch { shareHub.revoke(token) }
    }

    fun visitShare(input: String) {
        scope.launch { shareHub.visit(input) }
    }

    fun leaveShare() {
        shareHub.leave()
    }

    override suspend fun awaitSignaling(): Boolean {
        if (signal.state is SignalLinkState.Open) return true
        return withTimeoutOrNull(12_000) {
            _state.map { it.signal }.first { it is SignalLinkState.Open }
            true
        } ?: false
    }

    override fun registerSharePeer(peerId: String, share: SharePeer) {
        val conn = conn(peerId)
        val same = conn.share != null &&
            conn.share!!.token == share.token &&
            conn.share!!.seeder == share.seeder
        conn.share = share
        if (!same) {
            // 同一台设备换了一条分享，旧链路的认证公钥已经不对了，必须拆掉重来。
            resetConn(conn, "换了一条分享", keepWaiter = false)
        }
    }

    override suspend fun serveSharePeer(peerId: String) {
        val conn = conns[peerId] ?: throw IOException("没有这个分享对端")
        val share = conn.share ?: throw IOException("没有分享记录")
        if (!share.seeder) throw IOException("访客不发起连接，等对方把 offer 送过来")
        if (conn.phase == SessionPhase.READY) return
        val waiter = conn.waiter?.takeIf { !it.isCompleted }
            ?: CompletableDeferred<Unit>().also { conn.waiter = it }
        if (conn.rtc == null) {
            resetConn(conn, "开始服务这个访客", keepWaiter = true)
            conn.waiter = waiter
            setPhase(conn, SessionPhase.SIGNALING)
            armConnectTimeout(conn)
            startRtc(conn, initiator = true)
        }
        waiter.await()
    }

    override fun closeSharePeer(peerId: String, reason: String) {
        val conn = conns.remove(peerId) ?: return
        resetConn(conn, reason, keepWaiter = false)
        conn.share = null
        _state.update { it.copy(peers = it.peers - peerId) }
    }

    override suspend fun sendShareFile(peerId: String, file: UriSendFile) {
        val engine = conns[peerId]?.engine ?: throw IOException("连接还没有准备好")
        val id = newTransferId()
        addTransfer(
            TransferItem(
                id = id,
                peerId = peerId,
                direction = Direction.OUT,
                name = file.name,
                size = file.size,
                mime = file.mime,
            ),
        )
        engine.enqueue(id, file)
    }

    override fun noteSharePeer(peerId: String, name: String) {
        // 公开分享不写通讯录，但界面和传输记录需要一个名字。
        updatePresence(peerId, true, name)
    }

    override fun sendSignal(message: SignalMessage) {
        signal.send(message)
    }

    override fun launchShare(block: suspend () -> Unit) {
        scope.launch { block() }
    }

    /* ---------------------------------------------------------- 信令分发 */

    private fun handleSignalOpen() {
        log("向灯塔发送 hello / watch")
        sendHello()
        sendWatch()
        if (advertising) requestCode()
    }

    private fun sendHello() {
        signal.send(Hello(myId, settings.deviceName, identity.publicJwk))
    }

    /** 灯塔的 watch 是整体替换的，每次都要把完整通讯录发过去；extra 用于还没入册的对端 */
    private fun sendWatch(extra: String? = null) {
        signal.send(Watch(contacts.list().map { it.peerId } + listOfNotNull(extra)))
    }

    private fun handleSignal(message: SignalMessage) {
        when (message) {
            is PresenceList -> {
                for (entry in message.entries) {
                    updatePresence(entry.id, entry.online, entry.name)
                }
            }
            is Presence -> updatePresence(message.id, message.online, message.name)
            is Code -> {
                if (!advertising) return
                log("灯塔发来新配对码")
                val now = System.currentTimeMillis()
                issuedCodes[message.code] = message.expiresAt
                issuedCodes.entries.removeAll { it.value < now }
                while (issuedCodes.size > Pairing.MAX_CODES_PER_DEVICE) {
                    val oldest = issuedCodes.entries.minByOrNull { it.value } ?: break
                    issuedCodes.remove(oldest.key)
                }
                _state.update {
                    it.copy(
                        code = message.code,
                        codeExpiresAt = message.expiresAt,
                        pairLink = "${settings.httpBaseUrl}/#c=${message.code}",
                    )
                }
            }
            is CodeOwner -> handleCodeOwner(message)
            is CodeMiss -> {
                if (message.code != outgoingCode) return
                outgoingCode = null
                joinTimeout?.cancel()
                joinTimeout = null
                _state.update { it.copy(joining = false) }
                val suffix = message.retryAfterMs?.takeIf { it > 0 }?.let {
                    "（${(it + 999) / 1000} 秒后再试）"
                } ?: ""
                emitError("这个配对码没找到：${message.reason}$suffix")
            }
            is PairRequest -> handlePairRequest(message)
            is PairResponse -> handlePairResponse(message)
            is ShareConnect -> shareHub.onSignal(message)
            is ShareRevoked -> shareHub.onSignal(message)
            is ShareLeave -> shareHub.onSignal(message)
            is ConnectRequest -> {
                if (message.to != myId) return
                log("← connect-request（${shortId(message.from)}）")
                if (conns[message.from]?.share != null) return
                if (contacts.get(message.from) == null) return
                // 对方能发这条，说明它就在线；presence 可能还是断线前的旧值。
                updatePresence(message.from, true, null)
                connectPeer(message.from)
            }
            is Sdp -> {
                if (message.to == myId && message.from != myId) {
                    log("← sdp ${message.description.type}（${shortId(message.from)}）")
                }
                routeSdp(message)
            }
            is Ice -> {
                if (message.to != myId) return
                val kind = message.candidate.candidate
                    .substringAfter(" typ ", "?")
                    .substringBefore(' ')
                log("← ice $kind（${shortId(message.from)}）")
                val rtc = conns[message.from]?.rtc
                if (rtc != null) {
                    rtc.addRemoteCandidate(message.candidate)
                } else if (contacts.get(message.from) != null || conns[message.from]?.share != null) {
                    val list = pendingIce.getOrPut(message.from) { mutableListOf() }
                    if (list.size < MAX_PENDING_ICE) list.add(message.candidate)
                }
            }
            is Bye -> {
                log("对方断开（${shortId(message.from)}）")
                disconnect(message.from)
            }
            is SignalError -> emitError("灯塔返回错误：${message.code} ${message.message}")
            else -> Unit
        }
    }

    private fun handleCodeOwner(message: CodeOwner) {
        if (message.code != outgoingCode) return
        log("查到码主 ${shortId(message.deviceId)}（${message.name}）")
        val derived = identity.deviceIdFromKey(message.publicKey)
        if (derived != message.deviceId || derived.isBlank()) {
            outgoingCode = null
            _state.update { it.copy(joining = false) }
            emitError("对方送来的公钥和它的设备号对不上，可能有人在中间")
            return
        }
        joinTimeout?.cancel()
        joinTimeout = null
        outgoingPair = OutgoingPair(message.deviceId, message.name, message.publicKey)
        val sas = Pairing.sas(identity, message.publicKey, identity.publicJwk)
        _state.update {
            it.copy(
                joining = false,
                pairing = PairingUi(
                    peerId = message.deviceId,
                    peerName = message.name,
                    sas = sas,
                    role = PairingRole.JOINER,
                    // 这一侧要到 pair-response 才知道对方的端类型
                    peerPlatform = "",
                ),
            )
        }
        pairTimeout?.cancel()
        pairTimeout = scope.launch {
            delay(45_000)
            val pending = outgoingPair
            if (pending != null && pending.peerId == message.deviceId) {
                outgoingPair = null
                outgoingCode = null
                _state.update { it.copy(pairing = null) }
                emitError("对方一直没确认，再试一次吧")
            }
        }
        sendWatch(message.deviceId)
        signal.send(
            PairRequest(
                from = myId,
                to = message.deviceId,
                code = message.code,
                name = settings.deviceName,
                publicKey = identity.publicJwk,
                platform = PLATFORM_NATIVE,
            ),
        )
    }

    private fun handlePairRequest(message: PairRequest) {
        if (message.to != myId) return
        if (screenOffline) {
            // 息屏/锁屏时不接受新的配对；信令可能已经断开，发不出去也没关系
            signal.send(
                PairResponse(
                    myId,
                    message.from,
                    false,
                    "对方屏幕已关闭，稍后再试",
                    platform = PLATFORM_NATIVE,
                ),
            )
            return
        }
        log("收到配对请求（${shortId(message.from)}）")
        val expiresAt = issuedCodes[message.code]
        if (expiresAt == null) {
            signal.send(
                PairResponse(
                    myId,
                    message.from,
                    false,
                    "这个配对码不是我发出去的",
                    platform = PLATFORM_NATIVE,
                ),
            )
            return
        }
        if (expiresAt < System.currentTimeMillis()) {
            issuedCodes.remove(message.code)
            signal.send(
                PairResponse(
                    myId,
                    message.from,
                    false,
                    "配对码已经换过了，让对方用屏幕上新的那个",
                    platform = PLATFORM_NATIVE,
                ),
            )
            return
        }
        if (identity.deviceIdFromKey(message.publicKey) != message.from) {
            signal.send(
                PairResponse(
                    myId,
                    message.from,
                    false,
                    "设备号和公钥对不上",
                    platform = PLATFORM_NATIVE,
                ),
            )
            return
        }
        val sas = Pairing.sas(identity, identity.publicJwk, message.publicKey)
        updatePresence(message.from, true, message.name)
        incomingPair = IncomingPair(
            from = message.from,
            name = message.name,
            publicKey = message.publicKey,
            code = message.code,
            platform = message.platform,
        )
        _state.update {
            it.copy(
                pairing = PairingUi(
                    peerId = message.from,
                    peerName = message.name,
                    sas = sas,
                    role = PairingRole.OWNER,
                    peerPlatform = message.platform,
                ),
            )
        }
        pairTimeout?.cancel()
        pairTimeout = scope.launch {
            delay(60_000)
            if (incomingPair?.from == message.from) {
                incomingPair = null
                _state.update { it.copy(pairing = null) }
                emitError("配对请求超时了，让对方重新试一次")
            }
        }
    }

    private fun handlePairResponse(message: PairResponse) {
        if (message.to != myId) return
        val pending = outgoingPair ?: return
        if (pending.peerId != message.from) return
        log("配对回应：${if (message.accepted) "接受" else "拒绝"}")
        pairTimeout?.cancel()
        pairTimeout = null
        outgoingPair = null
        outgoingCode = null
        _state.update { it.copy(pairing = null) }
        if (!message.accepted) {
            emitError("对方拒绝了配对：${message.reason ?: "未说明原因"}")
            return
        }
        contacts.add(
            ContactRecord(
                peerId = pending.peerId,
                peerName = pending.name,
                publicKey = pending.publicKey,
                fingerprint = identity.fingerprintOf(pending.publicKey),
                pairedAt = System.currentTimeMillis(),
                peerPlatform = message.platform.ifBlank { pending.platform },
            ),
        )
        updatePresence(pending.peerId, true, pending.name)
        refreshContacts()
        // 同上：watch 是整体替换，发完整的通讯录
        sendWatch()
        flushPending(pending.peerId)
        connectPeer(pending.peerId)
    }

    private fun routeSdp(message: Sdp) {
        if (message.to != myId || message.from == myId) return
        val share = conns[message.from]?.share
        if (share == null && contacts.get(message.from) == null) {
            if (message.description.type == "offer") bufferSignal(message)
            return
        }
        when (message.description.type) {
            "offer" -> {
                // 配对时通道由设备号大的一侧创建，收到 offer 说明我们是被叫方。
                // 公开分享例外：永远是分享者发 offer，访客只应答。
                if (share != null && share.seeder) return
                if (share == null && ownsChannel(message.from)) return
                val conn = conn(message.from)
                if (conn.phase == SessionPhase.READY) {
                    resetConn(conn, "对端重新发起", keepWaiter = true)
                }
                if (conn.rtc == null) {
                    if (share == null) setActive(message.from)
                    setPhase(conn, SessionPhase.SIGNALING)
                    armConnectTimeout(conn)
                    startRtc(conn, initiator = false)
                }
                conn.rtc?.handleRemoteDescription("offer", message.description.sdp)
            }
            "answer" -> {
                conns[message.from]?.rtc?.handleRemoteDescription("answer", message.description.sdp)
            }
        }
    }

    private fun bufferSignal(message: Sdp) {
        val entry = buffered.getOrPut(message.from) {
            BufferedSignals(System.currentTimeMillis(), mutableListOf())
        }
        entry.messages.add(message)
    }

    private fun flushPending(peerId: String) {
        val entry = buffered.remove(peerId) ?: return
        if (System.currentTimeMillis() - entry.at > BUFFER_TTL_MS) return
        for (message in entry.messages) handleSignal(message)
    }

    /* ---------------------------------------------------------- 传输回调 */

    private fun transferHandlers(peerId: String): TransferHandlers = object : TransferHandlers {
        override fun onStatus(update: TransferUpdate) {
            scope.launch {
                applyTransferUpdate(peerId, update)
                if (update.status == TransferStatus.DONE || update.status == TransferStatus.ERROR) {
                    val item = _state.value.transfers.firstOrNull { it.id == update.id }
                    val action = if (update.direction == Direction.IN) "接收" else "发送"
                    val result = if (update.status == TransferStatus.DONE) {
                        "完成"
                    } else {
                        "失败：${update.message ?: "未知原因"}"
                    }
                    log("$action「${item?.name ?: update.id}」$result")
                }
                if (update.status == TransferStatus.DONE || update.status == TransferStatus.ERROR) {
                    rememberHistory(update.id)
                }
                shareHub.onTransferStatus(update)
            }
        }

        override fun onProgress(id: String, direction: Direction, transferred: Long, size: Long) {
            scope.launch {
                val now = System.currentTimeMillis()
                updateTransfer(id) { item ->
                    val startedAt = if (item.startedAt == 0L) now else item.startedAt
                    val elapsed = (now - startedAt).coerceAtLeast(1)
                    item.copy(
                        transferred = transferred,
                        status = TransferStatus.ACTIVE,
                        startedAt = startedAt,
                        speed = if (transferred > 0 && elapsed >= 250) {
                            transferred * 1000 / elapsed
                        } else {
                            item.speed
                        },
                    )
                }
                shareHub.onProgress(direction, transferred, size)
            }
        }

        override fun onText(id: String, text: String) {
            scope.launch {
                addText(
                    TextItem(
                        id = id,
                        peerId = peerId,
                        direction = Direction.IN,
                        text = text,
                    ),
                )
            }
        }

        override fun onArtifact(id: String, artifact: dev.p2pshare.app.core.ReceivedArtifact) {
            scope.launch {
                updateTransfer(id) { it.copy(uri = artifact.uri, name = artifact.name) }
                log("已保存「${artifact.name}」")
                rememberHistory(id)
            }
        }

        override fun log(line: String) = this@P2PSession.log(line)
    }

    private fun applyTransferUpdate(peerId: String, update: TransferUpdate) {
        val existing = _state.value.transfers.firstOrNull { it.id == update.id }
        if (existing == null) {
            addTransfer(
                TransferItem(
                    id = update.id,
                    peerId = peerId,
                    direction = update.direction,
                    name = update.meta?.name ?: "文件",
                    size = update.meta?.size ?: 0,
                    mime = update.meta?.mime ?: "",
                    status = update.status,
                    message = update.message,
                ),
            )
            return
        }
        updateTransfer(update.id) {
            it.copy(
                name = update.meta?.name ?: it.name,
                size = update.meta?.size ?: it.size,
                mime = update.meta?.mime ?: it.mime,
                status = update.status,
                message = update.message,
            )
        }
    }

    /** 只记已经结束的传输；uri 到了之后再覆盖一次，侧边菜单才能点开收到的文件。 */
    private fun rememberHistory(id: String) {
        val state = _state.value
        val item = state.transfers.firstOrNull { it.id == id } ?: return
        if (item.status != TransferStatus.DONE && item.status != TransferStatus.ERROR) return
        historyStore.upsert(
            HistoryEntry(
                id = item.id,
                peerId = item.peerId,
                peerName = state.displayName(item.peerId),
                direction = item.direction,
                name = item.name,
                size = item.size,
                mime = item.mime,
                status = item.status,
                at = item.at,
                message = item.message,
                uri = item.uri,
            ),
        )
        _state.update { it.copy(history = historyStore.list()) }
    }

    private fun addTransfer(item: TransferItem) {
        _state.update { state ->
            if (state.transfers.any { it.id == item.id }) state
            else state.copy(transfers = listOf(item) + state.transfers)
        }
    }

    private fun updateTransfer(id: String, block: (TransferItem) -> TransferItem) {
        _state.update { state ->
            state.copy(transfers = state.transfers.map { if (it.id == id) block(it) else it })
        }
    }

    private fun addText(item: TextItem) {
        _state.update { state ->
            if (state.texts.any { it.id == item.id }) state
            else state.copy(texts = listOf(item) + state.texts)
        }
    }

    /* ---------------------------------------------------------- 状态小工具 */

    private fun updatePresence(id: String, online: Boolean, name: String?) {
        val wasOnline = _state.value.presence[id]
        _state.update {
            it.copy(
                presence = it.presence + (id to online),
                presenceNames = if (name != null) it.presenceNames + (id to name) else it.presenceNames,
            )
        }
        if (wasOnline != online) {
            contacts.markPresence(id, online, System.currentTimeMillis())
            pruneContacts()
            refreshContacts()
        }
        // 只有从「不在线」变成「在线」才触发自动重连，重复的 presence 推送不算
        if (online && wasOnline != true) maybeAutoReconnect(id)
    }

    /**
     * 清掉离线的网页端联系人。应用启动、presence 变化、首页可见时各跑一次。
     *
     * 网页端每个标签页都是新身份，不清会堆成一长串「Windows · Edge / 离线」。
     *
     * @param includeNeverSeenOffline 启动时用：offlineSince 为空的记录按上次见到的时间估算
     * @return 这次移除的条数
     */
    fun pruneContacts(includeNeverSeenOffline: Boolean = false): Int {
        val removed = contacts.pruneExpired(
            now = System.currentTimeMillis(),
            windowMs = WEB_CONTACT_TTL_MS,
            includeNeverSeenOffline = includeNeverSeenOffline,
        )
        if (removed > 0) {
            log("清理了 $removed 个离线的网页端联系人")
            refreshContacts()
        }
        return removed
    }

    /**
     * 对端重新上线，而用户正好停在这台的会话页：静默重连。
     *
     * 失败态和「对方离线、还没开始连」两种情况都算。只重试 [MAX_AUTO_RETRIES] 次，
     * 再失败就把文案换成「对方已上线，点重试」，免得两边网络都不稳时无限重连。
     * 用户自己点设备或点重试会清空计数。
     */
    private fun maybeAutoReconnect(peerId: String) {
        if (activePeerId != peerId) return
        val conn = conns[peerId] ?: return
        if (conn.phase != SessionPhase.FAILED && conn.phase != SessionPhase.IDLE) return
        if (contacts.get(peerId) == null) return
        if (conn.autoRetries >= MAX_AUTO_RETRIES) {
            setPhase(conn, SessionPhase.FAILED, "对方已上线，点重试")
            return
        }
        conn.autoRetries += 1
        val attempt = conn.autoRetries
        val delayMs = if (attempt == 1) AUTO_RETRY_FIRST_MS else AUTO_RETRY_NEXT_MS
        log("对方上线，${delayMs / 1000} 秒后自动重连（第 $attempt 次）")
        conn.autoRetryJob?.cancel()
        conn.autoRetryJob = scope.launch {
            delay(delayMs)
            if (activePeerId == peerId &&
                (conn.phase == SessionPhase.FAILED || conn.phase == SessionPhase.IDLE) &&
                conn.rtc == null &&
                conn.waiter == null &&
                _state.value.presence[peerId] == true
            ) {
                log("自动重连 ${shortId(peerId)}")
                connectPeer(peerId)
            }
        }
    }

    private fun refreshContacts() {
        _state.update { it.copy(contacts = contacts.list()) }
    }

    private fun setActive(peerId: String?) {
        activePeerId = peerId
        _state.update { it.copy(activePeerId = peerId) }
    }

    private fun setPhase(conn: Conn, phase: SessionPhase, message: String? = null) {
        conn.phase = phase
        _state.update { it.copy(peers = it.peers + (conn.peerId to PeerUi(phase, message))) }
    }

    private fun emitError(message: String) {
        log("错误：$message")
        _state.update { it.copy(error = UiError(System.nanoTime(), message)) }
    }

    /** 诊断日志：落盘保留最近 200 行，配对码、nonce、签名都不记。 */
    private fun log(message: String) {
        val line = "${logClock.format(Date())} $message"
        val next = (listOf(line) + _state.value.logs).take(MAX_LOGS)
        _state.update { it.copy(logs = next) }
        diagnostics.save(next)
    }

    private fun shortId(id: String): String = id.take(6)

    private fun conn(peerId: String): Conn = conns.getOrPut(peerId) { Conn(peerId) }

    private fun ownsChannel(peerId: String): Boolean = myId > peerId

    private fun newTransferId(): String {
        transferSeq += 1
        val suffix = identity.randomBytes(2).toHex()
        return "${myId.take(6)}-${transferSeq.toString(36)}-$suffix"
    }

    private class Conn(val peerId: String) {
        var rtc: RtcSession? = null
        var link: PeerLink? = null
        var engine: TransferEngine? = null
        /** 有这一项就是公开分享的对端：没有通讯录记录，公钥另有一个来源 */
        var share: SharePeer? = null
        var myChallenge: Pairing.Challenge? = null
        var iVerifiedPeer = false
        var peerVerifiedMe = false
        var authStarted = false
        var phase = SessionPhase.IDLE
        var generation = 0
        var timer: Job? = null
        var waiter: CompletableDeferred<Unit>? = null
        /** 自动重连已经用掉几次；连上或用户手动重试时清零 */
        var autoRetries = 0
        var autoRetryJob: Job? = null
    }

    private data class OutgoingPair(
        val peerId: String,
        val name: String,
        val publicKey: PublicKeyJwk,
        val platform: String = "",
    )

    private data class IncomingPair(
        val from: String,
        val name: String,
        val publicKey: PublicKeyJwk,
        val code: String,
        val platform: String = "",
    )

    private data class BufferedSignals(
        val at: Long,
        val messages: MutableList<Sdp>,
    )

    private companion object {
        const val CONNECT_TIMEOUT_MS = 20_000L
        const val BUFFER_TTL_MS = 30_000L
        const val MAX_PENDING_ICE = 64
        const val MAX_LOGS = 200
        /** 对端上线后最多自动重连几次；超过就交给用户点重试 */
        const val MAX_AUTO_RETRIES = 2
        const val AUTO_RETRY_FIRST_MS = 800L
        const val AUTO_RETRY_NEXT_MS = 2_500L
        /** 网页端联系人离线多久后自动移除。验收时可以临时改成 10_000L 看效果 */
        const val WEB_CONTACT_TTL_MS = 10 * 60_000L
        /** 定时清理的间隔上限 */
        const val WEB_CONTACT_SWEEP_MS = 30_000L
        /** 息屏时正在传的文件统一用这个原因 */
        const val CANCELLED_BY_SCREEN_OFF = "已取消（屏幕关闭）"
    }
}
