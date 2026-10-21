package dev.p2pshare.app.core

private val TOKEN_ONLY = Regex("^[0-9a-f]{32}$", RegexOption.IGNORE_CASE)
private val CODE_ONLY = Regex("^[0-9a-f]{8}$", RegexOption.IGNORE_CASE)
private val TOKEN_IN_LINK = Regex("[#&?]s=([0-9a-f]{32})", RegexOption.IGNORE_CASE)

/** 收整条链接、`#s=` 后面那一段、32 位十六进制，或者末 8 位短编号。 */
fun parseShareToken(text: String?): String? {
    val raw = text?.trim().orEmpty()
    if (raw.isEmpty()) return null
    TOKEN_IN_LINK.find(raw)?.groupValues?.getOrNull(1)?.let { return it.lowercase() }
    if (TOKEN_ONLY.matches(raw)) return raw.lowercase()
    if (CODE_ONLY.matches(raw)) return raw.lowercase()
    return null
}

/** 只发一串编号时用的短码，和后端 code 保持一致。 */
fun shareCode(token: String): String = token.takeLast(8)

fun shareLink(origin: String, token: String): String =
    "${origin.trimEnd('/')}/#s=$token"
