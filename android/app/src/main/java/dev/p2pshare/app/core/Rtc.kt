package dev.p2pshare.app.core

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

enum class PeerState { CONNECTING, CONNECTED, FAILED, CLOSED }

/** 数据通道的薄封装。所有发送和读取都走这里，传输引擎不认识 org.webrtc。 */
interface PeerLink {
    val state: PeerState
    fun sendText(text: String): Boolean
    fun sendBinary(bytes: ByteArray): Boolean
    fun bufferedAmount(): Long
    fun close()
    fun onText(handler: (String) -> Unit)
    fun onBinary(handler: (ByteArray) -> Unit)
    fun onStateChange(handler: (PeerState) -> Unit)
    fun onBufferedAmountChange(handler: () -> Unit)
}

class DataChannelLink(private val channel: DataChannel) : PeerLink {
    private val textHandlers = CopyOnWriteArrayList<(String) -> Unit>()
    private val binaryHandlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    private val stateHandlers = CopyOnWriteArrayList<(PeerState) -> Unit>()
    private val drainHandlers = CopyOnWriteArrayList<() -> Unit>()

    @Volatile
    private var forcedFailure = false

    private val observer = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {
            for (handler in drainHandlers) handler()
        }

        override fun onStateChange() {
            val current = state
            for (handler in stateHandlers) handler(current)
        }

        override fun onMessage(buffer: DataChannel.Buffer) {
            val data = buffer.data
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            if (buffer.binary) {
                for (handler in binaryHandlers) handler(bytes)
            } else {
                val text = String(bytes, StandardCharsets.UTF_8)
                for (handler in textHandlers) handler(text)
            }
        }
    }

    init {
        channel.registerObserver(observer)
    }

    override val state: PeerState
        get() = when {
            forcedFailure -> PeerState.FAILED
            channel.state() == DataChannel.State.OPEN -> PeerState.CONNECTED
            channel.state() == DataChannel.State.CLOSING || channel.state() == DataChannel.State.CLOSED -> PeerState.CLOSED
            else -> PeerState.CONNECTING
        }

    override fun sendText(text: String): Boolean = send(text.toByteArray(StandardCharsets.UTF_8), binary = false)

    override fun sendBinary(bytes: ByteArray): Boolean = send(bytes, binary = true)

    private fun send(bytes: ByteArray, binary: Boolean): Boolean {
        if (channel.state() != DataChannel.State.OPEN) return false
        return channel.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), binary))
    }

    override fun bufferedAmount(): Long = channel.bufferedAmount()

    override fun close() {
        channel.close()
    }

    fun markFailed() {
        forcedFailure = true
        for (handler in stateHandlers) handler(PeerState.FAILED)
    }

    fun detach() {
        runCatching { channel.unregisterObserver() }
    }

    override fun onText(handler: (String) -> Unit) {
        textHandlers.add(handler)
    }

    override fun onBinary(handler: (ByteArray) -> Unit) {
        binaryHandlers.add(handler)
    }

    override fun onStateChange(handler: (PeerState) -> Unit) {
        stateHandlers.add(handler)
    }

    override fun onBufferedAmountChange(handler: () -> Unit) {
        drainHandlers.add(handler)
    }
}

/**
 * 一条点对点连接。
 *
 * 只有设备号大的一侧创建 DataChannel 和 offer；另一侧等对端的 offer。
 * 这个规则必须和网页端、托盘端保持一致，否则两端会各自发 offer 撞在一起。
 */
class RtcSession(
    factory: PeerConnectionFactory,
    private val initiator: Boolean,
    private val onLocalDescription: (type: String, sdp: String) -> Unit,
    private val onLocalCandidate: (IceCandidateInit) -> Unit,
    private val onLink: (PeerLink) -> Unit,
    private val onFailure: (String) -> Unit,
) {
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val pc: PeerConnection
    private val deferredCandidates = mutableListOf<IceCandidate>()
    private val pendingRemoteCandidates = mutableListOf<IceCandidate>()
    private val failed = AtomicBoolean(false)

    @Volatile
    private var link: DataChannelLink? = null

    @Volatile
    private var closed = false

    @Volatile
    private var hasRemoteDescription = false

    private var widenJob: Job? = null

    private val sdpObserver = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = Unit
        override fun onSetFailure(error: String) = Unit
    }

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) flushDeferredCandidates()
        }

        override fun onIceCandidate(candidate: IceCandidate?) {
            if (candidate == null || closed) return
            val isHost = candidate.sdp.contains(" typ host ")
            if (isHost || pc.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) {
                emitCandidate(candidate)
                return
            }
            synchronized(deferredCandidates) { deferredCandidates.add(candidate) }
            if (widenJob == null) {
                widenJob = scope.launch {
                    delay(LAN_FIRST_MS)
                    flushDeferredCandidates()
                }
            }
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit

        override fun onAddStream(stream: MediaStream) = Unit

        override fun onRemoveStream(stream: MediaStream) = Unit

        override fun onDataChannel(channel: DataChannel) {
            attachChannel(channel)
        }

        override fun onRenegotiationNeeded() = Unit

        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            when (newState) {
                PeerConnection.PeerConnectionState.FAILED -> fail("点对点连接失败")
                PeerConnection.PeerConnectionState.CLOSED -> if (!closed) fail("点对点连接已关闭")
                else -> Unit
            }
        }
    }

    init {
        val config = PeerConnection.RTCConfiguration(
            listOf(PeerConnection.IceServer.builder(STUN_URL).createIceServer()),
        ).apply {
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        pc = factory.createPeerConnection(config, observer)
            ?: throw IllegalStateException("PeerConnection 创建失败")
        if (initiator) {
            val channel = pc.createDataChannel("data", DataChannel.Init().apply { ordered = true })
            attachChannel(channel)
            createOffer()
        }
    }

    fun handleRemoteDescription(type: String, sdp: String) {
        if (closed) return
        val descriptionType = if (type == "answer") SessionDescription.Type.ANSWER else SessionDescription.Type.OFFER
        if (descriptionType == SessionDescription.Type.OFFER && initiator) return
        pc.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onSetSuccess() {
                hasRemoteDescription = true
                drainPendingCandidates()
                if (descriptionType == SessionDescription.Type.OFFER) createAnswer()
            }

            override fun onCreateFailure(error: String) = Unit
            override fun onSetFailure(error: String) {
                fail("应用对方 SDP 失败：$error")
            }
        }, SessionDescription(descriptionType, sdp))
    }

    fun addRemoteCandidate(candidate: IceCandidateInit) {
        if (closed) return
        val value = IceCandidate(candidate.sdpMid ?: "", candidate.sdpMLineIndex ?: 0, candidate.candidate)
        synchronized(pendingRemoteCandidates) {
            if (!hasRemoteDescription) {
                pendingRemoteCandidates.add(value)
                return
            }
        }
        pc.addIceCandidate(value)
    }

    fun close() {
        if (closed) return
        closed = true
        widenJob?.cancel()
        link?.detach()
        link?.close()
        link = null
        runCatching { pc.close() }
        runCatching { pc.dispose() }
        scope.cancel()
    }

    private fun createOffer() {
        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                pc.setLocalDescription(object : SdpObserver {
                    override fun onCreateSuccess(value: SessionDescription) = Unit
                    override fun onSetSuccess() {
                        if (!closed) onLocalDescription("offer", description.description)
                    }

                    override fun onCreateFailure(error: String) = Unit
                    override fun onSetFailure(error: String) {
                        fail("生成本地 SDP 失败：$error")
                    }
                }, description)
            }

            override fun onSetSuccess() = Unit
            override fun onCreateFailure(error: String) {
                fail("创建 offer 失败：$error")
            }

            override fun onSetFailure(error: String) = Unit
        }, MediaConstraints())
    }

    private fun createAnswer() {
        pc.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                pc.setLocalDescription(object : SdpObserver {
                    override fun onCreateSuccess(value: SessionDescription) = Unit
                    override fun onSetSuccess() {
                        if (!closed) onLocalDescription("answer", description.description)
                    }

                    override fun onCreateFailure(error: String) = Unit
                    override fun onSetFailure(error: String) {
                        fail("生成本地 SDP 失败：$error")
                    }
                }, description)
            }

            override fun onSetSuccess() = Unit
            override fun onCreateFailure(error: String) {
                fail("创建 answer 失败：$error")
            }

            override fun onSetFailure(error: String) = Unit
        }, MediaConstraints())
    }

    private fun attachChannel(channel: DataChannel) {
        if (closed || link != null) return
        val value = DataChannelLink(channel)
        link = value
        onLink(value)
    }

    private fun emitCandidate(candidate: IceCandidate) {
        onLocalCandidate(
            IceCandidateInit(
                candidate = candidate.sdp,
                sdpMid = candidate.sdpMid,
                sdpMLineIndex = candidate.sdpMLineIndex,
            ),
        )
    }

    private fun flushDeferredCandidates() {
        val pending = synchronized(deferredCandidates) {
            if (deferredCandidates.isEmpty()) return
            deferredCandidates.toList().also { deferredCandidates.clear() }
        }
        pending.forEach(::emitCandidate)
    }

    private fun drainPendingCandidates() {
        val pending = synchronized(pendingRemoteCandidates) {
            if (pendingRemoteCandidates.isEmpty()) return
            pendingRemoteCandidates.toList().also { pendingRemoteCandidates.clear() }
        }
        pending.forEach { pc.addIceCandidate(it) }
    }

    private fun fail(reason: String) {
        if (closed || !failed.compareAndSet(false, true)) return
        link?.markFailed()
        onFailure(reason)
    }

    private companion object {
        const val STUN_URL = "stun:stun.cloudflare.com:3478"
        const val LAN_FIRST_MS = 3_000L
    }
}

/** PeerConnectionFactory 全进程一个；初始化要尽早做，别等用户点发送。 */
object Rtc {
    @Volatile
    private var factory: PeerConnectionFactory? = null

    fun initialize(context: Context) {
        if (factory != null) return
        synchronized(this) {
            if (factory != null) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        }
    }

    fun factory(): PeerConnectionFactory =
        factory ?: throw IllegalStateException("Rtc.initialize 还没有调用")
}
