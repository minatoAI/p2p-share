package dev.p2pshare.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

data class FileMeta(val id: String, val name: String, val size: Long, val mime: String)

enum class TransferStatus { PENDING, ACTIVE, DONE, ERROR }

enum class Direction { IN, OUT }

data class TransferUpdate(
    val id: String,
    val direction: Direction,
    val status: TransferStatus,
    val peerId: String? = null,
    val meta: FileMeta? = null,
    val message: String? = null,
)

data class ReceivedArtifact(val id: String, val uri: String, val name: String)

interface SendFile {
    val name: String
    val size: Long
    val mime: String
    fun open(): InputStream
}

interface WriteSession {
    suspend fun write(bytes: ByteArray)
    suspend fun commit(): ReceivedArtifact
    suspend fun abort(reason: String)
}

interface FileSink {
    fun maxBufferedBytes(): Long?
    suspend fun begin(meta: FileMeta): WriteSession
}

interface TransferHandlers {
    fun onStatus(update: TransferUpdate)
    fun onProgress(id: String, direction: Direction, transferred: Long, size: Long)
    fun onText(id: String, text: String)
    fun onArtifact(id: String, artifact: ReceivedArtifact)
    /** 对端确认收到文字；老版本对端不会发这条 */
    fun onTextAck(id: String) {}
    fun log(line: String) {}
}

/**
 * 传输引擎。串行发送、按字节水位背压、接收重组、收尾确认。
 * 规则来自 app/src/core/transfer.ts，尤其是这几条：
 *   - 一个方向同时只传一个文件，所以分片只带序号，不带传输 ID；
 *   - 发送完成不等于成功，必须等对方回一个覆盖全文件的 ack；
 *   - 接收端落盘失败要把原因回给发送端，不能让两边各说各话。
 *
 * 引擎的所有状态都在一个单线程调度器上改，公开方法只投递任务，因此不需要锁。
 */
class TransferEngine(
    private val sink: FileSink,
    private val handlers: TransferHandlers,
    private val newTransferId: () -> String,
    private val peerId: String,
) {
    // 单线程视图：pump、收帧、等待 ack 都改同一批集合，多线程 IO 会把它们撞坏。
    private val scope = CoroutineScope(Dispatchers.IO.limitedParallelism(1) + SupervisorJob())
    private val queue = ArrayDeque<Outgoing>()
    private val acks = mutableMapOf<String, Long>()
    private val remoteErrors = mutableMapOf<String, String>()
    // remoteErrors 里的原因是「取消」而不是普通失败：传出去时不要再加前缀。
    private val canceledByPeer = mutableMapOf<String, String>()
    private val ackChanges = Channel<Unit>(Channel.CONFLATED)
    private val progressAt = mutableMapOf<String, Long>()
    private val closed = AtomicBoolean(false)
    @Volatile
    private var link: PeerLink? = null
    private var sending = false
    // pump 取到的那一条即使已经从队列挪走，也要能被取消原因找到。
    private var activeOutgoingId: String? = null
    private var incoming: Incoming? = null

    private data class Outgoing(val id: String, val file: SendFile)

    private sealed interface Frame {
        data class Text(val raw: String) : Frame
        data class Binary(val bytes: ByteArray) : Frame
    }

    /**
     * 收到的帧必须按到达顺序串行处理。
     *
     * 早先是每帧各自 launch 一个协程：Meta 正在等 sink.begin（建文件）时，
     * 后面的分片协程已经能跑，而那时 incoming 还是 null，整批分片被当成
     * “没有正在接收的传输”丢掉；对端随后发来 done，就报“收到 0 字节”。
     * 32 MB 的 APK 比图片更容易撞上，就是因为它让建文件的窗口更显眼。
     */
    private val frames = Channel<Frame>(Channel.UNLIMITED)

    private class Incoming(
        val meta: FileMeta,
        val session: WriteSession,
    ) {
        var expected = 0
        var total = 0
        var bytes = 0L
        var lastAckBytes = 0L
        val cache = mutableMapOf<Int, ByteArray>()
    }

    fun attach(link: PeerLink) {
        if (closed.get()) return
        this.link = link
        link.onText { raw -> frames.trySend(Frame.Text(raw)) }
        link.onBinary { bytes -> frames.trySend(Frame.Binary(bytes)) }
        link.onStateChange { state ->
            if (state == PeerState.CLOSED || state == PeerState.FAILED) {
                scope.launch { failAll("连接已断开") }
            }
        }
        scope.launch {
            for (frame in frames) {
                when (frame) {
                    is Frame.Text -> handleText(frame.raw)
                    is Frame.Binary -> handleBinary(frame.bytes)
                }
            }
        }
        scope.launch { pump() }
    }

    fun detach(reason: String = "连接已断开") {
        scope.launch {
            failAll(reason)
            link = null
        }
    }

    /**
     * 息屏或锁屏前把取消原因告诉对端：正在收的文件和正在发、排队的文件各发一帧。
     *
     * 帧必须赶在 detach 之前进入数据通道，所以这里和 detach 用同一个单线程 scope：
     * 先调用先执行，P2PSession 再保留 400ms 才 close。
     */
    fun notifyCancel(reason: String) {
        scope.launch {
            val current = link ?: return@launch
            if (current.state != PeerState.CONNECTED) return@launch
            val ids = buildList {
                incoming?.let { add(it.meta.id) }
                activeOutgoingId?.let { add(it) }
                queue.forEach { add(it.id) }
            }.distinct()
            if (ids.isEmpty()) return@launch
            for (id in ids) {
                current.sendText(encodeControl(Cancel(id = id, reason = reason)))
            }
            handlers.log("已通知对端取消 ${ids.size} 个传输（$reason）")
        }
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        link?.close()
        link = null
        scope.cancel()
    }

    fun enqueue(id: String, file: SendFile) {
        handlers.onStatus(
            TransferUpdate(
                id = id,
                direction = Direction.OUT,
                status = TransferStatus.PENDING,
                peerId = peerId,
                meta = FileMeta(id, sanitizeFileName(file.name), file.size, file.mime),
            ),
        )
        scope.launch {
            queue.addLast(Outgoing(id, file))
            pump()
        }
    }

    /** 同步发一帧文本。返回 false 表示链路已经不在了。 */
    fun sendText(text: String): Boolean {
        val current = link
        if (current?.state != PeerState.CONNECTED) return false
        return current.sendText(encodeControl(TextMessage(newTransferId(), text)))
    }

    private suspend fun pump() {
        if (sending) return
        val current = link
        if (current?.state != PeerState.CONNECTED) return
        sending = true
        try {
            while (queue.isNotEmpty()) {
                val job = queue.first()
                val active = link
                if (active == null || active.state != PeerState.CONNECTED) break
                activeOutgoingId = job.id
                try {
                    sendJob(job)
                    // failAll 可能已经把这批任务标成取消了，别再覆盖成 DONE / 普通失败。
                    if (queue.removeFirstOrNull() == job) {
                        handlers.onStatus(
                            TransferUpdate(
                                id = job.id,
                                direction = Direction.OUT,
                                status = TransferStatus.DONE,
                                peerId = peerId,
                            ),
                        )
                    }
                } catch (t: Throwable) {
                    if (queue.removeFirstOrNull() == job) {
                        handlers.onStatus(
                            TransferUpdate(
                                id = job.id,
                                direction = Direction.OUT,
                                status = TransferStatus.ERROR,
                                peerId = peerId,
                                message = t.message ?: "发送失败",
                            ),
                        )
                    }
                } finally {
                    activeOutgoingId = null
                }
            }
        } finally {
            sending = false
        }
    }

    private suspend fun sendJob(job: Outgoing) {
        val current = link ?: throw IOException("还没有绑定链路")
        canceledByPeer[job.id]?.let { throw IOException(it) }
        val file = job.file
        val mime = file.mime.ifBlank { "application/octet-stream" }
        val name = sanitizeFileName(file.name)
        val size = file.size
        val totalChunks = if (size == 0L) 0 else ((size + CHUNK_SIZE - 1) / CHUNK_SIZE).toInt()
        val meta = FileMeta(job.id, name, size, mime)

        handlers.onStatus(
            TransferUpdate(job.id, Direction.OUT, TransferStatus.ACTIVE, peerId, meta),
        )
        if (!send(Meta(job.id, name, size, mime))) throw IOException("发送中断：连接已关闭")

        file.open().use { input ->
            val buffer = ByteArray(CHUNK_SIZE)
            var index = 0
            var transferred = 0L
            while (index < totalChunks) {
                canceledByPeer[job.id]?.let { throw IOException(it) }
                awaitCapacity()
                if (link?.state != PeerState.CONNECTED) throw IOException("发送中断：连接已关闭")
                val read = readFully(input, buffer)
                if (read == 0) throw IOException("文件比声明的短")
                val payload = if (read == buffer.size) buffer else buffer.copyOf(read)
                if (!current.sendBinary(encodeChunk(index, totalChunks, payload))) {
                    throw IOException("发送中断：连接已关闭")
                }
                transferred += read
                index += 1
                emitProgress(job.id, Direction.OUT, transferred, size)
            }
        }

        canceledByPeer[job.id]?.let { throw IOException(it) }
        if (!send(Done(job.id, size))) throw IOException("发送中断：连接已关闭")
        waitForAck(job.id, size)
    }

    private suspend fun awaitCapacity() {
        val deadline = System.currentTimeMillis() + DRAIN_TIMEOUT_MS
        while (true) {
            val current = link ?: throw IOException("发送中断：连接已关闭")
            if (current.state != PeerState.CONNECTED) throw IOException("发送中断：连接已关闭")
            if (current.bufferedAmount() <= HIGH_WATER) return
            if (System.currentTimeMillis() > deadline) return
            delay(30)
        }
    }

    private suspend fun waitForAck(id: String, size: Long) {
        while (true) {
            if ((acks[id] ?: 0L) >= size) return
            remoteFailure(id)?.let { throw it }
            val current = link
            if (current == null || current.state != PeerState.CONNECTED) {
                throw IOException("发送中断：连接已关闭")
            }
            val changed = withTimeoutOrNull(ACK_TIMEOUT_MS) { ackChanges.receive() }
            if (changed == null) {
                val confirmed = acks[id] ?: 0L
                remoteFailure(id)?.let { throw it }
                if (confirmed >= size) return
                throw IOException("发送中断：对方没有确认收完（已确认 $confirmed / $size 字节）")
            }
        }
    }

    /** 对端报告的失败原因；取消原因原样显示，普通控制错误保留「对方报告失败」前缀。 */
    private fun remoteFailure(id: String): IOException? = remoteErrors[id]?.let { message ->
        IOException(if (canceledByPeer.containsKey(id)) message else "对方报告失败：$message")
    }

    private fun onAck(id: String, received: Long) {
        val previous = acks[id] ?: 0L
        if (received > previous) {
            acks[id] = received
            ackChanges.trySend(Unit)
        }
    }

    /* ---------------------------------------------------------- 接收 */

    private suspend fun handleText(raw: String) {
        val message = decodeControl(raw) ?: return
        when (message) {
            is Meta -> startIncoming(message)
            is Done -> finishIncoming(message.id, message.size)
            is Ack -> onAck(message.id, message.received)
            is Cancel -> handleCancel(message)
            is TextMessage -> {
                // 文字只进文字列表，别再造一条「文件已完成」的传输记录：
                // 那会让界面多出一张「已保存到下载」的卡片，用户以为存了文件。
                handlers.onText(message.id, message.text)
                // 回执用收到的 text 帧 id；老版本对端会忽略这条不认识的帧
                send(TextAck(message.id))
            }
            is TextAck -> {
                // 迟到或重复的确认由会话层忽略，这里只管转交
                handlers.onTextAck(message.id)
            }
            is ControlError -> {
                if (message.id != null) {
                    remoteErrors[message.id] = message.message
                    ackChanges.trySend(Unit)
                } else {
                    handlers.onStatus(
                        TransferUpdate("", Direction.IN, TransferStatus.ERROR, peerId, message = message.message),
                    )
                }
            }
            else -> Unit
        }
    }

    /**
     * 对端取消：id 匹配正在接收的文件就中止写入、删掉半截文件；匹配本机的
     * 发送任务就写进 remoteErrors 并唤醒 ack 等待；id 省略按整条链路处理。
     */
    private suspend fun handleCancel(message: Cancel) {
        val text = cancelMessage(message.reason)
        val id = message.id?.takeIf { it.isNotBlank() }
        if (id == null) {
            // 整条链路取消时也把正在发的那一条喊停，别让它继续把文件写完。
            activeOutgoingId?.let { active ->
                remoteErrors[active] = text
                canceledByPeer[active] = text
            }
            failAll(text)
            return
        }
        val receiving = incoming
        if (receiving != null && receiving.meta.id == id) {
            incoming = null
            runCatching { receiving.session.abort(text) }
            handlers.onStatus(
                TransferUpdate(id, Direction.IN, TransferStatus.ERROR, peerId, message = text),
            )
        }
        if (queue.any { it.id == id } || activeOutgoingId == id) {
            remoteErrors[id] = text
            canceledByPeer[id] = text
            ackChanges.trySend(Unit)
        }
    }

    private suspend fun startIncoming(message: Meta) {
        incoming?.let { previous ->
            runCatching { previous.session.abort("对端开始了新的传输") }
            handlers.onStatus(
                TransferUpdate(
                    previous.meta.id,
                    Direction.IN,
                    TransferStatus.ERROR,
                    peerId,
                    message = "被新的传输打断",
                ),
            )
        }
        incoming = null

        val limit = sink.maxBufferedBytes()
        if (limit != null && message.size > limit) {
            send(ControlError(message.id, "对方这一次收不下这么大的文件"))
            handlers.onStatus(
                TransferUpdate(
                    message.id,
                    Direction.IN,
                    TransferStatus.ERROR,
                    peerId,
                    message = "文件太大，本机收不下",
                ),
            )
            return
        }

        val mime = message.mime.ifBlank { "application/octet-stream" }
        val meta = FileMeta(message.id, ensureFileName(message.name, mime), message.size, mime)
        val session = try {
            sink.begin(meta)
        } catch (t: Throwable) {
            failIncoming(meta.id, "接收端建不了文件：${t.message ?: "未知错误"}")
            return
        }
        incoming = Incoming(meta, session)
        handlers.onStatus(
            TransferUpdate(meta.id, Direction.IN, TransferStatus.ACTIVE, peerId, meta),
        )
    }

    private suspend fun handleBinary(bytes: ByteArray) {
        val current = incoming ?: return
        try {
            val chunk = decodeChunk(bytes)
            current.total = chunk.total
            if (chunk.index < current.expected) return
            if (chunk.index > current.expected) {
                current.cache[chunk.index] = chunk.payload
                return
            }
            writeChunk(current, chunk.index, chunk.payload)
            while (true) {
                val next = current.cache.remove(current.expected) ?: break
                writeChunk(current, current.expected, next)
            }
            if (current.bytes - current.lastAckBytes >= ACK_INTERVAL_BYTES) {
                current.lastAckBytes = current.bytes
                send(Ack(current.meta.id, current.bytes))
            }
        } catch (t: Throwable) {
            failIncoming(current.meta.id, "接收失败：${t.message ?: "写入出错"}")
        }
    }

    private suspend fun writeChunk(incoming: Incoming, index: Int, payload: ByteArray) {
        incoming.session.write(payload)
        incoming.expected = index + 1
        incoming.bytes += payload.size
        emitProgress(incoming.meta.id, Direction.IN, incoming.bytes, incoming.meta.size)
    }

    private suspend fun finishIncoming(id: String, size: Long) {
        val current = incoming ?: return
        if (current.meta.id != id) return
        incoming = null
        // 以完成帧为准：它是发送端发完所有分片之后给出的实际大小。
        // 开头的 meta 只是预告，可能和最终大小不一致，不能拿它一票否决
        // ——真机上出现过两者差几个字节、白传 32 MB 的情况。
        if (current.bytes != size) {
            runCatching { current.session.abort("大小不一致") }
            failIncoming(
                id,
                "大小不一致：收到 ${current.bytes} 字节，完成时声明 $size 字节",
            )
            return
        }
        if (current.meta.size != size) {
            handlers.log(
                "⚠ 接收「${current.meta.name}」时预告大小 ${current.meta.size} 与完成大小 $size 不一致，按完成大小收下",
            )
        }
        val artifact = try {
            current.session.commit()
        } catch (t: Throwable) {
            failIncoming(id, "接收端收尾失败：${t.message ?: "未知错误"}")
            return
        }
        send(Ack(id, current.bytes))
        handlers.onStatus(
            TransferUpdate(id, Direction.IN, TransferStatus.DONE, peerId, current.meta),
        )
        handlers.onArtifact(id, artifact)
    }

    private suspend fun failIncoming(id: String, message: String) {
        send(ControlError(id, message))
        incoming?.let { current ->
            if (current.meta.id == id) {
                incoming = null
                runCatching { current.session.abort(message) }
            }
        }
        handlers.onStatus(
            TransferUpdate(id, Direction.IN, TransferStatus.ERROR, peerId, message = message),
        )
    }

    private suspend fun failAll(reason: String) {
        while (queue.isNotEmpty()) {
            val job = queue.removeFirst()
            handlers.onStatus(
                TransferUpdate(job.id, Direction.OUT, TransferStatus.ERROR, peerId, message = reason),
            )
        }
        ackChanges.trySend(Unit)
        incoming?.let { current ->
            incoming = null
            runCatching { current.session.abort(reason) }
            handlers.onStatus(
                TransferUpdate(
                    current.meta.id,
                    Direction.IN,
                    TransferStatus.ERROR,
                    peerId,
                    message = reason,
                ),
            )
        }
    }

    private fun emitProgress(id: String, direction: Direction, transferred: Long, size: Long) {
        val now = System.currentTimeMillis()
        val finished = size > 0 && transferred >= size
        if (!finished && now - (progressAt[id] ?: 0L) < PROGRESS_INTERVAL_MS) return
        progressAt[id] = now
        handlers.onProgress(id, direction, transferred, size)
    }

    private fun send(message: ControlMessage): Boolean {
        val current = link ?: return false
        if (current.state != PeerState.CONNECTED) return false
        return current.sendText(encodeControl(message))
    }

    private fun readFully(input: InputStream, buffer: ByteArray): Int {
        var total = 0
        while (total < buffer.size) {
            val read = input.read(buffer, total, buffer.size - total)
            if (read < 0) break
            if (read == 0) continue
            total += read
        }
        return total
    }

    private companion object {
        const val CHUNK_SIZE = 16 * 1024
        const val HIGH_WATER = 8 * 1024 * 1024L
        const val ACK_INTERVAL_BYTES = 256 * 1024L
        const val ACK_TIMEOUT_MS = 30_000L
        const val DRAIN_TIMEOUT_MS = 5_000L
        const val PROGRESS_INTERVAL_MS = 100L
    }
}

/** 取消原因文案，三端一致；缺失或旧版本按「已取消」处理。 */
private fun cancelMessage(reason: String?): String = when (reason) {
    "screen-off" -> "已取消（屏幕关闭）"
    "peer-offline" -> "已取消（对方离线）"
    else -> "已取消"
}

private val BAD_NAME_CHARS = Regex("[\\u0000-\\u001f<>:\"|?*]")

fun sanitizeFileName(name: String): String {
    val base = name.split('/', '\\').lastOrNull() ?: ""
    val cleaned = BAD_NAME_CHARS.replace(base, "_").trimStart('.').trim()
    return cleaned.ifEmpty { "unnamed" }
}

private val HAS_EXTENSION = Regex("\\.[a-z0-9]{1,8}$", RegexOption.IGNORE_CASE)

private val MIME_EXTENSION = mapOf(
    "image/png" to "png",
    "image/jpeg" to "jpg",
    "image/jpg" to "jpg",
    "image/gif" to "gif",
    "image/webp" to "webp",
    "image/bmp" to "bmp",
    "image/svg+xml" to "svg",
    "image/heic" to "heic",
    "image/heif" to "heif",
    "image/avif" to "avif",
    "text/plain" to "txt",
    "text/markdown" to "md",
    "text/csv" to "csv",
    "application/pdf" to "pdf",
    "application/zip" to "zip",
    "application/json" to "json",
)

fun ensureFileName(name: String, mime: String): String {
    val clean = sanitizeFileName(name)
    if (HAS_EXTENSION.containsMatchIn(clean)) return clean
    val base = mime.lowercase().substringBefore(';').trim()
    val extension = MIME_EXTENSION[base]
        ?: base.substringAfter('/', "").replace(Regex("[^a-z0-9]"), "")
    return if (extension.isBlank()) clean else "$clean.$extension"
}
