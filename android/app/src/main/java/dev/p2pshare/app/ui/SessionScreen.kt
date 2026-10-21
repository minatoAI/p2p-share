package dev.p2pshare.app.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AttachFile
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.LinkOff
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.p2pshare.app.core.Direction
import dev.p2pshare.app.core.TransferStatus
import dev.p2pshare.app.session.AppState
import dev.p2pshare.app.session.SessionPhase
import dev.p2pshare.app.session.TextDelivery
import dev.p2pshare.app.session.TextItem
import dev.p2pshare.app.session.TransferItem
import kotlinx.coroutines.delay

private sealed interface Entry {
    val at: Long
    val key: String

    data class TextLine(val item: TextItem) : Entry {
        override val at: Long get() = item.at
        override val key: String get() = "text:${item.id}"
    }

    data class FileLine(val item: TransferItem) : Entry {
        override val at: Long get() = item.at
        override val key: String get() = "file:${item.id}"
    }
}

@Composable
fun SessionScreen(
    state: AppState,
    peerId: String,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onCancelReconnect: () -> Unit,
    onCancel: () -> Unit,
    onForget: () -> Unit,
    onSendFiles: (List<Uri>) -> Unit,
    onSendText: (String) -> Unit,
    onRetryText: (String) -> Unit,
    onOpenFile: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val name = state.displayName(peerId)
    val peerUi = state.peers[peerId]
    val phase = peerUi?.phase ?: SessionPhase.IDLE
    val ready = phase == SessionPhase.READY
    // 息屏/无网/后台或静默重连期间：失败和重连横幅先不露
    val quiet = peerUi?.quiet == true && !ready
    val autoRetrying = peerUi?.autoRetrying == true
    val retryAttempt = peerUi?.retryAttempt ?: 0
    val peerOnline = state.presence[peerId] == true
    val contact = state.contacts.firstOrNull { it.peerId == peerId }
    // 有配对记录就可以先写/先选文件，连接没就绪时由会话层排住
    val canCompose = contact != null

    val entries = remember(state.transfers, state.texts, peerId) {
        buildList {
            state.texts.forEach { if (it.peerId == peerId) add(Entry.TextLine(it)) }
            state.transfers.forEach { if (it.peerId == peerId) add(Entry.FileLine(it)) }
        }.sortedBy { it.at }
    }

    var draft by rememberSaveable(peerId) { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmForget by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val haptic = LocalHapticFeedback.current
    // 系统返回和左上角一样：回首页，连接留在后台。
    BackHandler { onBack() }
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isNotEmpty()) onSendFiles(uris)
    }

    LaunchedEffect(entries.size) {
        if (entries.isNotEmpty()) listState.animateScrollToItem(entries.lastIndex)
    }

    val submit = {
        val text = draft.trim()
        // 连接没就绪也允许发：会话层会先排住，连上后自动补发
        if (text.isNotEmpty() && canCompose) {
            draft = ""
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            onSendText(text)
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 6.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Rounded.ArrowBack,
                    contentDescription = "返回",
                    tint = scheme.onSurface,
                )
            }
            Avatar(name = name, size = 38.dp)
            Spacer(Modifier.size(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = name,
                        style = MaterialTheme.typography.titleMedium,
                        color = scheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Spacer(Modifier.size(7.dp))
                    PlatformBadge(contact?.peerPlatform, compact = true)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // 静默恢复期间用「连接中」的中性色，不摆红点吓人
                    val shownPhase = if (quiet) SessionPhase.SIGNALING else phase
                    PulseDot(
                        color = phaseColor(shownPhase, scheme.primary, scheme.secondary, scheme.error),
                        pulsing = !ready && !quiet && phase != SessionPhase.FAILED && phase != SessionPhase.IDLE,
                        size = 6.dp,
                    )
                    Spacer(Modifier.size(5.dp))
                    Text(
                        text = primaryStatus(phase, peerOnline, quiet),
                        style = MaterialTheme.typography.labelMedium,
                        color = phaseColor(shownPhase, scheme.primary, scheme.secondary, scheme.error),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(
                        imageVector = Icons.Rounded.MoreVert,
                        contentDescription = "更多",
                        tint = scheme.onSurfaceVariant,
                    )
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("忘记这台设备") },
                        leadingIcon = {
                            Icon(
                                imageVector = Icons.Rounded.DeleteOutline,
                                contentDescription = null,
                                tint = scheme.error,
                            )
                        },
                        onClick = {
                            menuOpen = false
                            confirmForget = true
                        },
                    )
                }
            }
        }
        HorizontalDivider(
            color = scheme.outlineVariant.copy(alpha = 0.6f),
            thickness = 1.dp,
        )

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            if (entries.isEmpty()) {
                EmptyConversation(
                    phase = phase,
                    reason = peerUi?.message,
                    peerOnline = peerOnline,
                    fingerprint = contact?.fingerprint,
                    quiet = quiet,
                    autoRetrying = autoRetrying,
                    retryAttempt = retryAttempt,
                    onRetry = onRetry,
                    onCancelReconnect = onCancelReconnect,
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 10.dp,
                        bottom = 12.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    itemsIndexed(entries, key = { _, entry -> entry.key }) { index, entry ->
                        val previous = entries.getOrNull(index - 1)
                        val showTime = previous == null || entry.at - previous.at > 5 * 60_000
                        Column(Modifier.fillMaxWidth()) {
                            if (showTime) {
                                Text(
                                    text = formatClock(entry.at),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = scheme.onSurfaceVariant.copy(alpha = 0.55f),
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(top = 6.dp, bottom = 4.dp),
                                )
                            }
                            when (entry) {
                                is Entry.TextLine -> TextBubble(
                                    item = entry.item,
                                    onRetry = { onRetryText(entry.item.id) },
                                )
                                is Entry.FileLine -> FileCard(
                                    item = entry.item,
                                    onOpen = {
                                        entry.item.uri?.let { onOpenFile(it, entry.item.mime) }
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }

        // 失败时中间区域已经写了原因和「重试」，底部横幅只在有聊天记录时补位。
        // 静默恢复期间（息屏/无网/后台/前几次重试）整个横幅先不显示。
        if (!ready && !quiet && !(phase == SessionPhase.FAILED && entries.isEmpty())) {
            ConnectionBanner(
                phase = phase,
                detail = peerUi?.message,
                peerOnline = peerOnline,
                autoRetrying = autoRetrying,
                retryAttempt = retryAttempt,
                onRetry = onRetry,
                onCancelReconnect = onCancelReconnect,
                onCancel = onCancel,
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            FilledTonalIconButton(
                onClick = { picker.launch(arrayOf("*/*")) },
                enabled = canCompose,
                modifier = Modifier.size(46.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.AttachFile,
                    contentDescription = "选择文件",
                    modifier = Modifier.size(21.dp),
                )
            }
            Spacer(Modifier.size(8.dp))
            Surface(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 46.dp),
                shape = RoundedCornerShape(23.dp),
                color = scheme.surfaceVariant.copy(alpha = if (canCompose) 0.85f else 0.45f),
            ) {
                BasicTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    enabled = canCompose,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(
                        color = if (canCompose) scheme.onSurface else scheme.onSurfaceVariant.copy(alpha = 0.5f),
                    ),
                    cursorBrush = SolidColor(scheme.primary),
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Text,
                        imeAction = ImeAction.Send,
                    ),
                    keyboardActions = KeyboardActions(onSend = { submit() }),
                    decorationBox = { inner ->
                        Box(
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 11.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            if (draft.isEmpty()) {
                                Text(
                                    // 连接没就绪也能先写，发出去后会排队等连接
                                    text = if (!canCompose) "配对后才能发送"
                                    else if (ready) "说句话…"
                                    else "先写下来，连上自动发送",
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = scheme.onSurfaceVariant.copy(alpha = 0.6f),
                                )
                            }
                            inner()
                        }
                    },
                )
            }
            Spacer(Modifier.size(8.dp))
            FilledIconButton(
                onClick = submit,
                enabled = canCompose && draft.isNotBlank(),
                modifier = Modifier.size(46.dp),
                shape = CircleShape,
            ) {
                Icon(
                    imageVector = Icons.Rounded.ArrowUpward,
                    contentDescription = "发送",
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }

    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            title = { Text("忘记 $name？") },
            text = {
                Text(
                    platformExplanation(contact?.peerPlatform) +
                        " 删除后下次需要重新配对，正在进行的传输会中断。",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmForget = false
                        onForget()
                    },
                ) {
                    Text("忘记", color = scheme.error, fontWeight = FontWeight.Medium)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmForget = false }) { Text("取消") }
            },
        )
    }
}

private fun phaseColor(
    phase: SessionPhase,
    ready: androidx.compose.ui.graphics.Color,
    pending: androidx.compose.ui.graphics.Color,
    failed: androidx.compose.ui.graphics.Color,
): androidx.compose.ui.graphics.Color = when (phase) {
    SessionPhase.READY -> ready
    SessionPhase.FAILED -> failed
    SessionPhase.IDLE -> pending.copy(alpha = 0.6f)
    else -> pending
}

private fun primaryStatus(phase: SessionPhase, peerOnline: Boolean, quiet: Boolean): String = when (phase) {
    SessionPhase.READY -> "已连接"
    // 失败页中间已经有一个「连接失败」和重试按钮，头栏不再重复同一个词，
    // 只留状态点。AND-1 的“头栏不重复”靠这一行兑现。
    SessionPhase.FAILED -> if (quiet) "正在恢复连接" else ""
    SessionPhase.IDLE -> when {
        quiet -> "正在恢复连接"
        peerOnline -> "在线"
        else -> "对方离线"
    }
    // 正在找对方、打洞、核验身份都只是过程，主状态仍然是「在线」。
    else -> if (quiet) "正在连接" else "在线"
}

@Composable
private fun TextBubble(item: TextItem, onRetry: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val outgoing = item.direction == Direction.OUT
    val clipboard = LocalClipboardManager.current
    val haptic = LocalHapticFeedback.current
    var copied by remember(item.id) { mutableStateOf(false) }
    // 复制反馈只停留一小会，不占聊天记录
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }
    val shape = if (outgoing) RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp)
    else RoundedCornerShape(20.dp, 20.dp, 20.dp, 6.dp)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
    ) {
        Column(horizontalAlignment = if (outgoing) Alignment.End else Alignment.Start) {
            Surface(
                shape = shape,
                color = if (outgoing) scheme.primary else scheme.surfaceVariant,
                modifier = Modifier
                    .widthIn(max = 300.dp)
                    .clip(shape)
                    .clickable {
                        // 收到的文字和链接都只做复制，不当文件落盘
                        clipboard.setText(AnnotatedString(item.text))
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        copied = true
                    },
            ) {
                Text(
                    text = item.text,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (outgoing) scheme.onPrimary else scheme.onSurface,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
            // 收到的一律提示可以复制；自己发的显示送达状态，超时未确认给一个重发按钮
            val hint = when {
                copied -> "已复制"
                !outgoing -> "点击可复制"
                else -> when (item.delivery) {
                    TextDelivery.QUEUED -> "连接后自动发送"
                    TextDelivery.SENDING -> "已发送，等待对方确认"
                    TextDelivery.DELIVERED -> "已送达"
                    TextDelivery.UNCONFIRMED -> "未确认"
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = hint,
                    style = MaterialTheme.typography.labelSmall,
                    color = when {
                        copied -> scheme.primary
                        outgoing && item.delivery == TextDelivery.DELIVERED -> scheme.primary
                        else -> scheme.onSurfaceVariant.copy(alpha = 0.65f)
                    },
                    modifier = Modifier.padding(start = 6.dp, top = 3.dp),
                )
                if (outgoing && item.delivery == TextDelivery.UNCONFIRMED) {
                    // 圈箭头：重发同一段文字，id 不变，重新等 text-ack
                    IconButton(
                        onClick = onRetry,
                        modifier = Modifier.size(28.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Refresh,
                            contentDescription = "重发这条文字",
                            tint = scheme.primary,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun FileCard(item: TransferItem, onOpen: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val outgoing = item.direction == Direction.OUT
    val done = item.status == TransferStatus.DONE
    val failed = item.status == TransferStatus.ERROR
    val fraction = when {
        done -> 1f
        item.size > 0 -> (item.transferred.toFloat() / item.size).coerceIn(0f, 1f)
        else -> 0f
    }
    val animated by animateFloatAsState(
        targetValue = fraction,
        animationSpec = tween(durationMillis = 240),
        label = "file-fraction",
    )
    val clickable = done && !outgoing && item.uri != null

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            modifier = Modifier
                .widthIn(max = 312.dp)
                .then(if (clickable) Modifier.clickable(onClick = onOpen) else Modifier),
            shape = if (outgoing) RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp)
            else RoundedCornerShape(20.dp, 20.dp, 20.dp, 6.dp),
            color = if (outgoing) scheme.primaryContainer else scheme.surfaceVariant,
        ) {
            Column(Modifier.padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    FileGlyph(
                        mime = item.mime,
                        name = item.name,
                        incoming = !outgoing,
                    )
                    Spacer(Modifier.size(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = item.name,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.Medium,
                            color = if (outgoing) scheme.onPrimaryContainer else scheme.onSurface,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.height(3.dp))
                        Text(
                            text = statusLine(item, outgoing),
                            style = MaterialTheme.typography.labelMedium,
                            color = when {
                                failed -> scheme.error
                                outgoing -> scheme.onPrimaryContainer.copy(alpha = 0.66f)
                                else -> scheme.onSurfaceVariant
                            },
                        )
                    }
                    if (done) {
                        Icon(
                            imageVector = Icons.Rounded.Check,
                            contentDescription = null,
                            tint = if (outgoing) scheme.primary else scheme.onSurfaceVariant,
                            modifier = Modifier
                                .padding(start = 6.dp)
                                .size(18.dp),
                        )
                    }
                }
                if (item.status == TransferStatus.ACTIVE || item.status == TransferStatus.PENDING) {
                    Spacer(Modifier.height(12.dp))
                    LinearProgressIndicator(
                        progress = { animated },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(4.dp)
                            .clip(CircleShape),
                        color = scheme.primary,
                        trackColor = if (outgoing) scheme.primary.copy(alpha = 0.16f)
                        else scheme.onSurfaceVariant.copy(alpha = 0.14f),
                    )
                    Spacer(Modifier.height(7.dp))
                    Row(Modifier.fillMaxWidth()) {
                        Text(
                            text = "${formatBytes(item.transferred)} / ${formatBytes(item.size)}",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (outgoing) scheme.onPrimaryContainer.copy(alpha = 0.6f)
                            else scheme.onSurfaceVariant.copy(alpha = 0.8f),
                        )
                        Spacer(Modifier.weight(1f))
                        Text(
                            text = "${(fraction * 100).toInt()}%",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (outgoing) scheme.onPrimaryContainer.copy(alpha = 0.6f)
                            else scheme.onSurfaceVariant.copy(alpha = 0.8f),
                        )
                    }
                }
            }
        }
    }
}

private fun statusLine(item: TransferItem, outgoing: Boolean): String = when (item.status) {
    TransferStatus.PENDING -> "排队中 · ${formatBytes(item.size)}"
    TransferStatus.ACTIVE -> buildString {
        append(if (outgoing) "发送中" else "接收中")
        append(" · ${formatBytes(item.size)}")
        if (item.speed > 0) append(" · ${formatSpeed(item.speed)}")
    }
    TransferStatus.DONE -> when {
        outgoing -> "已送达 · 对方确认收齐"
        // 没有落盘地址的完成记录不算「已保存」：老版本可能把文字也标成了传输
        item.uri != null -> "已保存到下载 · 点按打开"
        else -> "已收到"
    }
    TransferStatus.ERROR -> item.message ?: if (outgoing) "发送失败" else "接收失败"
}

@Composable
private fun EmptyConversation(
    phase: SessionPhase,
    reason: String?,
    peerOnline: Boolean,
    fingerprint: String?,
    quiet: Boolean,
    autoRetrying: Boolean,
    retryAttempt: Int,
    onRetry: () -> Unit,
    onCancelReconnect: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val ready = phase == SessionPhase.READY
    val failed = phase == SessionPhase.FAILED && !quiet
    val idle = phase == SessionPhase.IDLE && !quiet
    val recovering = quiet && !ready
    // 只有确实能连、且不是静默恢复的时候才给按钮
    val canRetry = !quiet && (failed || (idle && peerOnline))
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .background(
                    when {
                        ready -> scheme.primaryContainer
                        failed -> scheme.errorContainer
                        else -> scheme.surfaceVariant
                    },
                    CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            when {
                ready -> Icon(
                    imageVector = Icons.Rounded.Shield,
                    contentDescription = null,
                    tint = scheme.primary,
                    modifier = Modifier.size(30.dp),
                )
                failed -> Icon(
                    imageVector = Icons.Rounded.ErrorOutline,
                    contentDescription = null,
                    tint = scheme.error,
                    modifier = Modifier.size(30.dp),
                )
                recovering -> CircularProgressIndicator(
                    modifier = Modifier.size(26.dp),
                    strokeWidth = 2.5.dp,
                )
                idle -> Icon(
                    imageVector = Icons.Rounded.LinkOff,
                    contentDescription = null,
                    tint = scheme.onSurfaceVariant,
                    modifier = Modifier.size(28.dp),
                )
                else -> CircularProgressIndicator(
                    modifier = Modifier.size(26.dp),
                    strokeWidth = 2.5.dp,
                )
            }
        }
        Spacer(Modifier.height(20.dp))
        Text(
            text = when {
                ready -> "连接好了"
                recovering -> "正在恢复连接"
                failed -> "连接失败"
                idle && peerOnline -> "还没有连接"
                idle -> "对方上线后会自动连回来"
                else -> "正在建立连接"
            },
            style = MaterialTheme.typography.headlineSmall,
            color = if (failed) scheme.error else scheme.onBackground,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = when {
                ready -> "已验签 · 点对点加密。\n发个文件，或说句话，内容只在两台设备之间走。"
                recovering -> if (autoRetrying) {
                    "自动重连第 $retryAttempt 次，连上后排队的内容会自动发出。"
                } else {
                    "亮屏或网络恢复后会自动连回来，这期间发送的内容会先排队。"
                }
                failed -> reason ?: "点对点连接断了"
                idle && peerOnline -> "点下面重新连一次。"
                idle -> "等对方上线后会自动连回来。"
                else -> "正在建立连接，一会就好。内容只在两台设备之间走。"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = scheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (canRetry) {
            Spacer(Modifier.height(18.dp))
            if (failed && autoRetrying) {
                TextButton(onClick = onCancelReconnect) { Text("取消重连") }
            } else {
                Button(onClick = onRetry) { Text(if (failed) "重试" else "连接") }
            }
        }
        if (ready && fingerprint != null) {
            Spacer(Modifier.height(18.dp))
            SmallChip(
                text = "配对指纹 ${formatFingerprint(fingerprint)}",
                icon = Icons.Rounded.Lock,
                tint = scheme.primary,
            )
        }
    }
}

@Composable
private fun ConnectionBanner(
    phase: SessionPhase,
    detail: String?,
    peerOnline: Boolean,
    autoRetrying: Boolean,
    retryAttempt: Int,
    onRetry: () -> Unit,
    onCancelReconnect: () -> Unit,
    onCancel: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val failed = phase == SessionPhase.FAILED
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp)
            .animateContentSize(),
        shape = RoundedCornerShape(18.dp),
        color = if (failed) scheme.errorContainer else scheme.surfaceVariant.copy(alpha = 0.7f),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (failed) {
                Icon(
                    imageVector = Icons.Rounded.ErrorOutline,
                    contentDescription = null,
                    tint = scheme.error,
                    modifier = Modifier.size(19.dp),
                )
            } else {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = scheme.primary,
                )
            }
            Spacer(Modifier.size(11.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = when (phase) {
                        SessionPhase.SIGNALING -> "正在找对方"
                        SessionPhase.ICE -> "正在打通网络"
                        SessionPhase.AUTH -> "正在核验身份"
                        SessionPhase.FAILED -> "连接失败"
                        SessionPhase.IDLE -> if (peerOnline) "在线" else "对方离线"
                        SessionPhase.READY -> ""
                    },
                    style = MaterialTheme.typography.labelLarge,
                    color = if (failed) scheme.onErrorContainer else scheme.onSurface,
                )
                Text(
                    text = detail ?: when (phase) {
                        SessionPhase.SIGNALING -> "通过服务器交换连接信息"
                        SessionPhase.ICE -> "优先走局域网，走不通再走外网"
                        SessionPhase.AUTH -> "确认对方就是配对过的那台设备"
                        SessionPhase.FAILED ->
                            if (autoRetrying) "自动重连第 $retryAttempt 次" else "点重试再来一次"
                        SessionPhase.IDLE -> if (peerOnline) {
                            "点重试再来一次。"
                        } else {
                            "等对方上线后会自动连回来。"
                        }
                        else -> "点重试再来一次"
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = if (failed) scheme.onErrorContainer.copy(alpha = 0.75f)
                    else scheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.size(6.dp))
            if (failed) {
                // 自动重连中给「取消重连」，用户按下才停下；否则才给「重试」
                if (autoRetrying) {
                    TextButton(onClick = onCancelReconnect) { Text("取消重连") }
                } else {
                    Button(onClick = onRetry) { Text("重试") }
                }
            } else {
                TextButton(onClick = onCancel) { Text("取消") }
            }
        }
    }
}
