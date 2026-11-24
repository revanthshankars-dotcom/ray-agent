package app.ray.phone

import android.annotation.SuppressLint
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.Settings

class RayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "RAY is running", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_ALERTS, "RAY messages", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_CALLS, "RAY calling", NotificationManager.IMPORTANCE_HIGH))
    }

    companion object {
        const val CH_STATUS = "ray_status"
        const val CH_ALERTS = "ray_alerts"
        const val CH_CALLS = "ray_calls"
    }
}

/** Where this phone connects: RAY's server, room and room token (set by pairing). */
class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("ray", Context.MODE_PRIVATE)
    var hub: String get() = p.getString("hub", "") ?: ""; set(v) = p.edit().putString("hub", v.trimEnd('/')).apply()
    var room: String get() = p.getString("room", "") ?: ""; set(v) = p.edit().putString("room", v).apply()
    var token: String get() = p.getString("token", "") ?: ""; set(v) = p.edit().putString("token", v).apply()
    var enabled: Boolean get() = p.getBoolean("enabled", true); set(v) = p.edit().putBoolean("enabled", v).apply()
    val paired get() = hub.isNotBlank() && room.isNotBlank() && token.isNotBlank()

    @SuppressLint("HardwareIds")
    fun deviceId(ctx: Context): String = "android-" + (Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "phone").take(12)

    val deviceName: String get() = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL} (RAY App)"

    /**
     * Accepts ray://pair?hub=&room=&token=  or RAY's own join link  https://host/?room=…&token=…
     * Returns null when the link is fine, otherwise what is wrong.
     */
    fun pairFrom(link: String): String? {
        val u = try { Uri.parse(link.trim()) } catch (e: Exception) { return "That isn't a link." }
        val room = u.getQueryParameter("room") ?: return "The link has no room in it."
        val token = u.getQueryParameter("token") ?: return "The link has no room token in it."
        val hub = if (u.scheme == "ray") u.getQueryParameter("hub") ?: return "The link has no server in it." else "${u.scheme}://${u.authority}"
        if (!hub.startsWith("http")) return "The server address must start with https://"
        this.hub = hub; this.room = room.uppercase(); this.token = token; enabled = true
        return null
    }
}
