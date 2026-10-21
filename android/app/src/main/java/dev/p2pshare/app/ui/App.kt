package dev.p2pshare.app.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas as AndroidCanvas
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.p2pshare.app.core.parseShareToken
import dev.p2pshare.app.ui.theme.ThemeController
import kotlinx.coroutines.launch
import kotlin.math.hypot
import kotlin.math.max

@Composable
fun P2PShareApp(
    viewModel: AppViewModel = viewModel(),
    incomingLink: String? = null,
    incomingFiles: List<Uri> = emptyList(),
    onIncomingLinkHandled: () -> Unit = {},
    onIncomingFilesHandled: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }
    var showJoin by rememberSaveable { mutableStateOf(false) }
    var joinInput by rememberSaveable { mutableStateOf("") }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    var showLogs by rememberSaveable { mutableStateOf(false) }
    var showMenu by rememberSaveable { mutableStateOf(false) }
    var showShare by rememberSaveable { mutableStateOf(false) }
    var shareTab by rememberSaveable { mutableStateOf("share") }
    var shareInput by rememberSaveable { mutableStateOf("") }
    val systemDark = isSystemInDarkTheme()
    val darkTheme = ThemeController.isDark(systemDark)

    // 应用是否在前台。后台收到文字不抢页面，连接失败也不弹；回到前台再静默恢复。
    val lifecycleOwner = LocalLifecycleOwner.current
    var foreground by remember {
        mutableStateOf(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        foreground = true
        viewModel.setForeground(true)
    }
    LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) {
        foreground = false
        viewModel.setForeground(false)
    }

    // Windows 端点「粘贴给对方」发来文字：前台且没有弹窗流程时，直接带到对应会话页。
    // 已经停在这台设备的会话页、或者在配对/取件/设置/分享/菜单里，都不打断。
    LaunchedEffect(state.incomingText?.id) {
        val notice = state.incomingText ?: return@LaunchedEffect
        if (!foreground) return@LaunchedEffect
        val modal = showJoin ||
            showSettings ||
            showLogs ||
            showMenu ||
            showShare ||
            state.advertising ||
            state.pairing != null ||
            state.visit != null
        if (modal) return@LaunchedEffect
        if (state.activePeerId == notice.peerId) return@LaunchedEffect
        // 只跳已配对设备；公开分享的访客没有会话页
        if (state.contacts.none { it.peerId == notice.peerId }) return@LaunchedEffect
        viewModel.connect(notice.peerId)
    }

    // 主题切换：拍下当前这一帧，再从按钮位置把它裁开/收回，制造圆形转场
    val view = LocalView.current
    val revealScope = rememberCoroutineScope()
    val initialDarkTheme = remember { ThemeController.isDark(systemDark) }
    var revealSnapshot by remember { mutableStateOf<ImageBitmap?>(null) }
    var revealCenter by remember { mutableStateOf(Offset.Zero) }
    var revealRetract by remember { mutableStateOf(false) }
    var revealProgress by remember { mutableFloatStateOf(0f) }
    var revealBusy by remember { mutableStateOf(false) }

    val toggleTheme: (Offset) -> Unit = { center ->
        if (!revealBusy) {
            val motion = Settings.Global.getFloat(
                context.contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f,
            )
            val nextDark = !darkTheme
            val retract = nextDark == initialDarkTheme
            val snapshot = if (motion > 0f && view.width > 0 && view.height > 0) {
                runCatching {
                    Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                        .also { view.draw(AndroidCanvas(it)) }
                        .asImageBitmap()
                }.getOrNull()
            } else {
                null
            }
            if (snapshot == null) {
                ThemeController.toggle(context, darkTheme)
            } else {
                revealSnapshot = snapshot
                revealCenter = center
                revealRetract = retract
                revealProgress = 0f
                revealBusy = true
                ThemeController.toggle(context, darkTheme)
                revealScope.launch {
                    try {
                        animate(
                            initialValue = 0f,
                            targetValue = 1f,
                            animationSpec = tween(
                                durationMillis = 520,
                                easing = if (retract) {
                                    CubicBezierEasing(0.8f, 0f, 0.8f, 0.2f)
                                } else {
                                    CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)
                                },
                            ),
                        ) { value, _ -> revealProgress = value }
                    } finally {
                        revealSnapshot = null
                        revealBusy = false
                    }
                }
            }
        }
    }

    LaunchedEffect(incomingLink) {
        val token = incomingLink?.let(::parseShareToken) ?: return@LaunchedEffect
        // 从外部点进来时，把挡在取件页前面的面板收掉
        showJoin = false
        showMenu = false
        if (state.advertising) viewModel.closeReceive()
        shareInput = token
        shareTab = "visit"
        showShare = true
        viewModel.visitShare(token)
        onIncomingLinkHandled()
    }

    LaunchedEffect(incomingFiles) {
        if (incomingFiles.isEmpty()) return@LaunchedEffect
        showJoin = false
        showMenu = false
        if (state.advertising) viewModel.closeReceive()
        shareTab = "share"
        showShare = true
        viewModel.shareFiles(incomingFiles)
        onIncomingFilesHandled()
    }

    LaunchedEffect(state.pairing != null) {
        if (state.pairing != null) showJoin = false
    }

    // 回到首页时再清一次过期的网页端联系人
    LaunchedEffect(state.activePeerId) {
        if (state.activePeerId == null) viewModel.pruneContacts()
    }

    LaunchedEffect(state.error?.id) {
        val error = state.error ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(error.message)
        viewModel.clearError(error.id)
    }

    Box(Modifier.fillMaxSize()) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            contentWindowInsets = WindowInsets.safeDrawing,
            snackbarHost = {
                SnackbarHost(snackbarHostState) { data ->
                    Snackbar(
                        snackbarData = data,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            },
        ) { inner ->
            AnimatedContent(
                targetState = state.activePeerId,
                transitionSpec = {
                    if (targetState != null) {
                        (slideInHorizontally(tween(300)) { it / 4 } + fadeIn(tween(200))) togetherWith
                            (slideOutHorizontally(tween(220)) { -it / 10 } + fadeOut(tween(160)))
                    } else {
                        (slideInHorizontally(tween(300)) { -it / 4 } + fadeIn(tween(200))) togetherWith
                            (slideOutHorizontally(tween(220)) { it / 10 } + fadeOut(tween(160)))
                    }
                },
                modifier = Modifier
                    .fillMaxSize()
                    .padding(inner),
                label = "screen",
            ) { peerId ->
                if (peerId == null) {
                    HomeScreen(
                        state = state,
                        darkTheme = darkTheme,
                        onToggleTheme = toggleTheme,
                        onMenu = { showMenu = true },
                        onReceive = viewModel::receive,
                        onShare = {
                            shareTab = "share"
                            showShare = true
                        },
                        onOpenPeer = viewModel::connect,
                        onForget = viewModel::forget,
                    )
                } else {
                    SessionScreen(
                        state = state,
                        peerId = peerId,
                        onBack = { viewModel.background(peerId) },
                        onRetry = { viewModel.retry(peerId) },
                        onCancelReconnect = { viewModel.cancelReconnect(peerId) },
                        onCancel = { viewModel.disconnect(peerId) },
                        onForget = { viewModel.forget(peerId) },
                        onSendFiles = { uris -> viewModel.sendFiles(peerId, uris) },
                        onSendText = { text -> viewModel.sendText(peerId, text) },
                        onRetryText = { id -> viewModel.retryText(peerId, id) },
                        onOpenFile = { uri, mime -> openReceived(context, uri, mime) },
                    )
                }
            }
        }

        revealSnapshot?.let { snapshot ->
            Canvas(Modifier.fillMaxSize()) {
                val maxRadius = hypot(
                    max(revealCenter.x, size.width - revealCenter.x).toDouble(),
                    max(revealCenter.y, size.height - revealCenter.y).toDouble(),
                ).toFloat()
                val radius = maxRadius *
                    (if (revealRetract) 1f - revealProgress else revealProgress)
                val circle = Path().apply {
                    addOval(Rect(center = revealCenter, radius = radius.coerceAtLeast(0f)))
                }
                val dst = IntSize(size.width.toInt(), size.height.toInt())
                if (revealRetract) {
                    clipPath(circle) { drawImage(snapshot, dstSize = dst) }
                } else {
                    clipPath(circle, ClipOp.Difference) { drawImage(snapshot, dstSize = dst) }
                }
            }
        }
    }

    if (showMenu) {
        SideMenu(
            state = state,
            onDismiss = { showMenu = false },
            onSettings = {
                showMenu = false
                showSettings = true
            },
            onOpenHistory = { entry ->
                entry.uri?.let { openReceived(context, it, entry.mime) }
            },
        )
    }

    if (state.advertising) {
        ReceiveSheet(
            state = state,
            onClose = viewModel::closeReceive,
            onRefresh = viewModel::refreshCode,
            onJoin = {
                joinInput = ""
                viewModel.closeReceive()
                showJoin = true
            },
        )
    }
    if (showShare) {
        ShareSheet(
            state = state,
            initialTab = shareTab,
            initialLink = shareInput,
            onDismiss = { showShare = false },
            onCreateShare = viewModel::createShare,
            onRevoke = viewModel::revokeShare,
            onVisit = viewModel::visitShare,
            onLeave = viewModel::leaveShare,
        )
    }
    if (showJoin) {
        JoinSheet(
            state = state,
            initialCode = joinInput,
            onJoin = viewModel::join,
            onCancelJoin = viewModel::cancelJoin,
            onShowMine = {
                if (state.joining) viewModel.cancelJoin()
                showJoin = false
                joinInput = ""
                viewModel.receive()
            },
            onDismiss = {
                showJoin = false
                joinInput = ""
            },
        )
    }
    if (showSettings) {
        SettingsSheet(
            state = state,
            onSaveName = viewModel::setDeviceName,
            onShowLogs = { showLogs = true },
            onDismiss = { showSettings = false },
        )
    }
    if (showLogs) {
        LogDialog(logs = state.logs, onDismiss = { showLogs = false })
    }
    state.pairing?.let { pairing ->
        PairingDialog(
            pairing = pairing,
            onConfirm = viewModel::confirmPairing,
            onCancel = viewModel::dismissPairing,
        )
    }
}

private fun openReceived(context: Context, uriString: String, mime: String) {
    val uri = Uri.parse(uriString)
    val type = mime.ifBlank {
        runCatching { context.contentResolver.getType(uri) }.getOrNull() ?: "*/*"
    }
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, type)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        clipData = ClipData.newRawUri(null, uri)
    }
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "没有能打开这种文件的应用", Toast.LENGTH_SHORT).show()
    }
}
