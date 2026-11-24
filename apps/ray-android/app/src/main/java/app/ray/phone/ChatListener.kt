package app.ray.phone

import android.app.Notification
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * Relays new chat notifications (WhatsApp, Instagram, Messenger, Telegram, SMS…) to RAY so it can brief
 * Ray and reply on his command. Reads only what the notification already shows; Ray turns it on in
 * Android settings (Notification access → RAY).
 */
class ChatListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val app = APPS[sbn.packageName] ?: return
        val ex = sbn.notification.extras
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val from = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return
        val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: return
        val key = "$app|$from|$text"
        synchronized(lock) {
            if (!seen.add(key)) return
            if (seen.size > 500) seen.clear()
            val item = JSONObject().put("app", app).put("from", from).put("text", text.take(1500)).put("receivedAt", System.currentTimeMillis())
            queue.add(item)
            recent.add(item)
            while (recent.size > 50) recent.removeAt(0)
        }
    }

    companion object {
        private val lock = Any()
        private val seen = LinkedHashSet<String>()
        private val queue = mutableListOf<JSONObject>()
        private val recent = mutableListOf<JSONObject>()
        val APPS = mapOf(
            "com.whatsapp" to "whatsapp", "com.whatsapp.w4b" to "whatsapp", "com.instagram.android" to "instagram",
            "com.facebook.orca" to "messenger", "org.telegram.messenger" to "telegram", "com.google.android.apps.messaging" to "sms",
            "com.samsung.android.messaging" to "sms", "com.instagram.barcelona" to "threads", "com.android.mms" to "sms",
        )

        fun drain(): JSONArray = synchronized(lock) { JSONArray(queue.toList()).also { queue.clear() } }
        fun recent(): JSONArray = synchronized(lock) { JSONArray(recent.toList()) }
    }
}

/** Starts the bridge after a reboot or app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs(context).paired && Prefs(context).enabled) BridgeService.start(context)
    }
}
