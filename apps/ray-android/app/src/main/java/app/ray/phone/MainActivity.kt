package app.ray.phone

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** RAY phone app: pair with RAY, grant what it needs, download SmolVLM2, ask about a photo. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var root: LinearLayout
    private val main = Handler(Looper.getMainLooper())
    private var pickedImage: ByteArray? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        window.statusBarColor = Color.parseColor(Ui.PAGE)
        window.decorView.systemUiVisibility = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        handleIntent(intent)
        build()
        if (prefs.paired && prefs.enabled) BridgeService.start(this)
        refresh = { main.post { build() } }
        tick()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
        build()
    }

    override fun onResume() {
        super.onResume()
        build()
    }

    override fun onDestroy() {
        refresh = null
        super.onDestroy()
    }

    private fun tick() {
        main.postDelayed({ if (Vision.downloading) build(); tick() }, 1000)
    }

    private fun handleIntent(i: Intent?) {
        if (i == null) return
        if (i.action == Intent.ACTION_VIEW && i.data?.scheme == "ray") {
            val err = prefs.pairFrom(i.data.toString())
            if (err == null) BridgeService.start(this)
            toast = err ?: "Connected to RAY."
        }
        if (i.action == Intent.ACTION_SEND) {
            @Suppress("DEPRECATION") val uri = i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            if (uri != null) pickedImage = contentResolver.openInputStream(uri)?.use { it.readBytes() }
        }
    }

    private var toast = ""
    private var answer = ""

    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun build() {
        val scroll = ScrollView(this).apply { setBackgroundColor(Color.parseColor(Ui.PAGE)); isFillViewport = true }
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(Ui.dp(this@MainActivity, 18f), Ui.dp(this@MainActivity, 28f), Ui.dp(this@MainActivity, 18f), Ui.dp(this@MainActivity, 40f)) }
        scroll.addView(root)

        // Header: the notch + status
        root.addView(Ui.eyes(this))
        root.addView(Ui.title(this, "ray", 30f).apply { gravity = Gravity.CENTER })
        root.addView(Ui.body(this, if (!prefs.paired) "Not connected yet" else BridgeService.lastStatus).apply { gravity = Gravity.CENTER })
        if (toast.isNotBlank()) root.addView(Ui.body(this, toast).apply { gravity = Gravity.CENTER; setTextColor(Color.parseColor(Ui.BLUE)) })

        // 1. Connect
        root.addView(Ui.card(this).apply {
            addView(Ui.eyebrow(context, "Step 1"))
            addView(Ui.title(context, if (prefs.paired) "Connected to your RAY" else "Connect to your RAY"))
            if (prefs.paired) {
                addView(Ui.body(context, "Room ${prefs.room} · ${Uri.parse(prefs.hub).host}"))
                addView(Ui.pill(context, if (prefs.enabled) "Pause RAY on this phone" else "Turn RAY on", dark = !prefs.enabled) {
                    prefs.enabled = !prefs.enabled
                    if (prefs.enabled) BridgeService.start(context) else BridgeService.stop(context)
                    build()
                })
                addView(Ui.pill(context, "Connect to a different RAY", dark = false) { prefs.token = ""; BridgeService.stop(context); build() })
            } else {
                addView(Ui.body(context, "On your PC open RAY → Connections → Phone app and tap “Open in RAY app” on this phone — or copy the link and paste it here."))
                val input = EditText(context).apply { hint = "Paste the RAY link"; setSingleLine() }
                addView(input)
                addView(Ui.pill(context, "Connect") {
                    val err = prefs.pairFrom(input.text.toString())
                    toast = err ?: "Connected to RAY."
                    if (err == null) BridgeService.start(context)
                    build()
                })
            }
        })

        // 2. Permissions
        val pm = getSystemService(PowerManager::class.java)
        val listenerOn = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")?.contains(ComponentName(this, ChatListener::class.java).flattenToString()) == true
        val items = listOf(
            Triple("Notifications", Build.VERSION.SDK_INT < 33 || has(Manifest.permission.POST_NOTIFICATIONS)) { if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) },
            Triple("Show RAY over other apps", Settings.canDrawOverlays(this)) { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) },
            Triple("Read chat notifications (WhatsApp, Instagram…)", listenerOn) { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) },
            Triple("Calls and contacts", has(Manifest.permission.CALL_PHONE) && has(Manifest.permission.READ_CONTACTS)) { requestPermissions(arrayOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_CONTACTS), 2) },
            Triple("Keep running (battery: unrestricted)", pm.isIgnoringBatteryOptimizations(packageName)) {
                @Suppress("BatteryLife") startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            },
        )
        root.addView(Ui.card(this).apply {
            addView(Ui.eyebrow(context, "Step 2"))
            addView(Ui.title(context, "Let RAY help on this phone"))
            addView(Ui.body(context, "Nothing is sent or done without your command. On Xiaomi/Redmi phones also turn on Autostart for RAY."))
            for ((label, ok, ask) in items) {
                val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, Ui.dp(context, 8f), 0, 0) }
                row.addView(TextView(context).apply { text = if (ok) "✓" else "•"; setTextColor(Color.parseColor(if (ok) "#16A34A" else Ui.MUTE)); textSize = 16f; setPadding(0, 0, Ui.dp(context, 10f), 0) })
                row.addView(TextView(context).apply { text = label; setTextColor(Color.parseColor(Ui.INK)); textSize = 14f; layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) })
                if (!ok) row.addView(Ui.pill(context, "Allow", dark = false) { ask() })
                addView(row)
            }
        })

        // 3. SmolVLM2 on the phone
        root.addView(Ui.card(this).apply {
            addView(Ui.eyebrow(context, "Offline"))
            addView(Ui.title(context, "Photos, answered on the phone"))
            addView(Ui.body(context, "SmolVLM2 (${Vision.SIZE_MB} MB, free) reads photos and screenshots with no internet. Download it once on Wi-Fi."))
            when {
                Vision.ready(context) -> {
                    addView(Ui.pill(context, if (pickedImage == null) "Choose a photo" else "Change photo", dark = false) {
                        startActivityForResult(Intent(Intent.ACTION_GET_CONTENT).setType("image/*"), 9)
                    })
                    if (pickedImage != null) {
                        val q = EditText(context).apply { hint = "Ask about the photo"; setText("What does this show?") }
                        addView(q)
                        addView(Ui.pill(context, "Ask") {
                            answer = "Thinking on the phone…"; build()
                            val img = pickedImage!!
                            Thread {
                                answer = try { Vision.ask(context, img, q.text.toString()) } catch (e: Exception) { "Couldn't answer: ${e.message}" }
                                main.post { build() }
                            }.start()
                        })
                    }
                    if (answer.isNotBlank()) addView(TextView(context).apply { text = answer; setTextColor(Color.parseColor(Ui.INK)); textSize = 15f; setPadding(0, Ui.dp(context, 10f), 0, 0) })
                }
                Vision.downloading -> addView(Ui.body(context, "Downloading… ${(Vision.progress * 100).toInt()}%"))
                else -> {
                    if (Vision.lastError.isNotBlank()) addView(Ui.body(context, "Last try: ${Vision.lastError}").apply { setTextColor(Color.parseColor("#DC2626")) })
                    addView(Ui.pill(context, "Download SmolVLM2 (${Vision.SIZE_MB} MB)") { Thread { Vision.download(context); main.post { build() } }.start(); build() })
                }
            }
        })
        setContentView(scroll)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 9 && resultCode == RESULT_OK) {
            data?.data?.let { uri -> pickedImage = contentResolver.openInputStream(uri)?.use { it.readBytes() } }
            answer = ""
            build()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        build()
    }

    companion object {
        @Volatile var refresh: (() -> Unit)? = null
    }
}
