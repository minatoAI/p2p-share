package dev.p2pshare.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.p2pshare.app.core.parseShareToken
import dev.p2pshare.app.ui.P2PShareApp
import dev.p2pshare.app.ui.theme.P2PShareTheme
import dev.p2pshare.app.ui.theme.ThemeController

class MainActivity : ComponentActivity() {
    /** 从外部点进来或分享进来的分享编号。消费掉就置空，免得重组时重复发起。 */
    private var incomingLink by mutableStateOf<String?>(null)
    /** 从相册、文件管理器分享进来的文件 */
    private var incomingFiles by mutableStateOf<List<Uri>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        ThemeController.load(this)
        // 转屏会带着原 intent 重建，savedInstanceState 非空时不能再当成一次新点击
        if (savedInstanceState == null) {
            handleIntent(intent)
        }
        setContent {
            P2PShareTheme(darkTheme = ThemeController.isDark(isSystemInDarkTheme())) {
                P2PShareApp(
                    incomingLink = incomingLink,
                    incomingFiles = incomingFiles,
                    onIncomingLinkHandled = { incomingLink = null },
                    onIncomingFilesHandled = { incomingFiles = emptyList() },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val files = sharedUris(intent)
        if (files.isNotEmpty()) {
            incomingLink = null
            incomingFiles = files
            return
        }
        incomingLink = shareTokenFrom(intent)
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(intent: Intent?): List<Uri> {
        if (intent?.action != Intent.ACTION_SEND && intent?.action != Intent.ACTION_SEND_MULTIPLE) {
            return emptyList()
        }
        val out = mutableListOf<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let(out::addAll)
        } else {
            intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(out::add)
        }
        if (out.isEmpty()) {
            intent.clipData?.let { clip ->
                for (index in 0 until clip.itemCount) {
                    clip.getItemAt(index).uri?.let(out::add)
                }
            }
        }
        return out.filter { it.scheme == "content" || it.scheme == "file" }
    }

    private fun shareTokenFrom(intent: Intent?): String? {
        val raw = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.dataString
            Intent.ACTION_SEND -> intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            else -> null
        } ?: return null
        return parseShareToken(raw)
    }
}
