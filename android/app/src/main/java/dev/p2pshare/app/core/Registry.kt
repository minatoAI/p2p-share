package dev.p2pshare.app.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

@Serializable
data class ShareCreateRequest(
    val deviceId: String,
    val deviceName: String,
    val publicKey: PublicKeyJwk,
    val name: String,
    val size: Long,
    val mime: String,
    val ttlMs: Long? = null,
)

@Serializable
data class ShareCreateResponse(val token: String, val expiresAt: Long)

@Serializable
data class ShareStatusResponse(
    val token: String,
    val status: String,
    val name: String,
    val size: Long,
    val mime: String,
    val deviceName: String,
    val deviceId: String,
    val publicKey: PublicKeyJwk? = null,
    val expiresAt: Long,
)

@Serializable
private data class ErrorBody(val error: String? = null, val limit: Int? = null)

/**
 * 分享注册表的 HTTP 客户端。
 *
 * 只传元信息，不上传文件。地址从灯塔地址推导：wss://host/ws/presence -> https://host/api。
 * 404 是"这条分享不存在"，属于答案，不抛异常。
 */
class RegistryClient(baseUrl: String) {
    private val base = baseUrl.trimEnd('/')
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    suspend fun create(input: ShareCreateRequest): ShareCreateResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(ShareCreateRequest.serializer(), input)
            .toRequestBody(JSON)
        val request = Request.Builder()
            .url("$base/api/share")
            .post(body)
            .build()
        execute(request) { text ->
            json.decodeFromString(ShareCreateResponse.serializer(), text)
        }
    }

    suspend fun status(token: String): ShareStatusResponse? = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$base/api/share/${java.net.URLEncoder.encode(token, "UTF-8")}")
            .get()
            .build()
        try {
            client.newCall(request).execute().use { response ->
                if (response.code == 404) return@withContext null
                if (!response.isSuccessful) throw IOException(errorText(response.code, response.body?.string()))
                val text = response.body?.string() ?: throw IOException("注册表返回了空内容")
                json.decodeFromString(ShareStatusResponse.serializer(), text)
            }
        } catch (t: Throwable) {
            if (t is IOException) throw t
            throw IOException(t.message ?: "读取分享失败", t)
        }
    }

    suspend fun revoke(token: String, deviceId: String) = withContext(Dispatchers.IO) {
        val body = json.encodeToString(RevokeBody.serializer(), RevokeBody(deviceId))
            .toRequestBody(JSON)
        val request = Request.Builder()
            .url("$base/api/share/${java.net.URLEncoder.encode(token, "UTF-8")}")
            .delete(body)
            .build()
        execute(request) { }
    }

    private fun <T> execute(request: Request, parse: (String) -> T): T {
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) throw IOException(errorText(response.code, text))
                return parse(text)
            }
        } catch (t: Throwable) {
            if (t is IOException) throw t
            throw IOException(t.message ?: "请求注册表失败", t)
        }
    }

    private fun errorText(code: Int, body: String?): String {
        val detail = runCatching {
            json.decodeFromString(ErrorBody.serializer(), body.orEmpty())
        }.getOrNull()
        val reason = detail?.error ?: "HTTP $code"
        val limit = detail?.limit?.let { "（上限 $it 条）" }.orEmpty()
        return reason + limit
    }

    @Serializable
    private data class RevokeBody(val deviceId: String)

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
