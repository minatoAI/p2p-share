package dev.p2pshare.app.data

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 诊断日志的落盘。
 *
 * 只存最近 200 行，重启应用后还能看到上一次会话的连接和传输事件。
 * 配对码、nonce、签名本来就不写进日志，落盘的也是同样的内容。
 */
class DiagnosticsStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(): List<String> =
        prefs.getString(KEY, null)
            ?.split('\n')
            ?.filter { it.isNotBlank() }
            ?.take(MAX_LINES)
            .orEmpty()

    fun save(lines: List<String>) {
        prefs.edit().putString(KEY, lines.take(MAX_LINES).joinToString("\n")).apply()
    }

    private companion object {
        const val PREFS = "p2p-diagnostics"
        const val KEY = "lines"
        const val MAX_LINES = 200
    }
}

/**
 * 把日志写到「下载/在线互传/diagnostics-时间.txt」，返回给人看的位置。
 *
 * Android 10 起走 MediaStore，不需要存储权限；更老的系统没有写公共下载目录的权限，
 * 退到应用自己的外部目录，并把真实路径告诉用户。
 */
fun exportDiagnostics(context: Context, lines: List<String>): Result<String> = runCatching {
    require(lines.isNotEmpty()) { "日志是空的" }
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
    val name = "diagnostics-$stamp.txt"
    val body = lines.joinToString("\n")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/在线互传")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("系统没有给出下载目录")
        resolver.openOutputStream(uri)?.use { it.write(body.toByteArray()) }
            ?: error("写不进这个文件")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        "Download/在线互传/$name"
    } else {
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "在线互传")
            .apply { mkdirs() }
        val file = File(dir, name)
        file.writeText(body)
        file.absolutePath
    }
}
