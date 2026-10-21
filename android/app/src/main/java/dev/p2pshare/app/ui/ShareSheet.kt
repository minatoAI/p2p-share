package dev.p2pshare.app.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.OpenInNew
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.p2pshare.app.core.parseShareToken
import dev.p2pshare.app.session.AppState
import dev.p2pshare.app.session.ShareUi
import dev.p2pshare.app.session.ShareVisitorPhase
import dev.p2pshare.app.session.VisitPhase
import dev.p2pshare.app.session.VisitUi

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareSheet(
    state: AppState,
    onDismiss: () -> Unit,
    onCreateShare: (Uri) -> Unit,
    onRevoke: (String) -> Unit,
    onVisit: (String) -> Unit,
    onLeave: () -> Unit,
    initialTab: String = "share",
    initialLink: String = "",
) {
    val scheme = MaterialTheme.colorScheme
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var tab by rememberSaveable(initialTab) { mutableStateOf(initialTab) }
    var linkInput by rememberSaveable(initialLink) { mutableStateOf(initialLink) }
    var copiedToken by remember { mutableStateOf<String?>(null) }
    // 撤销不可逆，先确认一次；点「返回」不会动链接
    var pendingRevoke by remember { mutableStateOf<ShareUi?>(null) }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            runCatching {
                context.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
            onCreateShare(uri)
        }
    }

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
                .padding(horizontal = 24.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Eyebrow("公开链接")
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.Rounded.Close,
                        contentDescription = "关闭",
                        tint = scheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(
                text = if (tab == "share") "发一条链接，\n对方打开就能取。" else "打开别人的链接，\n不用配对。",
                style = MaterialTheme.typography.headlineMedium,
                color = scheme.onBackground,
            )
            Spacer(Modifier.height(18.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(scheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(14.dp))
                    .padding(4.dp),
            ) {
                ShareTab("我分享", tab == "share", Modifier.weight(1f)) { tab = "share" }
                ShareTab("我取件", tab == "visit", Modifier.weight(1f)) { tab = "visit" }
            }

            if (tab == "share") {
                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = { picker.launch(arrayOf("*/*")) },
                    enabled = !state.shareBusy,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp),
                    shape = RoundedCornerShape(16.dp),
                ) {
                    if (state.shareBusy) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(17.dp),
                            strokeWidth = 2.dp,
                            color = scheme.onPrimary,
                        )
                        Spacer(Modifier.width(9.dp))
                        Text("正在生成链接…")
                    } else {
                        Icon(
                            imageVector = Icons.Rounded.Link,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("选择文件生成链接")
                    }
                }
                Spacer(Modifier.height(14.dp))
                if (state.shares.isEmpty()) {
                    Text(
                        text = "还没有挂出去的链接。",
                        style = MaterialTheme.typography.bodyMedium,
                        color = scheme.onSurfaceVariant.copy(alpha = 0.7f),
                        modifier = Modifier.padding(vertical = 12.dp),
                    )
                } else {
                    LazyColumn(
                        modifier = Modifier.heightIn(max = 360.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 8.dp),
                    ) {
                        items(state.shares, key = { it.token }) { share ->
                            ShareCard(
                                share = share,
                                copied = copiedToken == share.token,
                                onCopy = {
                                    clipboard.setText(AnnotatedString(share.link))
                                    copiedToken = share.token
                                },
                                onSend = {
                                    val send = Intent(Intent.ACTION_SEND).apply {
                                        type = "text/plain"
                                        putExtra(Intent.EXTRA_TEXT, share.link)
                                    }
                                    context.startActivity(Intent.createChooser(send, "发送链接"))
                                },
                                onRevoke = { pendingRevoke = share },
                            )
                        }
                    }
                }
            } else {
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value = linkInput,
                    onValueChange = { linkInput = it },
                    label = { Text("链接或分享编号") },
                    placeholder = { Text("粘贴 https://…/#s=… 或 32 位编号") },
                    singleLine = true,
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { onVisit(linkInput) },
                        enabled = parseShareToken(linkInput) != null && !state.shareBusy,
                        modifier = Modifier
                            .weight(1f)
                            .height(48.dp),
                        shape = RoundedCornerShape(15.dp),
                    ) {
                        Text("打开链接")
                    }
                    TextButton(
                        onClick = {
                            linkInput = state.visit?.token.orEmpty()
                        },
                        enabled = state.visit?.token?.isNotBlank() == true,
                    ) {
                        Text("填入上一条")
                    }
                }
                Spacer(Modifier.height(14.dp))
                state.visit?.let { visit ->
                    VisitCard(visit = visit, onLeave = onLeave, onRetry = { onVisit(visit.token) })
                }
            }

            Spacer(Modifier.height(28.dp))
        }
    }

    pendingRevoke?.let { share ->
        AlertDialog(
            onDismissRequest = { pendingRevoke = null },
            title = { Text("撤销这条链接？") },
            text = {
                Text(
                    "撤销后「${share.name}」立刻失效，已经拿到链接的人也打不开。",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingRevoke = null
                        onRevoke(share.token)
                    },
                ) {
                    Text("确认撤销", color = scheme.error, fontWeight = FontWeight.Medium)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingRevoke = null }) { Text("返回") }
            },
        )
    }
}

@Composable
private fun ShareTab(text: String, active: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        modifier = modifier.height(38.dp),
        shape = RoundedCornerShape(11.dp),
        color = if (active) scheme.background else androidx.compose.ui.graphics.Color.Transparent,
        contentColor = if (active) scheme.onSurface else scheme.onSurfaceVariant,
        shadowElevation = if (active) 1.dp else 0.dp,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(text, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun ShareCard(
    share: ShareUi,
    copied: Boolean,
    onCopy: () -> Unit,
    onSend: () -> Unit,
    onRevoke: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = scheme.surfaceVariant.copy(alpha = 0.42f),
        border = androidx.compose.foundation.BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        Column(Modifier.padding(horizontal = 15.dp, vertical = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = share.name,
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = "${formatBytes(share.size)} · 有效到 ${formatHistoryTime(share.expiresAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = scheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onRevoke) {
                    Text("撤销", color = scheme.error)
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                text = share.link,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = MonoDigits),
                color = scheme.primary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onCopy, modifier = Modifier.height(38.dp)) {
                    Icon(
                        imageVector = Icons.Rounded.ContentCopy,
                        contentDescription = null,
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.width(5.dp))
                    Text(if (copied) "已复制" else "复制")
                }
                OutlinedButton(onClick = onSend, modifier = Modifier.height(38.dp)) {
                    Icon(
                        imageVector = Icons.Rounded.OpenInNew,
                        contentDescription = null,
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.width(5.dp))
                    Text("发出去")
                }
            }
            if (share.visitors.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = share.visitors.joinToString("、") {
                        "${it.name}（${visitorPhaseText(it.phase)}）"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = scheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun VisitCard(visit: VisitUi, onLeave: () -> Unit, onRetry: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = scheme.surfaceVariant.copy(alpha = 0.42f),
        border = androidx.compose.foundation.BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 15.dp)) {
            if (visit.name != null) {
                Text(
                    text = visit.name,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = listOfNotNull(
                        visit.size?.let(::formatBytes),
                        visit.deviceName?.let { "来自「$it」" },
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall,
                    color = scheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
            }
            Text(
                text = visitPhaseText(visit),
                style = MaterialTheme.typography.bodyMedium,
                color = when (visit.phase) {
                    VisitPhase.DONE -> scheme.primary
                    VisitPhase.FAILED, VisitPhase.EXPIRED, VisitPhase.REVOKED -> scheme.error
                    else -> scheme.onSurface
                },
            )
            if (visit.phase == VisitPhase.DOWNLOADING) {
                Spacer(Modifier.height(10.dp))
                LinearProgressIndicator(
                    progress = { visit.progress ?: 0f },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(5.dp)
                        .clip(RoundedCornerShape(50)),
                    color = scheme.primary,
                    trackColor = scheme.primary.copy(alpha = 0.15f),
                )
                Spacer(Modifier.height(5.dp))
                Text(
                    text = buildString {
                        append("${((visit.progress ?: 0f) * 100).toInt()}%")
                        if (visit.speed > 0) append(" · ${formatSpeed(visit.speed)}")
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = scheme.onSurfaceVariant,
                )
            }
            if (visit.note != null && visit.phase != VisitPhase.DONE) {
                Spacer(Modifier.height(6.dp))
                Text(
                    text = visit.note,
                    style = MaterialTheme.typography.labelMedium,
                    color = scheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (visit.phase) {
                    VisitPhase.CHECKING, VisitPhase.CONNECTING, VisitPhase.DOWNLOADING ->
                        OutlinedButton(onClick = onLeave) { Text("取消") }
                    VisitPhase.OFFLINE, VisitPhase.BUSY, VisitPhase.FAILED ->
                        Button(onClick = onRetry) { Text("再试一次") }
                    else -> Unit
                }
            }
        }
    }
}

private fun visitPhaseText(visit: VisitUi): String = when (visit.phase) {
    VisitPhase.CHECKING -> "正在查这条分享还在不在…"
    VisitPhase.CONNECTING -> "正在建立点对点连接…"
    VisitPhase.DOWNLOADING -> "正在收，别关掉这一页"
    VisitPhase.DONE -> "收好了，文件已经保存到系统下载"
    VisitPhase.OFFLINE -> "对方此刻不在线"
    VisitPhase.REVOKED -> "分享者撤销了这条链接"
    VisitPhase.EXPIRED -> "这条链接到期了"
    VisitPhase.NOT_FOUND -> "找不到这条链接"
    VisitPhase.BUSY -> "对方一次只给一个人发文件"
    VisitPhase.FAILED -> "取件失败"
    VisitPhase.LEFT -> "已取消"
}

private fun visitorPhaseText(phase: ShareVisitorPhase): String = when (phase) {
    ShareVisitorPhase.CONNECTING -> "正在连"
    ShareVisitorPhase.SENDING -> "正在发"
    ShareVisitorPhase.DONE -> "已取完"
    ShareVisitorPhase.FAILED -> "失败"
    ShareVisitorPhase.LEFT -> "已离开"
}
