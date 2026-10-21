package dev.p2pshare.app.data

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import dev.p2pshare.app.core.FileMeta
import dev.p2pshare.app.core.FileSink
import dev.p2pshare.app.core.ReceivedArtifact
import dev.p2pshare.app.core.SendFile
import dev.p2pshare.app.core.WriteSession
import dev.p2pshare.app.core.sanitizeFileName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * 收到的文件放到系统「下载/在线互传」。
 *
 * Android 10 起用 MediaStore，文件出现在系统下载列表里，不需要存储权限；
 * Android 8/9 没有 Downloads 集合，退回应用专属目录，用 FileProvider 打开。
 */
class AndroidFileSink(private val context: Context) : FileSink {
    override fun maxBufferedBytes(): Long? = null

    override suspend fun begin(meta: FileMeta): WriteSession = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) beginMediaStore(meta) else beginFile(meta)
    }

    private fun beginMediaStore(meta: FileMeta): WriteSession {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, meta.name)
            put(MediaStore.MediaColumns.MIME_TYPE, meta.mime)
            put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                "${Environment.DIRECTORY_DOWNLOADS}/$DIR_NAME",
            )
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values)
            ?: throw IOException("系统没有为这次下载创建文件")
        val output = resolver.openOutputStream(uri)
            ?: throw IOException("打不开系统下载文件")
        return MediaStoreWriteSession(resolver, uri, meta, BufferedOutputStream(output, BUFFER))
    }

    private fun beginFile(meta: FileMeta): WriteSession {
        val root = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir,
            DIR_NAME,
        )
        if (!root.exists() && !root.mkdirs()) throw IOException("建不了下载目录")
        val target = uniqueFile(root, meta.name)
        val output = BufferedOutputStream(FileOutputStream(target), BUFFER)
        return FileWriteSession(context, target, meta, output)
    }

    private fun uniqueFile(root: File, name: String): File {
        var target = File(root, name)
        if (!target.exists()) return target
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        var index = 1
        while (true) {
            target = File(root, "$base ($index)$extension")
            if (!target.exists()) return target
            index += 1
        }
    }

    private class MediaStoreWriteSession(
        private val resolver: android.content.ContentResolver,
        private val uri: Uri,
        private val meta: FileMeta,
        private val output: OutputStream,
    ) : WriteSession {
        private var finished = false

        override suspend fun write(bytes: ByteArray) = withContext(Dispatchers.IO) {
            output.write(bytes)
        }

        override suspend fun commit(): ReceivedArtifact = withContext(Dispatchers.IO) {
            if (!finished) {
                finished = true
                output.flush()
                output.close()
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
                resolver.update(uri, values, null, null)
            }
            ReceivedArtifact(meta.id, uri.toString(), meta.name)
        }

        override suspend fun abort(reason: String) = withContext(Dispatchers.IO) {
            if (!finished) {
                finished = true
                runCatching { output.close() }
                runCatching { resolver.delete(uri, null, null) }
            }
        }
    }

    private class FileWriteSession(
        private val context: Context,
        private val file: File,
        private val meta: FileMeta,
        private val output: OutputStream,
    ) : WriteSession {
        private var finished = false

        override suspend fun write(bytes: ByteArray) = withContext(Dispatchers.IO) {
            output.write(bytes)
        }

        override suspend fun commit(): ReceivedArtifact = withContext(Dispatchers.IO) {
            if (!finished) {
                finished = true
                output.flush()
                output.close()
            }
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.files",
                file,
            )
            ReceivedArtifact(meta.id, uri.toString(), meta.name)
        }

        override suspend fun abort(reason: String) = withContext(Dispatchers.IO) {
            if (!finished) {
                finished = true
                runCatching { output.close() }
                runCatching { file.delete() }
            }
        }
    }

    companion object {
        const val DIR_NAME = "在线互传"
        private const val BUFFER = 256 * 1024
    }
}

/** 从 SAF 选中的 Uri 读文件。大小读不出来时 size 为 -1，调用方要拒绝发送。 */
class UriSendFile(
    private val context: Context,
    private val uri: Uri,
    private val mimeOverride: String? = null,
) : SendFile {
    override val name: String
    override val size: Long
    override val mime: String

    /** 分享记录落盘时用；下次启动靠它重新拿到同一份文件。 */
    val uriString: String get() = uri.toString()

    init {
        val resolver = context.contentResolver
        var displayName: String? = null
        var length = -1L
        runCatching {
            resolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                        displayName = cursor.getString(nameIndex)
                    }
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                        length = cursor.getLong(sizeIndex)
                    }
                }
            }
        }
        if (length < 0) {
            length = runCatching {
                resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
            }.getOrDefault(-1L)
        }
        name = sanitizeFileName(displayName ?: uri.lastPathSegment ?: "unnamed")
        size = length
        mime = mimeOverride?.takeIf { it.isNotBlank() }
            ?: runCatching { resolver.getType(uri) }.getOrNull()
            ?: "application/octet-stream"
    }

    override fun open(): InputStream {
        val stream = context.contentResolver.openInputStream(uri)
            ?: throw IOException("打不开这个文件")
        return BufferedInputStream(stream, BUFFER)
    }

    /** 系统分享进来的文件如果被复制到了应用目录，撤销分享时顺手删掉。 */
    fun deleteLocalCopy() {
        if (uri.scheme != "file") return
        val path = uri.path ?: return
        val dir = File(context.filesDir, "shared").absolutePath
        if (!path.startsWith("$dir/")) return
        runCatching { File(path).delete() }
    }

    private companion object {
        const val BUFFER = 256 * 1024
    }
}
