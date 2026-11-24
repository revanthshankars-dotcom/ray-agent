package app.ray.phone

import android.content.Context
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * SmolVLM2 500M on the phone (Google LiteRT-LM, CPU): answers questions about photos and screenshots
 * fully offline. The 363 MB model is downloaded once from Hugging Face when Ray taps Download.
 */
object Vision {
    private const val URL = "https://huggingface.co/litert-community/SmolVLM2-500M/resolve/main/SmolVLM2-500M.litertlm"
    private const val SHA256 = "7b432bbc0a5c54ba15ecb2f039a7711c1cfb1fe38badec01397a076b5043f74e"
    const val SIZE_MB = 363

    @Volatile var progress = 0f
    @Volatile var downloading = false
    @Volatile var lastError = ""
    private var engine: Engine? = null
    private val lock = Any()

    private fun file(ctx: Context) = File(ctx.filesDir, "SmolVLM2-500M.litertlm")
    fun ready(ctx: Context) = file(ctx).exists() && file(ctx).length() > 300_000_000L

    /** Downloads (resumes if interrupted) and checks the file's SHA-256. Blocking; call off the main thread. */
    fun download(ctx: Context): Boolean {
        if (ready(ctx)) return true
        downloading = true
        lastError = ""
        try {
            val part = File(ctx.filesDir, "SmolVLM2-500M.litertlm.part")
            val have = if (part.exists()) part.length() else 0L
            val http = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
            val req = Request.Builder().url(URL).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
            http.newCall(req).execute().use { r ->
                if (!r.isSuccessful) throw Exception("download failed (${r.code})")
                val append = r.code == 206
                val total = (r.body!!.contentLength().takeIf { it > 0 } ?: 363_085_824L) + (if (append) have else 0L)
                var got = if (append) have else 0L
                java.io.FileOutputStream(part, append).use { out ->
                    r.body!!.byteStream().use { input ->
                        val buf = ByteArray(1 shl 16)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            got += n
                            progress = got.toFloat() / total
                        }
                    }
                }
            }
            val md = MessageDigest.getInstance("SHA-256")
            part.inputStream().use { s -> val b = ByteArray(1 shl 16); while (true) { val n = s.read(b); if (n < 0) break; md.update(b, 0, n) } }
            val sum = md.digest().joinToString("") { "%02x".format(it) }
            if (sum != SHA256) { part.delete(); throw Exception("the download was damaged — try again") }
            part.renameTo(file(ctx))
            return true
        } catch (e: Exception) {
            lastError = e.message ?: e.toString()
            return false
        } finally {
            downloading = false
        }
    }

    private fun engine(ctx: Context): Engine = synchronized(lock) {
        engine ?: Engine(
            EngineConfig(
                modelPath = file(ctx).absolutePath,
                backend = Backend.CPU(),
                visionBackend = Backend.CPU(),
                maxNumTokens = 2048,
                maxNumImages = 1,
                cacheDir = ctx.cacheDir.absolutePath,
            )
        ).also { it.initialize(); engine = it }
    }

    /** Ask about an image (JPEG/PNG bytes). Blocking; call off the main thread. */
    fun ask(ctx: Context, image: ByteArray, question: String): String {
        if (!ready(ctx)) throw IllegalStateException("SmolVLM2 isn't downloaded yet (RAY app → Download).")
        val conv = engine(ctx).createConversation(ConversationConfig(samplerConfig = SamplerConfig(topK = 1, topP = 1.0, temperature = 0.0)))
        try {
            val reply = conv.sendMessage(Contents.of(Content.ImageBytes(image), Content.Text(question.ifBlank { "Describe this picture." })))
            return reply.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }.trim()
        } finally {
            conv.close()
        }
    }

    /** RAY server → phone: local_ai {op: status | install | vision (image base64 + question)}. */
    fun action(ctx: Context, a: JSONObject): Out = when (a.optString("op", "status")) {
        "install" -> {
            Thread { download(ctx) }.start()
            Out(true, data = status(ctx).put("status", "installing"))
        }
        "vision" -> try {
            val bytes = android.util.Base64.decode(a.optString("image"), android.util.Base64.DEFAULT)
            Out(true, data = JSONObject().put("answer", ask(ctx, bytes, a.optString("question"))).put("model", "SmolVLM2 500M (phone)"))
        } catch (e: Exception) {
            Out(false, error = e.message)
        }
        else -> Out(true, data = status(ctx))
    }

    fun status(ctx: Context): JSONObject = JSONObject()
        .put("status", if (downloading) "installing" else if (ready(ctx)) "installed" else "not-installed")
        .put("progress", progress.toDouble()).put("error", lastError)
        .put("models", org.json.JSONArray().put(JSONObject().put("kind", "vision").put("label", "SmolVLM2 500M — photos (on the phone)").put("mb", SIZE_MB).put("ready", ready(ctx))))
}
