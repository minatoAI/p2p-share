package dev.p2pshare.app.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.FolderZip
import androidx.compose.material.icons.rounded.HelpOutline
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.InsertDriveFile
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Laptop
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.PictureAsPdf
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.p2pshare.app.core.PLATFORM_ANDROID
import dev.p2pshare.app.core.PLATFORM_NATIVE
import dev.p2pshare.app.core.PLATFORM_WEB
import dev.p2pshare.app.core.PLATFORM_WINDOWS
import dev.p2pshare.app.core.SignalLinkState
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

fun formatSpeed(bytesPerSecond: Long): String =
    if (bytesPerSecond <= 0) "" else "${formatBytes(bytesPerSecond)}/s"

fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    var value = bytes.toDouble() / 1024
    var unit = 0
    val units = arrayOf("KB", "MB", "GB", "TB")
    while (value >= 1024 && unit < units.lastIndex) {
        value /= 1024
        unit += 1
    }
    val text = if (value >= 10) String.format(Locale.US, "%.0f", value)
    else String.format(Locale.US, "%.1f", value)
    return "$text ${units[unit]}"
}

private val ClockFormat = DateTimeFormatter.ofPattern("HH:mm")
private val HistoryFormat = DateTimeFormatter.ofPattern("MM-dd HH:mm")

fun formatClock(at: Long): String =
    Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(ClockFormat)

fun formatHistoryTime(at: Long): String =
    Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(HistoryFormat)

fun formatFingerprint(fingerprint: String): String =
    fingerprint.chunked(4).joinToString(" ")

@Composable
fun BrandMark(size: Dp = 34.dp) {
    val scheme = MaterialTheme.colorScheme
    Box(
        modifier = Modifier
            .size(size)
            .background(scheme.primary, RoundedCornerShape(size * 0.32f)),
        contentAlignment = Alignment.Center,
    ) {
        // 和网页端、Windows 托盘端同一组双向箭头，也和桌面图标一致。
        Canvas(Modifier.size(size * 0.62f)) {
            val u = this.size.minDimension / 64f
            val ink = scheme.onPrimary
            drawLine(
                color = ink,
                start = Offset(13f * u, 22.25f * u),
                end = Offset(37f * u, 22.25f * u),
                strokeWidth = 6.5f * u,
                cap = StrokeCap.Round,
            )
            drawPath(
                Path().apply {
                    moveTo(39f * u, 12.8f * u)
                    lineTo(52f * u, 22.25f * u)
                    lineTo(39f * u, 31.7f * u)
                    close()
                },
                color = ink,
            )
            drawLine(
                color = ink,
                start = Offset(51f * u, 41.65f * u),
                end = Offset(27f * u, 41.65f * u),
                strokeWidth = 6.5f * u,
                cap = StrokeCap.Round,
            )
            drawPath(
                Path().apply {
                    moveTo(25f * u, 32.2f * u)
                    lineTo(12f * u, 41.65f * u)
                    lineTo(25f * u, 51.1f * u)
                    close()
                },
                color = ink,
            )
        }
    }
}

@Composable
fun Eyebrow(text: String, color: Color = MaterialTheme.colorScheme.primary) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.4.sp,
        color = color,
    )
}

@Composable
fun SectionHeader(title: String, trailing: String? = null) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.weight(1f))
        if (trailing != null) {
            Text(
                text = trailing,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun Avatar(name: String, size: Dp = 44.dp, dim: Boolean = false) {
    val scheme = MaterialTheme.colorScheme
    val palettes = listOf(
        scheme.primaryContainer to scheme.onPrimaryContainer,
        scheme.secondaryContainer to scheme.onSecondaryContainer,
        scheme.tertiaryContainer to scheme.onTertiaryContainer,
        scheme.surfaceVariant to scheme.onSurfaceVariant,
    )
    val index = (name.hashCode() and Int.MAX_VALUE) % palettes.size
    val (container, content) = palettes[index]
    val initial = name.trim().firstOrNull()?.toString() ?: "?"
    Box(
        modifier = Modifier
            .size(size)
            .alpha(if (dim) 0.55f else 1f)
            .background(container, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = initial,
            color = content,
            fontSize = (size.value * 0.38f).sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
fun PulseDot(color: Color, pulsing: Boolean, size: Dp = 8.dp) {
    if (!pulsing) {
        Box(Modifier.size(size).background(color, CircleShape))
        return
    }
    val transition = rememberInfiniteTransition(label = "pulse")
    val scale by transition.animateFloat(
        initialValue = 0.7f,
        targetValue = 1.25f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "pulse-scale",
    )
    val opacity by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.45f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "pulse-alpha",
    )
    Box(contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(size * 2f)
                .alpha(opacity * 0.35f)
                .background(color, CircleShape),
        )
        Box(Modifier.size(size * scale).background(color, CircleShape))
    }
}

@Composable
fun SignalPill(state: SignalLinkState) {
    val scheme = MaterialTheme.colorScheme
    val (label, color, pulsing) = when (state) {
        // X-2：本机连上服务、没有对端时用「在线」，不再说「您已上线」。
        is SignalLinkState.Open -> Triple("在线", scheme.primary, false)
        is SignalLinkState.Connecting -> Triple("连接中", scheme.secondary, true)
        is SignalLinkState.Waiting -> Triple("正在重新连接 · 第 ${state.attempt} 次", scheme.secondary, true)
        is SignalLinkState.Closed -> Triple("本机离线", scheme.error, false)
    }
    Row(
        modifier = Modifier
            .background(scheme.surfaceVariant.copy(alpha = 0.55f), RoundedCornerShape(50))
            .border(1.dp, scheme.outlineVariant, RoundedCornerShape(50))
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        PulseDot(color = color, pulsing = pulsing)
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = scheme.onSurfaceVariant,
        )
    }
}

fun fileIcon(mime: String, name: String): ImageVector {
    val base = mime.lowercase().substringBefore(';').trim()
    val extension = name.substringAfterLast('.', "").lowercase()
    return when {
        base.startsWith("image/") -> Icons.Rounded.Image
        base.startsWith("video/") -> Icons.Rounded.Movie
        base.startsWith("audio/") -> Icons.Rounded.MusicNote
        base == "application/pdf" || extension == "pdf" -> Icons.Rounded.PictureAsPdf
        base.contains("zip") || extension in setOf("zip", "rar", "7z", "gz", "tar") ->
            Icons.Rounded.FolderZip
        base.startsWith("text/") || extension in setOf("txt", "md", "csv", "json", "log") ->
            Icons.Rounded.Description
        else -> Icons.Rounded.InsertDriveFile
    }
}

@Composable
fun FileGlyph(mime: String, name: String, incoming: Boolean, size: Dp = 42.dp) {
    val scheme = MaterialTheme.colorScheme
    Box(
        modifier = Modifier
            .size(size)
            .background(
                if (incoming) scheme.surfaceVariant else scheme.primary.copy(alpha = 0.14f),
                RoundedCornerShape(size * 0.32f),
            ),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.material3.Icon(
            imageVector = fileIcon(mime, name),
            contentDescription = null,
            tint = if (incoming) scheme.onSurfaceVariant else scheme.primary,
            modifier = Modifier.size(size * 0.48f),
        )
    }
}

@Composable
fun SmallChip(text: String, icon: ImageVector? = null, tint: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Row(
        modifier = Modifier
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(13.dp),
            )
        }
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * 配对记录来自哪种端。
 *
 * 网页端的身份只活在当前页面里，刷新就换一台设备，所以这条记录只能算一次性的；
 * 原生端把私钥放在系统密钥库里，配对可以一直用下去。
 *
 * 新版本会明确发 android / windows：安卓用手机图标、Windows 用笔记本图标。
 * 旧版 Windows 端只发 "native"，同样按电脑端显示，不能让它看起来像手机。
 */
@Composable
fun PlatformBadge(platform: String?, compact: Boolean = false) {
    val scheme = MaterialTheme.colorScheme
    val (label, icon, color) = when (platform) {
        PLATFORM_WEB -> Triple(
            if (compact) "网页端" else "网页端 · 一次性",
            Icons.Rounded.Language,
            scheme.secondary,
        )
        PLATFORM_ANDROID -> Triple(
            if (compact) "安卓端" else "安卓端 · 持续",
            Icons.Rounded.Smartphone,
            scheme.primary,
        )
        // 老版本 Windows 只发 native，按电脑处理
        PLATFORM_WINDOWS, PLATFORM_NATIVE -> Triple(
            if (compact) "Windows" else "Windows 端 · 电脑",
            Icons.Rounded.Laptop,
            scheme.primary,
        )
        else -> Triple(
            "端未标注",
            Icons.Rounded.HelpOutline,
            scheme.onSurfaceVariant,
        )
    }
    Row(
        modifier = Modifier
            .background(color.copy(alpha = 0.11f), RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        androidx.compose.material3.Icon(
            imageVector = icon,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(12.dp),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = color,
            maxLines = 1,
        )
    }
}

fun platformExplanation(platform: String?): String = when (platform) {
    PLATFORM_WEB -> "对方是网页端。网页身份只在这一页有效，刷新后这条配对就会失效，可以优先删除。"
    PLATFORM_ANDROID -> "对方是安卓端。身份保存在系统里，这条配对会长期保留，不用每次重配。"
    PLATFORM_WINDOWS, PLATFORM_NATIVE ->
        "对方是 Windows 电脑。身份保存在系统里，这条配对会长期保留，不用每次重配。"
    else -> "这条记录来自旧版本，无法确定对方是什么端。可以删掉后重新配对一次。"
}

@Composable
fun rememberAppVersion(): String {
    val context = LocalContext.current
    return remember(context) {
        runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull().orEmpty().ifBlank { "未知" }
    }
}

/** 等宽数字，避免倒计时和配对码跳动。 */
val MonoDigits = FontFamily.Monospace
