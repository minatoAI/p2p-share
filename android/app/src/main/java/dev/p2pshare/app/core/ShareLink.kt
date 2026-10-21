package dev.p2pshare.app.core

private val TOKEN_ONLY = Regex("^[0-9a-f]{32}$", RegexOption.IGNORE_CASE)
private val TOKEN_IN_LINK = Regex("[#&?]s=([0-9a-f]{32})", RegexOption.IGNORE_CASE)

/** 收整条链接、`#s=` 后面那一段，或者直接粘的 32 位十六进制。 */
fun parseShareToken(text: String?): String? {
    val raw = text?.trim().orEmpty()
    if (raw.isEmpty()) return null
    TOKEN_IN_LINK.find(raw)?.groupValues?.getOrNull(1)?.let { return it.lowercase() }
    if (TOKEN_ONLY.matches(raw)) return raw.lowercase()
    return null
}

fun shareLink(origin: String, token: String): String =
    "${origin.trimEnd('/')}/#s=$token"
