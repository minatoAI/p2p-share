package dev.p2pshare.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

sealed interface SignalLinkState {
    data object Connecting : SignalLinkState
    data object Open : SignalLinkState
    data class Waiting(val attempt: Int, val delayMs: Long) : SignalLinkState
    data object Closed : SignalLinkState
}

/**
 * 灯塔的长连接。
 *
 * 心跳用 WebSocket 协议层 PING（OkHttp 的 pingInterval），不发应用层心跳：
 * Cloudflare 的 Durable Object 按请求计费，应用层心跳会把免费额度吃掉。
 * 重连阶梯 1 / 2 / 5 / 10 秒，和托盘端一致。
 */
class SignalingClient(
    baseUrl: String,
    deviceId: String,
    deviceName: String,
    private val scope: CoroutineScope,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onMessage(message: SignalMessage)
        fun onState(state: SignalLinkState)
    }

    /**
     * 灯塔在升级请求里就要知道设备号：它靠这个把消息路由给对端，
     * 也靠它踢掉同一台设备的旧连接。名字只是给在线状态板用的，
     * 之后 hello 还会再更新一次。
     */
    private val url = buildString {
        append(baseUrl)
        append(if ('?' in baseUrl) '&' else '?')
        append("deviceId=").append(URLEncoder.encode(deviceId, "UTF-8"))
        append("&name=").append(URLEncoder.encode(deviceName, "UTF-8"))
    }

    private val lock = Any()
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var generation = 0
    private var attempt = 0
    private var open = false
    private var closedByUser = false

    @Volatile
    var state: SignalLinkState = SignalLinkState.Closed
        private set

    fun start() {
        synchronized(lock) {
            if (closedByUser) closedByUser = false
            if (socket != null) return
        }
        attempt = 0
        connectNow()
    }

    fun send(message: SignalMessage): Boolean {
        val ws = synchronized(lock) { if (open) socket else null } ?: return false
        return ws.send(encodeSignal(message))
    }

    fun close() {
        val ws: WebSocket?
        synchronized(lock) {
            closedByUser = true
            generation++
            reconnectJob?.cancel()
            reconnectJob = null
            ws = socket
            socket = null
            open = false
        }
        updateState(SignalLinkState.Closed)
        ws?.close(1000, "bye")
    }

    private fun connectNow() {
        val myGeneration: Int
        synchronized(lock) {
            if (closedByUser) return
            myGeneration = ++generation
            socket = null
            open = false
        }
        updateState(SignalLinkState.Connecting)
        val request = Request.Builder().url(url).build()
        client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!adopt(myGeneration, webSocket)) {
                    webSocket.close(1000, "stale")
                    return
                }
                attempt = 0
                updateState(SignalLinkState.Open)
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!isCurrent(myGeneration)) return
                decodeSignal(text)?.let(listener::onMessage)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                drop(myGeneration)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                drop(myGeneration)
            }
        })
    }

    private fun adopt(myGeneration: Int, webSocket: WebSocket): Boolean = synchronized(lock) {
        if (closedByUser || myGeneration != generation) return false
        socket = webSocket
        open = true
        true
    }

    private fun isCurrent(myGeneration: Int): Boolean = synchronized(lock) {
        !closedByUser && myGeneration == generation && open
    }

    /** 连接断了。第一次回调安排重连，同一代的后续回调全部忽略。 */
    private fun drop(myGeneration: Int) {
        var schedule = false
        var currentAttempt = 0
        var delayMs = 0L
        synchronized(lock) {
            if (myGeneration != generation) return
            socket = null
            open = false
            generation++
            if (!closedByUser) {
                attempt += 1
                currentAttempt = attempt
                delayMs = LADDER[(attempt - 1).coerceIn(0, LADDER.lastIndex)]
                schedule = true
            }
        }
        if (!schedule) {
            updateState(SignalLinkState.Closed)
            return
        }
        updateState(SignalLinkState.Waiting(currentAttempt, delayMs))
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            val shouldConnect = synchronized(lock) { !closedByUser }
            if (shouldConnect) connectNow()
        }
    }

    private fun updateState(next: SignalLinkState) {
        state = next
        listener.onState(next)
    }

    private companion object {
        val LADDER = longArrayOf(1_000, 2_000, 5_000, 10_000)
    }
}
