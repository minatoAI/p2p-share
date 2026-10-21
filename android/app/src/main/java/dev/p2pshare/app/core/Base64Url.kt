package dev.p2pshare.app.core

/**
 * base64url，无填充。字母表和 app/src/core/pairing.ts 保持一致。
 *
 * 不用 android.util.Base64：它的 URL_SAFE 会带不带填充、以及是否换行这两处
 * 平台差异，跨语言对齐时最容易在这里出错。
 */
object Base64Url {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size * 4 + 2) / 3)
        var i = 0
        while (i < bytes.size) {
            val a = bytes[i].toInt() and 0xff
            val b = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xff else 0
            val c = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xff else 0
            out.append(ALPHABET[a ushr 2])
            out.append(ALPHABET[((a and 3) shl 4) or (b ushr 4)])
            if (i + 1 >= bytes.size) break
            out.append(ALPHABET[((b and 15) shl 2) or (c ushr 6)])
            if (i + 2 >= bytes.size) break
            out.append(ALPHABET[c and 63])
            i += 3
        }
        return out.toString()
    }

    fun decode(text: String): ByteArray {
        val clean = text.filter { it.isLetterOrDigit() || it == '-' || it == '_' }
        val out = ByteArray(clean.length * 3 / 4 + 3)
        var size = 0
        var i = 0
        while (i < clean.length) {
            val c0 = indexOf(clean[i])
            val c1 = if (i + 1 < clean.length) indexOf(clean[i + 1]) else -1
            if (c0 < 0 || c1 < 0) break
            val c2 = if (i + 2 < clean.length) indexOf(clean[i + 2]) else -1
            val c3 = if (i + 3 < clean.length) indexOf(clean[i + 3]) else -1
            out[size++] = (((c0 shl 2) or (c1 ushr 4)) and 255).toByte()
            if (c2 >= 0) out[size++] = ((((c1 and 15) shl 4) or (c2 ushr 2)) and 255).toByte()
            if (c3 >= 0 && c2 >= 0) out[size++] = ((((c2 and 3) shl 6) or c3) and 255).toByte()
            i += 4
        }
        return out.copyOf(size)
    }

    private fun indexOf(ch: Char): Int {
        if (ch in 'A'..'Z') return ch - 'A'
        if (ch in 'a'..'z') return ch - 'a' + 26
        if (ch in '0'..'9') return ch - '0' + 52
        return when (ch) {
            '-' -> 62
            '_' -> 63
            else -> -1
        }
    }
}
