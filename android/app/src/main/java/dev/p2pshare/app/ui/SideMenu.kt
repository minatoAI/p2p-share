package dev.p2pshare.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.p2pshare.app.core.Direction
import dev.p2pshare.app.core.TransferStatus
import dev.p2pshare.app.data.HistoryEntry
import dev.p2pshare.app.session.AppState

@Composable
fun SideMenu(
    state: AppState,
    onDismiss: () -> Unit,
    onSettings: () -> Unit,
    onOpenHistory: (HistoryEntry) -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.34f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onDismiss,
                ),
        ) {
            AnimatedVisibility(
                visible = true,
                enter = slideInHorizontally(tween(240)) { it } + fadeIn(tween(160)),
                modifier = Modifier.align(Alignment.CenterEnd),
            ) {
                Surface(
                    modifier = Modifier
                        .fillMaxHeight()
                        .width(340.dp)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = {},
                        ),
                    color = scheme.background,
                    contentColor = scheme.onBackground,
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(horizontal = 20.dp, vertical = 16.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            BrandMark(size = 34.dp)
                            Spacer(Modifier.size(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = "在线互传",
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Text(
                                    text = "版本 ${rememberAppVersion()} · ${state.deviceName}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = scheme.onSurfaceVariant,
                                )
                            }
                            IconButton(onClick = onDismiss) {
                                Icon(
                                    imageVector = Icons.Rounded.Close,
                                    contentDescription = "关闭菜单",
                                    tint = scheme.onSurfaceVariant,
                                )
                            }
                        }

                        Spacer(Modifier.height(16.dp))
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(18.dp))
                                .clickable(onClick = onSettings),
                            color = scheme.surfaceVariant.copy(alpha = 0.55f),
                            shape = RoundedCornerShape(18.dp),
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 15.dp, vertical = 13.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Settings,
                                    contentDescription = null,
                                    tint = scheme.primary,
                                    modifier = Modifier.size(19.dp),
                                )
                                Spacer(Modifier.size(11.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        text = "设置",
                                        style = MaterialTheme.typography.labelLarge,
                                    )
                                    Text(
                                        text = "设备名、身份、诊断日志",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = scheme.onSurfaceVariant,
                                    )
                                }
                                Text(
                                    text = "›",
                                    style = MaterialTheme.typography.titleMedium,
                                    color = scheme.onSurfaceVariant.copy(alpha = 0.5f),
                                )
                            }
                        }

                        Spacer(Modifier.height(22.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "传输记录",
                                style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                text = if (state.history.isEmpty()) "还没有" else "${state.history.size} 条",
                                style = MaterialTheme.typography.labelMedium,
                                color = scheme.onSurfaceVariant,
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "这里记的是所有设备的文件传输，完成后落盘，重启还在。",
                            style = MaterialTheme.typography.labelSmall,
                            color = scheme.onSurfaceVariant.copy(alpha = 0.72f),
                        )
                        Spacer(Modifier.height(10.dp))
                        HorizontalDivider(color = scheme.outlineVariant.copy(alpha = 0.7f))

                        if (state.history.isEmpty()) {
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxWidth(),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = "传过文件之后，\n记录会出现在这里。",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = scheme.onSurfaceVariant.copy(alpha = 0.7f),
                                )
                            }
                        } else {
                            LazyColumn(
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxWidth(),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                                    top = 6.dp,
                                    bottom = 10.dp,
                                ),
                            ) {
                                items(state.history, key = { it.id }) { entry ->
                                    HistoryRow(
                                        entry = entry,
                                        peerName = state.displayName(entry.peerId)
                                            .takeIf { it != entry.peerId }
                                            ?: entry.peerName,
                                        onClick = {
                                            if (entry.uri != null) onOpenHistory(entry)
                                        },
                                    )
                                }
                            }
                        }

                        Spacer(Modifier.height(8.dp))
                        HorizontalDivider(color = scheme.outlineVariant.copy(alpha = 0.7f))
                        Spacer(Modifier.height(12.dp))
                        Text(
                            text = "配对指纹 ${formatFingerprint(state.fingerprint)}",
                            style = MaterialTheme.typography.labelSmall,
                            color = scheme.onSurfaceVariant.copy(alpha = 0.6f),
                        )
                        Spacer(Modifier.height(3.dp))
                        Text(
                            text = "文件内容只在两台设备之间走，记录只存在本机。",
                            style = MaterialTheme.typography.labelSmall,
                            color = scheme.onSurfaceVariant.copy(alpha = 0.6f),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun HistoryRow(
    entry: HistoryEntry,
    peerName: String,
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val incoming = entry.direction == Direction.IN
    val done = entry.status == TransferStatus.DONE
    val clickable = entry.uri != null && incoming && done
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .then(if (clickable) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(34.dp)
                .background(
                    if (incoming) scheme.surfaceVariant else scheme.primary.copy(alpha = 0.12f),
                    CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (incoming) Icons.Rounded.ArrowDownward else Icons.Rounded.ArrowUpward,
                contentDescription = null,
                tint = if (incoming) scheme.onSurfaceVariant else scheme.primary,
                modifier = Modifier.size(17.dp),
            )
        }
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = entry.name,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "${if (incoming) "收到" else "发出"} · $peerName · ${formatHistoryTime(entry.at)}",
                style = MaterialTheme.typography.labelSmall,
                color = scheme.onSurfaceVariant.copy(alpha = 0.75f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.size(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text = formatBytes(entry.size),
                style = MaterialTheme.typography.labelSmall,
                color = scheme.onSurfaceVariant,
            )
            Text(
                text = if (done) "已完成" else "失败",
                style = MaterialTheme.typography.labelSmall,
                color = if (done) scheme.primary else scheme.error,
            )
        }
    }
}
