package app.ray.phone

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/** What RAY can do on this phone. Everything here runs only on RAY's command (or Ray's tap). */
class Actions(private val ctx: Context) {
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private val http = OkHttpClient()

    private fun granted(p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    fun openUrl(url: String): Out {
        if (!Regex("^(https?|whatsapp|tel|sms|mailto|spotify|instagram|tg|intent):", RegexOption.IGNORE_CASE).containsMatchIn(url)) return Out(false, error = "Refused to open $url")
        val i = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // Chrome reuses one tab per site when links carry the same application id.
        Uri.parse(url).host?.let { h -> if (url.startsWith("http")) i.putExtra("com.android.browser.application_id", "ray." + h.removePrefix("www.").removePrefix("m.")) }
        return try {
            ctx.startActivity(i); Out(true, "Opened $url")
        } catch (e: Exception) {
            Out(false, error = "No app can open $url")
        }
    }

    /** "spotify", "whats app", "camera" -> the installed app whose name fits best. */
    fun openApp(name: String): Out {
        val q = name.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "")
        if (q.isEmpty()) return Out(false, error = "Which app?")
        val pm = ctx.packageManager
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        val scored = apps.map { ri ->
            val label = ri.loadLabel(pm).toString()
            val l = label.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "")
            val score = when {
                l == q -> 100
                l.startsWith(q) -> 80
                l.contains(q) -> 60
                ri.activityInfo.packageName.lowercase(Locale.ROOT).contains(q) -> 50
                q.contains(l) && l.length >= 3 -> 40
                else -> 0
            }
            Triple(ri, label, score)
        }.filter { it.third > 0 }.sortedByDescending { it.third }
        val best = scored.firstOrNull() ?: return Out(false, error = "No app called \"$name\" on this phone")
        val launch = pm.getLaunchIntentForPackage(best.first.activityInfo.packageName) ?: return Out(false, error = "${best.second} can't be opened")
        ctx.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return Out(true, "Opened ${best.second}")
    }

    fun call(to: String): Out {
        val raw = to.trim()
        val number = if (raw.replace(Regex("[^0-9+]"), "").length >= 6 && Regex("^[+\\d\\s()-]+$").matches(raw)) raw.replace(Regex("[^0-9+]"), "")
        else (lookupContact(raw).data as? JSONObject)?.optString("number") ?: return Out(false, error = "No contact called \"$raw\"")
        val i = Intent(if (granted(Manifest.permission.CALL_PHONE)) Intent.ACTION_CALL else Intent.ACTION_DIAL, Uri.parse("tel:$number")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
        return Out(true, if (i.action == Intent.ACTION_CALL) "Calling $raw" else "Opened the dialer for $raw (allow Phone calls in RAY to call directly)")
    }

    private fun contacts(): List<Pair<String, String>> {
        if (!granted(Manifest.permission.READ_CONTACTS)) return emptyList()
        val out = mutableListOf<Pair<String, String>>()
        ctx.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
            null, null, null
        )?.use { c -> while (c.moveToNext() && out.size < 5000) out.add((c.getString(0) ?: "") to (c.getString(1) ?: "")) }
        return out.filter { it.first.isNotBlank() && it.second.isNotBlank() }
    }

    fun listContacts(): Out {
        if (!granted(Manifest.permission.READ_CONTACTS)) return Out(false, error = "Allow Contacts for the RAY app first")
        return Out(true, data = JSONArray(contacts().map { JSONObject().put("name", it.first).put("number", it.second.replace(Regex("[^0-9+]"), "")) }))
    }

    fun lookupContact(name: String): Out {
        val q = name.lowercase(Locale.ROOT).trim()
        val all = contacts()
        if (all.isEmpty()) return Out(false, error = "Allow Contacts for the RAY app first")
        val exact = all.filter { it.first.lowercase(Locale.ROOT) == q }
        val partial = all.filter { it.first.lowercase(Locale.ROOT).contains(q) }
        val hit = exact.firstOrNull() ?: partial.distinctBy { it.first }.singleOrNull()
            ?: return Out(false, error = if (partial.isNotEmpty()) "Several contacts match \"$name\": ${partial.map { it.first }.distinct().take(5).joinToString()}" else "No contact named \"$name\"")
        return Out(true, data = JSONObject().put("name", hit.first).put("number", hit.second.replace(Regex("[^0-9+]"), "")))
    }

    fun notify(title: String, text: String): Out {
        val n = Notification.Builder(ctx, RayApp.CH_ALERTS).setSmallIcon(R.drawable.ic_ray).setContentTitle(title).setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text)).setAutoCancel(true).build()
        ctx.getSystemService(NotificationManager::class.java).notify((System.currentTimeMillis() % 100000).toInt(), n)
        return Out(true, "Notified")
    }

    fun speak(text: String): Out {
        main.post {
            val t = tts
            if (t == null) {
                tts = TextToSpeech(ctx) { st -> if (st == TextToSpeech.SUCCESS) { tts?.language = Locale.UK; tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "ray") } }
            } else t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "ray")
        }
        return Out(true, "Speaking")
    }

    fun clipboard(text: String): Out {
        main.post { (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("RAY", text)) }
        return Out(true, "Copied to the phone's clipboard")
    }

    fun timer(seconds: Int, label: String): Out {
        val i = Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, seconds.coerceAtLeast(1)).putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .putExtra(AlarmClock.EXTRA_MESSAGE, label.ifBlank { "RAY timer" }).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try { ctx.startActivity(i); Out(true, "Timer set on the phone") } catch (e: Exception) { Out(false, error = "No clock app for timers") }
    }

    fun volume(level: Int): Out {
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        am.setStreamVolume(AudioManager.STREAM_MUSIC, (level.coerceIn(0, 100) * max / 100), 0)
        return Out(true, "Volume set to $level%")
    }

    fun wakeScreen() {
        @Suppress("DEPRECATION")
        (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "ray:wake").acquire(8000)
    }

    /** RAY rings the phone: ringtone + full-screen alert; answering opens RAY (the call screen). */
    fun ring(from: String, message: String, hub: String, askId: String): Out {
        wakeScreen()
        val url = "$hub/?answer=1${if (askId.isNotBlank()) "&ask=$askId" else ""}"
        val open = PendingIntent.getActivity(ctx, 7, Intent(Intent.ACTION_VIEW, Uri.parse(url)), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(ctx, RayApp.CH_CALLS).setSmallIcon(R.drawable.ic_ray).setContentTitle("$from is calling")
            .setContentText(message.ifBlank { "Tap to answer" }).setCategory(Notification.CATEGORY_CALL).setFullScreenIntent(open, true)
            .setContentIntent(open).setAutoCancel(true).build()
        ctx.getSystemService(NotificationManager::class.java).notify(99, n)
        main.post {
            val r = RingtoneManager.getRingtone(ctx, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            r?.play()
            main.postDelayed({ r?.stop() }, 25_000)
        }
        return Out(true, "Ringing the phone")
    }

    /** RAY's question shown over whatever app is open; the answer goes straight back to RAY. */
    fun ask(askId: String, question: String, options: JSONArray?, prefs: Prefs): Out {
        if (!Settings.canDrawOverlays(ctx)) {
            notify("RAY needs you", question)
            return Out(true, "Shown as a notification (allow 'Display over other apps' for pop-ups)")
        }
        main.post {
            val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val dp = ctx.resources.displayMetrics.density
            val card = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding((18 * dp).toInt(), (16 * dp).toInt(), (18 * dp).toInt(), (16 * dp).toInt())
                background = GradientDrawable().apply { setColor(Color.parseColor("#0A0A0B")); cornerRadius = 26 * dp }
            }
            lateinit var close: () -> Unit
            fun answer(a: String) {
                close()
                Thread {
                    try {
                        val body = JSONObject().put("roomId", prefs.room).put("askId", askId).put("answer", a).put("via", "RAY phone app")
                        http.newCall(Request.Builder().url("${prefs.hub}/api/ask/answer").header("X-Relay-Room-Token", prefs.token)
                            .post(body.toString().toRequestBody("application/json".toMediaType())).build()).execute().close()
                    } catch (_: Exception) {}
                }.start()
            }
            card.addView(Ui.eyes(ctx, 0.8f))
            card.addView(TextView(ctx).apply { text = question; setTextColor(Color.WHITE); textSize = 16f; setPadding(0, (10 * dp).toInt(), 0, (10 * dp).toInt()) })
            val row = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            for (i in 0 until (options?.length() ?: 0)) {
                val o = options!!.optString(i)
                row.addView(Ui.pill(ctx, o, dark = false) { answer(o) })
            }
            card.addView(row)
            val input = EditText(ctx).apply { hint = "Or type your answer"; setTextColor(Color.WHITE); setHintTextColor(Color.GRAY) }
            card.addView(input)
            val actionsRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
            actionsRow.addView(Ui.pill(ctx, "Later", dark = true) { close() })
            actionsRow.addView(Ui.pill(ctx, "Send", dark = false) { if (input.text.isNotBlank()) answer(input.text.toString()) })
            card.addView(actionsRow)
            val lp = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT
            ).apply { gravity = Gravity.TOP; y = (40 * dp).toInt(); horizontalMargin = 0.03f }
            close = { try { wm.removeView(card) } catch (_: Exception) {} }
            wm.addView(card, lp)
            speak(question)
        }
        return Out(true, "Asked on the phone")
    }
}
