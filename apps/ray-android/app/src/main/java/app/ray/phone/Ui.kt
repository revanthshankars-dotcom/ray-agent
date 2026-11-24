package app.ray.phone

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Small Nixi-style building blocks: the notch with eyes, pill buttons, white cards. */
object Ui {
    const val INK = "#0A0A0B"
    const val PAGE = "#F4F5F7"
    const val BLUE = "#2563EB"
    const val MUTE = "#6B7280"

    fun dp(ctx: Context, v: Float) = (v * ctx.resources.displayMetrics.density).toInt()

    /** The black notch with two blinking eyes. */
    fun eyes(ctx: Context, scale: Float = 1f): View {
        val pill = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            background = GradientDrawable().apply { setColor(Color.parseColor(INK)); cornerRadius = dp(ctx, 40f * scale).toFloat() }
            layoutParams = LinearLayout.LayoutParams(dp(ctx, 120f * scale), dp(ctx, 56f * scale)).apply { gravity = Gravity.CENTER_HORIZONTAL }
        }
        repeat(2) { i ->
            val eye = View(ctx).apply {
                background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(ctx, 8f * scale).toFloat() }
                layoutParams = LinearLayout.LayoutParams(dp(ctx, 12f * scale), dp(ctx, 24f * scale)).apply { marginStart = if (i == 1) dp(ctx, 16f * scale) else 0 }
            }
            ObjectAnimator.ofFloat(eye, "scaleY", 1f, 1f, 0.1f, 1f).apply {
                duration = 5200; repeatCount = ValueAnimator.INFINITE; startDelay = 800
                setCurrentFraction(0f)
            }.start()
            pill.addView(eye)
        }
        return pill
    }

    fun pill(ctx: Context, label: String, dark: Boolean = true, onClick: () -> Unit): Button = Button(ctx).apply {
        text = label
        isAllCaps = false
        textSize = 14f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(if (dark) Color.WHITE else Color.parseColor(INK))
        background = GradientDrawable().apply {
            setColor(Color.parseColor(if (dark) INK else "#FFFFFF"))
            cornerRadius = dp(ctx, 999f).toFloat()
            if (!dark) setStroke(dp(ctx, 1f), Color.parseColor("#E2E5EA"))
        }
        setPadding(dp(ctx, 18f), 0, dp(ctx, 18f), 0)
        minHeight = dp(ctx, 42f)
        minimumHeight = dp(ctx, 42f)
        stateListAnimator = null
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, dp(ctx, 6f), dp(ctx, 8f), 0) }
        setOnClickListener { onClick() }
    }

    fun card(ctx: Context): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(ctx, 18f), dp(ctx, 16f), dp(ctx, 18f), dp(ctx, 16f))
        background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(ctx, 22f).toFloat(); setStroke(dp(ctx, 1f), Color.parseColor("#E2E5EA")) }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, dp(ctx, 14f), 0, 0) }
    }

    fun eyebrow(ctx: Context, s: String) = TextView(ctx).apply {
        text = s.uppercase(); setTextColor(Color.parseColor(BLUE)); textSize = 11f; letterSpacing = 0.14f; typeface = Typeface.DEFAULT_BOLD
    }

    fun title(ctx: Context, s: String, size: Float = 20f) = TextView(ctx).apply {
        text = s; setTextColor(Color.parseColor(INK)); textSize = size; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); letterSpacing = -0.02f
        setPadding(0, dp(ctx, 4f), 0, dp(ctx, 2f))
    }

    fun body(ctx: Context, s: String) = TextView(ctx).apply { text = s; setTextColor(Color.parseColor(MUTE)); textSize = 14f; setLineSpacing(0f, 1.15f) }
}
