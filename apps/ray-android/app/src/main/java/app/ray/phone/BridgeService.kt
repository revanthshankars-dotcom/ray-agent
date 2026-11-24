package app.ray.phone

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The phone bridge (replaces Termux): stays connected to RAY in the background, runs RAY's commands on
 * this phone (open apps & links, calls, contacts, notifications, speech, timers, questions over any
 * app), relays chat notifications, and answers photo questions on the phone with SmolVLM2.
 */
class BridgeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private var ws: WebSocket? = null
    private var attempt = 0
    private var wake: PowerManager.WakeLock? = null
    private lateinit var prefs: Prefs
    private lateinit var actions: Actions

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        actions = Actions(this)
        instance = this
        startForegroundCompat("Connecting to RAY…")
        wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ray:bridge").apply { setReferenceCounted(false) }
        connect()
        scope.launch { relayLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (ws == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        ws?.close(1000, "stopped")
        super.onDestroy()
    }

    private fun startForegroundCompat(text: String) {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, RayApp.CH_STATUS)
            .setSmallIcon(R.drawable.ic_ray)
            .setContentTitle("RAY")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(1, n)
    }

    private fun status(text: String) {
        lastStatus = text
        startForegroundCompat(text)
        MainActivity.refresh?.invoke()
    }

    // ---------------------------------------------------------------- connection ---------------------
    private fun connect() {
        if (!prefs.paired || !prefs.enabled) return status("Not paired — open RAY to connect")
        val url = prefs.hub.replaceFirst("http", "ws") + "/ws?room=${enc(prefs.room)}&token=${enc(prefs.token)}"
        ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                connected = true
                status("Connected · RAY can use this phone")
                send(webSocket, "device:register", JSONObject()
                    .put("id", prefs.deviceId(this@BridgeService))
                    .put("name", prefs.deviceName)
                    .put("type", "bridge")
                    .put("os", "Android ${Build.VERSION.RELEASE} (RAY App)")
                    .put("browser", "RAY App 1.0")
                    .put("capabilities", JSONArray(CAPABILITIES))
                    .put("telemetry", telemetry()))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handle(webSocket, text) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry()
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry()
        })
    }

    private fun retry() {
        connected = false
        ws = null
        status("Reconnecting to RAY…")
        scope.launch {
            delay(minOf(30_000L, 2000L shl minOf(attempt++, 4)))
            connect()
        }
    }

    private fun send(socket: WebSocket?, event: String, data: JSONObject) {
        (socket ?: ws)?.send(JSONObject().put("event", event).put("data", data).toString())
    }

    // ---------------------------------------------------------------- commands -----------------------
    private suspend fun handle(socket: WebSocket, text: String) {
        val msg = try { JSONObject(text) } catch (e: Exception) { return }
        val data = msg.optJSONObject("data") ?: JSONObject()
        when (msg.optString("event")) {
            "bridge:proxy_request" -> {
                val requestId = data.optString("requestId")
                val out = runAction(data.optString("action"), data)
                send(socket, "bridge:proxy_response", JSONObject().put("requestId", requestId).put("ok", out.ok).put("data", out.data ?: JSONObject.NULL).put("error", out.error ?: JSONObject.NULL))
            }
            "command:execute" -> {
                val out = runCommand(data)
                send(socket, "command:ack", JSONObject().put("commandId", data.optString("id")).put("deviceId", prefs.deviceId(this)).put("status", if (out.ok) "completed" else "failed").put("message", out.message()))
            }
        }
    }

    private suspend fun runCommand(cmd: JSONObject): Out {
        val p = cmd.optJSONObject("payload") ?: JSONObject()
        return when (cmd.optString("type")) {
            "open_url" -> actions.openUrl(p.optString("url"))
            "notify" -> actions.notify(p.optString("title", "RAY"), p.optString("message", p.optString("body")))
            "speak" -> actions.speak(p.optString("text"))
            "clipboard" -> actions.clipboard(p.optString("content"))
            "set_timer" -> actions.timer(p.optInt("durationSeconds", p.optInt("seconds", 60)), p.optString("label"))
            "call" -> actions.ring(p.optString("fromName", "RAY"), p.optString("message"), prefs.hub, p.optString("askId"))
            "ask" -> actions.ask(p.optString("askId"), p.optString("question"), p.optJSONArray("options"), prefs)
            "wake" -> { actions.wakeScreen(); Out(true, "Screen woken") }
            "refresh_telemetry" -> { send(null, "device:telemetry", JSONObject().put("id", prefs.deviceId(this)).put("telemetry", telemetry())); Out(true, "Updated") }
            "bridge_command" -> runAction(p.optString("action"), p)
            else -> Out(false, error = "The RAY app can't run ${cmd.optString("type")} yet")
        }
    }

    private suspend fun runAction(action: String, a: JSONObject): Out = when (action) {
        "open_app", "open_application" -> actions.openApp(a.optString("target", a.optString("application", a.optString("app_name"))))
        "open_url" -> actions.openUrl(a.optString("url"))
        "place_call" -> actions.call(a.optString("to"))
        "lookup_contact" -> actions.lookupContact(a.optString("name"))
        "list_contacts" -> actions.listContacts()
        "notify" -> actions.notify(a.optString("title", "RAY"), a.optString("message"))
        "speak" -> actions.speak(a.optString("text"))
        "clipboard_set" -> actions.clipboard(a.optString("content", a.optString("text")))
        "battery", "system_info" -> Out(true, data = telemetry())
        "adjust_volume" -> actions.volume(a.optInt("level", 50))
        "read_notifications" -> Out(true, data = JSONObject().put("items", ChatListener.recent()))
        "local_ai" -> Vision.action(this, a)
        "ask" -> actions.ask(a.optString("askId"), a.optString("question"), a.optJSONArray("options"), prefs)
        else -> Out(false, error = "The RAY app doesn't support $action yet")
    }

    // ---------------------------------------------------------------- chat relay + telemetry ---------
    private suspend fun relayLoop() {
        while (true) {
            delay(8000)
            val items = ChatListener.drain()
            if (items.length() > 0 && connected) send(null, "messages:incoming", JSONObject().put("items", items))
        }
    }

    private fun telemetry(): JSONObject {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return JSONObject()
            .put("batteryLevel", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            .put("charging", bm.isCharging)
            .put("platform", "android")
            .put("appVersion", "1.0")
            .put("localVision", Vision.ready(this))
    }

    companion object {
        @Volatile var instance: BridgeService? = null
        @Volatile var connected = false
        @Volatile var lastStatus = "Not started"
        val CAPABILITIES = listOf("notify", "speak", "clipboard", "open_url", "timers", "apps", "calls", "contacts", "notifications-relay", "ask", "popup", "local-vision", "chat-compose")
        fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

        fun start(ctx: Context) {
            val i = Intent(ctx, BridgeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, BridgeService::class.java))
    }
}

/** Result of a command or action. */
data class Out(val ok: Boolean, val text: String? = null, val data: Any? = null, val error: String? = null) {
    fun message(): String = error ?: text ?: (data?.toString()?.take(2000) ?: if (ok) "Done" else "Failed")
}
