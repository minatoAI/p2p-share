package dev.p2pshare.app.ui

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import dev.p2pshare.app.session.AppState
import dev.p2pshare.app.session.P2PSession
import kotlinx.coroutines.flow.StateFlow

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val session = P2PSession(application)
    val state: StateFlow<AppState> = session.state

    init {
        session.start()
    }

    override fun onCleared() {
        session.close()
        super.onCleared()
    }

    fun receive() = session.startAdvertising()
    fun closeReceive() = session.stopAdvertising()
    fun refreshCode() = session.refreshCode()

    fun join(code: String) = session.joinWithCode(code)
    fun cancelJoin() = session.cancelJoin()

    fun confirmPairing(accept: Boolean) = session.confirmPairing(accept)
    fun dismissPairing() = session.dismissPairing()

    fun connect(peerId: String) = session.connect(peerId)
    fun retry(peerId: String) = session.connect(peerId)
    fun cancelReconnect(peerId: String) = session.cancelReconnect(peerId)
    /** 前后台切换：后台时连接失败先不弹，回前台静默恢复 */
    fun setForeground(foreground: Boolean) = session.setForeground(foreground)
    fun pruneContacts() = session.pruneContacts()
    fun background(peerId: String) = session.background(peerId)
    fun disconnect(peerId: String) = session.disconnect(peerId)
    fun forget(peerId: String) = session.forget(peerId)

    fun sendFiles(peerId: String, uris: List<Uri>) = session.sendFiles(peerId, uris)
    fun sendText(peerId: String, text: String) = session.sendText(peerId, text)
    fun retryText(peerId: String, id: String) = session.retryText(peerId, id)

    fun createShare(uri: Uri) = session.createShare(uri)
    fun shareFiles(uris: List<Uri>) = session.shareSharedFiles(uris)
    fun revokeShare(token: String) = session.revokeShare(token)
    fun visitShare(input: String) = session.visitShare(input)
    fun leaveShare() = session.leaveShare()

    fun setDeviceName(name: String) = session.setDeviceName(name)
    fun clearError(id: Long) = session.clearError(id)
}
