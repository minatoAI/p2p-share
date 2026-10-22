package dev.p2pshare.app.data

import android.content.Context
import android.os.Build
import android.provider.Settings
import dev.p2pshare.app.core.Direction
import dev.p2pshare.app.core.PLATFORM_WEB
import dev.p2pshare.app.core.PublicKeyJwk
import dev.p2pshare.app.core.TransferStatus
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.MessageDigest

@Serializable
data class ContactRecord(
    val peerId: String,
    val peerName: String,
    val publicKey: PublicKeyJwk,
    val fingerprint: String,
    val pairedAt: Long,
    val lastSeenAt: Long? = null,
    /** web / native；旧版本配对没有这一项，空串表示不知道 */
    val peerPlatform: String = "",
    /** 从在线变成离线的时刻；在线时为 null。网页端的过期清理以它为起点 */
    val offlineSince: Long? = null,
)

class ContactStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Any()
    private val records: MutableList<ContactRecord> = load()

    fun list(): List<ContactRecord> = synchronized(lock) { records.toList() }

    fun get(peerId: String): ContactRecord? = synchronized(lock) {
        records.firstOrNull { it.peerId == peerId }
    }

    fun add(record: ContactRecord) {
        synchronized(lock) {
            records.removeAll { it.peerId == record.peerId }
            records.add(record)
            persist()
        }
    }

    fun touch(peerId: String, at: Long) {
        synchronized(lock) {
            val index = records.indexOfFirst { it.peerId == peerId }
            if (index < 0) return
            records[index] = records[index].copy(lastSeenAt = at)
            persist()
        }
    }

    /**
     * 记一次在线状态。
     *
     * 上线时刷新 lastSeenAt 并清掉离线起点；下线时只补一次 offlineSince，
     * 重复的 off 推送不能把起点往后挪，否则 10 分钟永远走不完。
     */
    fun markPresence(peerId: String, online: Boolean, at: Long) {
        synchronized(lock) {
            val index = records.indexOfFirst { it.peerId == peerId }
            if (index < 0) return
            val record = records[index]
            val next = if (online) {
                record.copy(lastSeenAt = at, offlineSince = null)
            } else {
                record.copy(offlineSince = record.offlineSince ?: at)
            }
            if (next == record) return
            records[index] = next
            persist()
        }
    }

    /**
     * 移除离线的网页端联系人，返回移掉的条数。
     *
     * 只处理 peerPlatform == web；原生端和没有平台标记的旧记录都留着。
     *
     * 起点优先用 offlineSince。只有应用启动时（[includeNeverSeenOffline]）才退回
     * max(lastSeenAt, pairedAt)：那时还没收到 presence，不知道谁在线，只能按上次见到的时间估。
     * 运行期间 offlineSince 为空就代表「在线或还没报过」，不能拿 lastSeenAt 当离线起点，
     * 否则一直在线的网页端也会被定时清掉。
     */
    fun pruneExpired(now: Long, windowMs: Long, includeNeverSeenOffline: Boolean = false): Int {
        synchronized(lock) {
            val expired = records.filter { record ->
                if (record.peerPlatform != PLATFORM_WEB) return@filter false
                val anchor = record.offlineSince ?: run {
                    if (!includeNeverSeenOffline) return@filter false
                    maxOf(record.lastSeenAt ?: 0L, record.pairedAt)
                }
                now - anchor >= windowMs
            }
            if (expired.isEmpty()) return 0
            records.removeAll(expired)
            persist()
            return expired.size
        }
    }

    fun remove(peerId: String) {
        synchronized(lock) {
            records.removeAll { it.peerId == peerId }
            persist()
        }
    }

    private fun load(): MutableList<ContactRecord> {
        val raw = prefs.getString(KEY, null) ?: return mutableListOf()
        return runCatching {
            json.decodeFromString<List<ContactRecord>>(raw).toMutableList()
        }.getOrDefault(mutableListOf())
    }

    private fun persist() {
        prefs.edit().putString(KEY, json.encodeToString(records)).apply()
    }

    private companion object {
        const val PREFS = "p2p-contacts"
        const val KEY = "records"
    }
}

class SettingsStore(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var deviceName: String
        get() = prefs.getString(KEY_NAME, null)?.takeIf { it.isNotBlank() } ?: defaultName()
        set(value) {
            prefs.edit().putString(KEY_NAME, value).apply()
        }

    val lighthouseUrl: String
        get() = prefs.getString(KEY_LIGHTHOUSE, null) ?: DEFAULT_LIGHTHOUSE

    /** system / light / dark。第一次点右上角按钮之后才固定下来。 */
    var themeMode: String
        get() = prefs.getString(KEY_THEME, "system") ?: "system"
        set(value) {
            prefs.edit().putString(KEY_THEME, value).apply()
        }

    /** 注册表 HTTP 地址。灯塔是 wss://host/ws/presence，注册表在同一个 host 的 /api。 */
    val httpBaseUrl: String
        get() {
            val base = lighthouseUrl
                .replaceFirst("wss://", "https://")
                .replaceFirst("ws://", "http://")
            val cut = base.indexOf("/ws/")
            return (if (cut >= 0) base.substring(0, cut) else base).trimEnd('/')
        }

    /**
     * 两台同型号手机不该显示成同一个名字。型号给人看，末尾四位设备摘要给机器看：
     * 摘要来自 ANDROID_ID，同一台手机稳定，不同手机不会重复；用户自己改过名字则不再用默认值。
     */
    private fun defaultName(): String {
        val maker = Build.MANUFACTURER?.trim().orEmpty()
        val model = Build.MODEL?.trim().orEmpty()
        val label = when {
            model.isEmpty() -> "安卓设备"
            maker.isEmpty() || model.startsWith(maker, ignoreCase = true) -> model
            else -> "$maker $model"
        }
        return "$label · ${deviceTag()}"
    }

    private fun deviceTag(): String {
        val androidId = runCatching {
            Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID)
        }.getOrNull().orEmpty()
        val source = androidId.ifBlank {
            Build.FINGERPRINT + Build.DEVICE + Build.MODEL
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(source.toByteArray())
        return digest.take(2).joinToString("") { "%02X".format(it.toInt() and 0xFF) }
    }

    companion object {
        const val DEFAULT_LIGHTHOUSE = "wss://p2p-share-web.pages.dev/ws/presence"
        private const val PREFS = "p2p-settings"
        private const val KEY_NAME = "deviceName"
        private const val KEY_LIGHTHOUSE = "lighthouse"
        private const val KEY_THEME = "themeMode"
    }
}

/** 侧边菜单里一条传输记录。和当前会话的 TransferItem 分开，方便落盘。 */
data class HistoryEntry(
    val id: String,
    val peerId: String,
    val peerName: String,
    val direction: Direction,
    val name: String,
    val size: Long,
    val mime: String,
    val status: TransferStatus,
    val at: Long,
    val message: String? = null,
    val uri: String? = null,
)

/** 挂出去的一条分享。原生端身份是持久的，所以这些记录也落盘，重启后链接还能服务。 */
data class OutgoingShareRecord(
    val token: String,
    val name: String,
    val size: Long,
    val mime: String,
    val createdAt: Long,
    val expiresAt: Long,
    val uri: String,
)

@Serializable
private data class StoredShare(
    val token: String,
    val name: String,
    val size: Long,
    val mime: String,
    val createdAt: Long,
    val expiresAt: Long,
    val uri: String,
)

class ShareStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Any()
    private val records: MutableList<StoredShare> = load()

    fun list(): List<OutgoingShareRecord> = synchronized(lock) {
        val now = System.currentTimeMillis()
        records.removeAll { it.expiresAt < now }
        persist()
        records.sortedByDescending { it.createdAt }.map {
            OutgoingShareRecord(
                token = it.token,
                name = it.name,
                size = it.size,
                mime = it.mime,
                createdAt = it.createdAt,
                expiresAt = it.expiresAt,
                uri = it.uri,
            )
        }
    }

    fun add(record: OutgoingShareRecord) {
        synchronized(lock) {
            records.removeAll { it.token == record.token }
            records.add(
                StoredShare(
                    token = record.token,
                    name = record.name,
                    size = record.size,
                    mime = record.mime,
                    createdAt = record.createdAt,
                    expiresAt = record.expiresAt,
                    uri = record.uri,
                ),
            )
            persist()
        }
    }

    fun remove(token: String) {
        synchronized(lock) {
            records.removeAll { it.token == token }
            persist()
        }
    }

    private fun load(): MutableList<StoredShare> {
        val raw = prefs.getString(KEY, null) ?: return mutableListOf()
        return runCatching {
            json.decodeFromString<List<StoredShare>>(raw).toMutableList()
        }.getOrDefault(mutableListOf())
    }

    private fun persist() {
        prefs.edit().putString(KEY, json.encodeToString(records)).apply()
    }

    private companion object {
        const val PREFS = "p2p-shares"
        const val KEY = "records"
    }
}

@Serializable
private data class HistoryRecord(
    val id: String,
    val peerId: String,
    val peerName: String,
    val direction: String,
    val name: String,
    val size: Long,
    val mime: String,
    val status: String,
    val at: Long,
    val message: String? = null,
    val uri: String? = null,
)

class HistoryStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Any()
    private val records: MutableList<HistoryRecord> = load()

    fun list(): List<HistoryEntry> = synchronized(lock) {
        records.sortedByDescending { it.at }.map { it.toEntry() }
    }

    /** 同一个传输 id 覆盖写，完成时带 uri 的那一条会覆盖先前没有 uri 的。 */
    fun upsert(entry: HistoryEntry) {
        synchronized(lock) {
            records.removeAll { it.id == entry.id }
            records.add(
                HistoryRecord(
                    id = entry.id,
                    peerId = entry.peerId,
                    peerName = entry.peerName,
                    direction = entry.direction.name,
                    name = entry.name,
                    size = entry.size,
                    mime = entry.mime,
                    status = entry.status.name,
                    at = entry.at,
                    message = entry.message,
                    uri = entry.uri,
                ),
            )
            val trimmed = records.sortedByDescending { it.at }.take(MAX_RECORDS)
            records.clear()
            records.addAll(trimmed)
            persist()
        }
    }

    private fun load(): MutableList<HistoryRecord> {
        val raw = prefs.getString(KEY, null) ?: return mutableListOf()
        return runCatching {
            json.decodeFromString<List<HistoryRecord>>(raw).toMutableList()
        }.getOrDefault(mutableListOf())
    }

    private fun persist() {
        prefs.edit().putString(KEY, json.encodeToString(records)).apply()
    }

    private fun HistoryRecord.toEntry() = HistoryEntry(
        id = id,
        peerId = peerId,
        peerName = peerName,
        direction = runCatching { Direction.valueOf(direction) }.getOrDefault(Direction.IN),
        name = name,
        size = size,
        mime = mime,
        status = runCatching { TransferStatus.valueOf(status) }.getOrDefault(TransferStatus.ERROR),
        at = at,
        message = message,
        uri = uri,
    )

    private companion object {
        const val PREFS = "p2p-history"
        const val KEY = "records"
        const val MAX_RECORDS = 200
    }
}
