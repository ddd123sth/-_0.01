package online.ainiannian.garden;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.system.Os;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.net.*;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private android.widget.FrameLayout root;
    // 全窗分工：原生根层、原生兜底背景、WebView 三者都铺满整窗，谁也不对谁加系统栏缩进。
    // 状态栏/挖孔/键盘的遮挡只作为一份数据交给网页的安全交互层，由它扣一次。
    // 旧实现在这里给 webLayer 加四边 padding，把整个 WebView 往下压，业务页又隐藏原生背景，
    // 于是状态栏后面是一条原生色带、下面才是网页内容 —— 那就是"顶部不到顶"的直接来源。
    private android.widget.ImageView backdrop;
    private android.widget.FrameLayout webLayer;
    private volatile WebView web;
    private volatile WebView stopSurfaceWebView;
    private volatile String stopSurfaceOrigin = "";
    private TextView message;
    private android.widget.FrameLayout opening;
    private android.widget.ImageView openingBackground;
    private android.widget.ImageView openingLogo;
    private TextView openingMotto;
    private android.animation.ObjectAnimator pulse;
    private boolean entered;
    private boolean openingRisen;
    private boolean panelReady;
    private boolean keyboardVisible;
    private boolean imeVisible;
    private boolean imeRetryPending;
    private int imeEmptyRetries;
    private int barsLeftPx, barsTopPx, barsRightPx, barsBottomPx;
    private int imeBottomPx;
    /* 每次窗口度量变化都加一；网页据此丢弃旧代次的回调，避免迟到的 JS 把新场景挪回去。 */
    private int layoutGeneration;
    private String pageMode = "loading";
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean destroyed;
    private volatile boolean connecting;
    private volatile boolean activityResumed;
    private volatile boolean autoFollowProbeInFlight;
    private volatile long nextAutoFollowAttemptElapsedMs;
    private volatile int enginePid = -1;
    private volatile int enginePort = -1;
    private volatile String engineProcessGeneration = "";
    private volatile String engineProcessStartNonce = "";
    private volatile String engineProcessStartToken = "";
    private final BoundedControlRequestLane sessionFollowLane = new BoundedControlRequestLane("activity-follow",
        () -> android.util.Log.e("GardenControl", "Activity follow control lane is unhealthy"));
    private Runnable sessionFollowRunnable;
    private volatile String token = "";
    private volatile String origin = "";
    private volatile int engineGeneration = 1;
    private volatile String enginePhase = "starting";
    private volatile String engineInstance = "";
    private volatile String engineMessage = "正在准备手机运行服务…";
    private volatile String engineCode = "";
    private Runnable pageReadyTimeout;
    private volatile int connectingGeneration;
    private volatile String rejectedToken = "";
    private static final long ENGINE_READY_TIMEOUT_MS = 30_000L;
    private static final long PAGE_READY_TIMEOUT_MS = 30_000L;
    private static final long ENGINE_PROBE_TIMEOUT_MS = 1_700L;
    private static final long ENGINE_SESSION_FOLLOW_INTERVAL_MS = 5_000L;
    private static final long ENGINE_SESSION_FOLLOW_RETRY_MS = 5_000L;
    private static final int ENGINE_READY_MAX_BYTES = 64 * 1024;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        KeepAlive.consumeRecoveryNotification(this, getIntent());
        getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        // The panel page colour, so the window never flashes white before the first frame.
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.rgb(248, 245, 253)));
        getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        message = new TextView(this); message.setGravity(android.view.Gravity.CENTER); message.setText("正在准备本机托管…");
        message.setTextColor(android.graphics.Color.rgb(139, 124, 155)); message.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13);
        message.setAlpha(0f);
        message.setOnClickListener(view -> { if ("failed".equals(enginePhase)) restartEngineBinding(); });
        root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(android.graphics.Color.rgb(240, 234, 247));
        backdrop = new android.widget.ImageView(this);
        backdrop.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
        backdrop.setImageBitmap(assetBitmap("brand/garden-moon.png", 4));
        backdrop.setAlpha(0.36f);
        root.addView(backdrop, matchMatch());
        webLayer = new android.widget.FrameLayout(this);
        root.addView(webLayer, matchMatch());
        buildOpening();
        root.addView(opening, matchMatch());
        setContentView(root);
        ownWindowInsets();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 10);
        playOpening();
        connectEngine();
    }
    private android.widget.FrameLayout.LayoutParams matchMatch() {
        return new android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT, android.widget.FrameLayout.LayoutParams.MATCH_PARENT);
    }
    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density); }
    /* The permanent canvas never shrinks. On API 30+ the content fits the union of
       bars/cutout and IME explicitly; no window resize subtracts the IME again.
       Older windows use adjustResize and only reserve the remaining system bars. */
    private void ownWindowInsets() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN);
            getWindow().getDecorView().setSystemUiVisibility(getWindow().getDecorView().getSystemUiVisibility()
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
        View content = findViewById(android.R.id.content);
        content.setOnApplyWindowInsetsListener((view, insets) -> applyWindowInsets(view, insets));
        content.requestApplyInsets();
        webLayer.addOnLayoutChangeListener((view, l, t, r, b, ol, ot, ob, oc) -> syncWindowState());
        if (Build.VERSION.SDK_INT < 30) content.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            android.graphics.Rect visible = new android.graphics.Rect();
            content.getWindowVisibleDisplayFrame(visible);
            android.graphics.Point display = new android.graphics.Point();
            getWindowManager().getDefaultDisplay().getSize(display);
            setKeyboardVisible(display.y - visible.bottom > dp(96));
        });
    }
    private WindowInsets applyWindowInsets(View view, WindowInsets insets) {
        int left, top, right, bottom;
        boolean consumed;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                | android.view.WindowInsets.Type.displayCutout());
            android.graphics.Insets ime = insets.getInsets(android.view.WindowInsets.Type.ime());
            left = bars.left; top = bars.top; right = bars.right; bottom = bars.bottom;
            imeBottomPx = ime.bottom;
            imeVisible = insets.isVisible(android.view.WindowInsets.Type.ime());
            /* Floating/hardware-keyboard IMEs may remain visible with no covered area.
               A short animation retry must not become a permanent 220ms polling loop. */
            if (imeVisible && imeBottomPx <= 0) {
                android.graphics.Rect visibleFrame = new android.graphics.Rect();
                view.getWindowVisibleDisplayFrame(visibleFrame);
                int covered = root.getHeight() - visibleFrame.bottom;
                if (covered > dp(96)) imeBottomPx = covered;
                else if (!imeRetryPending && imeEmptyRetries < 2) {
                    imeEmptyRetries++;
                    imeRetryPending = true;
                    view.postDelayed(() -> {
                        imeRetryPending = false;
                        if (!destroyed && view.isAttachedToWindow()) view.requestApplyInsets();
                    }, 220);
                }
            } else imeEmptyRetries = 0;
            keyboardVisible = imeVisible;
            consumed = true;
        } else {
            left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop();
            right = insets.getSystemWindowInsetRight();
            boolean ime = insets.getSystemWindowInsetBottom() > insets.getStableInsetBottom() + dp(96);
            bottom = Math.min(insets.getSystemWindowInsetBottom(), insets.getStableInsetBottom());
            imeBottomPx = ime ? insets.getSystemWindowInsetBottom() : 0;
            imeVisible = ime;
            keyboardVisible = ime;
            consumed = false;
        }
        barsLeftPx = left; barsTopPx = top; barsRightPx = right; barsBottomPx = bottom;
        /* 关键改动：不再对整个 WebView 加 padding。WebView 覆盖全窗，把插画和背景一直画到物理顶边，
           状态栏/挖孔/键盘的遮挡改成一份数据交给网页的安全交互层，只在那里扣一次。
           WebView 自己的 padding 保持 0，任何人再想"顺手缩一点"都会在这里被覆盖掉。 */
        webLayer.setPadding(0, 0, 0, 0);
        layoutGeneration++;
        syncWindowState();
        // Consume so the page cannot apply the same bars or cutout a second time.
        return consumed ? WindowInsets.CONSUMED : insets.replaceSystemWindowInsets(0, 0, 0, 0);
    }
    private void setKeyboardVisible(boolean visible) {
        keyboardVisible = visible;
        imeVisible = visible;
        syncWindowState();
    }
    private void syncWindowState() {
        final WebView view = web;
        if (view == null) return;
        view.post(() -> {
            if (destroyed || view != web) return;
            try {
                /* 单位约定：这里给的全是 Android 物理 px；网页用 innerWidth/webViewPx.width 现算比例
                   再换成 CSS px，所以 textZoom、initial-scale 变化都不会让遮挡算错，也不把 density 直接当 devicePixelRatio。 */
                int[] origin = new int[2];
                view.getLocationInWindow(origin);
                int pageImeBottomPx = imeBottomPx;
                JSONObject imeState = new JSONObject().put("visible", imeVisible);
                if (Build.VERSION.SDK_INT < 30) {
                    // adjustResize may already have removed the IME from this WebView.
                    // Both measurements below use screen coordinates; the in-window origin
                    // above must not be subtracted from a screen-coordinate visible frame.
                    String mode = "legacy-reported-inset-fallback";
                    if (!imeVisible) {
                        pageImeBottomPx = 0;
                        mode = "legacy-ime-hidden";
                    } else {
                        try {
                            android.graphics.Rect visibleFrame = new android.graphics.Rect();
                            int[] screenOrigin = new int[2];
                            view.getWindowVisibleDisplayFrame(visibleFrame);
                            view.getLocationOnScreen(screenOrigin);
                            int viewWidth = view.getWidth(), viewHeight = view.getHeight();
                            if (view.isAttachedToWindow() && viewWidth > 0 && viewHeight > 0
                                && visibleFrame.width() > 0 && visibleFrame.height() > 0
                                && visibleFrame.right > screenOrigin[0]
                                && visibleFrame.left < (long) screenOrigin[0] + viewWidth) {
                                long overlap = (long) screenOrigin[1] + viewHeight - visibleFrame.bottom;
                                pageImeBottomPx = (int) Math.max(0L, Math.min((long) viewHeight, overlap));
                                mode = "legacy-visible-frame-residual";
                            }
                        } catch (RuntimeException unavailable) { /* Keep the original, explicitly marked fallback. */ }
                    }
                    // Raw diagnostic context only. It neither changes stable navigation-bar
                    // insets nor claims that a legacy IME/device has been verified.
                    imeState.put("mode", mode).put("reportedBottom", imeBottomPx);
                }
                imeState.put("bottom", pageImeBottomPx);
                JSONObject state = new JSONObject()
                    .put("keyboardVisible", keyboardVisible)
                    .put("fontScale", getResources().getConfiguration().fontScale)
                    .put("generation", layoutGeneration)
                    .put("pageMode", pageMode)
                    .put("density", (double) getResources().getDisplayMetrics().density)
                    .put("dpr", getResources().getDisplayMetrics().densityDpi / 160.0)
                    .put("windowPx", new JSONObject()
                        .put("width", root.getWidth()).put("height", root.getHeight()))
                    .put("webViewPx", new JSONObject()
                        .put("x", origin[0]).put("y", origin[1])
                        .put("width", view.getWidth()).put("height", view.getHeight()))
                    .put("barsPx", new JSONObject()
                        .put("top", barsTopPx).put("right", barsRightPx)
                        .put("bottom", barsBottomPx).put("left", barsLeftPx))
                    .put("imePx", imeState);
                view.evaluateJavascript("window.onGardenWindow&&window.onGardenWindow(" + state + ")", null);
            } catch (Exception ignored) { }
        });
    }
    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        View content = findViewById(android.R.id.content);
        if (content != null) content.requestApplyInsets();
        syncWindowState();
    }
    private void buildOpening() {
        opening = new android.widget.FrameLayout(this);
        openingBackground = new android.widget.ImageView(this);
        openingBackground.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
        openingBackground.setImageBitmap(assetBitmap("brand/garden-moon.png", 4));
        openingBackground.setAlpha(0f);
        opening.addView(openingBackground, matchMatch());
        android.widget.LinearLayout brand = new android.widget.LinearLayout(this);
        brand.setOrientation(android.widget.LinearLayout.VERTICAL);
        brand.setGravity(android.view.Gravity.CENTER);
        openingLogo = new android.widget.ImageView(this);
        openingLogo.setImageBitmap(assetBitmap("brand/logo-endless-summer.webp", 2));
        int logoSize = (int) (210 * getResources().getDisplayMetrics().density);
        android.widget.LinearLayout.LayoutParams logoParams = new android.widget.LinearLayout.LayoutParams(logoSize, logoSize);
        openingLogo.setLayoutParams(logoParams);
        openingLogo.setAlpha(0f);
        openingLogo.setScaleX(0.92f); openingLogo.setScaleY(0.92f);
        // The logo is a single image carrying the name, so nothing repeats it beside it.
        openingMotto = new TextView(this);
        openingMotto.setText("花开无尽夏。雨落有晴天。");
        openingMotto.setTextColor(android.graphics.Color.rgb(73, 61, 102));
        openingMotto.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14);
        openingMotto.setGravity(android.view.Gravity.CENTER);
        openingMotto.setAlpha(0f);
        android.widget.LinearLayout.LayoutParams mottoParams = new android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT);
        mottoParams.topMargin = (int) (14 * getResources().getDisplayMetrics().density);
        openingMotto.setLayoutParams(mottoParams);
        android.widget.FrameLayout.LayoutParams brandParams = new android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT, android.widget.FrameLayout.LayoutParams.MATCH_PARENT);
        android.widget.LinearLayout.LayoutParams waitParams = new android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT);
        waitParams.topMargin = (int) (34 * getResources().getDisplayMetrics().density);
        message.setLayoutParams(waitParams);
        brand.addView(openingLogo);
        brand.addView(openingMotto);
        brand.addView(message);
        opening.addView(brand, brandParams);
    }
    private void playOpening() {
        openingBackground.animate().alpha(0.36f).setDuration(320).start();
        main.postDelayed(() -> {
            if (destroyed) return;
            openingLogo.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(520).setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
        }, 180);
        main.postDelayed(() -> { if (!destroyed) openingMotto.animate().alpha(1f).setDuration(420).start(); }, 620);
        main.postDelayed(this::riseOpening, 1500);
    }
    // The brand mark steps up and the waiting line takes over, until the panel has painted.
    private void riseOpening() {
        if (destroyed || openingRisen) return;
        openingRisen = true;
        float rise = 96 * getResources().getDisplayMetrics().density;
        openingLogo.animate().translationY(-rise / 3).setDuration(380).setInterpolator(new android.view.animation.AccelerateDecelerateInterpolator()).start();
        openingMotto.animate().translationY(-rise / 3).alpha(0.55f).setDuration(380).start();
        message.animate().alpha(1f).setDuration(380).start();
        pulse = android.animation.ObjectAnimator.ofFloat(message, "alpha", 0.45f, 1f, 0.45f);
        pulse.setDuration(1400); pulse.setRepeatCount(android.animation.ObjectAnimator.INFINITE); pulse.start();
        revealPanelIfReady();
    }
    private Bitmap assetBitmap(String name, int sampleSize) {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize;
        try (InputStream in = getAssets().open(name)) { return BitmapFactory.decodeStream(in, null, options); }
        catch (IOException missing) { return null; }
    }
    private void connectEngine() { connectEngine(false); }
    private void connectEngine(boolean automaticReconnect) {
        if (destroyed || "stopping".equals(enginePhase) || (connecting && connectingGeneration == engineGeneration)) return;
        final int generation = engineGeneration;
        connecting = true;
        connectingGeneration = generation;
        if (!"ready".equals(enginePhase)) setEnginePhase(generation, "starting", "正在启动手机运行服务…");
        Intent start = new Intent(this, EngineService.class);
        // A session-follow reconnect is not a user start: it must never override a
        // durable STOP latch. User opens/resumes and help actions remain explicit.
        if (automaticReconnect) start.putExtra(KeepAlive.EXTRA_AUTO_RECONNECT, true);
        else start.putExtra(KeepAlive.EXTRA_USER_START, true);
        try { startForegroundService(start); }
        catch (RuntimeException unavailable) { connecting = false; setEnginePhase(generation, "failed", "手机运行服务未能启动，请点连接帮助后重试。"); return; }
        new Thread(() -> { try { awaitEngine(generation); } finally { if (connectingGeneration == generation) connecting = false; } }, "garden-connect").start();
    }
    private static final int VPN_CONSENT_REQUEST = 4002;
    private volatile int pendingVpnConsentEpoch = -1;
    private void applyVpnChoice(boolean enabled) {
        if (!enabled) {
            int epoch = KeepAlive.bumpVpnEpoch(this);
            pendingVpnConsentEpoch = -1;
            KeepAlive.controlPreferences(this).edit().putBoolean(KeepAlive.VPN_ENABLED, false).commit();
            try { startService(new Intent(this, KeepAliveVpnService.class).setAction(KeepAlive.ACTION_VPN_STOP)); }
            catch (RuntimeException unavailable) { /* Closing the tunnel is best effort. */ }
            KeepAlive.writeVpnState(this, false, "user-disabled");
            return;
        }
        int epoch = KeepAlive.bumpVpnEpoch(this);
        Intent consent;
        try { consent = android.net.VpnService.prepare(this); }
        catch (RuntimeException unavailable) {
            KeepAlive.writeVpnState(this, false, unavailable.getClass().getSimpleName());
            return;
        }
        if (consent == null) { startVpnService(epoch); return; }
        pendingVpnConsentEpoch = epoch;
        try { startActivityForResult(consent, VPN_CONSENT_REQUEST); }
        catch (RuntimeException unavailable) { pendingVpnConsentEpoch = -1; KeepAlive.writeVpnState(this, false, "consent-intent-failed"); }
    }
    private void startVpnService(int epoch) {
        // A consent result that arrives after the user changed the choice must not re-enable.
        if (epoch != KeepAlive.vpnEpoch(this)) return;
        KeepAlive.controlPreferences(this).edit().putBoolean(KeepAlive.VPN_ENABLED, true)
            .putInt(KeepAlive.VPN_FAILURE_COUNT, 0).putString(KeepAlive.VPN_LAST_ERROR, "").commit();
        try { startService(new Intent(this, KeepAliveVpnService.class)); }
        catch (RuntimeException denied) {
            // A VpnService that never calls startForeground() must not be started with
            // startForegroundService(); the honest result is that it did not run.
            KeepAlive.writeVpnState(this, false, denied.getClass().getSimpleName());
        }
    }
    private void rearmVpnIfEnabled() {
        if (!KeepAlive.controlPreferences(this).getBoolean(KeepAlive.VPN_ENABLED, false)) return;
        if (KeepAlive.vpnState(this).optBoolean("active", false)) return;
        if (!KeepAlive.vpnConsentGranted(this)) return;
        try { startService(new Intent(this, KeepAliveVpnService.class)); }
        catch (RuntimeException unavailable) { /* Reported by the next status read. */ }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == VPN_CONSENT_REQUEST) {
            int epoch = pendingVpnConsentEpoch;
            pendingVpnConsentEpoch = -1;
            if (epoch < 0 || epoch != KeepAlive.vpnEpoch(this)) return;
            if (resultCode == RESULT_OK) startVpnService(epoch);
            else KeepAlive.writeVpnState(this, false, "consent-denied");
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        KeepAlive.consumeRecoveryNotification(this, intent);
    }
    private Runnable uiHeartbeatTick;
    private void writeUiHeartbeat(boolean resumed) {
        try {
            PrivateFiles.write(new File(getFilesDir(), KeepAlive.UI_HEARTBEAT_FILE), new JSONObject()
                .put("at", System.currentTimeMillis()).put("resumed", resumed)
                .put("pid", android.os.Process.myPid()).put("generation", engineGeneration).put("phase", enginePhase).toString());
        } catch (Exception ignored) { /* Status only. */ }
    }
    private void startUiHeartbeat() {
        stopUiHeartbeat();
        Runnable tick = new Runnable() {
            @Override public void run() {
                if (destroyed || !activityResumed || uiHeartbeatTick != this) return;
                writeUiHeartbeat(true);
                main.postDelayed(this, 15_000L);
            }
        };
        uiHeartbeatTick = tick;
        main.post(tick);
    }
    private void stopUiHeartbeat() {
        Runnable current = uiHeartbeatTick; uiHeartbeatTick = null;
        if (current != null) main.removeCallbacks(current);
        writeUiHeartbeat(false);
    }
    @Override public void onResume() {
        super.onResume();
        activityResumed = true;
        startUiHeartbeat();
        rearmVpnIfEnabled();
        View content = findViewById(android.R.id.content);
        if (content != null) content.requestApplyInsets();
        if (web != null) {
            syncWindowState();
            web.evaluateJavascript("window.onGardenNativeResume && window.onGardenNativeResume()", null);
            connectEngine();
            startSessionFollow();
        }
    }
    @Override public void onPause() {
        activityResumed = false;
        stopUiHeartbeat();
        stopSessionFollow();
        super.onPause();
    }
    private boolean currentEngine(int generation) { return !destroyed && generation == engineGeneration; }
    private boolean engineStopPending() {
        try { if (new File(getFilesDir(), "user-stop-request.json").isFile()) return true; }
        catch (RuntimeException ignored) { /* Fall back to the preference snapshot. */ }
        return getSharedPreferences("engine-safety", MODE_PRIVATE).getBoolean("stop_requested", false);
    }
    private boolean engineHostDesired() { return getSharedPreferences("engine-safety", MODE_PRIVATE).getBoolean("engine_desired", false); }
    private void startSessionFollow() {
        if (sessionFollowRunnable != null) return;
        sessionFollowRunnable = new Runnable() {
            @Override public void run() {
                if (destroyed || !activityResumed) { sessionFollowRunnable = null; return; }
                followEngineSession();
                main.postDelayed(this, ENGINE_SESSION_FOLLOW_INTERVAL_MS);
            }
        };
        main.postDelayed(sessionFollowRunnable, ENGINE_SESSION_FOLLOW_INTERVAL_MS);
    }
    private void stopSessionFollow() {
        Runnable current = sessionFollowRunnable; sessionFollowRunnable = null;
        if (current != null) main.removeCallbacks(current);
    }
    private void followEngineSession() {
        if (destroyed || !activityResumed || connecting || autoFollowProbeInFlight || engineStopPending() || !engineHostDesired() ||
                SystemClock.elapsedRealtime() < nextAutoFollowAttemptElapsedMs) return;
        final int generation = engineGeneration;
        autoFollowProbeInFlight = true;
        Thread probe = new Thread(() -> {
            boolean needsReconnect = false;
            String newOrigin = null, newToken = null, newGeneration = null, newStartNonce = null, newStartToken = null; int newPid = -1;
            try {
                JSONObject session = new JSONObject(PrivateFiles.text(new File(getFilesDir(), "engine-session.json")));
                newPid = session.optInt("pid", -1); int newPort = session.optInt("port", -1); newToken = session.optString("token", "");
                newGeneration = session.optString("processGeneration", ""); newStartNonce = session.optString("processStartNonce", "");
                newStartToken = session.optString("processStartToken", "");
                newOrigin = newPort > 0 ? "http://127.0.0.1:" + newPort : null;
                if (newPid <= 0 || newToken.isEmpty() || newOrigin == null) throw new IOException("No current engine session tuple");
                if (!newToken.equals(token) || !newOrigin.equals(origin) || newPid != enginePid || newPort != enginePort ||
                        !newGeneration.equals(engineProcessGeneration) || !newStartNonce.equals(engineProcessStartNonce) ||
                        !newStartToken.equals(engineProcessStartToken)) {
                    needsReconnect = true;
                } else {
                    JSONObject ready = sessionFollowLane.execute(newPort, newToken, "GET", "/api/local/health", null);
                    if (!ready.optBoolean("responsive", false) ||
                            ready.optInt("pid", -1) != newPid || !newGeneration.equals(ready.optString("processGeneration", "")) ||
                            !newStartNonce.equals(ready.optString("processStartNonce", "")) ||
                            !newStartToken.equals(ready.optString("processStartToken", ""))) needsReconnect = true;
                    else if (!ready.optBoolean("requiresEngineRestart", false) && ready.optBoolean("ready", false)
                            && ("failed".equals(enginePhase) || "starting".equals(enginePhase))) needsReconnect = true;
                }
            } catch (Exception unavailable) { needsReconnect = true; }
            final boolean reconnect = needsReconnect; final String sessionRoot = newOrigin; final String sessionToken = newToken; final int sessionPid = newPid;
            final String sessionGeneration = newGeneration, sessionStartNonce = newStartNonce, sessionStartToken = newStartToken;
            main.post(() -> {
                autoFollowProbeInFlight = false;
                if (destroyed || !activityResumed || !currentEngine(generation) || engineStopPending() || !engineHostDesired()) return;
                if (reconnect) {
                    nextAutoFollowAttemptElapsedMs = SystemClock.elapsedRealtime() + ENGINE_SESSION_FOLLOW_RETRY_MS;
                    if (sessionRoot != null && sessionToken != null && sessionPid > 0 &&
                            (!sessionToken.equals(token) || !sessionRoot.equals(origin) || sessionPid != enginePid ||
                             !sessionGeneration.equals(engineProcessGeneration) || !sessionStartNonce.equals(engineProcessStartNonce) ||
                             !sessionStartToken.equals(engineProcessStartToken))) {
                        engineGeneration++; connecting = false; connectingGeneration = 0;
                    } else if ("ready".equals(enginePhase)) {
                        setEnginePhase(generation, "starting", "手机运行服务连接中断，正在自动重新连接…");
                    } else if (sessionRoot != null && sessionRoot.equals(origin) && sessionToken != null && sessionToken.equals(token)
                            && ("failed".equals(enginePhase) || "starting".equals(enginePhase))) {
                        // The process tuple is healthy and ready, so recover the existing UI binding in place.
                        // A binding timeout must not strand the page waiting for a user-initiated help action.
                        if (web != null) web.reload();
                        setEnginePhase(generation, "starting", "手机运行服务已恢复，正在自动重新绑定页面…");
                    }
                    connectEngine(true);
                }
            });
        }, "garden-session-follow");
        probe.setDaemon(true); probe.start();
    }
    private String engineStateJson() {
        try { return new JSONObject().put("generation", engineGeneration).put("phase", enginePhase)
            .put("instanceId", engineInstance).put("message", engineMessage).put("code", engineCode).toString(); }
        catch (Exception unavailable) { return "{}"; }
    }
    private void setEnginePhase(int generation, String phase, String text) {
        setEnginePhase(generation, phase, text, "");
    }
    private void setEnginePhase(int generation, String phase, String text, String code) {
        Runnable update = () -> {
            if (!currentEngine(generation)) return;
            if (!"binding".equals(phase)) cancelPageReadyTimeout();
            boolean residualStop = false;
            try { residualStop = KeepAlive.stopConfirmation(this).optBoolean("residualDesired", false); }
            catch (Exception ignored) { /* Keep the engine text when unread. */ }
            String displayText = text;
            // Do not describe an intentionally stopped engine as an unintended
            // disconnect. User-start messages ("正在启动…") are left untouched.
            if (residualStop && ("starting".equals(phase) || "failed".equals(phase)) && displayText != null
                    && (displayText.contains("连接中断") || displayText.contains("连接超时")
                        || displayText.contains("正在重新检查") || displayText.contains("自动恢复连接"))) {
                displayText = "当前任务已停止；停止意愿已由本机服务耐久确认，本地停止标记未写入。后台恢复已拦截。";
            }
            enginePhase = phase; engineMessage = displayText; engineCode = code;
            showWaiting(displayText);
            if (web != null) web.evaluateJavascript("window.onGardenEngineState&&window.onGardenEngineState(" + engineStateJson() + ")", null);
        };
        if (Looper.myLooper() == Looper.getMainLooper()) update.run(); else main.post(update);
    }
    private void cancelPageReadyTimeout() {
        if (pageReadyTimeout != null) main.removeCallbacks(pageReadyTimeout);
        pageReadyTimeout = null;
    }
    private void armPageReadyTimeout(int generation, WebView page, String instance) {
        if (!currentEngine(generation) || page == null || page != web
            || !instance.equals(engineInstance) || !"binding".equals(enginePhase)) return;
        cancelPageReadyTimeout();
        Runnable timeout = new Runnable() {
            @Override public void run() {
                if (pageReadyTimeout != this) return;
                pageReadyTimeout = null;
                if (!currentEngine(generation) || page != web || !instance.equals(engineInstance)
                    || !"binding".equals(enginePhase)) return;
                setEnginePhase(generation, "failed",
                    "页面绑定超时，正在自动恢复本机服务连接；可查看本地运行日志。",
                    "LOCAL_UI_BINDING_TIMEOUT");
            }
        };
        pageReadyTimeout = timeout;
        main.postDelayed(timeout, PAGE_READY_TIMEOUT_MS);
    }
    private void restartEngineBinding() {
        if (destroyed || "stopping".equals(enginePhase)) return;
        final String previousToken = token;
        final String previousOrigin = origin;
        int savedPid = -1;
        try { savedPid = new JSONObject(PrivateFiles.text(new File(getFilesDir(), "engine-session.json"))).optInt("pid", -1); }
        catch (Exception missing) { /* A missing session still permits stopping the service. */ }
        final int previousPid = savedPid;
        final int generation = ++engineGeneration;
        rejectedToken = previousToken;
        token = ""; origin = ""; engineInstance = "";
        setEnginePhase(generation, "stopping", "正在关闭旧连接，准备重新读取软件身份…");
        try { stopService(new Intent(this, EngineService.class)); }
        catch (RuntimeException unavailable) { setEnginePhase(generation, "failed", "旧连接未能关闭，正在等待本机服务自动恢复；可查看本地运行日志。"); return; }
        new Thread(() -> {
            // No elapsed delay is treated as readiness: wait until the old process's
            // authenticated endpoint has actually gone away before starting another.
            for (int attempt = 0; attempt < 100 && currentEngine(generation); attempt++) {
                boolean processGone = previousPid <= 0 || !new File("/proc/" + previousPid).exists();
                if (processGone && (previousOrigin.isEmpty() || !oldEngineResponds(previousOrigin, previousToken))) {
                    main.post(() -> { if (currentEngine(generation)) { setEnginePhase(generation, "starting", "旧连接已关闭，正在启动手机运行服务…"); connectEngine(); } });
                    return;
                }
                try { Thread.sleep(100); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
            }
            setEnginePhase(generation, "failed", "旧运行服务尚未停止，请在连接帮助中重新检查并核对当前软件身份；不要重复提交登录。", "LOCAL_ENGINE_STOP_TIMEOUT");
        }, "garden-rebind-stop").start();
    }
    private boolean oldEngineResponds(String root, String sessionToken) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(root + "/api/local/ready").openConnection();
            connection.setRequestProperty("Authorization", "Bearer " + sessionToken);
            connection.setConnectTimeout(400); connection.setReadTimeout(500);
            // Any HTTP response means this endpoint still exists, even if shutting down.
            connection.getResponseCode(); return true;
        } catch (Exception stopped) { return false; }
        finally { if (connection != null) connection.disconnect(); }
    }
    private JSONObject readEngineReady(String root, String sessionToken) throws Exception {
        return readEngineReady(root, sessionToken, engineGeneration, SystemClock.elapsedRealtime() + ENGINE_PROBE_TIMEOUT_MS);
    }
    private int engineProbeRemaining(int generation, long deadline) throws IOException {
        if (!currentEngine(generation) || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Local engine probe cancelled");
        long remaining = deadline - SystemClock.elapsedRealtime();
        if (remaining <= 0) throw new SocketTimeoutException("Local engine readiness deadline reached");
        return (int) Math.min(Integer.MAX_VALUE, remaining);
    }
    private JSONObject readEngineReady(String root, String sessionToken, int generation, long deadline) throws Exception {
        final long probeDeadline = Math.min(deadline, SystemClock.elapsedRealtime() + ENGINE_PROBE_TIMEOUT_MS);
        engineProbeRemaining(generation, probeDeadline);
        final HttpURLConnection connection = (HttpURLConnection) new URL(root + "/api/local/ready").openConnection();
        connection.setInstanceFollowRedirects(false);
        FutureTask<JSONObject> probe = new FutureTask<>(() -> {
            try {
                connection.setRequestProperty("Authorization", "Bearer " + sessionToken);
                connection.setConnectTimeout(Math.min(500, engineProbeRemaining(generation, probeDeadline)));
                connection.setReadTimeout(Math.min(1200, engineProbeRemaining(generation, probeDeadline)));
                if (connection.getResponseCode() != 200) return new JSONObject();
                engineProbeRemaining(generation, probeDeadline);
                try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[4096];
                    while (true) {
                        connection.setReadTimeout(Math.min(1200, engineProbeRemaining(generation, probeDeadline)));
                        int length = in.read(buffer);
                        engineProbeRemaining(generation, probeDeadline);
                        if (length < 0) break;
                        if (out.size() + length > ENGINE_READY_MAX_BYTES) throw new IOException("Local engine readiness response too large");
                        out.write(buffer, 0, length);
                    }
                    return new JSONObject(out.toString("UTF-8"));
                }
            } finally { connection.disconnect(); }
        });
        Thread worker = new Thread(probe, "garden-ready-probe");
        worker.setDaemon(true);
        worker.start();
        try {
            // Socket read timeouts are idle limits, not a whole-response deadline.
            // The caller also bounds headers and slow bodies without waiting for cleanup.
            return probe.get(engineProbeRemaining(generation, probeDeadline), TimeUnit.MILLISECONDS);
        } catch (TimeoutException expired) {
            throw new SocketTimeoutException("Local engine readiness probe timed out");
        } catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt();
            throw new InterruptedIOException("Local engine probe interrupted");
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IOException("Local engine readiness probe failed", cause);
        } finally {
            if (!probe.isDone()) probe.cancel(true);
            if (probe.isCancelled()) {
                // Disconnect this probe only; never block the deadline thread or UI
                // on stream close, and never touch a later generation's connection.
                Thread cleanup = new Thread(connection::disconnect, "garden-ready-cancel");
                cleanup.setDaemon(true);
                cleanup.start();
            }
        }
    }
    private void awaitEngine(int generation) {
        final long deadline = SystemClock.elapsedRealtime() + ENGINE_READY_TIMEOUT_MS;
        String lastCode = "LOCAL_ENGINE_SESSION_UNAVAILABLE";
        String lastReason = "尚未取得可读取的手机服务会话信息";
        while (currentEngine(generation) && SystemClock.elapsedRealtime() < deadline) {
            String stage = "session";
            try {
                // engine-error.json is not bound to this launch attempt. Do not report an
                // earlier process's file as the cause of this connection, or fail from it.
                JSONObject session = new JSONObject(PrivateFiles.text(new File(getFilesDir(), "engine-session.json")));
                String root = "http://127.0.0.1:" + session.getInt("port");
                String newToken = session.getString("token");
                if (newToken.equals(rejectedToken)) {
                    stage = "previous-session";
                    lastCode = "LOCAL_ENGINE_WAITING_NEW_SESSION";
                    lastReason = "仍在等待替换旧连接的新会话信息";
                    throw new IOException("Previous engine session is not eligible for this binding");
                }
                stage = "probe";
                JSONObject ready = readEngineReady(root, newToken, generation, deadline);
                if (!currentEngine(generation)) return;
                if (SystemClock.elapsedRealtime() >= deadline) break;
                if (ready.optBoolean("requiresEngineRestart", false)) {
                    // EngineService observes the same tuple-bound health flag and performs
                    // the durable bounded restart, including when this Activity is absent.
                    lastCode = "LOCAL_ENGINE_RESTART_REQUIRED";
                    lastReason = "软件身份切换需要本机执行器恢复，正在等待新会话";
                    try { Thread.sleep(1000L); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
                    continue;
                }
                int sessionPid = session.optInt("pid", -1);
                if ("failed".equals(ready.optString("phase")) && sessionPid > 0 && ready.optInt("pid", -1) == sessionPid) {
                    String code = "LOCAL_SOFTWARE_INIT_FAILED".equals(ready.optString("code"))
                        ? "LOCAL_SOFTWARE_INIT_FAILED" : "LOCAL_ENGINE_INIT_FAILED";
                    setEnginePhase(generation, "failed", "本机身份初始化未完成，服务正在自动恢复；可查看本地运行日志。", code);
                    return;
                }
                if (ready.optBoolean("ready", false) && ready.optBoolean("softwareInitialized", false)
                        && ready.optBoolean("ownerBound", false) && sessionPid > 0 && ready.optInt("pid", -1) == sessionPid
                        && !ready.optString("instanceId").isEmpty()) {
                    final String newInstance = ready.getString("instanceId");
                    main.post(() -> {
                        if (!currentEngine(generation)) return;
                        if (SystemClock.elapsedRealtime() >= deadline) { engineReadinessTimedOut(generation); return; }
                        boolean changed = !newToken.equals(token) || !root.equals(origin) || !newInstance.equals(engineInstance) || web == null;
                        token = newToken; origin = root; engineInstance = newInstance; enginePid = sessionPid; enginePort = session.optInt("port", -1);
                         engineProcessGeneration = session.optString("processGeneration", "");
                         engineProcessStartNonce = session.optString("processStartNonce", "");
                         engineProcessStartToken = session.optString("processStartToken", "");
                        if (changed) {
                            setEnginePhase(generation, "binding", "手机服务已启动，正在读取当前身份与游戏号…");
                            showPanel(generation);
                        } else if (!"ready".equals(enginePhase)) {
                            setEnginePhase(generation, "binding", "正在重新核对当前软件身份…");
                            armPageReadyTimeout(generation, web, newInstance);
                        }
                    });
                    return;
                }
                if (sessionPid <= 0 || ready.optInt("pid", -1) != sessionPid) {
                    lastCode = "LOCAL_ENGINE_SESSION_MISMATCH";
                    lastReason = "会话进程与本机接口的就绪信息尚未匹配";
                } else if (!ready.optBoolean("softwareInitialized", false)) {
                    lastCode = "LOCAL_ENGINE_INITIALIZING";
                    lastReason = "手机服务仍在初始化当前软件身份";
                } else {
                    lastCode = "LOCAL_ENGINE_READINESS_INCOMPLETE";
                    lastReason = "本机接口尚未确认完整的身份与名册就绪信息";
                }
            } catch (Exception notReady) {
                // Only a fixed code for the stage actually observed here is retained. Never
                // expose exception text, the loopback URL, session content or credentials.
                if ("session".equals(stage)) {
                    lastCode = "LOCAL_ENGINE_SESSION_UNAVAILABLE";
                    lastReason = "尚未取得可读取的手机服务会话信息";
                } else if ("probe".equals(stage)) {
                    if (notReady instanceof SocketTimeoutException) {
                        lastCode = "LOCAL_ENGINE_PROBE_TIMEOUT";
                        lastReason = "本机就绪接口最近一次未及时完整返回";
                    } else if (notReady instanceof org.json.JSONException) {
                        lastCode = "LOCAL_ENGINE_READINESS_INVALID";
                        lastReason = "本机就绪接口最近一次返回的信息无法读取";
                    } else {
                        lastCode = "LOCAL_ENGINE_PROBE_UNAVAILABLE";
                        lastReason = "本机就绪接口最近一次未能连接或读取";
                    }
                }
                if (Thread.currentThread().isInterrupted()) return;
            }
            if (!currentEngine(generation)) return;
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) break;
            if ("ready".equals(enginePhase)) setEnginePhase(generation, "starting", "手机运行服务连接中断，正在重新检查…");
            try { Thread.sleep(Math.min(1000L, remaining)); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
        if (currentEngine(generation)) engineReadinessTimedOut(generation, lastCode, lastReason);
    }
    private void engineReadinessTimedOut(int generation) {
        engineReadinessTimedOut(generation, "LOCAL_ENGINE_READY_TIMEOUT", "手机服务未在期限内完成本机就绪确认");
    }
    private void engineReadinessTimedOut(int generation, String code, String reason) {
        setEnginePhase(generation, "failed", "手机服务连接超时：" + reason + "。正在自动恢复连接；可查看本地运行日志。", code);
    }
    private void showWaiting(String text) {
        TextView view = message;
        if (view != null && !entered) {
            boolean failed = "failed".equals(enginePhase);
            boolean residualStop = false;
            try { residualStop = KeepAlive.stopConfirmation(this).optBoolean("residualDesired", false); }
            catch (Exception ignored) { /* The panel still reports unread. */ }
            if (residualStop && ("starting".equals(enginePhase) || failed)) {
                // A backend-confirmed STOP whose local marker could not be
                // written must not be described as an unintended disconnect.
                text = "当前任务已停止；停止意愿已由本机服务耐久确认，本地停止标记未写入。后台恢复已拦截。";
            }
            view.setText(text + (failed ? "\n点此重新连接" : ""));
            view.setClickable(failed); view.setFocusable(failed);
            if (failed) { if (pulse != null) { pulse.cancel(); pulse = null; } view.setAlpha(1f); }
        }
    }
    private void showPanel(int generation) {
        if (!currentEngine(generation)) return;
        cancelPageReadyTimeout();
        stopSurfaceWebView = null; stopSurfaceOrigin = "";
        if (web != null) { webLayer.removeView(web); web.destroy(); }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        // Transparent so the single native backdrop shows through the auth and loading screens.
        web.setBackgroundColor(0x00000000);
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
        // CSS scales text and controls together using the real Android font scale.
        web.getSettings().setTextZoom(100);
        // Respect the compact CSS sizes; system text zoom remains available.
        web.getSettings().setMinimumFontSize(1); web.getSettings().setMinimumLogicalFontSize(1);
        web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= 26) web.getSettings().setSafeBrowsingEnabled(true);
        web.addJavascriptInterface(new Bridge(generation, engineInstance, origin, token, web), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                return !"http".equals(url.getScheme()) || !"127.0.0.1".equals(url.getHost()) || url.getPort() != Uri.parse(origin).getPort();
            }
            @Override public void onPageFinished(WebView view, String url) { if (view == web) main.post(MainActivity.this::panelPainted); }
            // The auth/loading brand image must survive an engine rebind: the loopback origin is
            // stopped during logout, so serve these exact bytes from the APK instead of the engine.
            @Override public WebResourceResponse shouldInterceptRequest(WebView ignore, WebResourceRequest request) {
                if ("/brand/logo-endless-summer.webp".equals(request.getUrl().getPath())) {
                    try { return new WebResourceResponse("image/webp", null, getAssets().open("brand/logo-endless-summer.webp")); }
                    catch (Exception ignored) { /* fall through to the engine copy */ }
                }
                return super.shouldInterceptRequest(ignore, request);
            }
        });
        web.setAlpha(entered ? 1f : 0f);
        webLayer.addView(web, matchMatch());
        armPageReadyTimeout(generation, web, engineInstance);
        web.loadUrl(origin + "/");
    }
    private void panelPainted() {
        if (destroyed) return;
        panelReady = true;
        if (entered) { publishVisibleStopSurface(web, origin); return; }
        revealPanelIfReady();
    }
    private void publishVisibleStopSurface(WebView candidate, String expectedOrigin) {
        if (destroyed || candidate == null || candidate != web || candidate.getParent() != webLayer ||
            !candidate.isShown() || candidate.getAlpha() <= 0f || expectedOrigin == null || expectedOrigin.isEmpty()) return;
        try {
            Uri expected = Uri.parse(expectedOrigin), loaded = Uri.parse(candidate.getUrl());
            if (!"http".equals(expected.getScheme()) || !"127.0.0.1".equals(expected.getHost()) ||
                !"http".equals(loaded.getScheme()) || !"127.0.0.1".equals(loaded.getHost()) ||
                loaded.getPort() != expected.getPort()) return;
            stopSurfaceOrigin = expectedOrigin;
            stopSurfaceWebView = candidate;
        } catch (RuntimeException unavailable) { /* Do not publish an unverified bridge surface. */ }
    }
    // One entry per process: returning to the foreground reuses the panel instead of replaying the opening.
    private void revealPanelIfReady() {
        if (destroyed || entered || !panelReady || !openingRisen) return;
        entered = true;
        if (pulse != null) { pulse.cancel(); pulse = null; }
        WebView revealedWeb = web; String revealedOrigin = origin;
        revealedWeb.animate().alpha(1f).setDuration(220).withEndAction(() -> publishVisibleStopSurface(revealedWeb, revealedOrigin)).start();
        // Only the opening mask fades; the permanent backdrop stays behind the login screen.
        opening.animate().alpha(0f).setDuration(260).withEndAction(() -> root.removeView(opening)).start();
    }
    private final class Bridge {
        private final int pageGeneration;
        private final String pageInstance, pageOrigin, pageToken;
        private final WebView pageWebView;
        Bridge(int generation, String instance, String root, String sessionToken, WebView pageView) {
            pageGeneration = generation; pageInstance = instance; pageOrigin = root; pageToken = sessionToken;
            pageWebView = pageView;
        }
        private boolean currentPage() { return currentEngine(pageGeneration) && web == pageWebView
            && pageInstance.equals(engineInstance) && pageOrigin.equals(origin); }
        private boolean currentVisibleStopSurface() {
            return !destroyed && activityResumed && pageWebView != null && web == pageWebView &&
                stopSurfaceWebView == pageWebView && !pageOrigin.isEmpty() && pageOrigin.equals(stopSurfaceOrigin);
        }
        @JavascriptInterface public void setPageMode(String mode) {
            if (!currentPage()) return;
            main.post(() -> {
                if (!currentPage()) return;
                pageMode = mode == null ? "loading" : mode;
                /* 不再按业务页隐藏原生背景。旧实现在 panel 模式把 backdrop 设成 GONE，等于让
                   "状态栏后面由原生画、内容区由网页画"这两张不同裁切的图各管一段，接缝必然存在。
                   现在原生背景只做启动与网页未就绪期间的兜底，网页自己铺全窗背景；
                   它保持可见也不会露出，因为网页那层是不透明的。 */
                backdrop.setVisibility(View.VISIBLE);
                syncWindowState();
            });
        }
        @JavascriptInterface public String sessionToken() { return currentPage() && ("ready".equals(enginePhase) || "binding".equals(enginePhase)) ? pageToken : ""; }
        @JavascriptInterface public String persistAccountStopRequest(String requestJson) {
            // A visible app-owned page remains a valid revocation surface while a replacement
            // engine process is binding. Do not extend this exception to any other bridge API.
            if (!currentVisibleStopSurface() || requestJson == null || requestJson.length() > 4096) return "{\"saved\":false,\"reasonCode\":\"NATIVE_STOP_PAGE_STALE\"}";
            try {
                JSONObject request = new JSONObject(requestJson);
                String latchId = request.optString("latchId", ""), commandId = request.optString("commandId", "");
                String ownerRef = request.optString("ownerRef", ""), accountRef = request.optString("accountRef", "");
                String subjectRef = request.optString("subjectRef", ""); long uid = request.optLong("officialUid", -1L);
                if (request.length() != 6 || !latchId.equals(commandId) || !latchId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}") ||
                    !ownerRef.matches("[A-Za-z0-9_.:-]{1,128}") || !accountRef.matches("[1-9][0-9]{0,8}") ||
                    !subjectRef.matches("[A-Za-z0-9_.:-]{1,128}") || uid <= 0L || uid > 9_007_199_254_740_991L)
                    return "{\"saved\":false,\"reasonCode\":\"NATIVE_STOP_TARGET_INVALID\"}";
                String targetEnvelope = ownerRef + "\n" + accountRef + "\n" + subjectRef + "\n" + uid;
                byte[] targetHash = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(targetEnvelope.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                StringBuilder scopeKey = new StringBuilder(64);
                for (byte value : targetHash) scopeKey.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
                File rootDirectory = new File(getFilesDir(), "account-stop-requests");
                if (!rootDirectory.isDirectory() && !rootDirectory.mkdirs()) throw new IOException("无法创建本机停止目录");
                Os.chmod(rootDirectory.getAbsolutePath(), 0700);
                File directory = new File(rootDirectory, scopeKey.toString());
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建账号停止目录");
                Os.chmod(directory.getAbsolutePath(), 0700);
                File target = new File(directory, latchId + ".json");
                if (target.isFile()) {
                    JSONObject prior = new JSONObject(PrivateFiles.text(target));
                    if (!prior.toString().equals(request.toString())) return "{\"saved\":false,\"reasonCode\":\"NATIVE_STOP_LATCH_CONFLICT\"}";
                } else PrivateFiles.write(target, request.toString());
                Os.chmod(target.getAbsolutePath(), 0600);
                return new JSONObject().put("saved", true).put("latchId", latchId).toString();
            } catch (Exception failure) { return "{\"saved\":false,\"reasonCode\":\"NATIVE_STOP_PERSIST_FAILED\"}"; }
        }
        @JavascriptInterface public String engineState() { return engineStateJson(); }
        @JavascriptInterface public void reconnectEngine() {
            if (!currentPage()) return;
            main.post(() -> {
                if (!currentPage()) return;
                // This bridge serves automatic page/connection recovery; it is passive
                // and may not override a STOP. A user open/resume remains explicit.
                connectEngine(true);
            });
        }
        // An owner change rebinds the local roster only in a fresh engine process; stopping the
        // service tears down the :engine process, and the relaunch reads the new software user.
        @JavascriptInterface public void restartEngine() {
            if (!currentPage()) return;
            main.post(() -> { if (currentPage()) restartEngineBinding(); });
        }
        @JavascriptInterface public String deviceInfo() {
            try { return DeviceProfile.publicInfo(MainActivity.this).toString(); } catch (Exception e) { return "{}"; }
        }
        // Every keep-alive reading below is a real device read. Anything unavailable
        // stays absent so the page shows "未读取" instead of inventing a granted state.
        @JavascriptInterface public String keepAliveStatus() {
            try { return KeepAlive.status(MainActivity.this).toString(); } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public String startKeepAliveProbe() {
            return KeepAliveProbe.start(MainActivity.this).toString();
        }
        @JavascriptInterface public String cancelKeepAliveProbe() {
            return KeepAliveProbe.cancel(MainActivity.this, "user-cancelled").toString();
        }
        @JavascriptInterface public void setScreenKeepOn(boolean on) {
            if (!currentPage()) return;
            main.post(() -> {
                if (!currentPage()) return;
                KeepAlive.controlPreferences(MainActivity.this).edit().putBoolean(KeepAlive.SCREEN_KEEP_ON, on).commit();
                // Only talk to an already running service: starting it here would create
                // engine intent merely because the user changed a screen preference.
                if (KeepAlive.engineState(MainActivity.this).optBoolean("engineAlive", false)) {
                    try { startService(new Intent(MainActivity.this, EngineService.class).putExtra(KeepAlive.EXTRA_SCREEN_ON, on)); }
                    catch (RuntimeException unavailable) { /* Applied on the next engine start. */ }
                }
            });
        }
        @JavascriptInterface public void setKeepAliveVpn(boolean enabled) {
            if (!currentPage()) return;
            main.post(() -> { if (currentPage()) applyVpnChoice(enabled); });
        }
        @JavascriptInterface public void openManufacturerSettings() {
            if (!currentPage()) return;
            main.post(() -> {
                if (!currentPage()) return;
                try {
                    JSONObject result = KeepAlive.openManufacturerSettings(MainActivity.this);
                    pageWebView.evaluateJavascript("window.onGardenKeepAliveResult&&window.onGardenKeepAliveResult(" + result + ")", null);
                } catch (Exception ignored) { /* The panel keeps the honest "manual" note. */ }
            });
        }
        @JavascriptInterface public void openExactAlarmSettings() {
            if (!currentPage()) return;
            main.post(() -> {
                if (!currentPage()) return;
                try {
                    JSONObject result = KeepAlive.openExactAlarmSettings(MainActivity.this);
                    pageWebView.evaluateJavascript("window.onGardenKeepAliveResult&&window.onGardenKeepAliveResult(" + result + ")", null);
                } catch (Exception ignored) { }
            });
        }
        @JavascriptInterface public void ready() { main.post(MainActivity.this::syncWindowState); }
        @JavascriptInterface public void pageReady(String instance, int generation) {
            if (!currentPage() || generation != pageGeneration || !pageInstance.equals(instance)) return;
            main.post(() -> {
                if (currentPage() && generation == engineGeneration) {
                    setEnginePhase(generation, "ready", "手机运行服务已连接"); syncWindowState();
                }
            });
        }
        // These are fixed device-settings destinations, not caller-supplied Intents. A null
        // reason means startActivity returned; it does not report a granted permission.
        private String tryBackgroundSettingsIntent(String action) {
            try {
                startActivity(new Intent(action, Uri.parse("package:" + getPackageName())));
                return null;
            } catch (ActivityNotFoundException unavailable) { return "activity-not-found"; }
            catch (SecurityException denied) { return "security-denied"; }
            catch (RuntimeException unavailable) { return "launch-failed"; }
        }
        private JSONObject backgroundSettingsAttempt(String target, String reason) throws org.json.JSONException {
            return new JSONObject().put("target", target)
                .put("result", reason == null ? "intent-accepted" : "failed")
                .put("reason", reason == null ? JSONObject.NULL : reason);
        }
        private boolean batteryAlreadyUnrestricted() {
            try {
                PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
                return power != null && power.isIgnoringBatteryOptimizations(getPackageName());
            } catch (RuntimeException unavailable) { return false; }
        }
        private JSONObject openBackgroundSettingsResult(JSONObject request) throws org.json.JSONException {
            org.json.JSONArray attempts = new org.json.JSONArray();
            // An already whitelisted App has nothing to request on the battery-exemption
            // prompt. Open its settings instead, recording only the Intent actually tried.
            String target = batteryAlreadyUnrestricted() ? "app-details" : "battery-request";
            String reason = tryBackgroundSettingsIntent("app-details".equals(target)
                ? Settings.ACTION_APPLICATION_DETAILS_SETTINGS : Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            attempts.put(backgroundSettingsAttempt(target, reason));
            if (reason != null && "battery-request".equals(target)) {
                if (!currentPage()) return null;
                target = "app-details";
                reason = tryBackgroundSettingsIntent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                attempts.put(backgroundSettingsAttempt(target, reason));
            }
            JSONObject result = request == null ? new JSONObject() : new JSONObject(request.toString());
            return result.put("result", reason == null ? "intent-accepted" : "failed")
                .put("target", reason == null ? target : JSONObject.NULL)
                .put("attempts", attempts)
                .put("reason", reason == null ? JSONObject.NULL : "all-intents-failed");
        }
        // Owner is an opaque public correlation key. The JS caller must still match its
        // current software session and original layer; no token or exception text is echoed.
        private JSONObject backgroundSettingsRequest(String json) {
            if (json == null || json.length() > 1024) return null;
            try {
                JSONObject request = new JSONObject(json);
                if (request.length() != 6 || !(request.opt("schemaVersion") instanceof Number)
                    || ((Number) request.opt("schemaVersion")).doubleValue() != 1d
                    || !(request.opt("requestId") instanceof String) || !request.getString("requestId").matches("[0-9a-f]{32}")
                    || !(request.opt("pageNonce") instanceof String) || !request.getString("pageNonce").matches("[0-9a-f]{32}")
                    || !(request.opt("softwareUserId") instanceof String) || !request.getString("softwareUserId").matches("(?:|[1-9][0-9]{0,18})")
                    || !(request.opt("engineGeneration") instanceof Number)
                    || ((Number) request.opt("engineGeneration")).doubleValue() != (double) pageGeneration
                    || !(request.opt("engineInstance") instanceof String) || !pageInstance.equals(request.getString("engineInstance"))) return null;
                return request;
            } catch (org.json.JSONException invalid) { return null; }
        }
        @JavascriptInterface public void requestBackgroundSettings(String requestJson) {
            if (!currentPage()) return;
            final JSONObject request = backgroundSettingsRequest(requestJson);
            if (request == null) return;
            main.post(() -> {
                if (!currentPage()) return;
                try {
                    JSONObject result = openBackgroundSettingsResult(request);
                    if (result == null || !currentPage()) return;
                    pageWebView.evaluateJavascript("window.onGardenBackgroundSettingsResult&&window.onGardenBackgroundSettingsResult(" + result + ")", null);
                } catch (org.json.JSONException invalid) { /* No fabricated launch result. */ }
            });
        }
        // Compatibility for older pages: the same guarded, fully caught launch path, with
        // no result callback. New pages use requestBackgroundSettings for actual outcomes.
        @JavascriptInterface public void openBackgroundSettings() {
            if (!currentPage()) return;
            main.post(() -> {
                if (!currentPage()) return;
                try { openBackgroundSettingsResult(null); }
                catch (org.json.JSONException invalid) { /* No result contract on the legacy method. */ }
            });
        }
    }
    @Override public void onBackPressed() {
        if (keyboardVisible) {
            InputMethodManager input = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            View focused = getCurrentFocus();
            if (input != null && focused != null) { input.hideSoftInputFromWindow(focused.getWindowToken(), 0); return; }
        }
        if (web != null) {
            web.evaluateJavascript("Boolean(window.onGardenBack&&window.onGardenBack())", handled -> {
                if (destroyed || "true".equals(handled)) return;
                if (web != null && web.canGoBack()) web.goBack(); else MainActivity.super.onBackPressed();
            });
        } else super.onBackPressed();
    }
    @Override public void onDestroy() {
        destroyed = true;
        stopSurfaceWebView = null; stopSurfaceOrigin = "";
        activityResumed = false; stopSessionFollow(); sessionFollowLane.stopAcceptingAndCancelActive();
        cancelPageReadyTimeout(); if (web != null) web.destroy(); super.onDestroy();
    }
}
