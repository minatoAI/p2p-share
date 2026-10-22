package dev.p2pshare.app.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.LightMode
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.QrCode2
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.p2pshare.app.core.PLATFORM_WEB
import dev.p2pshare.app.core.TransferStatus
import dev.p2pshare.app.data.ContactRecord
import dev.p2pshare.app.session.AppState

@Composable
fun HomeScreen(
    state: AppState,
    darkTheme: Boolean,
    onToggleTheme: (Offset) -> Unit,
    onMenu: () -> Unit,
    onReceive: () -> Unit,
    onShare: () -> Unit,
    onOpenPeer: (String) -> Unit,
    onForget: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    // 固定顺序：在线原生、在线网页、离线原生、离线网页；组内按最近见到的时间倒序
    val groups = remember(state.contacts, state.presence) {
        ContactGroup.entries.mapNotNull { group ->
            val items = state.contacts
                .filter { it.group(state.presence) == group }
                .sortedByDescending { it.lastSeenAt ?: it.pairedAt }
            if (items.isEmpty()) null else group to items
        }
    }
    val contactCount = groups.sumOf { it.second.size }
    val activeTransfers = remember(state.transfers) {
        state.transfers.filter {
            it.status == TransferStatus.PENDING || it.status == TransferStatus.ACTIVE
        }
    }
    // 只用布局回调记位置，不放进 state：滚动时每帧写 state 会白白重组整页
    val themeButtonCenter = remember { arrayOf(Offset.Zero) }
    var pendingDelete by remember { mutableStateOf<ContactRecord?>(null) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(scheme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 22.dp),
    ) {
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrandMark()
            Spacer(Modifier.size(10.dp))
            Text(
                text = "在线互传",
                style = MaterialTheme.typography.titleMedium,
                color = scheme.onBackground,
            )
            Spacer(Modifier.weight(1f))
            Surface(
                modifier = Modifier.onGloballyPositioned {
                    themeButtonCenter[0] = it.boundsInRoot().center
                },
                shape = CircleShape,
                color = scheme.surfaceVariant.copy(alpha = 0.6f),
            ) {
                IconButton(
                    onClick = { onToggleTheme(themeButtonCenter[0]) },
                    modifier = Modifier.size(42.dp),
                ) {
                    Icon(
                        imageVector = if (darkTheme) Icons.Rounded.LightMode else Icons.Rounded.DarkMode,
                        contentDescription = if (darkTheme) "切换到浅色" else "切换到深色",
                        tint = scheme.onSurfaceVariant,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Spacer(Modifier.size(8.dp))
            Surface(
                shape = CircleShape,
                color = scheme.surfaceVariant.copy(alpha = 0.6f),
            ) {
                IconButton(onClick = onMenu, modifier = Modifier.size(42.dp)) {
                    Icon(
                        imageVector = Icons.Rounded.Menu,
                        contentDescription = "菜单与传输记录",
                        tint = scheme.onSurfaceVariant,
                        modifier = Modifier.size(21.dp),
                    )
                }
            }
        }

        Spacer(Modifier.height(24.dp))
        SignalPill(state = state.signal)
        Spacer(Modifier.height(10.dp))
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Eyebrow("点对点 · 不经服务器")
            Text(
                text = "需要双方同时在线",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                letterSpacing = 1.2.sp,
                color = scheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(42.dp))
        Text(
            text = "请选择您的使用方式",
            style = MaterialTheme.typography.headlineLarge,
            color = scheme.onBackground,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(22.dp))
        ActionCard(
            title = "双方先匹配再发文件",
            caption = "配好之后直接传。",
            icon = Icons.Rounded.QrCode2,
            emphasized = true,
            onClick = onReceive,
        )
        Spacer(Modifier.height(10.dp))
        ActionCard(
            title = "直接生成一条链接",
            caption = "把链接发给对方，打开就能取。",
            icon = Icons.Rounded.Link,
            emphasized = false,
            onClick = onShare,
        )

        if (activeTransfers.isNotEmpty()) {
            Spacer(Modifier.height(18.dp))
            ActiveTransferBanner(
                state = state,
                transfers = activeTransfers,
                onOpenPeer = onOpenPeer,
            )
        }

        Spacer(Modifier.height(36.dp))
        SectionHeader(
            title = "已配对的设备",
            trailing = if (contactCount == 0) null else "$contactCount 台",
        )
        Spacer(Modifier.height(12.dp))
        if (groups.isEmpty()) {
            EmptyContacts()
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                groups.forEach { (group, items) ->
                    ContactGroupHeader(group)
                    items.forEach { contact ->
                        ContactRow(
                            contact = contact,
                            online = state.presence[contact.peerId] == true,
                            name = state.displayName(contact.peerId),
                            onClick = { onOpenPeer(contact.peerId) },
                            onLongPress = { pendingDelete = contact },
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(30.dp))
        Text(
            text = "版本 ${rememberAppVersion()}",
            style = MaterialTheme.typography.labelMedium,
            color = scheme.onSurfaceVariant.copy(alpha = 0.6f),
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(22.dp))
    }

    pendingDelete?.let { contact ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除「${state.displayName(contact.peerId)}」？") },
            text = { Text("删除后下次要重新配对。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingDelete = null
                        onForget(contact.peerId)
                    },
                ) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun ActionCard(
    title: String,
    caption: String,
    icon: ImageVector,
    emphasized: Boolean,
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.975f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.7f),
        label = "action-press",
    )

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .scale(scale)
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                onClick = onClick,
            ),
        shape = MaterialTheme.shapes.large,
        color = if (emphasized) scheme.primaryContainer else scheme.surface,
        border = BorderStroke(
            1.dp,
            if (emphasized) scheme.primary.copy(alpha = 0.18f) else scheme.outlineVariant,
        ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .background(
                        if (emphasized) scheme.primary.copy(alpha = 0.16f)
                        else scheme.surfaceVariant,
                        RoundedCornerShape(16.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = if (emphasized) scheme.primary else scheme.onSurfaceVariant,
                    modifier = Modifier.size(22.dp),
                )
            }
            Spacer(Modifier.size(14.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleLarge,
                    color = if (emphasized) scheme.onPrimaryContainer else scheme.onSurface,
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    text = caption,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (emphasized) scheme.onPrimaryContainer.copy(alpha = 0.7f)
                    else scheme.onSurfaceVariant,
                )
            }
            Icon(
                imageVector = Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = if (emphasized) scheme.primary.copy(alpha = 0.55f)
                else scheme.onSurfaceVariant.copy(alpha = 0.5f),
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

/** 首页联系人分四组，顺序就是 enum 的声明顺序 */
private enum class ContactGroup(val label: String) {
    ONLINE_NATIVE("在线 · 电脑/安卓"),
    ONLINE_WEB("在线 · 网页端"),
    OFFLINE_NATIVE("离线 · 电脑/安卓"),
    OFFLINE_WEB("离线 · 网页端"),
}

/** 没有平台标记的旧记录按电脑端处理，不参与网页端的过期清理 */
private fun ContactRecord.group(presence: Map<String, Boolean>): ContactGroup {
    val online = presence[peerId] == true
    return when {
        online && peerPlatform == PLATFORM_WEB -> ContactGroup.ONLINE_WEB
        online -> ContactGroup.ONLINE_NATIVE
        peerPlatform == PLATFORM_WEB -> ContactGroup.OFFLINE_WEB
        else -> ContactGroup.OFFLINE_NATIVE
    }
}

@Composable
private fun ContactGroupHeader(group: ContactGroup) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.padding(start = 4.dp, top = 4.dp)) {
        Text(
            text = group.label,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
            color = scheme.onSurfaceVariant,
        )
        if (group == ContactGroup.OFFLINE_WEB) {
            Text(
                text = "网页端离线 10 分钟后自动清理",
                style = MaterialTheme.typography.labelSmall,
                color = scheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ContactRow(
    contact: ContactRecord,
    online: Boolean,
    name: String,
    onClick: () -> Unit,
    onLongPress: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.985f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = 0.75f),
        label = "contact-press",
    )
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .scale(scale)
            .combinedClickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                onClick = onClick,
                onLongClick = onLongPress,
            ),
        shape = RoundedCornerShape(22.dp),
        color = scheme.surface,
        border = BorderStroke(1.dp, scheme.outlineVariant),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 15.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
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
                    PlatformBadge(contact.peerPlatform, compact = true)
                }
                Spacer(Modifier.height(2.dp))
                Text(
                    text = buildString {
                        append(if (online) "在线" else "离线")
                        // 网页端的配对是一次性的，最容易堆成一条条「离线」；
                        // 在这里直接告诉用户能长按清掉，不用先点进会话再找入口
                        if (contact.peerPlatform == PLATFORM_WEB) append(" · 长按可以删除")
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = if (online) scheme.primary else scheme.onSurfaceVariant.copy(alpha = 0.7f),
                )
            }
            Icon(
                imageVector = Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = scheme.onSurfaceVariant.copy(alpha = 0.45f),
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun EmptyContacts() {
    val scheme = MaterialTheme.colorScheme
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .drawBehind {
                val inset = 0.5.dp.toPx()
                drawRoundRect(
                    color = scheme.outline,
                    topLeft = Offset(inset, inset),
                    size = androidx.compose.ui.geometry.Size(
                        size.width - inset * 2,
                        size.height - inset * 2,
                    ),
                    cornerRadius = CornerRadius(24.dp.toPx()),
                    style = Stroke(
                        width = 1.dp.toPx(),
                        pathEffect = PathEffect.dashPathEffect(
                            floatArrayOf(6.dp.toPx(), 6.dp.toPx()),
                        ),
                    ),
                )
            }
            .padding(horizontal = 18.dp, vertical = 18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .background(scheme.surfaceVariant, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Rounded.Lock,
                    contentDescription = null,
                    tint = scheme.onSurfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier.size(18.dp),
                )
            }
            Spacer(Modifier.size(13.dp))
            Column {
                Text(
                    text = "还没有配对的设备",
                    style = MaterialTheme.typography.titleMedium,
                    color = scheme.onSurface,
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    text = "第一次互传时输入对方的六位码，之后就会出现在这里。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = scheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ActiveTransferBanner(
    state: AppState,
    transfers: List<dev.p2pshare.app.session.TransferItem>,
    onOpenPeer: (String) -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val peerId = transfers.first().peerId
    val totalSize = transfers.sumOf { it.size.coerceAtLeast(0) }
    val totalDone = transfers.sumOf { it.transferred.coerceAtLeast(0) }
    val fraction = if (totalSize > 0) (totalDone.toFloat() / totalSize).coerceIn(0f, 1f) else 0f
    val interaction = remember { MutableInteractionSource() }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize()
            .clickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                onClick = { onOpenPeer(peerId) },
            ),
        shape = RoundedCornerShape(20.dp),
        color = scheme.primary.copy(alpha = 0.08f),
        border = BorderStroke(1.dp, scheme.primary.copy(alpha = 0.16f)),
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                PulseDot(color = scheme.primary, pulsing = true)
                Spacer(Modifier.size(9.dp))
                Text(
                    text = "正在与 ${state.displayName(peerId)} 传输 ${transfers.size} 个文件",
                    style = MaterialTheme.typography.labelLarge,
                    color = scheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "${(fraction * 100).toInt()}%",
                    style = MaterialTheme.typography.labelMedium,
                    color = scheme.primary,
                )
            }
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(4.dp)
                    .clip(CircleShape),
                color = scheme.primary,
                trackColor = scheme.primary.copy(alpha = 0.15f),
            )
        }
    }
}
