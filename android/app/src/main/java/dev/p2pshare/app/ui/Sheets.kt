package dev.p2pshare.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Dialpad
import androidx.compose.material.icons.rounded.FileDownload
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.activity.compose.rememberLauncherForActivityResult
import com.journeyapps.barcodescanner.ScanContract
import dev.p2pshare.app.core.Pairing
import dev.p2pshare.app.core.SignalLinkState
import dev.p2pshare.app.data.exportDiagnostics
import dev.p2pshare.app.session.AppState
import dev.p2pshare.app.session.PairingRole
import dev.p2pshare.app.session.PairingUi
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceiveSheet(
    state: AppState,
    onClose: () -> Unit,
    onRefresh: () -> Unit,
    onJoin: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    // 显示的是"还有多久换码"，不是"码还有多久失效"：用户看到刷新，直觉上
    // 会把倒计时和刷新对上。码的 TTL 比轮换窗口长，两个时间不能混用。
    val rotateAt =
        if (state.codeExpiresAt > 0) {
            state.codeExpiresAt - Pairing.CODE_TTL_MS + Pairing.CODE_ROTATE_MS
        } else {
            0L
        }
    val remaining = rememberRemaining(rotateAt)
    val online = state.signal is SignalLinkState.Open

    LaunchedEffect(copied) {
        if (copied) {
            delay(1600)
            copied = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = sheetState,
        containerColor = scheme.background,
        contentColor = scheme.onBackground,
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 26.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("接收文件")
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onClose) {
                    Icon(
                        imageVector = Icons.Rounded.Close,
                        contentDescription = "关闭",
                        tint = scheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(
                text = "让对方连我",
                style = MaterialTheme.typography.headlineMedium,
                color = scheme.onBackground,
            )

            Spacer(Modifier.height(22.dp))
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                QrCode(content = state.pairLink, size = 196.dp)
            }

            Spacer(Modifier.height(14.dp))
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                AnimatedContent(
                    targetState = state.code,
                    transitionSpec = {
                        (slideInVertically { it / 2 } + fadeIn(tween(220))) togetherWith
                            (slideOutVertically { -it / 2 } + fadeOut(tween(140)))
                    },
                    label = "pair-code",
                ) { code ->
                    Text(
                        text = code?.let(Pairing::formatCode) ?: "· · ·",
                        style = MaterialTheme.typography.displayMedium.copy(
                            fontFamily = MonoDigits,
                            letterSpacing = 4.sp,
                            fontWeight = FontWeight.Medium,
                        ),
                        color = scheme.onSurface,
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                when {
                    !online -> {
                        PulseDot(color = scheme.secondary, pulsing = true, size = 7.dp)
                        Spacer(Modifier.width(9.dp))
                        Text(
                            text = "服务还没连上",
                            style = MaterialTheme.typography.labelMedium,
                            color = scheme.onSurfaceVariant,
                        )
                    }
                    state.code == null -> {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = scheme.primary,
                        )
                        Spacer(Modifier.width(9.dp))
                        Text(
                            text = "正在取码…",
                            style = MaterialTheme.typography.labelMedium,
                            color = scheme.onSurfaceVariant,
                        )
                    }
                    else -> {
                        CountdownRing(
                            remainingMs = remaining,
                            totalMs = Pairing.CODE_ROTATE_MS,
                        )
                        Spacer(Modifier.width(9.dp))
                        Text(
                            text = "${((remaining + 999) / 1000)} 秒后换",
                            style = MaterialTheme.typography.labelMedium,
                            color = scheme.onSurfaceVariant,
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
            ) {
                TextButton(
                    onClick = {
                        state.code?.let {
                            clipboard.setText(AnnotatedString(it))
                            copied = true
                        }
                    },
                    enabled = state.code != null,
                ) {
                    Icon(
                        imageVector = if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(if (copied) "已复制" else "复制")
                }
                TextButton(onClick = onRefresh, enabled = online) {
                    Icon(
                        imageVector = Icons.Rounded.Refresh,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text("换一个")
                }
            }

            Spacer(Modifier.height(14.dp))
            Button(
                onClick = onJoin,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Text("我来连对方", style = MaterialTheme.typography.labelLarge)
            }
            Spacer(Modifier.height(28.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun JoinSheet(
    state: AppState,
    onJoin: (String) -> Unit,
    onCancelJoin: () -> Unit,
    onDismiss: () -> Unit,
    onShowMine: () -> Unit,
    initialCode: String = "",
) {
    val scheme = MaterialTheme.colorScheme
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val clipboard = LocalClipboardManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var digits by rememberSaveable(initialCode) { mutableStateOf(initialCode) }
    var hint by remember { mutableStateOf<String?>(null) }
    val online = state.signal is SignalLinkState.Open
    val canSubmit = digits.length == Pairing.CODE_DIGITS && online && !state.joining

    val submit = {
        if (canSubmit) {
            keyboard?.hide()
            hint = null
            onJoin(digits)
        }
    }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@rememberLauncherForActivityResult
        val code = Pairing.normalizeCode(text)
        if (code == null) {
            hint = "这个二维码不是配对码"
        } else {
            digits = code
            if (online && !state.joining) {
                keyboard?.hide()
                hint = null
                onJoin(code)
            } else {
                hint = "服务还没连上，连上后点连接"
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = {
            if (state.joining) onCancelJoin()
            onDismiss()
        },
        sheetState = sheetState,
        containerColor = scheme.background,
        contentColor = scheme.onBackground,
        tonalElevation = 0.dp,
        // 默认的遮罩太淡，首页标题会露在面板上沿，切成半截字
        scrimColor = scheme.scrim.copy(alpha = 0.9f),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 26.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("配对设备")
                Spacer(Modifier.weight(1f))
                IconButton(
                    onClick = {
                        if (state.joining) onCancelJoin()
                        onDismiss()
                    },
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Close,
                        contentDescription = "关闭",
                        tint = scheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(
                text = "输入对方的码",
                style = MaterialTheme.typography.headlineMedium,
                color = scheme.onBackground,
            )

            Spacer(Modifier.height(18.dp))
            OutlinedButton(
                onClick = { scanner.launch(pairingScanOptions()) },
                enabled = !state.joining,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.QrCodeScanner,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text("扫对方的码")
            }
            Text(
                text = "或者手动输入",
                style = MaterialTheme.typography.labelMedium,
                color = scheme.onSurfaceVariant.copy(alpha = 0.7f),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp, bottom = 10.dp),
                textAlign = TextAlign.Center,
            )

            CodeInput(
                value = digits,
                enabled = !state.joining,
                onValueChange = { next ->
                    digits = next
                    hint = null
                },
                onSubmit = { submit() },
            )

            Spacer(Modifier.height(14.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = {
                        val raw = clipboard.getText()?.text.orEmpty()
                        val code = Pairing.normalizeCode(raw)
                        if (code == null) {
                            hint = "剪贴板里没有六位配对码"
                        } else {
                            digits = code
                            hint = null
                        }
                    },
                    enabled = !state.joining,
                ) {
                    Icon(
                        imageVector = Icons.Rounded.ContentPaste,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text("从剪贴板粘贴")
                }
                Spacer(Modifier.weight(1f))
                if (!online) {
                    Text(
                        text = "服务未连接",
                        style = MaterialTheme.typography.labelMedium,
                        color = scheme.error,
                    )
                }
            }
            if (hint != null) {
                Text(
                    text = hint.orEmpty(),
                    style = MaterialTheme.typography.labelMedium,
                    color = scheme.error,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }

            Spacer(Modifier.height(18.dp))
            Button(
                onClick = { if (state.joining) onCancelJoin() else submit() },
                enabled = if (state.joining) true else canSubmit,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                if (state.joining) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(17.dp),
                        strokeWidth = 2.dp,
                        color = scheme.onPrimary,
                    )
                    Spacer(Modifier.width(10.dp))
                    Text("正在找对方…", style = MaterialTheme.typography.labelLarge)
                } else {
                    Text("连接", style = MaterialTheme.typography.labelLarge)
                }
            }
            if (state.joining) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    TextButton(onClick = onCancelJoin) { Text("取消寻找") }
                }
            }
            Spacer(Modifier.height(6.dp))
            TextButton(
                onClick = onShowMine,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("让对方连我")
            }
            Spacer(Modifier.height(22.dp))
        }
    }
}

@Composable
private fun CodeInput(
    value: String,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val focusRequester = remember { FocusRequester() }
    Box {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(Pairing.CODE_DIGITS) { index ->
                val char = value.getOrNull(index)
                val active = enabled && index == value.length
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(58.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(
                            if (active) scheme.primary.copy(alpha = 0.08f)
                            else scheme.surfaceVariant.copy(alpha = 0.55f),
                        )
                        .border(
                            width = if (active) 1.5.dp else 1.dp,
                            color = if (active) scheme.primary else scheme.outlineVariant,
                            shape = RoundedCornerShape(14.dp),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = char?.toString() ?: "",
                        fontSize = 24.sp,
                        fontFamily = MonoDigits,
                        fontWeight = FontWeight.SemiBold,
                        color = scheme.onSurface,
                    )
                }
            }
        }
        BasicTextField(
            value = value,
            onValueChange = { raw ->
                val next = if (raw.length > Pairing.CODE_DIGITS) {
                    Pairing.normalizeCode(raw)
                        ?: raw.filter { it.isDigit() }.take(Pairing.CODE_DIGITS)
                } else {
                    raw.filter { it.isDigit() }.take(Pairing.CODE_DIGITS)
                }
                onValueChange(next)
            },
            enabled = enabled,
            modifier = Modifier
                .matchParentSize()
                .alpha(0.01f)
                .focusRequester(focusRequester),
            textStyle = TextStyle(color = Color.Transparent, fontSize = 1.sp),
            cursorBrush = SolidColor(Color.Transparent),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.NumberPassword,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onSubmit() }),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(
    state: AppState,
    onSaveName: (String) -> Unit,
    onShowLogs: () -> Unit,
    onDismiss: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var name by rememberSaveable { mutableStateOf(state.deviceName) }
    val trimmed = name.trim().take(24)
    val changed = trimmed.isNotEmpty() && trimmed != state.deviceName

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = scheme.background,
        contentColor = scheme.onBackground,
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 26.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("设置")
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.Rounded.Close,
                        contentDescription = "关闭",
                        tint = scheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(
                text = "这台设备",
                style = MaterialTheme.typography.headlineMedium,
                color = scheme.onBackground,
            )
            Spacer(Modifier.height(18.dp))
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(24) },
                label = { Text("设备名") },
                supportingText = { Text("配对时对方会看到这个名字。") },
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(18.dp))
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(20.dp),
                color = scheme.surfaceVariant.copy(alpha = 0.45f),
                border = BorderStroke(1.dp, scheme.outlineVariant),
            ) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                    IdentityRow("设备号", state.deviceId)
                    Spacer(Modifier.height(12.dp))
                    IdentityRow("公钥指纹", formatFingerprint(state.fingerprint))
                    Spacer(Modifier.height(12.dp))
                    IdentityRow(
                        "连接服务",
                        when (val signal = state.signal) {
                            is SignalLinkState.Open -> "已连接"
                            is SignalLinkState.Connecting -> "正在连接"
                            is SignalLinkState.Waiting -> "重连中 · 第 ${signal.attempt} 次"
                            is SignalLinkState.Closed -> "离线"
                        },
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = onShowLogs,
                    modifier = Modifier.padding(top = 2.dp),
                ) {
                    Text("诊断日志（${state.logs.size}）")
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = "版本 ${rememberAppVersion()}",
                    style = MaterialTheme.typography.labelMedium,
                    color = scheme.onSurfaceVariant.copy(alpha = 0.7f),
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(scheme.primary.copy(alpha = 0.07f), RoundedCornerShape(16.dp))
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Rounded.Lock,
                    contentDescription = null,
                    tint = scheme.primary,
                    modifier = Modifier.size(17.dp),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "设备私钥保存在 Android Keystore 里，不能导出。卸载应用会失去这个身份。",
                    style = MaterialTheme.typography.labelMedium,
                    color = scheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = {
                    onSaveName(trimmed)
                    onDismiss()
                },
                enabled = changed,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Text("保存名称", style = MaterialTheme.typography.labelLarge)
            }
            Spacer(Modifier.height(28.dp))
        }
    }
}

@Composable
private fun IdentityRow(label: String, value: String) {
    val scheme = MaterialTheme.colorScheme
    Column {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = scheme.onSurfaceVariant.copy(alpha = 0.7f),
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = MonoDigits),
            color = scheme.onSurface,
        )
    }
}

@Composable
fun LogDialog(
    logs: List<String>,
    onDismiss: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    var exported by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(copied) {
        if (copied) {
            delay(1600)
            copied = false
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(0.94f),
            shape = RoundedCornerShape(28.dp),
            color = scheme.background,
            border = BorderStroke(1.dp, scheme.outlineVariant),
        ) {
            Column(Modifier.padding(20.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "诊断日志",
                        style = MaterialTheme.typography.titleLarge,
                        color = scheme.onSurface,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(
                            imageVector = Icons.Rounded.Close,
                            contentDescription = "关闭",
                            tint = scheme.onSurfaceVariant,
                        )
                    }
                }
                Text(
                    text = "只记连接和传输事件（含文件名），配对码、nonce 和签名不记。" +
                        "重启后仍保留最近 200 行，最新的在最上面。",
                    style = MaterialTheme.typography.labelMedium,
                    color = scheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                if (logs.isEmpty()) {
                    Text(
                        text = "还没有记录。",
                        style = MaterialTheme.typography.bodyMedium,
                        color = scheme.onSurfaceVariant,
                    )
                } else {
                    Surface(
                        color = scheme.surfaceVariant.copy(alpha = 0.45f),
                        shape = RoundedCornerShape(16.dp),
                    ) {
                        LazyColumn(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 380.dp)
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            items(logs) { line ->
                                Text(
                                    text = line,
                                    style = MaterialTheme.typography.labelSmall.copy(
                                        fontFamily = MonoDigits,
                                    ),
                                    color = scheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.height(14.dp))
                exported?.let { result ->
                    Text(
                        text = result,
                        style = MaterialTheme.typography.labelMedium,
                        color = scheme.primary,
                        modifier = Modifier.padding(bottom = 6.dp),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(
                        onClick = {
                            clipboard.setText(AnnotatedString(logs.joinToString("\n")))
                            copied = true
                        },
                        enabled = logs.isNotEmpty(),
                    ) {
                        Icon(
                            imageVector = if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(if (copied) "已复制" else "复制全部")
                    }
                    TextButton(
                        onClick = {
                            exported = exportDiagnostics(context, logs).fold(
                                onSuccess = { "已导出到 $it" },
                                onFailure = { "导出失败：${it.message ?: "未知原因"}" },
                            )
                        },
                        enabled = logs.isNotEmpty(),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.FileDownload,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text("导出到下载")
                    }
                    Spacer(Modifier.weight(1f))
                    Button(onClick = onDismiss) { Text("关闭") }
                }
            }
        }
    }
}

@Composable
fun PairingDialog(
    pairing: PairingUi,
    onConfirm: (Boolean) -> Unit,
    onCancel: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val owner = pairing.role == PairingRole.OWNER

    Dialog(
        onDismissRequest = { if (!owner) onCancel() },
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnBackPress = !owner,
            dismissOnClickOutside = false,
        ),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.92f)
                .animateContentSize(),
            shape = RoundedCornerShape(34.dp),
            color = scheme.background,
            border = BorderStroke(1.dp, scheme.outlineVariant),
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 26.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Eyebrow("配对核对")
                Spacer(Modifier.height(14.dp))
                Text(
                    text = "两边数字\n一样吗？",
                    style = MaterialTheme.typography.headlineMedium,
                    color = scheme.onBackground,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = pairing.peerName,
                    style = MaterialTheme.typography.labelMedium,
                    color = scheme.onSurfaceVariant,
                )
                if (pairing.peerPlatform.isNotBlank()) {
                    Spacer(Modifier.height(8.dp))
                    PlatformBadge(pairing.peerPlatform)
                }
                Spacer(Modifier.height(24.dp))
                SasDigits(pairing.sas)
                Spacer(Modifier.height(18.dp))
                Text(
                    text = "这六个数由两台设备的公钥算出。一样，就说明中间没有人替换身份。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = scheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(26.dp))
                if (owner) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(
                            onClick = {
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                onConfirm(false)
                            },
                            modifier = Modifier
                                .weight(1f)
                                .height(50.dp),
                            shape = RoundedCornerShape(16.dp),
                        ) {
                            Text("不一致")
                        }
                        Button(
                            onClick = {
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                onConfirm(true)
                            },
                            modifier = Modifier
                                .weight(1f)
                                .height(50.dp),
                            shape = RoundedCornerShape(16.dp),
                        ) {
                            Text("一致")
                        }
                    }
                } else {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = scheme.primary,
                        )
                        Text(
                            text = "等对方确认…",
                            style = MaterialTheme.typography.labelLarge,
                            color = scheme.onSurface,
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = onCancel) { Text("取消配对") }
                    Text(
                        text = "如果两边数字不一样，取消这次配对。",
                        style = MaterialTheme.typography.labelMedium,
                        color = scheme.onSurfaceVariant.copy(alpha = 0.75f),
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}

@Composable
private fun SasDigits(code: String) {
    val scheme = MaterialTheme.colorScheme
    var shown by remember(code) { mutableIntStateOf(0) }
    LaunchedEffect(code) {
        shown = 0
        repeat(code.length) {
            delay(55)
            shown += 1
        }
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        code.forEachIndexed { index, char ->
            if (index == 3) Spacer(Modifier.width(11.dp))
            val visibility by animateFloatAsState(
                targetValue = if (index < shown) 1f else 0f,
                animationSpec = if (index < shown) spring(
                    dampingRatio = 0.55f,
                    stiffness = Spring.StiffnessLow,
                ) else tween(80),
                label = "sas-$index",
            )
            Text(
                text = char.toString(),
                fontSize = 40.sp,
                fontFamily = MonoDigits,
                fontWeight = FontWeight.Medium,
                color = scheme.primary,
                modifier = Modifier.graphicsLayer {
                    alpha = visibility
                    scaleX = 0.7f + visibility * 0.3f
                    scaleY = 0.7f + visibility * 0.3f
                },
            )
        }
    }
}

@Composable
private fun CountdownRing(remainingMs: Long, totalMs: Long, size: Dp = 26.dp) {
    val scheme = MaterialTheme.colorScheme
    val fraction = (remainingMs.toFloat() / totalMs.toFloat()).coerceIn(0f, 1f)
    val animated by animateFloatAsState(
        targetValue = fraction,
        animationSpec = tween(240),
        label = "countdown-ring",
    )
    Canvas(Modifier.size(size)) {
        val stroke = 2.5.dp.toPx()
        drawArc(
            color = scheme.outlineVariant,
            startAngle = -90f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = Offset(stroke / 2, stroke / 2),
            size = androidx.compose.ui.geometry.Size(this.size.width - stroke, this.size.height - stroke),
            style = Stroke(stroke, cap = StrokeCap.Round),
        )
        drawArc(
            color = if (fraction < 0.25f) scheme.secondary else scheme.primary,
            startAngle = -90f,
            sweepAngle = 360f * animated,
            useCenter = false,
            topLeft = Offset(stroke / 2, stroke / 2),
            size = androidx.compose.ui.geometry.Size(this.size.width - stroke, this.size.height - stroke),
            style = Stroke(stroke, cap = StrokeCap.Round),
        )
    }
}

@Composable
private fun rememberRemaining(expiresAt: Long): Long {
    var now by remember(expiresAt) { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(expiresAt) {
        if (expiresAt <= 0) return@LaunchedEffect
        while (true) {
            now = System.currentTimeMillis()
            delay(200)
        }
    }
    return if (expiresAt <= 0) 0 else (expiresAt - now).coerceAtLeast(0)
}
