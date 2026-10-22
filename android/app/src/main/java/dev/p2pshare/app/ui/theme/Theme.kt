package dev.p2pshare.app.ui.theme

import android.app.Activity
import android.content.Context
import android.graphics.drawable.ColorDrawable
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import dev.p2pshare.app.data.SettingsStore

private val LightColors = lightColorScheme(
    primary = Jade,
    onPrimary = Paper,
    primaryContainer = Color(0xFFD5E9E1),
    onPrimaryContainer = JadeDeep,
    secondary = Clay,
    onSecondary = Paper,
    secondaryContainer = Color(0xFFF5E2D6),
    onSecondaryContainer = Color(0xFF5A2C18),
    tertiary = Slate,
    onTertiary = Paper,
    background = Paper,
    onBackground = Ink,
    surface = Paper,
    onSurface = Ink,
    surfaceVariant = Mist,
    onSurfaceVariant = Color(0xFF5E5A52),
    outline = Line,
    outlineVariant = Color(0xFFEAE6DE),
)

private val DarkColors = darkColorScheme(
    primary = NightJade,
    onPrimary = Color(0xFF00382C),
    primaryContainer = Color(0xFF174E3F),
    onPrimaryContainer = Color(0xFFA8EBD6),
    secondary = NightClay,
    onSecondary = Color(0xFF4A2414),
    secondaryContainer = Color(0xFF5C3422),
    onSecondaryContainer = Color(0xFFFFDBCB),
    tertiary = Color(0xFFA9C4DC),
    onTertiary = Color(0xFF173244),
    background = NightPaper,
    onBackground = NightInk,
    surface = NightPaper,
    onSurface = NightInk,
    surfaceVariant = NightMist,
    onSurfaceVariant = Color(0xFFB9B5AC),
    outline = NightLine,
    outlineVariant = Color(0xFF262B28),
)

val AppShapes = Shapes(
    extraSmall = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    small = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
    medium = androidx.compose.foundation.shape.RoundedCornerShape(18.dp),
    large = androidx.compose.foundation.shape.RoundedCornerShape(26.dp),
    extraLarge = androidx.compose.foundation.shape.RoundedCornerShape(34.dp),
)

/**
 * 深浅色只由右上角那个按钮切换。第一次装的时候跟随系统，点过一次就固定下来，
 * 存进 SettingsStore，重启后还是用户选的那个。
 */
object ThemeController {
    private var mode by mutableStateOf("system")

    fun load(context: Context) {
        mode = SettingsStore(context.applicationContext).themeMode
    }

    fun isDark(systemDark: Boolean): Boolean = when (mode) {
        "dark" -> true
        "light" -> false
        else -> systemDark
    }

    fun toggle(context: Context, currentDark: Boolean) {
        val next = if (currentDark) "light" else "dark"
        mode = next
        SettingsStore(context.applicationContext).themeMode = next
    }
}

@Composable
fun P2PShareTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            // enableEdgeToEdge 把两条系统栏设成透明，露出来的是 windowBackground。
            // 只改图标明暗不够：窗口底色还是纯白/纯黑，和下面的 Paper/NightPaper 不是同一个色。
            window.statusBarColor = colors.background.toArgb()
            window.navigationBarColor = colors.background.toArgb()
            window.setBackgroundDrawable(ColorDrawable(colors.background.toArgb()))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+ 默认会给透明系统栏加一层对比度 scrim，正好把颜色又拉回白/黑。
                window.isStatusBarContrastEnforced = false
                window.isNavigationBarContrastEnforced = false
            }
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }
    MaterialTheme(
        colorScheme = colors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}
