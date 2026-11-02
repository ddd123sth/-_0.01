package online.ainiannian.garden;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import android.system.Os;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import com.sun.jna.Function;
import com.sun.jna.NativeLibrary;
import com.sun.jna.StringArray;
import java.io.*;
import java.net.*;
import java.util.ArrayDeque;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.json.JSONArray;

public final class EngineService extends Service {
    private static final String CHANNEL = "local-automation";
    private static final int NOTIFICATION_ID = 1;
    private static final String SAFETY_PREFERENCES = "engine-safety";
    private static final String STOP_REQUESTED = "stop_requested";
    private static final String STOP_LATCH_ID = "stop_latch_id";
    private static final String ENGINE_DESIRED = "engine_desired";
    private static final String ENGINE_FAILURE_COUNT = "engine_failure_count";
    private static final String ENGINE_RETRY_AT_MS = "engine_retry_at_ms";
    private static final long[] ENGINE_RETRY_DELAYS_MS = { 5_000L, 10_000L, 20_000L, 30_000L };
    private static final long ENGINE_STARTUP_GRACE_MS = 60_000L;
    private static final long ENGINE_WATCHDOG_KILL_MS = 22_000L;
    private static final int ENGINE_HEALTH_FAILURE_LIMIT = 3;
    private static final long ENGINE_STABLE_RESET_MS = 60_000L;
    // Six five-second samples (30 s) of engine-reported overdue work. The engine's
    // health call already retries stalled stages itself, so only a state that survives
    // those retries reaches the controlled restart gate.
    private static final int PROGRESS_STALL_SAMPLE_LIMIT = 6;
    // A partial wake lock is held while work is in flight. A waiting account whose
    // next own deadline is further away than this is woken by its alarm instead of
    // keeping the process on the CPU for the whole wait.
    private static final long CPU_LOCK_HORIZON_MS = 30_000L;
    private static final long CPU_LOCK_TIMEOUT_MS = 60_000L;
    // The network sampler runs every second; a gap this large means the process was
    // frozen (Doze, freezer cgroup) and the last published fact may be stale.
    private static final long NETWORK_SAMPLE_GAP_MS = 10_000L;
    private volatile String cpuLockReason = "unknown";
    private volatile boolean forceNetworkReport;
    private boolean idleRefreshRegistered;
    private final BroadcastReceiver networkRefreshReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            // Republish the current observation once; the one-second sampler posts it.
            forceNetworkReport = true;
        }
    };
    private long lastNetworkSampleElapsedMs;
    // Milliseconds from sending the authenticated STOP to receiving its receipt.
    // Kept separate from the cleanup result: a fast commit is not a drain.
    private volatile long lastStopLatencyMs = -1L;
    private volatile long lastHealthSampleAtMs;
    private volatile String lastHealthPhase = "";
    private volatile String lastHealthCode = "";
    private volatile int progressStallSamples;
    private volatile long reconnectWakeAtMs;
    private volatile String reconnectSelection = "{}";
    // Native reconnect deadline projection (N-001): the engine publishes one complete
    // current-intent document and this process validates it before it may touch an alarm.
    private static final String PROJECTION_FILE = "reconnect-deadlines.json";
    private static final String PROJECTION_VERSION = "native-reconnect-deadlines/v1";
    private static final String PROJECTION_SCOPE_ALGORITHM = "java-name-uuid-md5-utf8-nul/v1";
    private static final int PROJECTION_MAX_BYTES = 128 * 1024;
    private static final int PROJECTION_MAX_ACCOUNTS = 256;
    private static final int PROJECTION_MAX_ATTEMPTS = 3;
    private static final long PROJECTION_RETRY_BACKOFF_MS = 15_000L;
    private static final java.util.Set<String> PROJECTION_PUBLISHER_STATES = new java.util.HashSet<>(java.util.Arrays.asList(
        "initializing", "ready", "draining", "closing"));
    private static final java.util.Set<String> PROJECTION_CONTROL_KINDS = new java.util.HashSet<>(java.util.Arrays.asList(
        "NONE", "USER_START", "STOP"));
    private static final java.util.Set<String> PROJECTION_STATES = new java.util.HashSet<>(java.util.Arrays.asList(
        "STOPPED", "STARTING", "CONNECTING", "SYNCHRONIZING", "RUNNABLE", "WAITING", "WAITING_NETWORK",
        "WAITING_LOGIN", "RECOVERING", "STOPPING", "SUSPENDED", "BLOCKED"));
    private static final java.util.regex.Pattern PROJECTION_UUID = java.util.regex.Pattern.compile(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", java.util.regex.Pattern.CASE_INSENSITIVE);
    private static final java.util.regex.Pattern PROJECTION_TEXT = java.util.regex.Pattern.compile("^[A-Za-z0-9_.:-]{1,256}$");
    private final Object projectionLock = new Object();
    // Reader handoff uses one lock: the pending and running flags are handed over atomically so
    // the last notification cannot be dropped when the loop exits.
    private final Object projectionQueueLock = new Object();
    private final ExecutorService projectionReader = Executors.newSingleThreadExecutor(r -> new Thread(r, "garden-reconnect-projection"));
    private boolean projectionReadRunning;
    private boolean projectionReadPending;
    private FileObserver projectionObserver;
    // Source version and appointment state are deliberately separate: a failed AlarmManager call
    // must not consume the version, and the same unchanged file stays retryable.
    private final AtomicLong projectionSourceSequence = new AtomicLong();
    private volatile long projectionAcceptedRevision = -1L;
    private volatile String projectionAcceptedGeneration = "";
    private volatile long projectionAcceptedSeq;
    private volatile long projectionScheduledRevision = -1L;
    private volatile String projectionScheduledKey = "";
    private volatile int projectionAttempts;
    private volatile long projectionNextAttemptElapsedMs;
    private volatile String projectionIntentKey = "";
    private volatile long projectionIntentDeadlineMs;
    private volatile String projectionIntentAccountRef = "";
    private volatile String projectionIntentScopeHash = "";
    private volatile long projectionIntentRunEpoch;
    private volatile long projectionLastScheduledDeadline;
    private volatile String projectionLastScheduledScope = "";
    private volatile String projectionState = "not-started";
    private volatile String projectionCode = "";
    // Observed absolute -> canonical pair for the last rejected path, published so a real device
    // rejection can be told apart from a theory. App-private paths only, no credentials.
    private volatile String projectionPathDetail = "";
    private volatile long projectionAcceptedAtMs;
    // Governing-source flag. True means the accepted document owns the decision, including an
    // explicit cancel, an overdue intent or a failed appointment. It is NOT "an alarm is set".
    private volatile boolean projectionAuthoritative;
    private volatile boolean projectionWatchOk;
    // Eligibility is granted only by a validated current file and is checked inside the decision
    // boundary so a stale retry cannot schedule after a source failure.
    private volatile boolean projectionSourceEligible;
    // attempt / read / validated are separate: a failed attempt never refreshes source eligibility.
    private volatile long projectionLastAttemptElapsedMs;
    private volatile long projectionLastReadElapsedMs;
    private volatile long projectionLastValidatedElapsedMs;
    private static final long PROJECTION_REREAD_MS = 60_000L;
    // An immutable accepted source: text, revision, generation and the monotonic order move together
    // and can never be mixed with a newer document.
    private static final class ProjectionSnapshot {
        final String text;
        final long revision;
        final String generation;
        final long sourceSeq;
        ProjectionSnapshot(String text, long revision, String generation, long sourceSeq) {
            this.text = text; this.revision = revision; this.generation = generation; this.sourceSeq = sourceSeq;
        }
    }
    private volatile ProjectionSnapshot projectionSnapshot;
    // Identity facts come from one real status response, published as one immutable snapshot so
    // software/control/pid/generation can never be mixed across responses.
    private static final class IdentitySnapshot {
        final JSONObject software;
        final JSONObject control;
        final int pid;
        final String generation;
        final long requestSeq;
        final long identityEpoch;
        final boolean authorized;
        IdentitySnapshot(JSONObject software, JSONObject control, int pid, String generation, long requestSeq,
                         long identityEpoch, boolean authorized) {
            this.software = software; this.control = control; this.pid = pid; this.generation = generation;
            this.requestSeq = requestSeq; this.identityEpoch = identityEpoch; this.authorized = authorized;
        }
    }
    private volatile IdentitySnapshot identitySnapshot;
    private PowerManager.WakeLock screen;
    private final Object stopLatchLock = new Object();
    private final ScheduledExecutorService monitor = Executors.newSingleThreadScheduledExecutor();
    private final ScheduledExecutorService healthMonitor = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "garden-health-monitor"));
    private final ScheduledExecutorService watchdogDeadlineMonitor = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "garden-watchdog-deadline"));
    private final ScheduledExecutorService recoveryJournalMonitor = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "garden-recovery-journal"));
    private final BoundedControlRequestLane recoveryJournalLane = new BoundedControlRequestLane("recovery-journal", () -> { });
    private final Object recoveryJournalLock = new Object();
    private static final int RECOVERY_JOURNAL_MAX_EVENTS = 64;
    private static final int RECOVERY_JOURNAL_MAX_BYTES = 64 * 1024;
    // One bounded HTTP drain may wait for its deadline while the other thread
    // still samples real network state on the independent one-second cycle.
    private final ScheduledExecutorService networkReporter = Executors.newScheduledThreadPool(2, r -> new Thread(r, "garden-network-reporter"));
    private PowerManager.WakeLock cpu;
    private ProcessCost processCost;
    private String lastProfileTransport;
    private boolean started;
    // Set only by a non-null app attach. It permits this service instance one
    // Node lifetime to deliver an existing STOP latch for its real ACK path.
    // A sticky/null restart never inherits this process-local permission.
    private volatile boolean allowStopDrainAttempt;
    private volatile boolean stopLatchClearCommitFailed;
    private volatile String stopLatchClearFailedId = "";
    // A foreground user start may supersede an older durable STOP. The new
    // command id is recorded by the backend before this process clears one
    // byte of the old latch, so a late old receipt cannot stop it.
    private volatile boolean userStartSupersedePending;
    private volatile String userStartSupersedeCommand = "";
    private volatile int userStartSupersedeEpoch;
    private volatile long engineAttemptStartedElapsedMs;
    private volatile boolean closing;
    private volatile int port;
    private volatile String token;
    private volatile String nativeGeneration = "";
    private volatile String nativeStartToken = "";
    private volatile String nativeStartNonce = "";
    private volatile String nativeOwnerRef = "";
    private volatile long startupGraceUntilElapsedMs;
    private final AtomicInteger consecutiveHealthMisses = new AtomicInteger();
    private volatile String lastHealthFailureCause = "health_transport_failure";
    private volatile int lastHealthHttpStatus;
    private volatile String lastHealthReadFailureKind;
    private final Object restartHealthSummaryLock = new Object();
    private final Object restartDecisionWriteLock = new Object();
    private volatile RestartHealthSummary restartHealthSummary = new RestartHealthSummary(0L, 0L, "", "", false,
        "", false, false, 0, "");
    private final AtomicBoolean watchdogRestartPending = new AtomicBoolean();
    private final AtomicBoolean restartRequestLaneUnhealthy = new AtomicBoolean();
    private volatile boolean healthLaneUnhealthy;
    private volatile boolean stopLaneUnhealthy;
    private volatile boolean lastControlHealthMatched;
    private volatile long healthStableSinceElapsedMs;
    private static final class HealthRequestSnapshot {
        final long startedAtMs, startedElapsedMs, finishedAtMs, durationMs;
        HealthRequestSnapshot(long startedAtMs, long startedElapsedMs, long finishedAtMs, long durationMs) {
            this.startedAtMs = startedAtMs; this.startedElapsedMs = startedElapsedMs;
            this.finishedAtMs = finishedAtMs; this.durationMs = durationMs;
        }
    }
    private static final class HealthProbe {
        final long id, startedElapsedMs, deadlineNanos;
        final CompletableFuture<JSONObject> completion = new CompletableFuture<>();
        volatile BoundedControlRequestLane.Attempt attempt;
        volatile JSONObject response;
        volatile Throwable failure;
        HealthProbe(long id, long startedElapsedMs, long deadlineNanos) {
            this.id=id; this.startedElapsedMs=startedElapsedMs; this.deadlineNanos=deadlineNanos;
        }
    }
    private static final class HealthProbeBusyException extends IOException {
        final HealthProbe owner;
        HealthProbeBusyException(HealthProbe owner) { super("health request already has an in-flight sample"); this.owner=owner; }
    }
    private static final class HealthProbeJoinNotObservedException extends IOException {
        HealthProbeJoinNotObservedException() { super("one-shot join probe did not overlap its exact health owner"); }
    }
    private static final class HealthBusyJoinDiagnostic {
        final long claimedAtUtcMs;
        final String generation;
        volatile HealthProbe ownerProbe;
        volatile BoundedControlRequestLane.Attempt admittedAttempt;
        volatile long ownerProbeId, attemptId, ownerStartedElapsedMs, ownerDeadlineNanos, observerElapsedMs;
        volatile long joinStartedElapsedMs, joinFinishedElapsedMs;
        volatile long joinEnteredNanos, joinFinishedNanos, remainingOriginalNanosAtJoinStart, originalAwaitEnteredNanos;
        volatile boolean observerEntered, joinerStartFailed, exactBusyCaught, originalAwaitEntered, joinedWithinOriginalDeadline;
        volatile boolean sameAttempt, sameDeadline, sameResponseObject, phaseKnown, nativeIdentityMatches, stopOrClosingObserved;
        volatile boolean responsePidMatches, responseGenerationMatches, responseStartNonceMatches, responseStartTokenMatches;
        volatile String outcome = "not-observed", errorKind = "";
        volatile int responsePid = -1, responseHttpStatus = -1;
        volatile String responseGeneration = "", responsePhase = "";
        volatile boolean responseReady, responseResponsive;
        HealthBusyJoinDiagnostic(long claimedAtUtcMs, String generation) {
            this.claimedAtUtcMs=claimedAtUtcMs; this.generation=generation;
        }
    }
    private static final class HealthProbeJoinInterruptedException extends InterruptedIOException {
        HealthProbeJoinInterruptedException() { super("health probe join interrupted"); }
    }
    private static final class HealthProbeOwnerUnavailableException extends IOException {
        final boolean probeDeadlineExpired;
        HealthProbeOwnerUnavailableException(boolean probeDeadlineExpired) {
            super(probeDeadlineExpired ? "health probe remained unresolved through its original deadline" :
                "health contention had no admitted probe owner");
            this.probeDeadlineExpired=probeDeadlineExpired;
        }
    }
    private static final class HealthDiagnosticsSnapshot {
        final long atMs;
        final String json;
        HealthDiagnosticsSnapshot(long atMs, String json) { this.atMs = atMs; this.json = json; }
    }
    private static final class RestartHealthSummary {
        final long successAtMs, failureAtMs;
        final String phase, code, gateState, failureKind;
        final boolean requiresRestart, gateDrained, gateMayInterrupt;
        final int cleanupPendingCount;
        RestartHealthSummary(long successAtMs, long failureAtMs, String phase, String code, boolean requiresRestart,
                String gateState, boolean gateDrained, boolean gateMayInterrupt, int cleanupPendingCount, String failureKind) {
            this.successAtMs = successAtMs; this.failureAtMs = failureAtMs; this.phase = phase; this.code = code;
            this.requiresRestart = requiresRestart; this.gateState = gateState; this.gateDrained = gateDrained;
            this.gateMayInterrupt = gateMayInterrupt; this.cleanupPendingCount = cleanupPendingCount; this.failureKind = failureKind;
        }
    }
    private final Object healthProbeLock = new Object();
    private final AtomicLong healthProbeSequence = new AtomicLong();
    private final ThreadLocal<HealthProbe> healthBusyJoinTargetForDiagnostic = new ThreadLocal<>();
    private final ThreadLocal<HealthBusyJoinDiagnostic> healthBusyJoinReceiptForDiagnostic = new ThreadLocal<>();
    private HealthProbe activeHealthProbe;
    private volatile HealthRequestSnapshot lastHealthRequest = new HealthRequestSnapshot(0L, 0L, 0L, 0L);
    private final ThreadLocal<HealthRequestSnapshot> healthRequestForCaller = new ThreadLocal<>();
    private volatile HealthDiagnosticsSnapshot lastSuccessfulHealthDiagnostics = new HealthDiagnosticsSnapshot(0L, "{}");
    private final BoundedControlRequestLane healthRequestLane = new BoundedControlRequestLane("health", () -> healthLaneUnhealthy = true);
    private final BoundedControlRequestLane stopRequestLane = new BoundedControlRequestLane("stop", () -> stopLaneUnhealthy = true);
    private final BoundedControlRequestLane restartRequestLane = new BoundedControlRequestLane("restart", () -> restartRequestLaneUnhealthy.set(true));
    private static final int MAX_PENDING_NETWORK_STATES = 64;
    private static final int NETWORK_RESPONSE_MAX_BYTES = 64 * 1024;
    private static final long NETWORK_REQUEST_MS = 5000L;
    private static final String NATIVE_NETWORK_SOURCE_INSTANCE = UUID.randomUUID().toString();
    private static final AtomicLong NETWORK_OBSERVATION_SEQUENCE = new AtomicLong();
    private final Object networkLock = new Object();
    private final ArrayDeque<NetworkObservation> pendingNetworkStates = new ArrayDeque<>();
    private NetworkObservation lastNetwork;
    private Network callbackDefaultNetwork;
    private boolean receivedNetworkCallback;
    private long networkCallbackVersion;
    private boolean networkSyncQueued;
    private long networkRetryAfterElapsedMs;
    private final AtomicBoolean networkHttpBusy = new AtomicBoolean();
    private volatile FutureTask<JSONObject> networkHttpTask;
    private volatile HttpURLConnection networkHttpConnection;
    private JSONObject pendingNetworkDiagnostic;
    private boolean networkDiagnosticQueued;
    private ConnectivityManager connectivity;
    private boolean wifiReceiverRegistered;
    private static final class NetworkObservation {
        final DeviceProfile.NetworkState state;
        final long sequence, observedAtMs, observedElapsedMs;
        final String source;
        NetworkObservation(DeviceProfile.NetworkState state, String source, long observedAtMs, long observedElapsedMs) {
            this.state = state; this.source = source; this.observedAtMs = observedAtMs; this.observedElapsedMs = observedElapsedMs;
            this.sequence = NETWORK_OBSERVATION_SEQUENCE.incrementAndGet();
        }
        JSONObject payload() throws Exception {
            return new JSONObject().put("online", state.online).put("transport", state.transport)
                .put("nativeSourceInstance", NATIVE_NETWORK_SOURCE_INSTANCE).put("observationSequence", sequence)
                .put("nativeObservedAtMs", observedAtMs).put("nativeObservedElapsedMs", observedElapsedMs).put("nativeSource", source);
        }
    }
    private final BroadcastReceiver wifiStateReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (closing || intent == null || !WifiManager.WIFI_STATE_CHANGED_ACTION.equals(intent.getAction())) return;
            final int state = intent.getIntExtra(WifiManager.EXTRA_WIFI_STATE, WifiManager.WIFI_STATE_UNKNOWN);
            if (state != WifiManager.WIFI_STATE_DISABLED && state != WifiManager.WIFI_STATE_DISABLING) return;
            final long at = System.currentTimeMillis(), elapsed = SystemClock.elapsedRealtime(), version;
            synchronized (networkLock) { version = ++networkCallbackVersion; }
            try { networkReporter.execute(() -> observeWifiBroadcast(state, version, at, elapsed)); }
            catch (RejectedExecutionException stopped) { /* A closing reporter cannot create new network work. */ }
        }
    };
    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            synchronized (networkLock) {
                if (closing) return;
                callbackDefaultNetwork = network;
                receivedNetworkCallback = true;
                networkCallbackVersion++;
                // API 26+ supplies the ordered capabilities callback immediately afterwards.
            }
        }
        @Override public void onLost(Network network) {
            synchronized (networkLock) {
                if (closing || !network.equals(callbackDefaultNetwork)) return;
                callbackDefaultNetwork = null;
                receivedNetworkCallback = true;
                networkCallbackVersion++;
            }
            // A default-network handover (for example WiFi -> the optional VPN
            // -> WiFi) loses the old network before the new one is reported.
            // Re-query instead of claiming offline: a real loss still fails the
            // query and is recorded as offline by syncNetwork().
            syncNetwork();
        }
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
            synchronized (networkLock) {
                if (closing || !network.equals(callbackDefaultNetwork)) return;
                networkCallbackVersion++;
                enqueueNetworkStateLocked(DeviceProfile.networkState(network, caps), "default-network-callback", System.currentTimeMillis(), SystemClock.elapsedRealtime());
            }
        }
    };
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL, "本机自动化运行状态", NotificationManager.IMPORTANCE_LOW));
        Notification initial = notification("正在准备手机执行器");
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, initial, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, initial);
        cpu = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "garden:automation");
        cpu.setReferenceCounted(false);
        // Optional screen-on mode. Default off; it is a separate user choice and is never
        // used as a substitute for the CPU lock the engine actually needs.
        screen = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK, "garden:screen");
        screen.setReferenceCounted(false);
        processCost = new ProcessCost(this);
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        connectivity.registerDefaultNetworkCallback(networkCallback);
        IntentFilter wifiChanges = new IntentFilter(WifiManager.WIFI_STATE_CHANGED_ACTION);
        // This protected system broadcast can originate outside this UID;
        // its disabled state is independently checked against real WIFI APIs.
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(wifiStateReceiver, wifiChanges, Context.RECEIVER_EXPORTED);
        else registerReceiver(wifiStateReceiver, wifiChanges);
        wifiReceiverRegistered = true;
        // A periodic task that throws is cancelled for the rest of the process by the
// executor. One transient failure during a platform transition must not stop
// the network reporter, the status sampler or the health sampler: the network
// observation is what lets the engine resume after Doze withholds a change.
        // Doze suspends the app's network access without changing the platform's
        // reported network, so an unchanged observation is the only way to withdraw
        // a stale offline fact the engine recorded. Leaving idle or waking the screen
        // republishes the current observation once.
        IntentFilter idleChanges = new IntentFilter(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED);
        idleChanges.addAction(Intent.ACTION_SCREEN_ON);
        try { registerReceiver(networkRefreshReceiver, idleChanges); idleRefreshRegistered = true; }
        catch (RuntimeException unavailable) { idleRefreshRegistered = false; }
        networkReporter.scheduleWithFixedDelay(periodic("network-sync", this::syncNetwork), 1, 1, TimeUnit.SECONDS);
        recoveryJournalMonitor.scheduleWithFixedDelay(periodic("recovery-journal", this::flushRecoveryJournal), 10, 10, TimeUnit.SECONDS);
    }
    private Notification notification(String message) {
        return notification(message, true);
    }
    // 没号在跑也没号在等的时候，通知上不留「停止本机任务」：按下去无事可停就是一颗假控件。
    private Notification notification(String message, boolean canStop) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, EngineService.class).setAction("STOP"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_myplaces)
            .setContentTitle("无尽夏").setContentText(message).setContentIntent(open)
            .setOngoing(true);
        if (canStop) builder.addAction(new Notification.Action.Builder(null, "停止本机任务", stop).build());
        return builder.build();
    }
    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (BuildConfig.DEBUG) {
            android.util.Log.i("GardenControl", "engine-start pid=" + android.os.Process.myPid()
                + " action=" + (intent == null ? "null" : intent.getAction())
                + " auto=" + (intent != null && intent.getBooleanExtra(KeepAlive.EXTRA_AUTO_RECONNECT, false))
                + " started=" + started
                + " stop=" + safetyPreferences().getBoolean(KeepAlive.STOP_REQUESTED, false)
                + " desired=" + safetyPreferences().getBoolean(KeepAlive.ENGINE_DESIRED, false));
        }
        if (intent != null && KeepAlive.ACTION_RECONNECT_DUE.equals(intent.getAction())) {
            if (!acceptReconnectDelivery(intent)) {
                if (!started) new Handler(Looper.getMainLooper()).post(() -> {
                    if (!started && stopSelfResult(id)) stopForeground(STOP_FOREGROUND_REMOVE);
                });
                return started ? START_STICKY : START_NOT_STICKY;
            }
            intent.setAction(KeepAlive.ACTION_RECOVER).putExtra(KeepAlive.EXTRA_REASON, "reconnect_due");
            if (started) {
                try { monitor.execute(this::refreshStatus); }
                catch (RejectedExecutionException ignored) { }
            }
        }
        boolean userStart = intent != null && intent.getBooleanExtra(KeepAlive.EXTRA_USER_START, false);
        boolean stopAction = intent != null && "STOP".equals(intent.getAction());
        boolean durableStopPending = safetyPreferences().getBoolean(KeepAlive.STOP_REQUESTED, false);
        if (!userStart && !stopAction && (durableStopPending
                || !started && KeepAlive.backendStopBlocksPassive(this))) {
            // A pending STOP, or a backend-durable STOP that outlived unwritable
            // local preferences, owns the decision. Only an explicit foreground
            // user start may reopen it.
            stopWithoutRecovery();
            return START_NOT_STICKY;
        }
        if (intent != null && "STOP".equals(intent.getAction())) {
            // The user's STOP owns the decision: retire the self-check alarm and bump the
            // control epoch so an already-queued alarm or boot broadcast cannot revive it.
            KeepAlive.cancelSelfCheck(this);
            KeepAlive.bumpEpoch(this);
            shutdown();
            return START_NOT_STICKY;
        }
        // Passive recovery must never establish or clear user intent, and a stale epoch
        // means a STOP (or a newer start) already replaced the decision that asked for it.
        if (intent != null && KeepAlive.ACTION_RECOVER.equals(intent.getAction())) {
            int epoch = intent.getIntExtra(KeepAlive.EXTRA_EPOCH, -1);
            if (!KeepAlive.engineAllowed(this) || (epoch >= 0 && epoch != KeepAlive.epoch(this))) {
                // A stale/denied passive request may not tear down an engine that is already
                // running the current decision. Only a service created solely for this
                // request stops itself; a live service ignores it.
                if (started) return START_STICKY;
                stopWithoutRecovery();
                return START_NOT_STICKY;
            }
        }
        if (intent != null && intent.hasExtra(KeepAlive.EXTRA_SCREEN_ON)) {
            applyScreenWakeLock(intent.getBooleanExtra(KeepAlive.EXTRA_SCREEN_ON, false));
        }
        if (!started) {
            started = true;
            // A system restart may deliver a non-null Intent with no action. Only an
            // action or an explicit user-start marker is a user decision; otherwise a
            // STOP latch must win over the passive restart.
            boolean explicitStart = intent != null && (intent.getAction() != null
                || intent.getBooleanExtra(KeepAlive.EXTRA_USER_START, false));
            long delayMs;
            synchronized (stopLatchLock) {
                SharedPreferences preferences = safetyPreferences();
                boolean stopPending = preferences.getBoolean(STOP_REQUESTED, false);
                boolean automaticReconnect = intent != null && intent.getBooleanExtra(KeepAlive.EXTRA_AUTO_RECONNECT, false);
                if (automaticReconnect && (stopPending || !preferences.getBoolean(ENGINE_DESIRED, false))) {
                    // An automatic reconnect resumes an existing desire; it never creates one.
                    // In particular it must not run after an acknowledged STOP cleared the latch.
                    stopWithoutRecovery();
                    return START_NOT_STICKY;
                }
                if (!explicitStart && stopPending) {
                    preferences.edit().putBoolean(ENGINE_DESIRED, false).commit();
                    stopWithoutRecovery();
                    return START_NOT_STICKY;
                }
                if (explicitStart) {
                    // MainActivity's attach intents are not a retry/reset signal.
                    // They may establish the service intent and one STOP-drain
                    // attempt, but never clear a durable backoff or STOP latch.
                    // A foreground user start is still allowed to run a
                    // management engine when every local store is unwritable;
                    // it simply cannot claim a durable running desire.
                    if (!preferences.edit().putBoolean(ENGINE_DESIRED, true).commit()) {
                        writeStartupFailure("本机运行意愿未能耐久保存，当前以前台管理界面维持");
                    }
                    allowStopDrainAttempt = stopPending;
                    if (stopPending || KeepAlive.backendStopBlocksPassive(this)) {
                        int epoch = KeepAlive.bumpEpoch(this);
                        if (epoch <= 0) epoch = KeepAlive.epoch(this);
                        userStartSupersedeEpoch = Math.max(0, epoch);
                        if (userStartSupersedeCommand.isEmpty())
                            userStartSupersedeCommand = java.util.UUID.randomUUID().toString();
                        userStartSupersedePending = true;
                    }
                } else if (!preferences.getBoolean(ENGINE_DESIRED, false)) {
                    stopWithoutRecovery();
                    return START_NOT_STICKY;
                }
                long retryAt = preferences.getLong(ENGINE_RETRY_AT_MS, 0L);
                delayMs = Math.max(0L, Math.min(ENGINE_RETRY_DELAYS_MS[ENGINE_RETRY_DELAYS_MS.length - 1], retryAt - System.currentTimeMillis()));
            }
            if (delayMs > 0L) {
                updateForegroundStatus("执行器异常，约 " + Math.max(1L, (delayMs + 999L) / 1000L) + " 秒后自动恢复");
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (!closing && (!stopRequested() || allowStopDrainAttempt)
                            && safetyPreferences().getBoolean(ENGINE_DESIRED, false)) {
                        new Thread(this::launchEngine, "garden-runtime").start();
                    } else if (!closing) {
                        stopWithoutRecovery();
                    }
                }, delayMs);
            } else {
                new Thread(this::launchEngine, "garden-runtime").start();
            }
        }
        // START_STICKY is the primary recovery mechanism; the alarm is the backstop
        // for devices that defer or refuse the sticky restart.
        KeepAlive.scheduleSelfCheck(this, false);
        reportEngineState(started ? "running" : "created", -1, -1);
        return START_STICKY;
    }
    private void applyScreenWakeLock(boolean on) {
        try {
            if (on) {
                if (screen != null && !screen.isHeld()) screen.acquire(30 * 60 * 1000L);
            } else if (screen != null && screen.isHeld()) screen.release();
        } catch (RuntimeException unavailable) { /* The setting stays reported as requested but unheld. */ }
    }
    private void syncScreenWakeLockFromPreferences() {
        try { applyScreenWakeLock(KeepAlive.controlPreferences(this).getBoolean(KeepAlive.SCREEN_KEEP_ON, false)); }
        catch (RuntimeException unavailable) { /* Leave the current state. */ }
    }
    @Override public void onTaskRemoved(Intent rootIntent) {
        // The service is declared stopWithTask=false, so swiping the task must not stop it.
        // A short extra check covers hosts that kill the process right after removal.
        if (!closing && KeepAlive.engineAllowed(this)) KeepAlive.scheduleCheckAfter(this, 20_000L);
        super.onTaskRemoved(rootIntent);
    }
    private void noteLockReason(boolean inFlight, int pending, boolean armedFarAhead) {
        cpuLockReason = inFlight ? "in-flight-work"
            : pending > 0 ? (armedFarAhead ? "released-own-alarm-armed" : "waiting-near-deadline") : "idle";
    }
    /**
     * A periodic task that throws is cancelled for the rest of the process by a
     * ScheduledExecutorService. One transient failure during a platform
     * transition must not stop the network reporter, the status sampler or the
     * health sampler; the network observation is what lets the engine resume
     * after Doze withholds a connectivity change.
     */
    private Runnable periodic(String name, Runnable work) {
        return () -> {
            try { work.run(); }
            catch (Throwable failed) {
                try { android.util.Log.i("GardenControl", name + "-periodic-failed " + failed.getClass().getSimpleName()); }
                catch (Throwable ignored) { }
            }
        };
    }
    private void reportEngineState(String state, int active, int pending) {
        try {
            JSONObject reconnect = KeepAlive.reconnectAlarmState(this);
            reconnectWakeAtMs = reconnect.optBoolean("scheduled", false) ? reconnect.optLong("triggerAtMs", 0L) : 0L;
            JSONObject doc = new JSONObject().put("state", state)
                .put("generation", nativeGeneration)
                .put("startToken", nativeStartToken)
                .put("healthMatched", lastControlHealthMatched)
                .put("healthLaneBusy", healthRequestLane.isBusy())
                .put("healthLaneHealthy", healthRequestLane.isHealthy())
                .put("stopLaneBusy", stopRequestLane.isBusy())
                .put("lastHealthFailureCause", lastHealthFailureCause)
                .put("lastHealthSampleAtMs", lastHealthSampleAtMs)
                .put("phase", lastHealthPhase).put("code", lastHealthCode)
                .put("failureCount", safetyPreferences().getInt(ENGINE_FAILURE_COUNT, 0))
                .put("retryAtMs", safetyPreferences().getLong(ENGINE_RETRY_AT_MS, 0L))
                .put("stallSamples", progressStallSamples)
                .put("desired", safetyPreferences().getBoolean(ENGINE_DESIRED, false))
                .put("stopRequested", stopRequested())
                .put("wakeLockHeld", cpu != null && cpu.isHeld())
                .put("cpuLockReason", cpuLockReason)
                .put("lastStopLatencyMs", lastStopLatencyMs)
                .put("screenWakeHeld", screen != null && screen.isHeld())
                .put("reconnectWakeAtMs", reconnectWakeAtMs)
                .put("reconnectSelection", new JSONObject(reconnectSelection))
                .put("reconnectAlarm", KeepAlive.reconnectAlarmState(this))
                .put("reconnectProjection", reconnectProjectionStatus())
                .put("backendStopControl", KeepAlive.nativeControlState(this))
                .put("passiveRecoveryBlocked", KeepAlive.backendStopBlocksPassive(this))
                .put("userStartEpoch", safetyPreferences().getInt(KeepAlive.USER_START_EPOCH, 0))
                .put("runningCount", active).put("pendingCount", pending);
            // One merged sample: the cost block rides on the existing fifteen-second
            // write instead of adding another file write per cycle.
            if (processCost != null) doc.put("cost", processCost.sample());
            JSONObject cycle = ReconnectTiming.latest(this);
            if (cycle != null) doc.put("reconnectTiming", cycle);
            KeepAlive.writeEngineState(this, doc);
        } catch (Exception ignored) { /* Status reporting never gates the engine. */ }
    }
    private void updateForegroundStatus(String message) {
        Notification note = notification(message);
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, note);
    }
    private void stopWithoutRecovery() {
        new Handler(Looper.getMainLooper()).post(() -> {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        });
    }
    private void writeStartupFailure(String message) {
        try { PrivateFiles.write(new File(getFilesDir(), "engine-error.json"), new JSONObject().put("message", message).toString()); }
        catch (Exception ignored) { }
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(message, false));
    }
    private long reserveEngineAttempt() throws IOException {
        synchronized (stopLatchLock) {
            SharedPreferences preferences = safetyPreferences();
            if (closing || (stopRequested() && !allowStopDrainAttempt)
                    || !preferences.getBoolean(ENGINE_DESIRED, false)) return -1L;
            int previous = Math.max(0, preferences.getInt(ENGINE_FAILURE_COUNT, 0));
            int attempt = Math.min(ENGINE_RETRY_DELAYS_MS.length, previous + 1);
            long delay = ENGINE_RETRY_DELAYS_MS[attempt - 1];
            long retryAt = System.currentTimeMillis() + delay;
            if (!preferences.edit().putInt(ENGINE_FAILURE_COUNT, attempt).putLong(ENGINE_RETRY_AT_MS, retryAt).commit()) {
                throw new IOException("本机恢复退避状态未能持久保存");
            }
            engineAttemptStartedElapsedMs = SystemClock.elapsedRealtime();
            return delay;
        }
    }
    private SharedPreferences safetyPreferences() { return getSharedPreferences(SAFETY_PREFERENCES, MODE_PRIVATE); }
    private boolean stopRequested() {
        return stopLatchClearCommitFailed || safetyPreferences().getBoolean(STOP_REQUESTED, false);
    }
    private String pendingStopLatchId() throws IOException {
        synchronized (stopLatchLock) {
            SharedPreferences preferences = safetyPreferences();
            if (!stopRequested()) return "";
            String latchId = preferences.getString(STOP_LATCH_ID, "");
            if (latchId.isEmpty() && stopLatchClearCommitFailed) latchId = stopLatchClearFailedId;
            // Upgrade an existing boolean latch durably before passing it to
            // Node. Missing IDs never authorize clearing the old STOP request.
            if (latchId.isEmpty()) {
                latchId = UUID.randomUUID().toString();
                if (!preferences.edit().putBoolean(STOP_REQUESTED, true).putString(STOP_LATCH_ID, latchId).commit()) {
                    throw new IOException("Pending stop identity could not be persisted");
                }
            }
            if (!UUID.fromString(latchId).toString().equals(latchId)) throw new IOException("Pending stop identity is invalid");
            return latchId;
        }
    }
    private void clearConfirmedStopLatch(JSONObject status) {
        synchronized (stopLatchLock) {
            // Serialize with shutdown: an earlier status cannot clear a later STOP.
            if (closing || !stopRequested()) return;
            String latchId = safetyPreferences().getString(STOP_LATCH_ID, "");
            if (latchId.isEmpty() && stopLatchClearCommitFailed) latchId = stopLatchClearFailedId;
            JSONObject receipt = status.optJSONObject("nativeStop"), readiness = status.optJSONObject("engineReadiness");
            if (latchId.isEmpty() || receipt == null || readiness == null
                    || !latchId.equals(receipt.optString("latchId", ""))
                    || !Boolean.TRUE.equals(receipt.opt("stopCommitted")) || !Boolean.TRUE.equals(receipt.opt("cleanupComplete"))
                    || receipt.optInt("pid", -1) != android.os.Process.myPid()
                    || readiness.optInt("pid", -1) != android.os.Process.myPid()) return;
            String instance = readiness.optString("instanceId", "");
            if (instance.isEmpty() || !instance.equals(receipt.optString("instanceId", ""))) return;
            // commit(), not apply(): cancellation must survive immediate process exit.
            if (!safetyPreferences().edit().remove(STOP_REQUESTED).remove(STOP_LATCH_ID)
                    .remove(KeepAlive.STOP_LATCH_EPOCH).commit()) {
                // commit() may have updated the in-memory map even if its disk
                // write failed. Keep this process fenced and restore the latch
                // in memory/durable storage before allowing any later start.
                stopLatchClearCommitFailed = true;
                stopLatchClearFailedId = latchId;
                safetyPreferences().edit().putBoolean(STOP_REQUESTED, true).putString(STOP_LATCH_ID, latchId).commit();
                return;
            }
            stopLatchClearCommitFailed = false;
            stopLatchClearFailedId = "";
        }
    }
    /**
     * A foreground user start supersedes an older STOP only after the backend
     * has durably recorded the ordered USER_START control. Until then the old
     * latch and the backend STOP fence keep passive recovery closed.
     */
    private void confirmUserStartControl() {
        if (!userStartSupersedePending) return;
        String command = userStartSupersedeCommand;
        if (command == null || command.isEmpty()) return;
        int epoch = userStartSupersedeEpoch;
        try {
            JSONObject response = request("POST", "/api/local/native-start", new JSONObject()
                .put("commandId", command).put("sourceGeneration", nativeGeneration)
                .put("sourceInstance", getPackageName() + ":" + android.os.Process.myPid())
                .put("requestedAtMs", System.currentTimeMillis()));
            if (!command.equals(response.optString("commandId", "")) || !response.optBoolean("ok", false)) return;
            long controlSeq = response.optLong("controlSeq", 0L);
            KeepAlive.recordUserStartControl(this, command, controlSeq, epoch);
            userStartSupersedePending = false;
            userStartSupersedeCommand = "";
            synchronized (stopLatchLock) {
                if (KeepAlive.clearSupersededStopLatch(this, epoch, controlSeq)) {
                    stopLatchClearCommitFailed = false;
                    stopLatchClearFailedId = "";
                }
            }
        } catch (Exception retry) { /* The next fifteen-second sample retries the same command. */ }
    }
    private void launchEngine() {
        try {
            if (reserveEngineAttempt() < 0L) {
                if (!closing) stopWithoutRecovery();
                return;
            }
            PrivateFiles.write(new File(getFilesDir(), "engine-error.json"), "{}");
            File engine = new File(getFilesDir(), "engine");
            PrivateFiles.extract(this, engine);
            // Bounded private-file pass before this generation writes anything:
            // probe captures, restart receipts and stale SQLite scratch.
            DiagnosticStorage.boundPrivateStorage(this);
            File data = new File(getFilesDir(), "data"); if (!data.isDirectory() && !data.mkdirs()) throw new IOException("本机数据目录不可写");
            File sqliteTmp = new File(getCacheDir().getCanonicalFile(), "sqlite");
            if (!sqliteTmp.getCanonicalFile().equals(sqliteTmp) || (!sqliteTmp.isDirectory() && !sqliteTmp.mkdir())) {
                throw new IOException("本机数据库临时目录不可写");
            }
            Os.chmod(sqliteTmp.getAbsolutePath(), 0700);
            File profile = new File(getFilesDir(), "device-profile.json");
            PrivateFiles.write(profile, DeviceProfile.capture(this).toString());
            try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { port = socket.getLocalPort(); }
            token = PrivateFiles.randomHex(32);
            synchronized (stopLatchLock) {
                nativeGeneration = UUID.randomUUID().toString();
                reconnectWakeAtMs = 0L;
                KeepAlive.cancelReconnectWakeup(this, "new-engine-generation");
            }
            nativeStartNonce = PrivateFiles.randomHex(32);
            nativeStartToken = readSelfProcessStartToken();
            if (nativeStartToken.isEmpty()) throw new IOException("Engine process start ticks are unavailable");
            startupGraceUntilElapsedMs = SystemClock.elapsedRealtime() + ENGINE_STARTUP_GRACE_MS;
            consecutiveHealthMisses.set(0); watchdogRestartPending.set(false);
            progressStallSamples = 0;
            reconnectWakeAtMs = 0L;
            syncScreenWakeLockFromPreferences();
            reportEngineState("launching", -1, -1);
            Os.setenv("DATA_DIR", data.getAbsolutePath(), true);
            Os.setenv("GARDEN_NATIVE_LIBRARY_DIR", getApplicationInfo().nativeLibraryDir, true);
            Os.setenv("SQLITE_TMPDIR", sqliteTmp.getAbsolutePath(), true);
            Os.setenv("GARDEN_LOCAL_TOKEN", token, true);
            Os.setenv("GARDEN_NATIVE_GENERATION", nativeGeneration, true);
            Os.setenv("GARDEN_NATIVE_START_TOKEN", nativeStartToken, true);
            Os.setenv("GARDEN_NATIVE_START_NONCE", nativeStartNonce, true);
            Os.setenv("GARDEN_LOCAL_PORT", Integer.toString(port), true);
            Os.setenv("GARDEN_ANDROID_DEVICE_PROFILE", profile.getAbsolutePath(), true);
            Os.setenv("GARDEN_CREDENTIAL_KEY", PrivateFiles.credentialKey(this), true);
            Os.setenv("GARDEN_WORLD_TRANSPORT", "node", true);
            Os.setenv("GARDEN_LOCAL_NATIVE", "1", true);
            // The event-loop stall test route exists only in debug builds.
            if (BuildConfig.DEBUG) Os.setenv("GARDEN_DEBUG_TOOLS", "1", true);
            Os.setenv("GARDEN_LOCAL_STOP_FILE", new File(getFilesDir(), "user-stop-request.json").getAbsolutePath(), true);
            Os.setenv("GARDEN_LOCAL_ACCOUNT_STOP_DIR", new File(getFilesDir(), "account-stop-requests").getAbsolutePath(), true);
            String stopLatchId = pendingStopLatchId();
            Os.setenv("GARDEN_LOCAL_STOP_REQUESTED", stopLatchId.isEmpty() ? "0" : "1", true);
            Os.setenv("GARDEN_LOCAL_STOP_LATCH_ID", stopLatchId, true);
            Os.setenv("GARDEN_APP_VERSION", packageVersion(), true);
            String cloudUrl = cloudBaseUrl();
            if (!cloudUrl.isEmpty()) Os.setenv("GARDEN_SOFTWARE_BASE_URL", cloudUrl, true);
            Os.setenv("NODE_ENV", "production", true);
            PrivateFiles.write(new File(getFilesDir(), "engine-session.json"), new JSONObject().put("port", port)
                .put("token", token).put("pid", android.os.Process.myPid()).put("processGeneration", nativeGeneration)
                .put("processStartNonce", nativeStartNonce).put("processStartToken", nativeStartToken).put("state", "starting").toString());
            monitor.scheduleWithFixedDelay(periodic("status", this::refreshStatus), 1, 15, TimeUnit.SECONDS);
            startReconnectProjection();
            healthMonitor.scheduleAtFixedRate(periodic("health", this::refreshHealth), 5, 5, TimeUnit.SECONDS);
            try { System.loadLibrary("c++_shared"); } catch (UnsatisfiedLinkError optional) { /* libnode may link its C++ runtime statically. */ }
            NativeLibrary node = NativeLibrary.getInstance(new File(getApplicationInfo().nativeLibraryDir, "libnode.so").getAbsolutePath());
            Function start = node.getFunction("_ZN4node5StartEiPPc");
            String[] nodeArguments = nativeNodeArguments(engine);
            StringArray args = new StringArray(nodeArguments, "UTF-8");
            startupGraceUntilElapsedMs = SystemClock.elapsedRealtime() + ENGINE_STARTUP_GRACE_MS;
            int code = start.invokeInt(new Object[] { nodeArguments.length, args });
            if (!closing) { recordRecoveryEvent("engine_exited", Math.max(1, safetyPreferences().getInt(ENGINE_FAILURE_COUNT, 1))); failure("本机执行器已结束（" + code + "），请重新打开应用"); }
        } catch (Throwable error) {
            recordRecoveryEvent("engine_start_failed", Math.max(1, safetyPreferences().getInt(ENGINE_FAILURE_COUNT, 1)));
            try { PrivateFiles.write(new File(getFilesDir(), "engine-diagnostic.json"), new JSONObject().put("errorType", error.getClass().getSimpleName()).toString()); } catch (Exception ignored) { }
            if (!closing) failure("本机执行器启动失败，请重新打开应用重试");
        }
    }
    /**
     * Consume one fixed, app-private diagnostic request before passing profiler flags to Node.
     * Any diagnostic setup failure falls back to the normal two-argument node::Start invocation.
     */
    private String[] nativeNodeArguments(File engine) {
        String script = new File(engine, "android/server.mjs").getAbsolutePath();
        String[] normal = new String[] { "node", script };
        try {
            String profileLog = consumeV8TickProfileRequest();
            if (profileLog == null) return normal;
            return new String[] { "node", "--prof", "--logfile=" + profileLog, script };
        } catch (Exception diagnosticFailure) {
            return normal;
        }
    }

    private String consumeV8TickProfileRequest() throws Exception {
        final String expectedMode = "v8-tick-profile-once-v1";
        File files = getFilesDir().getCanonicalFile();
        File request = new File(files, "v8-tick-profile-request.json");
        if (!request.isFile() || !request.getCanonicalFile().equals(request.getAbsoluteFile())) return null;

        File profileRoot = new File(files, "diagnostics/v8-tick-profile").getCanonicalFile();
        String rootPrefix = files.getPath() + File.separator;
        if (!profileRoot.getPath().startsWith(rootPrefix)) return null;
        // A capture is admitted only while the probe root is inside its hard cap;
        // the oldest capture is reclaimed first, never the running generation's.
        DiagnosticStorage.pruneProbeCaptures(files, nativeGeneration);
        if (!DiagnosticStorage.admitProfileCapture(profileRoot)) return null;
        File profileDir = new File(profileRoot, nativeGeneration).getCanonicalFile();
        if (!profileDir.getPath().startsWith(profileRoot.getPath() + File.separator)) return null;
        if (!profileDir.isDirectory() && !profileDir.mkdirs()) return null;
        Os.chmod(profileRoot.getPath(), 0700);
        Os.chmod(profileDir.getPath(), 0700);

        File claimed = new File(profileDir, "request-claimed.json");
        if (claimed.exists() || !request.renameTo(claimed)) return null;
        Os.chmod(claimed.getPath(), 0600);

        boolean valid = false;
        try {
            if (claimed.length() > 0 && claimed.length() <= 512) {
                byte[] bytes = new byte[(int) claimed.length()];
                try (FileInputStream input = new FileInputStream(claimed)) {
                    int offset = 0;
                    while (offset < bytes.length) {
                        int count = input.read(bytes, offset, bytes.length - offset);
                        if (count < 0) break;
                        offset += count;
                    }
                    valid = offset == bytes.length;
                }
                if (valid) {
                    JSONObject body = new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
                    java.util.Iterator<String> keys = body.keys();
                    int keyCount = 0;
                    while (keys.hasNext()) { keys.next(); keyCount++; }
                    valid = keyCount == 2 && expectedMode.equals(body.optString("mode", ""))
                        && Boolean.TRUE.equals(body.opt("once"));
                }
            }
        } catch (Exception invalidRequest) {
            valid = false;
        }

        File consumed = new File(profileDir, valid ? "request-consumed.json" : "request-rejected.json");
        if (consumed.exists() || !claimed.renameTo(consumed)) return null;
        Os.chmod(consumed.getPath(), 0600);
        if (!valid) return null;

        File log = new File(profileDir, "v8.log").getCanonicalFile();
        if (!log.getPath().startsWith(profileDir.getPath() + File.separator)) return null;
        File metadata = new File(profileDir, "profile-run.json");
        PrivateFiles.write(metadata, new JSONObject().put("mode", expectedMode)
            .put("processGeneration", nativeGeneration).put("pid", android.os.Process.myPid())
            .put("nativeStartUtcMs", System.currentTimeMillis()).put("profileLogArgument", log.getAbsolutePath()).toString());
        Os.chmod(metadata.getPath(), 0600);
        return log.getAbsolutePath();
    }

    private String packageVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception missing) { return "0.1.0"; }
    }
    // The cloud address is per-installation configuration and never baked into the APK:
    // writing files/cloud-url.txt points this phone at the project's own service.
    private String cloudBaseUrl() {
        try {
            File file = new File(getFilesDir(), "cloud-url.txt");
            if (file.isFile()) return PrivateFiles.text(file).trim();
            return BuildConfig.CLOUD_URL_DEFAULT == null ? "" : BuildConfig.CLOUD_URL_DEFAULT.trim();
        } catch (Exception unreadable) { return ""; }
    }
    private void failure(String message) {
        if (BuildConfig.DEBUG) android.util.Log.i("GardenControl", "engine-failure message=" + message + " closing=" + closing);
        if (cpu != null && cpu.isHeld()) cpu.release();
        if (screen != null && screen.isHeld()) screen.release();
        try { PrivateFiles.write(new File(getFilesDir(), "engine-error.json"), new JSONObject().put("message", message).toString()); } catch (Exception ignored) { }
        boolean restartInFreshProcess = false;
        long delayMs = 0L;
        synchronized (stopLatchLock) {
            SharedPreferences preferences = safetyPreferences();
            if (!closing && !stopRequested() && preferences.getBoolean(ENGINE_DESIRED, false)) {
                int attempts = Math.max(1, Math.min(ENGINE_RETRY_DELAYS_MS.length, preferences.getInt(ENGINE_FAILURE_COUNT, 1)));
                delayMs = ENGINE_RETRY_DELAYS_MS[attempts - 1];
                long retryAt = System.currentTimeMillis() + delayMs;
                restartInFreshProcess = preferences.edit().putInt(ENGINE_FAILURE_COUNT, attempts)
                    .putLong(ENGINE_RETRY_AT_MS, retryAt).commit();
            }
        }
        if (restartInFreshProcess) {
            long seconds = Math.max(1L, (delayMs + 999L) / 1000L);
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID,
                notification(message + "；约 " + seconds + " 秒后在新进程恢复"));
            // node::Start is a process lifetime entry point here; never call it a
            // second time in this process. Keep the sticky FGS started so Android
            // can recreate it, then honor the persisted delay in that new process.
            // The alarms survive this process, so a deferred sticky restart still recovers.
            // The short one mirrors this failure's persisted backoff; the periodic one remains
            // the outer backstop. Neither creates user intent.
            KeepAlive.scheduleSelfCheck(this, false);
            KeepAlive.scheduleCheckAfter(this, delayMs);
            reportEngineState("failed", -1, -1);
            android.os.Process.killProcess(android.os.Process.myPid());
            return;
        }
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(message));
        new Handler(Looper.getMainLooper()).post(() -> { stopForeground(STOP_FOREGROUND_DETACH); stopSelf(); });
    }
    private String readSelfProcessStartToken() {
        try {
            String stat = PrivateFiles.text(new File("/proc/" + android.os.Process.myPid() + "/stat"));
            int end = stat.lastIndexOf(')');
            if (end < 0) return "";
            String[] fields = stat.substring(end + 1).trim().split("\\s+");
            return fields.length > 19 && fields[19].matches("[0-9]{1,32}") ? fields[19] : "";
        } catch (Exception unavailable) { return ""; }
    }
    private HealthBusyJoinDiagnostic consumeHealthBusyJoinDiagnosticRequest() {
        final String expectedMode = "health-busy-join-once-v1";
        try {
            if (closing || stopRequested()) return null;
            File files = getFilesDir().getCanonicalFile();
            File request = new File(files, "health-busy-join-request.json");
            if (!request.isFile() || !request.getCanonicalFile().equals(request.getAbsoluteFile())) return null;
            File root = new File(files, "diagnostics/health-busy-join").getCanonicalFile();
            String rootPrefix = files.getPath() + File.separator;
            if (!root.getPath().startsWith(rootPrefix)) return null;
            File dir = new File(root, nativeGeneration).getCanonicalFile();
            if (!dir.getPath().startsWith(root.getPath() + File.separator)) return null;
            if (!root.isDirectory() && !root.mkdirs()) return null;
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            Os.chmod(root.getPath(), 0700); Os.chmod(dir.getPath(), 0700);
            File claimed = new File(dir, "request-claimed.json");
            if (claimed.exists() || !request.renameTo(claimed)) return null;
            Os.chmod(claimed.getPath(), 0600);
            boolean valid = false;
            try {
                long length = claimed.length();
                if (length > 0L && length <= 256L) {
                    byte[] bytes = new byte[(int)length];
                    try (FileInputStream input = new FileInputStream(claimed)) {
                        int offset = 0;
                        while (offset < bytes.length) {
                            int count = input.read(bytes, offset, bytes.length - offset);
                            if (count < 0) break;
                            offset += count;
                        }
                        if (offset == bytes.length) {
                            JSONObject body = new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
                            java.util.Iterator<String> keys = body.keys(); int count = 0;
                            while (keys.hasNext()) { keys.next(); count++; }
                            valid = count == 2 && expectedMode.equals(body.optString("mode", ""))
                                && Boolean.TRUE.equals(body.opt("once"));
                        }
                    }
                }
            } catch (Exception invalidRequest) { valid = false; }
            File consumed = new File(dir, valid ? "request-consumed.json" : "request-rejected.json");
            if (consumed.exists() || !claimed.renameTo(consumed)) return null;
            Os.chmod(consumed.getPath(), 0600);
            return valid ? new HealthBusyJoinDiagnostic(System.currentTimeMillis(), nativeGeneration) : null;
        } catch (Throwable unavailable) { return null; }
    }
    private void writeHealthBusyJoinDiagnostic(HealthBusyJoinDiagnostic diagnostic, HealthProbe probe) {
        if (diagnostic == null) return;
        try {
            File files = getFilesDir().getCanonicalFile();
            File root = new File(files, "diagnostics/health-busy-join").getCanonicalFile();
            File dir = new File(root, diagnostic.generation).getCanonicalFile();
            if (!dir.getPath().startsWith(root.getPath() + File.separator)) return;
            if (!dir.isDirectory() && !dir.mkdirs()) return;
            Os.chmod(root.getPath(), 0700); Os.chmod(dir.getPath(), 0700);
            JSONObject receipt = new JSONObject().put("schema", "health-busy-join-receipt/v1")
                .put("mode", "health-busy-join-once-v1").put("claimedAtUtcMs", diagnostic.claimedAtUtcMs)
                .put("nativeGeneration", diagnostic.generation).put("pid", android.os.Process.myPid())
                .put("observedAtUtcMs", System.currentTimeMillis()).put("outcome", diagnostic.outcome)
                .put("errorKind", diagnostic.errorKind).put("observerEntered", diagnostic.observerEntered)
                .put("joinerStartFailed", diagnostic.joinerStartFailed).put("sameAttempt", diagnostic.sameAttempt)
                .put("sameOriginalDeadline", diagnostic.sameDeadline).put("sameResponseObject", diagnostic.sameResponseObject)
                .put("exactBusyExceptionCaught", diagnostic.exactBusyCaught)
                .put("originalAwaitEntered", diagnostic.originalAwaitEntered).put("joinOrigin", diagnostic.originalAwaitEntered ? "active-health-probe" : "not-entered")
                .put("joinEnteredNanos", diagnostic.joinEnteredNanos).put("joinFinishedNanos", diagnostic.joinFinishedNanos)
                .put("remainingOriginalNanosAtJoinStart", diagnostic.remainingOriginalNanosAtJoinStart)
                .put("originalAwaitEnteredNanos", diagnostic.originalAwaitEnteredNanos)
                .put("joinedWithinOriginalDeadline", diagnostic.joinedWithinOriginalDeadline)
                .put("responseHttpStatus", diagnostic.responseHttpStatus).put("phaseKnown", diagnostic.phaseKnown)
                .put("nativeIdentityMatches", diagnostic.nativeIdentityMatches)
                .put("responsePidMatches", diagnostic.responsePidMatches)
                .put("responseGenerationMatches", diagnostic.responseGenerationMatches)
                .put("responseStartNonceMatches", diagnostic.responseStartNonceMatches)
                .put("responseStartTokenMatches", diagnostic.responseStartTokenMatches)
                .put("stopOrClosingObserved", diagnostic.stopOrClosingObserved)
                .put("ownerAdmissionCount", diagnostic.observerEntered ? 1 : 0).put("joinerIssuedRequest", false)
                .put("ownerProbeId", diagnostic.ownerProbeId).put("attemptId", diagnostic.attemptId)
                .put("ownerStartedElapsedMs", diagnostic.ownerStartedElapsedMs)
                .put("ownerDeadlineNanos", diagnostic.ownerDeadlineNanos)
                .put("observerElapsedMs", diagnostic.observerElapsedMs)
                .put("joinStartedElapsedMs", diagnostic.joinStartedElapsedMs)
                .put("joinFinishedElapsedMs", diagnostic.joinFinishedElapsedMs)
                .put("responsePid", diagnostic.responsePid).put("responseGeneration", diagnostic.responseGeneration)
                .put("responsePhase", diagnostic.responsePhase).put("responseReady", diagnostic.responseReady)
                .put("responseResponsive", diagnostic.responseResponsive)
                .put("ownerHasAdmittedAttempt", probe != null && probe.attempt != null);
            String text = receipt.toString();
            if (text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 4096) return;
            File output = new File(dir, "result.json");
            if (!output.exists()) PrivateFiles.write(output, text);
            Os.chmod(output.getPath(), 0600);
        } catch (Throwable ignored) { /* Private diagnostic evidence never affects health behavior. */ }
    }
    private void runHealthBusyJoinDiagnostic(HealthProbe owner, HealthBusyJoinDiagnostic diagnostic) {
        diagnostic.joinStartedElapsedMs = SystemClock.elapsedRealtime();
        diagnostic.joinEnteredNanos = System.nanoTime();
        diagnostic.remainingOriginalNanosAtJoinStart = Math.max(0L, owner.deadlineNanos - diagnostic.joinEnteredNanos);
        try {
            if (isHealthStopOrClosingRequested()) {
                diagnostic.stopOrClosingObserved = true;
                diagnostic.outcome = "cancelled-by-stop-or-closing";
                return;
            }
            diagnostic.ownerProbe = owner;
            healthBusyJoinTargetForDiagnostic.set(owner);
            healthBusyJoinReceiptForDiagnostic.set(diagnostic);
            JSONObject joined = healthControlRequestOrJoin();
            diagnostic.sameAttempt = owner.attempt != null && owner.attempt == diagnostic.admittedAttempt;
            diagnostic.sameDeadline = owner.attempt != null && owner.attempt == diagnostic.admittedAttempt
                && owner.deadlineNanos == owner.attempt.deadlineNanos;
            diagnostic.sameResponseObject = owner.response != null && joined == owner.response;
            diagnostic.responsePid = joined.optInt("pid", -1);
            diagnostic.responseGeneration = joined.optString("processGeneration", "");
            diagnostic.responsePhase = joined.optString("phase", "");
            diagnostic.responseReady = joined.optBoolean("ready", false);
            diagnostic.responseResponsive = joined.optBoolean("responsive", false);
            diagnostic.responseHttpStatus = joined.optInt("controlHttpStatus", -1);
            diagnostic.phaseKnown = "starting".equals(diagnostic.responsePhase) || "binding".equals(diagnostic.responsePhase)
                || "ready".equals(diagnostic.responsePhase) || "failed".equals(diagnostic.responsePhase)
                || "stopping".equals(diagnostic.responsePhase);
            diagnostic.responsePidMatches = diagnostic.responsePid == android.os.Process.myPid();
            diagnostic.responseGenerationMatches = nativeGeneration.equals(diagnostic.responseGeneration);
            diagnostic.responseStartNonceMatches = nativeStartNonce.equals(joined.optString("processStartNonce", ""));
            diagnostic.responseStartTokenMatches = nativeStartToken.equals(joined.optString("processStartToken", ""));
            diagnostic.nativeIdentityMatches = diagnostic.responseResponsive && diagnostic.responsePidMatches
                && diagnostic.responseGenerationMatches && diagnostic.responseStartNonceMatches
                && diagnostic.responseStartTokenMatches && diagnostic.phaseKnown
                && (diagnostic.responseHttpStatus == HttpURLConnection.HTTP_OK
                    || diagnostic.responseHttpStatus == HttpURLConnection.HTTP_UNAVAILABLE);
            diagnostic.outcome = "joined-owner-mismatch";
        } catch (HealthProbeJoinNotObservedException notObserved) {
            diagnostic.outcome = "not-observed"; diagnostic.errorKind = "owner-no-longer-active";
        } catch (Throwable failure) {
            diagnostic.outcome = "join-failed"; diagnostic.errorKind = failure.getClass().getSimpleName();
        } finally {
            healthBusyJoinTargetForDiagnostic.remove();
            healthBusyJoinReceiptForDiagnostic.remove();
            diagnostic.joinFinishedElapsedMs = SystemClock.elapsedRealtime();
            diagnostic.joinFinishedNanos = System.nanoTime();
            diagnostic.joinedWithinOriginalDeadline = diagnostic.joinEnteredNanos > 0L
                && diagnostic.joinFinishedNanos <= owner.deadlineNanos;
            diagnostic.stopOrClosingObserved = isHealthStopOrClosingRequested();
            if (diagnostic.stopOrClosingObserved) diagnostic.outcome = "cancelled-by-stop-or-closing";
            else if (diagnostic.exactBusyCaught && diagnostic.originalAwaitEntered && diagnostic.sameAttempt
                    && diagnostic.sameDeadline && diagnostic.sameResponseObject && diagnostic.nativeIdentityMatches) {
                diagnostic.outcome = diagnostic.joinedWithinOriginalDeadline ? "joined-exact-owner" : "joined-owner-late";
            }
            writeHealthBusyJoinDiagnostic(diagnostic, owner);
        }
    }
    private boolean isHealthStopOrClosingRequested() {
        try { return closing || stopRequested(); } catch (Throwable unavailable) { return true; }
    }
    private JSONObject healthControlRequest() throws Exception {
        healthRequestForCaller.remove();
        if (closing) throw new IOException("Health control lane unavailable");
        final HealthProbe diagnosticJoinTarget = healthBusyJoinTargetForDiagnostic.get();
        long startedAt = System.currentTimeMillis(), startedElapsed = SystemClock.elapsedRealtime();
        final long requestDeadlineNanos = System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(BoundedControlRequestLane.DEADLINE_MS);
        final HealthProbe probe;
        synchronized (healthProbeLock) {
            if (diagnosticJoinTarget != null && activeHealthProbe != diagnosticJoinTarget)
                throw new HealthProbeJoinNotObservedException();
            if (activeHealthProbe != null) throw new HealthProbeBusyException(activeHealthProbe);
            probe = new HealthProbe(healthProbeSequence.incrementAndGet(), startedElapsed, requestDeadlineNanos);
            activeHealthProbe = probe;
        }
        boolean publishSample = true;
        HealthBusyJoinDiagnostic joinDiagnostic = null;
        try {
            joinDiagnostic = consumeHealthBusyJoinDiagnosticRequest();
            Thread joiner = null;
            if (joinDiagnostic != null) {
                try {
                    final HealthBusyJoinDiagnostic armed = joinDiagnostic;
                    joiner = new Thread(() -> runHealthBusyJoinDiagnostic(probe, armed), "garden-health-busy-join-once");
                    joiner.setDaemon(true);
                } catch (Throwable setupFailure) {
                    joiner = null;
                    joinDiagnostic.joinerStartFailed = true;
                    joinDiagnostic.outcome = "joiner-setup-failed";
                    joinDiagnostic.errorKind = setupFailure.getClass().getSimpleName();
                }
            }
            final HealthBusyJoinDiagnostic armedJoinDiagnostic = joinDiagnostic;
            final Thread preparedJoiner = joiner;
            if (!healthRequestLane.recoverIfQuiescent() || !healthRequestLane.isHealthy()) throw new IOException("Health control lane unavailable");
            healthLaneUnhealthy = false;
            try {
                JSONObject result = healthRequestLane.execute(port, token, "GET", "/api/local/health", null,
                    probe.deadlineNanos, attempt -> {
                        probe.attempt = attempt;
                        if (armedJoinDiagnostic != null) {
                            armedJoinDiagnostic.observerEntered = true;
                            armedJoinDiagnostic.ownerProbeId = probe.id;
                            armedJoinDiagnostic.attemptId = attempt.id;
                            armedJoinDiagnostic.admittedAttempt = attempt;
                            armedJoinDiagnostic.ownerStartedElapsedMs = probe.startedElapsedMs;
                            armedJoinDiagnostic.ownerDeadlineNanos = probe.deadlineNanos;
                            armedJoinDiagnostic.observerElapsedMs = SystemClock.elapsedRealtime();
                            if (preparedJoiner != null) {
                                try { preparedJoiner.start(); }
                                catch (Throwable startFailure) {
                                    armedJoinDiagnostic.joinerStartFailed = true;
                                    armedJoinDiagnostic.outcome = "joiner-start-failed";
                                    armedJoinDiagnostic.errorKind = startFailure.getClass().getSimpleName();
                                }
                            }
                        }
                    });
                probe.response = result;
                return result;
            }
            catch (BoundedControlRequestLane.BusyException contention) {
                if (contention.transientContention) publishSample = false;
                probe.failure = contention;
                throw contention;
            }
            catch (Exception failure) {
                probe.failure = failure;
                throw failure;
            }
        } finally {
            if (publishSample) {
                long endedElapsed = SystemClock.elapsedRealtime();
                HealthRequestSnapshot snapshot = new HealthRequestSnapshot(startedAt, startedElapsed, System.currentTimeMillis(),
                    Math.max(0L, endedElapsed - startedElapsed));
                lastHealthRequest = snapshot;
                healthRequestForCaller.set(snapshot);
            }
            if (!probe.completion.isDone()) {
                if (probe.response != null) probe.completion.complete(probe.response);
                else probe.completion.completeExceptionally(probe.failure != null ? probe.failure :
                    new IOException("health sample ended without a result"));
            }
            synchronized (healthProbeLock) { if (activeHealthProbe == probe) activeHealthProbe = null; }
            if (joinDiagnostic != null && (!joinDiagnostic.observerEntered || joinDiagnostic.joinerStartFailed)) {
                if (!joinDiagnostic.observerEntered && !joinDiagnostic.joinerStartFailed) joinDiagnostic.outcome = "no-admission";
                writeHealthBusyJoinDiagnostic(joinDiagnostic, probe);
            }
        }
    }
    private JSONObject awaitHealthProbe(HealthProbe probe) throws Exception {
        HealthBusyJoinDiagnostic diagnostic = healthBusyJoinReceiptForDiagnostic.get();
        if (diagnostic != null && diagnostic.ownerProbe == probe) {
            diagnostic.originalAwaitEntered = true;
            diagnostic.originalAwaitEnteredNanos = System.nanoTime();
        }
        if (probe == null) throw new HealthProbeOwnerUnavailableException(false);
        long left = probe.deadlineNanos - System.nanoTime();
        if (left <= 0L && !probe.completion.isDone()) {
            if (probe.attempt != null) return healthRequestLane.awaitOriginalAttempt(probe.attempt);
            throw new HealthProbeOwnerUnavailableException(true);
        }
        try { return probe.completion.get(Math.max(0L, left), TimeUnit.NANOSECONDS); }
        catch (TimeoutException expired) {
            if (probe.attempt != null) return healthRequestLane.awaitOriginalAttempt(probe.attempt);
            throw new HealthProbeOwnerUnavailableException(System.nanoTime() >= probe.deadlineNanos);
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            if (cause instanceof BoundedControlRequestLane.BusyException) {
                BoundedControlRequestLane.BusyException busy = (BoundedControlRequestLane.BusyException)cause;
                if (busy.transientContention && busy.ownerAttempt != null) return healthRequestLane.awaitOriginalAttempt(busy);
                if (busy.transientContention) throw new HealthProbeOwnerUnavailableException(false);
            }
            if (cause instanceof Exception) throw (Exception)cause;
            throw new IOException("health probe failed", cause);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt(); throw new HealthProbeJoinInterruptedException();
        }
    }
    private JSONObject healthControlRequestOrJoin() throws Exception {
        try { return healthControlRequest(); }
        catch (HealthProbeBusyException busy) {
            HealthBusyJoinDiagnostic diagnostic = healthBusyJoinReceiptForDiagnostic.get();
            if (diagnostic != null && diagnostic.ownerProbe == busy.owner) diagnostic.exactBusyCaught = true;
            return awaitHealthProbe(busy.owner);
        }
        catch (BoundedControlRequestLane.BusyException busy) {
            if (!busy.transientContention) throw busy;
            if (busy.ownerAttempt == null) throw new HealthProbeOwnerUnavailableException(false);
            return healthRequestLane.awaitOriginalAttempt(busy);
        }
    }
    private void captureHealthDiagnostics(JSONObject health) {
        try {
            JSONObject diagnostics = new JSONObject(), timing = health.optJSONObject("controlTimingsMs"), plane = health.optJSONObject("controlPlane");
            for (String key : new String[] { "readiness", "progressSnapshots", "cleanupAndStableBudgets", "globalRecoveryGate", "localProcessAndDb", "total" }) {
                if (timing != null && timing.has(key)) {
                    double value = timing.optDouble(key, Double.NaN);
                    if (!Double.isNaN(value) && !Double.isInfinite(value) && value >= 0 && value <= 120000) diagnostics.put(key, value);
                }
            }
            for (String key : new String[] { "handlerMs", "eventLoopLagP99Ms", "eventLoopLagMaxMs" }) {
                if (plane != null && plane.has(key)) {
                    double value = plane.optDouble(key, Double.NaN);
                    if (!Double.isNaN(value) && !Double.isInfinite(value) && value >= 0 && value <= 120000) {
                        String outputKey = "controlPlane" + Character.toUpperCase(key.charAt(0)) + key.substring(1);
                        diagnostics.put(outputKey, value);
                    }
                }
            }
            if (plane != null && plane.has("eventLoopLagAvailable") && !plane.isNull("eventLoopLagAvailable"))
                diagnostics.put("controlPlaneEventLoopLagAvailable", plane.optBoolean("eventLoopLagAvailable"));
            lastSuccessfulHealthDiagnostics = new HealthDiagnosticsSnapshot(System.currentTimeMillis(), diagnostics.toString());
        } catch (Exception ignored) { /* Timing telemetry never gates a health result. */ }
    }
    private JSONObject stopControlRequest(String latchId) throws Exception {
        return stopRequestLane.execute(port, token, "POST", "/api/local/stop-all", new JSONObject()
            .put("commandId", latchId).put("sourceGeneration", nativeGeneration)
            .put("sourceInstance", getPackageName() + ":" + android.os.Process.myPid())
            .put("requestedAtMs", System.currentTimeMillis()));
    }
    private boolean writeStopMarker(String latchId) throws Exception {
        PrivateFiles.write(new File(getFilesDir(), "user-stop-request.json"), new JSONObject()
            .put("at", System.currentTimeMillis()).put("latchId", latchId).toString());
        return true;
    }
    private JSONObject request(String method, String route) throws Exception { return request(method, route, null); }
    private JSONObject request(String method, String route, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + route).openConnection();
        connection.setConnectTimeout(2000); connection.setReadTimeout(3000); connection.setRequestMethod(method);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
        }
        try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            PrivateFiles.copy(in, out); return new JSONObject(out.toString("UTF-8"));
        } finally { connection.disconnect(); }
    }
    private void scheduleNetworkSyncLocked() {
        if (closing || networkSyncQueued || pendingNetworkStates.isEmpty() || networkReporter.isShutdown()) return;
        networkSyncQueued = true;
        long delay = Math.max(0, networkRetryAfterElapsedMs - SystemClock.elapsedRealtime());
        try { networkReporter.schedule(this::drainNetworkStates, delay, TimeUnit.MILLISECONDS); }
        catch (RejectedExecutionException stopped) { networkSyncQueued = false; }
    }
    private void enqueueNetworkStateLocked(DeviceProfile.NetworkState state, String source, long at, long elapsed) {
        NetworkObservation previous = pendingNetworkStates.isEmpty() ? lastNetwork : pendingNetworkStates.peekLast();
        // Deduplication is what keeps the queue small, but an unchanged observation
        // is also the only way to correct a fact the engine recorded and cannot
        // observe itself. A forced refresh (after a freeze or Doze exit) republishes
        // the current state once so a stale offline fact can be withdrawn.
        boolean forced = forceNetworkReport;
        forceNetworkReport = false;
        if (closing || (!forced && state.sameObservation(previous == null ? null : previous.state))) return;
        if (pendingNetworkStates.size() >= MAX_PENDING_NETWORK_STATES) {
            // Bound a prolonged local-API outage, retaining the oldest unacknowledged
            // state, the first actual offline boundary, and the newest observation.
            NetworkObservation first = pendingNetworkStates.peekFirst(), offline = null;
            for (NetworkObservation pending : pendingNetworkStates) if (!pending.state.online) { offline = pending; break; }
            pendingNetworkStates.clear();
            pendingNetworkStates.addLast(first);
            if (offline != null && offline != first) pendingNetworkStates.addLast(offline);
            android.util.Log.w("GardenNetwork", "Pending network observations coalesced during a local API outage");
        }
        NetworkObservation observation = new NetworkObservation(state, source, at, elapsed);
        pendingNetworkStates.addLast(observation);
        recordNetworkDiagnostic(observation, "observed", 0, 0);
        scheduleNetworkSyncLocked();
    }
    private void observeWifiBroadcast(int wifiState, long version, long at, long elapsed) {
        if (closing) return;
        try {
            DeviceProfile.NetworkState state = DeviceProfile.networkState(this, wifiState);
            synchronized (networkLock) {
                if (!closing && version == networkCallbackVersion) {
                    enqueueNetworkStateLocked(state, "wifi-state-broadcast", at, elapsed);
                }
            }
        } catch (Exception unknown) { /* An unreadable active network is not offline. */ }
    }
    private void syncNetwork() {
        if (closing) return;
        long now = SystemClock.elapsedRealtime();
        // This one-second sampler is the only writer of native network facts. If it
        // did not run for a while the process was frozen, and the last fact may no
        // longer describe the platform, so the next pass republishes once.
        if (lastNetworkSampleElapsedMs > 0L && now - lastNetworkSampleElapsedMs > NETWORK_SAMPLE_GAP_MS) forceNetworkReport = true;
        lastNetworkSampleElapsedMs = now;
        long version;
        synchronized (networkLock) { version = networkCallbackVersion; }
        try {
            DeviceProfile.NetworkState state = DeviceProfile.networkState(this);
            synchronized (networkLock) {
                boolean sameDefault = callbackDefaultNetwork == null ? state.network == null : callbackDefaultNetwork.equals(state.network);
                // Append, never overtake queued callbacks. A real query of no
                // active path (including confirmed WIFI-disabled constraint)
                // need not wait for a delayed default-network lost callback.
                // A conflicting online API result still cannot revive that
                // lost callback's old network.
                // The forced path has to bypass this gate, not just the dedupe inside
                // enqueueNetworkStateLocked: after Doze the callback bookkeeping can
                // reject a periodic query even though the published fact is stale.
                boolean forced = forceNetworkReport;
                if (forced || version == networkCallbackVersion && (!receivedNetworkCallback || sameDefault || !state.online)) {
                    enqueueNetworkStateLocked(state, forced ? "forced-refresh" : "periodic-query",
                        System.currentTimeMillis(), SystemClock.elapsedRealtime());
                }
            }
        } catch (Exception unreadable) { /* Do not turn an unknown observation into offline. */ }
        synchronized (networkLock) { scheduleNetworkSyncLocked(); }
    }
    private void drainNetworkStates() {
        // Yield to periodic observations after a bounded batch of local ACKs.
        for (int batch = 0; batch < 8; batch++) {
            NetworkObservation observation;
            synchronized (networkLock) {
                if (closing || port == 0 || token == null || pendingNetworkStates.isEmpty()) { networkSyncQueued = false; return; }
                observation = pendingNetworkStates.peekFirst();
            }
            long sentAt = System.currentTimeMillis(), sentElapsed = SystemClock.elapsedRealtime();
            recordNetworkDiagnostic(observation, "sending", sentAt, sentElapsed);
            try {
                JSONObject receipt = networkRequest(observation.payload());
                Object ackSequence = receipt.opt("observationSequence");
                if (!receipt.optBoolean("ok", false) || !NATIVE_NETWORK_SOURCE_INSTANCE.equals(receipt.optString("nativeSourceInstance", "")) ||
                    !(ackSequence instanceof Number) || ((Number) ackSequence).longValue() != observation.sequence ||
                    ((Number) ackSequence).doubleValue() != (double) observation.sequence) {
                    throw new IOException("Exact network observation was not acknowledged");
                }
            } catch (Exception notReady) {
                String message = String.valueOf(notReady.getMessage());
                java.util.regex.Matcher rejection = java.util.regex.Pattern.compile("rejected ([0-9]{3})").matcher(message);
                int status = rejection.find() ? Integer.parseInt(rejection.group(1)) : 0;
                // A 4xx (other than a retryable 408/429) is permanent: the engine
                // refuses this exact observation, for example because a restart or an
                // older sequence already owns that number. Retrying it forever wedges
                // the only writer of native network facts, so the poisoned fact is
                // dropped and the next real observation is published instead.
                boolean permanent = status >= 400 && status < 500 && status != 408 && status != 429;
                recordNetworkDiagnostic(observation, permanent ? "rejected-permanent"
                    : notReady instanceof SocketTimeoutException ? "deadline" : "request-failed", sentAt, sentElapsed);
                if (permanent) {
                    synchronized (networkLock) {
                        if (pendingNetworkStates.peekFirst() == observation) {
                            pendingNetworkStates.removeFirst(); lastNetwork = observation;
                        }
                        networkSyncQueued = false; networkRetryAfterElapsedMs = SystemClock.elapsedRealtime() + 1000L;
                        scheduleNetworkSyncLocked();
                    }
                    return;
                }
                // Retry only this local fact after one second. Keep its exact
                // sequence ahead of a later real online event; no game retry.
                synchronized (networkLock) {
                    networkSyncQueued = false; networkRetryAfterElapsedMs = SystemClock.elapsedRealtime() + 1000L;
                    scheduleNetworkSyncLocked();
                }
                return;
            }
            synchronized (networkLock) {
                if (closing) { networkSyncQueued = false; return; }
                // A timeout/late response may never pop another head.
                if (pendingNetworkStates.peekFirst() != observation) { networkSyncQueued = false; scheduleNetworkSyncLocked(); return; }
                pendingNetworkStates.removeFirst(); lastNetwork = observation; networkRetryAfterElapsedMs = 0;
            }
            recordNetworkDiagnostic(observation, "acknowledged", sentAt, sentElapsed);
        }
        synchronized (networkLock) { networkSyncQueued = false; scheduleNetworkSyncLocked(); }
    }
    private int networkRequestRemaining(long deadline) throws IOException {
        if (closing || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Network report cancelled");
        long remaining = deadline - SystemClock.elapsedRealtime();
        if (remaining <= 0) throw new SocketTimeoutException("Network report deadline reached");
        return (int) Math.min(Integer.MAX_VALUE, remaining);
    }
    private JSONObject networkRequest(JSONObject payload) throws Exception {
        if (closing || port == 0 || token == null) throw new InterruptedIOException("Network endpoint unavailable");
        if (!networkHttpBusy.compareAndSet(false, true)) throw new IOException("Previous network report is still closing");
        final long deadline = SystemClock.elapsedRealtime() + NETWORK_REQUEST_MS;
        final HttpURLConnection connection;
        try { connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/local/network").openConnection(Proxy.NO_PROXY); }
        catch (Exception unavailable) { networkHttpBusy.set(false); throw unavailable; }
        final String sessionToken = token;
        FutureTask<JSONObject> task = new FutureTask<>(() -> {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(Math.min(2000, networkRequestRemaining(deadline)));
            connection.setReadTimeout(Math.min(1000, networkRequestRemaining(deadline)));
            connection.setRequestMethod("POST"); connection.setRequestProperty("Authorization", "Bearer " + sessionToken);
            connection.setRequestProperty("Content-Type", "application/json"); connection.setDoOutput(true);
            byte[] bytes = payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) { networkRequestRemaining(deadline); out.write(bytes); }
            networkRequestRemaining(deadline);
            int responseCode = connection.getResponseCode();
            if (responseCode != 200) throw new IOException("Network report was rejected " + responseCode);
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                while (true) {
                    connection.setReadTimeout(Math.min(1000, networkRequestRemaining(deadline)));
                    int count = in.read(buffer); networkRequestRemaining(deadline);
                    if (count < 0) break;
                    if (out.size() + count > NETWORK_RESPONSE_MAX_BYTES) throw new IOException("Network acknowledgement too large");
                    out.write(buffer, 0, count);
                }
                return new JSONObject(out.toString("UTF-8"));
            }
        });
        networkHttpConnection = connection; networkHttpTask = task;
        Thread worker = new Thread(() -> {
            try { task.run(); }
            finally {
                try { connection.disconnect(); }
                finally {
                    if (networkHttpConnection == connection) networkHttpConnection = null;
                    if (networkHttpTask == task) networkHttpTask = null;
                    networkHttpBusy.set(false);
                }
            }
        }, "garden-network-http");
        worker.setDaemon(true); worker.start();
        try { return task.get(networkRequestRemaining(deadline), TimeUnit.MILLISECONDS); }
        catch (TimeoutException expired) { throw new SocketTimeoutException("Network report deadline reached"); }
        catch (InterruptedException cancelled) { Thread.currentThread().interrupt(); throw new InterruptedIOException("Network reporter stopped"); }
        catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IOException("Network report failed", cause);
        } finally {
            if (!task.isDone()) {
                task.cancel(true);
                // Do not let platform disconnect cleanup extend the caller's
                // five-second deadline. Busy remains held until the one actual
                // HTTP worker exits, so retries cannot create extra I/O workers.
                Thread cancel = new Thread(connection::disconnect, "garden-network-disconnect");
                cancel.setDaemon(true); cancel.start();
            }
        }
    }
    private void recordNetworkDiagnostic(NetworkObservation observation, String phase, long sentAt, long sentElapsed) {
        try {
            synchronized (networkLock) {
                pendingNetworkDiagnostic = new JSONObject().put("observationSequence", observation.sequence).put("phase", phase)
                    .put("nativeObservedAtMs", observation.observedAtMs).put("nativeObservedElapsedMs", observation.observedElapsedMs)
                    .put("stageAtMs", System.currentTimeMillis()).put("stageElapsedMs", SystemClock.elapsedRealtime())
                    .put("sendStartedAtMs", sentAt).put("sendStartedElapsedMs", sentElapsed)
                    .put("online", observation.state.online).put("transport", observation.state.transport).put("nativeSource", observation.source)
                    .put("pendingCount", pendingNetworkStates.size()).put("httpInFlight", networkHttpBusy.get())
                    .put("acknowledgedSequence", lastNetwork == null ? 0 : lastNetwork.sequence);
                if (networkDiagnosticQueued || monitor.isShutdown()) return;
                networkDiagnosticQueued = true;
                try { monitor.execute(this::flushNetworkDiagnostic); }
                catch (RejectedExecutionException stopped) { networkDiagnosticQueued = false; }
            }
        } catch (Exception diagnosticUnavailable) { /* Safe diagnostics never veto a real observation. */ }
    }
    private void flushNetworkDiagnostic() {
        while (!closing) {
            JSONObject diagnostic;
            synchronized (networkLock) {
                diagnostic = pendingNetworkDiagnostic; pendingNetworkDiagnostic = null;
                if (diagnostic == null) { networkDiagnosticQueued = false; return; }
            }
            try {
                File file = new File(getFilesDir(), "native-network-diagnostic.json");
                PrivateFiles.write(file, diagnostic.toString()); Os.chmod(file.getAbsolutePath(), 0600);
            } catch (Exception unavailable) { /* Only finite safe timings were attempted. */ }
        }
        synchronized (networkLock) { networkDiagnosticQueued = false; }
    }
    private void refreshHealth() {
        if (closing || port == 0 || token == null) return;
        try {
            JSONObject health = healthControlRequest();
            captureRestartHealthSummary(health);
            captureHealthDiagnostics(health);
            lastHealthReadFailureKind = null;
            lastHealthHttpStatus = health.optInt("controlHttpStatus", 200);
            String phase = health.optString("phase", "");
            boolean phaseKnown = "starting".equals(phase) || "binding".equals(phase) || "ready".equals(phase)
                || "failed".equals(phase) || "stopping".equals(phase);
            boolean matched = health.optBoolean("responsive", false)
                && nativeGeneration.equals(health.optString("processGeneration", ""))
                && nativeStartNonce.equals(health.optString("processStartNonce", ""))
                && android.os.Process.myPid() == health.optInt("pid", -1)
                && nativeStartToken.equals(health.optString("processStartToken", ""))
                && phaseKnown;
            if (matched) nativeOwnerRef = health.optString("ownerRef", "");
            // Process responsiveness and business readiness are independent: a
            // starting/binding engine can answer health while work remains gated.
            boolean businessReady = health.optBoolean("ready", false);
            lastControlHealthMatched = matched;
            long now = SystemClock.elapsedRealtime();
            if (!matched) {
                healthStableSinceElapsedMs = 0L;
                android.util.Log.w("GardenControl", "Authenticated local health belongs to a different or unresponsive engine generation");
                recordHealthMiss("health_mismatch");
            } else {
                boolean databaseResponsive = health.optBoolean("databaseResponsive", false);
                boolean startExpired = now >= startupGraceUntilElapsedMs;
                boolean initializationFailed = "failed".equals(phase);
                boolean startupStalled = ("starting".equals(phase) || "binding".equals(phase)) && startExpired;
                boolean requiresEngineRestart = health.optBoolean("requiresEngineRestart", false) && !"stopping".equals(phase);
                String healthCode = health.optString("code", "");
                boolean accountCleanupStalled = "ACCOUNT_CLEANUP_STALLED".equals(healthCode);
                boolean accountCleanupDrainDeadline = "ACCOUNT_CLEANUP_DRAIN_DEADLINE".equals(healthCode);
                lastHealthSampleAtMs = System.currentTimeMillis();
                lastHealthPhase = phase; lastHealthCode = healthCode;
                // Process liveness alone is not enough: the engine reports its own overdue
                // scheduler/gateway work, which is the "process alive but tasks stuck" case.
                JSONObject schedulerProgress = health.optJSONObject("schedulerProgress");
                JSONObject gatewayProgress = health.optJSONObject("gatewayProgress");
                // Account-scoped recovery work (one account's pending or overdue
                // cleanup, scheduler or gateway stages) is fenced and recovered
                // inside that account. It must not restart the whole engine and
                // interrupt healthy accounts. Only a shared process/storage fault
                // may escalate to a process restart below.
                JSONObject supervisorProgress = health.optJSONObject("supervisorProgress");
                boolean progressStalled = schedulerProgress != null && schedulerProgress.optBoolean("stalled", false)
                    || gatewayProgress != null && gatewayProgress.optBoolean("stalled", false)
                    || supervisorProgress != null && supervisorProgress.optInt("overdueCleanupCount", 0) > 0;
                progressStallSamples = progressStalled ? progressStallSamples + 1 : 0;
                if (databaseResponsive) consecutiveHealthMisses.set(0);
                else {
                    healthStableSinceElapsedMs = 0L;
                    recordHealthMiss("database_unhealthy");
                }
                boolean cleanupDraining = "ACCOUNT_CLEANUP_DRAINING".equals(healthCode) || health.optInt("cleanupPendingCount", 0) > 0
                    || health.optJSONObject("globalRecoveryGate") != null
                    || health.optJSONObject("supervisorProgress") != null
                        && health.optJSONObject("supervisorProgress").optJSONArray("pendingCleanup") != null
                        && health.optJSONObject("supervisorProgress").optJSONArray("pendingCleanup").length() > 0;
                boolean stableHealthy = databaseResponsive && businessReady && "ready".equals(phase) && !cleanupDraining
                    && health.optBoolean("recoveryStable", false) && !initializationFailed && !startupStalled && !requiresEngineRestart;
                if (stableHealthy) {
                    if (healthStableSinceElapsedMs == 0L) healthStableSinceElapsedMs = now;
                    // A prompt may have been posted while the engine was already healthy (for
                    // example a refused start that raced a sticky restart), so clear it on every
                    // stable sample, not only on the first transition.
                    KeepAlive.clearRecoveryNotificationIfPending(this);
                    if (now - healthStableSinceElapsedMs >= ENGINE_STABLE_RESET_MS) clearHealthFailureCount();
                } else healthStableSinceElapsedMs = 0L;
                if (requiresEngineRestart || initializationFailed || startupStalled) {
                    String cause = accountCleanupDrainDeadline ? "account_cleanup_drain_deadline" : accountCleanupStalled ? "account_cleanup_stalled" : requiresEngineRestart ? "engine_restart_required" : initializationFailed ? "initialization_failed"
                        : "binding".equals(phase) ? "binding_stalled" : "startup_stalled";
                    recordRecoveryEvent(cause, Math.max(1, safetyPreferences().getInt(ENGINE_FAILURE_COUNT, 1)));
                    android.util.Log.w("GardenControl", "Responsive engine is not progressing: phase=" + phase);
                    requestGracefulEngineRestart(health);
                } else if (!databaseResponsive) {
                    android.util.Log.w("GardenControl", "Engine process responds while database readiness is unavailable");
                } else if (!businessReady) {
                    android.util.Log.i("GardenControl", "Engine process responds while readiness is " + phase);
                }
                // Account-scoped progress stays account-scoped: log it for
                // diagnostics but never restart the shared engine because one
                // account's stage or cleanup ran past its own deadline. Shared
                // faults are covered by database/process checks and
                // requiresEngineRestart above.
                if (progressStallSamples >= PROGRESS_STALL_SAMPLE_LIMIT) {
                    android.util.Log.w("GardenControl", "Account-scoped recovery work stayed overdue for "
                        + progressStallSamples + " samples; keeping other accounts running");
                    progressStallSamples = 0;
                }
            }
        } catch (Exception unavailable) {
            if (unavailable instanceof HealthProbeBusyException || unavailable instanceof BoundedControlRequestLane.BusyException &&
                    ((BoundedControlRequestLane.BusyException) unavailable).transientContention) {
                // Another authenticated control request owns the single-worker
                // lane. Skip this sample; the next regular health tick retries.
                return;
            }
            lastControlHealthMatched = false;
            healthStableSinceElapsedMs = 0L;
            lastHealthHttpStatus = unavailable instanceof BoundedControlRequestLane.ControlStatusException
                ? ((BoundedControlRequestLane.ControlStatusException) unavailable).status : 0;
            String failureKind = unavailable.getClass().getSimpleName();
            lastHealthReadFailureKind = failureKind.matches("[A-Za-z_$][A-Za-z0-9_$]{0,63}") ? failureKind : "UnknownHealthReadFailure";
            captureRestartHealthFailure(lastHealthReadFailureKind);
            recordHealthMiss(unavailable instanceof BoundedControlRequestLane.ControlStatusException ? "health_http_invalid" : "health_transport_failure");
            if (healthLaneUnhealthy) android.util.Log.e("GardenControl", "Health lane is unhealthy; explicit STOP latch remains durable");
        } finally { healthRequestForCaller.remove(); }
    }
    private void captureRestartHealthSummary(JSONObject health) {
        try {
            String phase = safeDiagnosticValue(health.optString("phase", ""));
            String code = safeDiagnosticValue(health.optString("code", ""));
            boolean requiresRestart = health.optBoolean("requiresEngineRestart", false);
            JSONObject gate = health.optJSONObject("globalRecoveryGate");
            String gateState = gate == null ? "" : safeDiagnosticValue(gate.optString("state", ""));
            boolean gateDrained = gate != null && gate.optBoolean("drained", false);
            boolean gateMayInterrupt = gate != null && gate.optBoolean("mayInterruptHealthyAccounts", false);
            int cleanupPendingCount = Math.max(0, health.optInt("cleanupPendingCount", 0));
            synchronized (restartHealthSummaryLock) {
                RestartHealthSummary previous = restartHealthSummary;
                restartHealthSummary = new RestartHealthSummary(System.currentTimeMillis(), previous.failureAtMs, phase, code,
                    requiresRestart, gateState, gateDrained, gateMayInterrupt, cleanupPendingCount, previous.failureKind);
            }
        } catch (Exception ignored) { /* Restart diagnostics never gate health handling. */ }
    }
    private void captureRestartHealthFailure(String failureKind) {
        try {
            synchronized (restartHealthSummaryLock) {
                RestartHealthSummary previous = restartHealthSummary;
                restartHealthSummary = new RestartHealthSummary(previous.successAtMs, System.currentTimeMillis(), previous.phase,
                    previous.code, previous.requiresRestart, previous.gateState, previous.gateDrained, previous.gateMayInterrupt,
                    previous.cleanupPendingCount, safeDiagnosticValue(failureKind));
            }
        } catch (Exception ignored) { /* Restart diagnostics never gate health handling. */ }
    }
    private static String safeDiagnosticValue(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_.:-]{0,64}")) return "";
        return value;
    }
    private void writeRestartBoundaryReceipt(String branch, String outcome, long expectedPid, String expectedGeneration,
            boolean ticketAvailable, boolean postAttempted, boolean postAccepted, boolean freshFencePassed,
            boolean freshHealthResponded, boolean freshIdentityMatched, boolean freshReady) {
        try {
            SharedPreferences preferences = safetyPreferences();
            RestartHealthSummary health = restartHealthSummary;
            JSONObject gate = new JSONObject().put("state", health.gateState)
                .put("drained", health.gateDrained).put("mayInterruptHealthyAccounts", health.gateMayInterrupt)
                .put("cleanupPendingCount", health.cleanupPendingCount);
            JSONObject receipt = new JSONObject().put("version", 1).put("recordedAtMs", System.currentTimeMillis())
                .put("branch", safeDiagnosticValue(branch)).put("outcome", safeDiagnosticValue(outcome))
                .put("pid", android.os.Process.myPid()).put("expectedPid", expectedPid)
                .put("processGeneration", safeDiagnosticValue(nativeGeneration)).put("expectedGeneration", safeDiagnosticValue(expectedGeneration))
                .put("generationMatches", nativeGeneration.equals(expectedGeneration)).put("stopRequested", stopRequested())
                .put("engineDesired", preferences.getBoolean(ENGINE_DESIRED, false)).put("closing", closing)
                .put("lastHealthSuccessAtMs", health.successAtMs).put("lastHealthFailureAtMs", health.failureAtMs)
                .put("lastHealthPhase", health.phase).put("lastHealthCode", health.code)
                .put("lastHealthRequiresRestart", health.requiresRestart).put("lastHealthGlobalRecoveryGate", gate)
                .put("lastHealthFailureKind", health.failureKind)
                .put("ticketAvailable", ticketAvailable).put("postAttempted", postAttempted).put("postAccepted", postAccepted)
                .put("freshFencePassed", freshFencePassed).put("freshHealthResponded", freshHealthResponded)
                .put("freshIdentityMatched", freshIdentityMatched).put("freshReady", freshReady);
            String encoded = receipt.toString();
            if (encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 4096) return;
            synchronized (restartDecisionWriteLock) {
                if (!nativeGeneration.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) return;
                File root = new File(getFilesDir(), "engine-restart-decisions").getCanonicalFile();
                String rootPrefix = getFilesDir().getCanonicalPath() + File.separator;
                if (!root.getPath().startsWith(rootPrefix)) return;
                if (!root.isDirectory() && !root.mkdirs()) return;
                Os.chmod(root.getAbsolutePath(), 0700);
                File file = new File(root, nativeGeneration + ".json").getCanonicalFile();
                if (!root.equals(file.getParentFile())) return;
                PrivateFiles.write(file, encoded); Os.chmod(file.getAbsolutePath(), 0600);
            }
        } catch (Exception ignored) { /* Private bounded telemetry never changes recovery behavior. */ }
    }
    private void recordHealthMiss(String cause) {
        if (closing || stopRequested() || SystemClock.elapsedRealtime() < startupGraceUntilElapsedMs) return;
        lastHealthFailureCause = validRecoveryCause(cause) ? cause : "health_transport_failure";
        int failures = consecutiveHealthMisses.incrementAndGet();
        if (failures >= ENGINE_HEALTH_FAILURE_LIMIT) { recordRecoveryEvent(lastHealthFailureCause, Math.max(1, safetyPreferences().getInt(ENGINE_FAILURE_COUNT, 1))); requestGracefulEngineRestart(null); }
    }
    private JSONObject freshRestartHealth(JSONObject observed) throws Exception {
        JSONObject health = observed == null ? healthControlRequest() : observed;
        if (observed == null) captureRestartHealthSummary(health);
        return health;
    }
    private void scheduleHardExitFallback(final long expectedPid, final String expectedGeneration,
            final String expectedNonce, final String expectedStartToken, final int expectedAttempt, final boolean controlledRestartAcceptedOrAmbiguous,
            final String restartBranch,
            final boolean ticketAvailable, final boolean postAttempted, final boolean postAccepted, final boolean freshFencePassed) {
        watchdogDeadlineMonitor.schedule(() -> {
            synchronized (stopLatchLock) {
                SharedPreferences preferences = safetyPreferences();
                if (closing || stopRequested() || !preferences.getBoolean(ENGINE_DESIRED, false)
                        || android.os.Process.myPid() != expectedPid || !nativeGeneration.equals(expectedGeneration)
                        || !nativeStartNonce.equals(expectedNonce) || !nativeStartToken.equals(expectedStartToken)
                        || preferences.getInt(ENGINE_FAILURE_COUNT, 0) != expectedAttempt) {
                    watchdogRestartPending.set(false); return;
                }
            }
            boolean freshHealthResponded = false, freshIdentityMatched = false, freshReady = false;
            JSONObject latestHealth = null;
            try {
                JSONObject latest = healthControlRequestOrJoin(); latestHealth = latest;
                freshHealthResponded = true;
                captureRestartHealthSummary(latest);
                freshIdentityMatched = latest.optBoolean("responsive", false)
                        && android.os.Process.myPid() == latest.optInt("pid", -1)
                        && nativeGeneration.equals(latest.optString("processGeneration", ""))
                        && nativeStartNonce.equals(latest.optString("processStartNonce", ""))
                        && nativeStartToken.equals(latest.optString("processStartToken", ""));
                freshReady = latest.optBoolean("ready", false) && latest.optBoolean("databaseResponsive", false)
                    && !latest.optBoolean("requiresEngineRestart", false) && "ready".equals(latest.optString("phase", ""));
                if (!controlledRestartAcceptedOrAmbiguous && freshIdentityMatched) {
                    watchdogRestartPending.set(false);
                    writeRestartBoundaryReceipt(restartBoundaryBranch(restartBranch, latestHealth), "cancelled-responsive", expectedPid, expectedGeneration,
                        ticketAvailable, postAttempted, postAccepted, freshFencePassed, freshHealthResponded, freshIdentityMatched, freshReady);
                    android.util.Log.i("GardenControl", "A fresh exact-generation health response proved the process responsive; cancelled liveness-only hard exit");
                    return;
                }
                if (controlledRestartAcceptedOrAmbiguous && freshIdentityMatched && freshReady) {
                    watchdogRestartPending.set(false);
                    writeRestartBoundaryReceipt(restartBoundaryBranch(restartBranch, latestHealth), "cancelled-ready", expectedPid, expectedGeneration,
                        ticketAvailable, postAttempted, postAccepted, freshFencePassed, freshHealthResponded, freshIdentityMatched, freshReady);
                    return;
                }
            } catch (Exception unresponsive) {
                if (!controlledRestartAcceptedOrAmbiguous && unresponsive instanceof HealthProbeOwnerUnavailableException &&
                        !((HealthProbeOwnerUnavailableException)unresponsive).probeDeadlineExpired) {
                    watchdogRestartPending.set(false);
                    writeRestartBoundaryReceipt(restartBoundaryBranch(restartBranch, latestHealth), "cancelled-no-health-attempt",
                        expectedPid, expectedGeneration, ticketAvailable, postAttempted, postAccepted, freshFencePassed,
                        false, false, false);
                    android.util.Log.i("GardenControl", "Transient health contention had no admitted probe to judge; cancelled liveness-only hard exit");
                    return;
                }
                if (!controlledRestartAcceptedOrAmbiguous && (unresponsive instanceof HealthProbeJoinInterruptedException ||
                        unresponsive instanceof BoundedControlRequestLane.JoinInterruptedException ||
                        unresponsive instanceof InterruptedIOException && Thread.currentThread().isInterrupted() &&
                            !(unresponsive instanceof SocketTimeoutException))) {
                    watchdogRestartPending.set(false);
                    writeRestartBoundaryReceipt(restartBoundaryBranch(restartBranch, latestHealth), "cancelled-probe-join-interrupted",
                        expectedPid, expectedGeneration, ticketAvailable, postAttempted, postAccepted, freshFencePassed,
                        false, false, false);
                    android.util.Log.i("GardenControl", "Health attempt join was interrupted before an original deadline result; cancelled liveness-only hard exit");
                    return;
                }
                String failureKind = unresponsive instanceof HealthProbeOwnerUnavailableException &&
                    ((HealthProbeOwnerUnavailableException)unresponsive).probeDeadlineExpired
                    ? "HealthProbeDeadlineExpired" : unresponsive.getClass().getSimpleName();
                lastHealthReadFailureKind = failureKind.matches("[A-Za-z_$][A-Za-z0-9_$]{0,63}") ? failureKind : "UnknownHealthReadFailure";
                captureRestartHealthFailure(lastHealthReadFailureKind);
                /* bounded hard-liveness fallback below */
            }
            synchronized (stopLatchLock) {
                SharedPreferences preferences = safetyPreferences();
                if (closing || stopRequested() || !preferences.getBoolean(ENGINE_DESIRED, false)
                        || android.os.Process.myPid() != expectedPid || !nativeGeneration.equals(expectedGeneration)
                        || !nativeStartNonce.equals(expectedNonce) || !nativeStartToken.equals(expectedStartToken)
                        || preferences.getInt(ENGINE_FAILURE_COUNT, 0) != expectedAttempt) return;
            }
            writeRestartBoundaryReceipt(restartBoundaryBranch(restartBranch, latestHealth), "hard-exit", expectedPid, expectedGeneration,
                ticketAvailable, postAttempted, postAccepted, freshFencePassed, freshHealthResponded, freshIdentityMatched, freshReady);
            synchronized (stopLatchLock) {
                SharedPreferences preferences = safetyPreferences();
                if (closing || stopRequested() || !preferences.getBoolean(ENGINE_DESIRED, false)
                        || android.os.Process.myPid() != expectedPid || !nativeGeneration.equals(expectedGeneration)
                        || !nativeStartNonce.equals(expectedNonce) || !nativeStartToken.equals(expectedStartToken)
                        || preferences.getInt(ENGINE_FAILURE_COUNT, 0) != expectedAttempt) return;
                recordRecoveryEvent("forced_exit_deadline", Math.max(1, expectedAttempt));
                android.util.Log.e("GardenControl", "Engine remained unresponsive through its bounded liveness deadline; terminating only the matching dedicated engine process");
                android.os.Process.killProcess(android.os.Process.myPid());
            }
        }, ENGINE_WATCHDOG_KILL_MS, TimeUnit.MILLISECONDS);
    }
    private String restartBoundaryBranch(String fallback, JSONObject health) {
        if (health == null || !health.optBoolean("responsive", false) || android.os.Process.myPid() != health.optInt("pid", -1) ||
                !nativeGeneration.equals(health.optString("processGeneration", "")) ||
                !nativeStartNonce.equals(health.optString("processStartNonce", "")) ||
                !nativeStartToken.equals(health.optString("processStartToken", ""))) return fallback;
        JSONObject gate = health.optJSONObject("globalRecoveryGate");
        String code = health.optString("code", "");
        String gateState = gate == null ? "" : gate.optString("state", "");
        if (code.startsWith("ACCOUNT_CLEANUP_") || health.optInt("cleanupPendingCount", 0) > 0 ||
                "draining".equals(gateState) || "drained".equals(gateState) || "deadline-expired".equals(gateState)) return "cleanup";
        return fallback;
    }
    private void requestGracefulEngineRestart(JSONObject observedHealth) {
        if (!watchdogRestartPending.compareAndSet(false, true)) return;
        final int previousFailures = Math.max(0, safetyPreferences().getInt(ENGINE_FAILURE_COUNT, 0));
        final long previousRetryAt = safetyPreferences().getLong(ENGINE_RETRY_AT_MS, 0L);
        final long delayMs;
        final int attempts;
        synchronized (stopLatchLock) {
            SharedPreferences preferences = safetyPreferences();
            if (closing || stopRequested() || !preferences.getBoolean(ENGINE_DESIRED, false)) { watchdogRestartPending.set(false); return; }
            attempts = Math.max(1, Math.min(ENGINE_RETRY_DELAYS_MS.length, previousFailures == 0 ? 1 : previousFailures + 1));
            delayMs = ENGINE_RETRY_DELAYS_MS[attempts - 1];
            if (!preferences.edit().putInt(ENGINE_FAILURE_COUNT, attempts)
                    .putLong(ENGINE_RETRY_AT_MS, System.currentTimeMillis() + delayMs).commit()) {
                watchdogRestartPending.set(false);
                android.util.Log.e("GardenControl", "Cannot persist watchdog backoff; preserving the live engine and desired state");
                return;
            }
        }
        boolean postMayHaveReachedServer = false, ticketAvailable = false, postAccepted = false, freshFencePassed = false;
        boolean freshHealthResponded = false, freshIdentityMatched = false, freshReady = false;
        JSONObject decisionHealth = observedHealth;
        try {
            JSONObject authorizedHealth = freshRestartHealth(observedHealth);
            if (authorizedHealth == null) throw new ControlRestartRejectedException();
            decisionHealth = authorizedHealth;
            freshHealthResponded = true;
            if (!authorizedHealth.optBoolean("responsive", false)) throw new IOException("fresh engine health reports an unresponsive process");
            if (!nativeGeneration.equals(authorizedHealth.optString("processGeneration", ""))
                    || !nativeStartNonce.equals(authorizedHealth.optString("processStartNonce", ""))
                    || android.os.Process.myPid() != authorizedHealth.optInt("pid", -1)
                    || !nativeStartToken.equals(authorizedHealth.optString("processStartToken", ""))) throw new ControlRestartRejectedException();
            freshIdentityMatched = true;
            ticketAvailable = !authorizedHealth.optString("restartTicket", "").isEmpty();
            freshFencePassed = true;
            freshReady = authorizedHealth.optBoolean("ready", false) && authorizedHealth.optBoolean("databaseResponsive", false)
                && !authorizedHealth.optBoolean("requiresEngineRestart", false) && "ready".equals(authorizedHealth.optString("phase", ""));
            if (!ticketAvailable) throw new ControlRestartRejectedException();
            JSONObject request = new JSONObject().put("restartTicket", authorizedHealth.getString("restartTicket"))
                .put("processGeneration", nativeGeneration).put("processStartNonce", nativeStartNonce);
            postMayHaveReachedServer = true;
            JSONObject accepted = restartRequestLane.execute(port, token, "POST", "/api/local/engine-restart", request);
            if (accepted.optInt("controlHttpStatus", 0) != 202 || !accepted.optBoolean("restartScheduled", false)) {
                throw new ControlRestartRejectedException();
            }
            postAccepted = true;
            android.util.Log.e("GardenControl", "Fresh engine health explicitly accepted a controlled restart");
            scheduleHardExitFallback(android.os.Process.myPid(), nativeGeneration, nativeStartNonce, nativeStartToken, attempts,
                postMayHaveReachedServer, restartBoundaryBranch("request-accepted", authorizedHealth), ticketAvailable,
                postMayHaveReachedServer, postAccepted, freshFencePassed);
        } catch (Exception unavailable) {
            if (unavailable instanceof ControlRestartRejectedException) {
                synchronized (stopLatchLock) {
                    SharedPreferences preferences = safetyPreferences();
                    if (!closing && !stopRequested() && preferences.getBoolean(ENGINE_DESIRED, false)) {
                        preferences.edit().putInt(ENGINE_FAILURE_COUNT, previousFailures).putLong(ENGINE_RETRY_AT_MS, previousRetryAt).commit();
                    }
                }
                watchdogRestartPending.set(false);
                writeRestartBoundaryReceipt(restartBoundaryBranch(postMayHaveReachedServer ? "request-ambiguous" : "liveness-only", decisionHealth),
                    "restart-gate-rejected", android.os.Process.myPid(), nativeGeneration, ticketAvailable, postMayHaveReachedServer,
                    postAccepted, freshFencePassed, freshHealthResponded, freshIdentityMatched, freshReady);
                android.util.Log.i("GardenControl", "Restart gate rejected or no longer authorizes this generation; retry and hard-exit deadline cancelled");
                return;
            }
            boolean responsiveWithoutAuthorization = false;
            try {
                JSONObject latest = healthControlRequest();
                captureRestartHealthSummary(latest);
                boolean exactResponsiveIdentity = latest.optBoolean("responsive", false)
                    && android.os.Process.myPid() == latest.optInt("pid", -1)
                    && nativeGeneration.equals(latest.optString("processGeneration", ""))
                    && nativeStartNonce.equals(latest.optString("processStartNonce", ""))
                    && nativeStartToken.equals(latest.optString("processStartToken", ""));
                if (!exactResponsiveIdentity) {
                    scheduleHardExitFallback(android.os.Process.myPid(), nativeGeneration, nativeStartNonce, nativeStartToken, attempts,
                        postMayHaveReachedServer, restartBoundaryBranch(postMayHaveReachedServer ? "request-ambiguous" : "liveness-only", latest), ticketAvailable,
                        postMayHaveReachedServer, postAccepted, freshFencePassed);
                    return;
                }
                boolean fullyReady = latest.optBoolean("ready", false) && latest.optBoolean("databaseResponsive", false)
                    && !latest.optBoolean("requiresEngineRestart", false) && "ready".equals(latest.optString("phase", ""));
                if (postMayHaveReachedServer && !fullyReady) {
                    // A lost POST response is ambiguous: the backend may
                    // already be draining. Preserve the controlled deadline
                    // unless fresh exact-generation health proves it is fully
                    // ready again; mere process responsiveness is insufficient.
                    scheduleHardExitFallback(android.os.Process.myPid(), nativeGeneration, nativeStartNonce, nativeStartToken, attempts,
                        postMayHaveReachedServer, restartBoundaryBranch("request-ambiguous", latest), ticketAvailable, postMayHaveReachedServer, postAccepted, freshFencePassed);
                    return;
                }
            } catch (Exception unresponsive) {
                // If the POST may have reached the server, its fresh health
                // read failed, or the local event loop is wedged, retain only
                // the bounded process-identity-checked liveness fallback.
                scheduleHardExitFallback(android.os.Process.myPid(), nativeGeneration, nativeStartNonce, nativeStartToken, attempts,
                    postMayHaveReachedServer, restartBoundaryBranch(postMayHaveReachedServer ? "request-ambiguous" : "liveness-only", decisionHealth), ticketAvailable,
                    postMayHaveReachedServer, postAccepted, freshFencePassed);
                return;
            }
            synchronized (stopLatchLock) {
                SharedPreferences preferences = safetyPreferences();
                if (!closing && !stopRequested() && preferences.getBoolean(ENGINE_DESIRED, false)) {
                    preferences.edit().putInt(ENGINE_FAILURE_COUNT, previousFailures).putLong(ENGINE_RETRY_AT_MS, previousRetryAt).commit();
                }
            }
            watchdogRestartPending.set(false);
            recordRecoveryEvent("restart_request_failed", Math.max(1, previousFailures));
            android.util.Log.w("GardenControl", "Fresh health did not accept the restart; retry and hard-exit deadline were cancelled");
        }
    }
    private static final class ControlRestartRejectedException extends IOException {
        ControlRestartRejectedException() { super("fresh health ticket was rejected"); }
    }
    private void clearHealthFailureCount() {
        if (closing || stopRequested()) return;
        synchronized (stopLatchLock) {
            SharedPreferences preferences = safetyPreferences();
            if (preferences.getBoolean(ENGINE_DESIRED, false) && !preferences.getBoolean(STOP_REQUESTED, false)) {
                preferences.edit().putInt(ENGINE_FAILURE_COUNT, 0).putLong(ENGINE_RETRY_AT_MS, 0L).commit();
            }
        }
        healthStableSinceElapsedMs = SystemClock.elapsedRealtime();
    }
    private File recoveryJournalFile() { return new File(getFilesDir(), "native-recovery-journal.json"); }
    private File recoveryJournalPrivateFile() { return new File(getFilesDir(), "native-recovery-journal-private.json"); }
    private static boolean validRecoveryCause(String cause) {
        return "health_mismatch".equals(cause) || "startup_stalled".equals(cause) || "binding_stalled".equals(cause) || "account_cleanup_stalled".equals(cause) || "account_cleanup_drain_deadline".equals(cause) || "initialization_failed".equals(cause)
            || "restart_request_failed".equals(cause) || "forced_exit_deadline".equals(cause)
            || "engine_start_failed".equals(cause) || "engine_exited".equals(cause) || "engine_restart_required".equals(cause)
            || "database_unhealthy".equals(cause) || "health_transport_failure".equals(cause) || "health_http_invalid".equals(cause)
            || "progress_stalled".equals(cause);
    }
    private JSONArray readRecoveryEvents(File file) throws Exception {
        if (!file.isFile()) return new JSONArray();
        if (file.length() > RECOVERY_JOURNAL_MAX_BYTES) throw new IOException("Recovery journal exceeds its bound");
        byte[] bytes;
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = in.read(buffer)) != -1) {
                if (out.size() + count > RECOVERY_JOURNAL_MAX_BYTES) throw new IOException("Recovery journal exceeds its bound");
                out.write(buffer, 0, count);
            }
            bytes = out.toByteArray();
        }
        if (bytes.length > RECOVERY_JOURNAL_MAX_BYTES) throw new IOException("Recovery journal exceeds its bound");
        JSONObject root = new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
        JSONArray events = root.optJSONArray("events");
        if (events == null || events.length() > RECOVERY_JOURNAL_MAX_EVENTS) throw new IOException("Recovery journal is invalid");
        return events;
    }
    private JSONArray readRecoveryJournal() throws Exception { return readRecoveryEvents(recoveryJournalFile()); }
    private void archiveOwnerlessRecoveryEvents() {
        try { synchronized (recoveryJournalLock) {
            JSONArray active = readRecoveryJournal(), privateEvents = readRecoveryEvents(recoveryJournalPrivateFile()), retained = new JSONArray();
            java.util.HashSet<String> known = new java.util.HashSet<>();
            for (int i = 0; i < privateEvents.length(); i++) { JSONObject old = privateEvents.optJSONObject(i); if (old != null) known.add(old.optString("eventId", "")); }
            for (int i = 0; i < active.length(); i++) {
                JSONObject event = active.optJSONObject(i);
                if (event == null) continue;
                if (event.optString("ownerRef", "").isEmpty()) {
                    if (known.add(event.optString("eventId", ""))) privateEvents.put(event);
                } else retained.put(event);
            }
            if (retained.length() == active.length()) return;
            JSONObject privateDoc = new JSONObject().put("version", 1).put("events", privateEvents);
            if (privateEvents.length() > RECOVERY_JOURNAL_MAX_EVENTS || privateDoc.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > RECOVERY_JOURNAL_MAX_BYTES) return;
            PrivateFiles.write(recoveryJournalPrivateFile(), privateDoc.toString());
            Os.chmod(recoveryJournalPrivateFile().getAbsolutePath(), 0600);
            JSONObject activeDoc = new JSONObject().put("version", 1).put("events", retained);
            PrivateFiles.write(recoveryJournalFile(), activeDoc.toString());
            Os.chmod(recoveryJournalFile().getAbsolutePath(), 0600);
        }} catch (Exception ignored) { /* Private-only telemetry migration never gates recovery. */ }
    }
    private void recordRecoveryEvent(String cause, int attempt) {
        if (!validRecoveryCause(cause)) return;
        String owner = nativeOwnerRef;
        archiveOwnerlessRecoveryEvents();
        String generation = nativeGeneration;
        if (generation == null || !generation.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) return;
        File target = owner == null || owner.isEmpty() ? recoveryJournalPrivateFile() : recoveryJournalFile();
        try { synchronized (recoveryJournalLock) {
            JSONArray events = readRecoveryEvents(target);
            long now = System.currentTimeMillis();
            for (int i = 0; i < events.length(); i++) {
                JSONObject prior = events.optJSONObject(i);
                long priorAt = prior == null ? 0L : prior.optLong("eventTimeMs", 0L);
                if (prior != null && cause.equals(prior.optString("cause")) && generation.equals(prior.optString("oldGeneration"))
                        && now >= priorAt && now - priorAt < 60_000L) return;
            }
            if (events.length() >= RECOVERY_JOURNAL_MAX_EVENTS) return;
            JSONObject event = new JSONObject().put("eventId", UUID.randomUUID().toString()).put("cause", cause)
                .put("attempt", Math.max(1, Math.min(1000, attempt))).put("eventTimeMs", now)
                .put("oldGeneration", generation);
            if ("health_mismatch".equals(cause) || "database_unhealthy".equals(cause) || "health_transport_failure".equals(cause) || "health_http_invalid".equals(cause)) {
                event.put("eventState", "requested").put("phase", "health").put("method", "GET").put("sourceNamespace", "engine-health");
                if (lastHealthHttpStatus >= 100 && lastHealthHttpStatus <= 599) event.put("httpStatus", lastHealthHttpStatus);
                String failureKind = lastHealthReadFailureKind;
                if (failureKind != null && failureKind.matches("[A-Za-z_$][A-Za-z0-9_$]{0,63}")) event.put("readFailureKind", failureKind);
                HealthRequestSnapshot requestSnapshot = healthRequestForCaller.get();
                if (requestSnapshot == null) requestSnapshot = lastHealthRequest;
                if (requestSnapshot.startedAtMs > 0L) event.put("healthRequestStartedAtMs", requestSnapshot.startedAtMs);
                if (requestSnapshot.finishedAtMs >= requestSnapshot.startedAtMs && requestSnapshot.finishedAtMs > 0L)
                    event.put("healthRequestFinishedAtMs", requestSnapshot.finishedAtMs);
                if (requestSnapshot.startedAtMs > 0L && requestSnapshot.finishedAtMs > 0L && requestSnapshot.durationMs >= 0L)
                    event.put("healthRequestDurationMs", requestSnapshot.durationMs);
                if (requestSnapshot.startedElapsedMs > 0L) event.put("healthRequestStartedElapsedMs", requestSnapshot.startedElapsedMs);
                event.put("healthLaneBusy", healthRequestLane.isBusy()).put("healthLaneHealthy", healthRequestLane.isHealthy());
                HealthDiagnosticsSnapshot diagnosticsSnapshot = lastSuccessfulHealthDiagnostics;
                if (diagnosticsSnapshot.atMs > 0L) event.put("lastSuccessfulHealthDiagnosticsAtMs", diagnosticsSnapshot.atMs)
                    .put("lastSuccessfulHealthDiagnostics", new JSONObject(diagnosticsSnapshot.json));
                long retryAt = safetyPreferences().getLong(ENGINE_RETRY_AT_MS, 0L);
                if (retryAt > 0L) event.put("retryAtMs", retryAt);
            } else if ("restart_request_failed".equals(cause)) {
                event.put("eventState", "incomplete").put("phase", "restart-request").put("method", "POST").put("sourceNamespace", "engine-recovery");
                long retryAt = safetyPreferences().getLong(ENGINE_RETRY_AT_MS, 0L);
                if (retryAt > 0L) event.put("retryAtMs", retryAt);
            } else {
                event.put("eventState", "requested").put("phase", "recovery").put("sourceNamespace", "engine-recovery");
                long retryAt = safetyPreferences().getLong(ENGINE_RETRY_AT_MS, 0L);
                if (retryAt > 0L) event.put("retryAtMs", retryAt);
            }
            if (owner != null && !owner.isEmpty()) event.put("ownerRef", owner);
            events.put(event);
            JSONObject doc = new JSONObject().put("version", 1).put("events", events);
            if (doc.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > RECOVERY_JOURNAL_MAX_BYTES) return;
            PrivateFiles.write(target, doc.toString());
            Os.chmod(target.getAbsolutePath(), 0600);
        }} catch (Exception ignored) { /* Telemetry must never gate engine recovery. */ }
    }
    private void flushRecoveryJournal() {
        if (closing || port == 0 || token == null || !recoveryJournalLane.isHealthy()) return;
        archiveOwnerlessRecoveryEvents();
        final JSONArray events;
        try { synchronized (recoveryJournalLock) { events = readRecoveryJournal(); } }
        catch (Exception corruptOrUnavailable) { return; }
        if (events.length() == 0) return;
        try {
            JSONArray importableEvents = new JSONArray();
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.optJSONObject(i);
                if (event != null && !event.optString("ownerRef", "").isEmpty()) importableEvents.put(event);
            }
            if (importableEvents.length() == 0) return;
            JSONObject response = recoveryJournalLane.execute(port, token, "POST", "/api/local/native-recovery/import", new JSONObject().put("events", importableEvents));
            JSONArray accepted = response.optJSONArray("acceptedIds");
            if (accepted == null || accepted.length() == 0) return;
            java.util.HashSet<String> acceptedIds = new java.util.HashSet<>();
            for (int i = 0; i < accepted.length(); i++) if (accepted.opt(i) instanceof String) acceptedIds.add(accepted.getString(i));
            if (acceptedIds.isEmpty()) return;
            synchronized (recoveryJournalLock) {
                JSONArray current = readRecoveryJournal(), remaining = new JSONArray();
                for (int i = 0; i < current.length(); i++) {
                    JSONObject event = current.optJSONObject(i);
                    if (event != null && !acceptedIds.contains(event.optString("eventId", ""))) remaining.put(event);
                }
                JSONObject doc = new JSONObject().put("version", 1).put("events", remaining);
                if (doc.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= RECOVERY_JOURNAL_MAX_BYTES) {
                    PrivateFiles.write(recoveryJournalFile(), doc.toString());
                    Os.chmod(recoveryJournalFile().getAbsolutePath(), 0600);
                }
            }
        } catch (Exception unavailable) { /* Retry later; event IDs make import idempotent. */ }
    }
    private boolean acceptReconnectDelivery(Intent intent) {
        synchronized (stopLatchLock) {
            JSONObject receipt = KeepAlive.readJsonState(this, KeepAlive.RECONNECT_STATE_FILE);
            String outcome = "stale-or-cancelled";
            boolean accepted = false;
            try {
                if (closing || stopRequested() || !KeepAlive.engineAllowed(this)
                        || new File(getFilesDir(), "user-stop-request.json").isFile()) outcome = "stop-or-desired-blocked";
                else if (KeepAlive.reconnectMatches(this, intent, receipt)
                        && intent.getIntExtra(KeepAlive.EXTRA_EPOCH, -1) == KeepAlive.epoch(this)
                        && (!started || nativeGeneration.equals(receipt.optString("generation", "")))) {
                    receipt.put("state", "delivered").put("scheduled", false)
                        .put("deliveredAtMs", System.currentTimeMillis());
                    accepted = KeepAlive.writeReconnectState(this, KeepAlive.RECONNECT_STATE_FILE, receipt);
                    outcome = accepted ? "accepted-passive-recovery" : "receipt-unavailable";
                    reconnectWakeAtMs = 0L;
                    if (accepted) ReconnectTiming.delivered(this, KeepAlive.reconnectEventId(intent),
                        receipt.optLong("deliveredAtMs", System.currentTimeMillis()));
                }
                long handledAtMs = System.currentTimeMillis();
                KeepAlive.writeReconnectState(this, KeepAlive.RECONNECT_HANDLING_FILE, new JSONObject()
                    .put("id", KeepAlive.reconnectEventId(intent))
                    .put("handledAtMs", handledAtMs).put("outcome", outcome)
                    .put("epoch", KeepAlive.epoch(this)).put("generation", nativeGeneration));
                ReconnectTiming.handled(this, KeepAlive.reconnectEventId(intent), handledAtMs, outcome);
            } catch (Exception unavailable) { return false; }
            return accepted;
        }
    }
    private String deviceBootId() {
        try {
            byte[] raw = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("/proc/sys/kernel/random/boot_id"));
            String value = new String(raw, java.nio.charset.StandardCharsets.UTF_8).trim();
            return PROJECTION_UUID.matcher(value).matches() ? value : "";
        } catch (Throwable unavailable) { return ""; }
    }
    private void setProjectionState(String state, String code) {
        projectionCode = code == null ? "" : code;
        projectionState = projectionCode.isEmpty() ? state : state + ":" + projectionCode;
    }
    /**
     * The only identity authority this process accepts is one real status response whose own
     * engineReadiness still names this process and generation. It is published atomically; a
     * stale or uninitialised source revokes eligibility and triggers a real projection re-read.
     */
    private void captureIdentitySource(JSONObject status, long requestSeq) {
        // Publication and revocation happen under the same lock the decision holds, so a new
        // revocation can never slip in between "identity verified" and "appointment issued".
        synchronized (projectionLock) {
        JSONObject software = status.optJSONObject("software");
        JSONObject readiness = status.optJSONObject("engineReadiness");
        boolean usable = software != null && !software.optString("installId", "").isEmpty()
            && !software.optString("ownerRef", "").isEmpty() && integral(software, "identityEpoch")
            && software.opt("authorized") instanceof Boolean && software.opt("requiresEngineRestart") instanceof Boolean
            && readiness != null && readiness.optLong("pid", -1L) == (long) android.os.Process.myPid()
            && !nativeGeneration.isEmpty() && nativeGeneration.equals(readiness.optString("instanceId", ""));
        if (!usable) {
            identitySnapshot = null;
            projectionUnavailable("IDENTITY_SOURCE_STALE");
            requestReconnectProjectionRead();
            return;
        }
        // A status request that started before the accepted snapshot cannot judge that snapshot:
        // this is a real causal comparison of the Java request order, not a stored ticket.
        if (requestSeq < projectionAcceptedSeq) return;
        IdentitySnapshot next = new IdentitySnapshot(software, status.optJSONObject("nativeStopControl"),
            android.os.Process.myPid(), nativeGeneration, requestSeq,
            software.optLong("identityEpoch", -1L), software.optBoolean("authorized", false));
        IdentitySnapshot previous = identitySnapshot;
        identitySnapshot = next;
        if (previous != null && (previous.identityEpoch != next.identityEpoch || previous.authorized != next.authorized)) {
            // Authorization or owner epoch changed: an older decision is no longer trustworthy.
            projectionUnavailable("IDENTITY_CHANGED");
            requestReconnectProjectionRead();
        } else if (previous == null && !projectionAuthoritative) {
            // The identity source only became usable now: a document that arrived before it was
            // rejected as unprovable and needs one real re-read to be decided.
            requestReconnectProjectionRead();
        }
        }
    }
    private void startReconnectProjection() {
        File directory = new File(getFilesDir(), "data");
        if (!directory.isDirectory() && !directory.mkdirs()) { setProjectionState("unavailable", "DATA_DIRECTORY_UNAVAILABLE"); return; }
        if (projectionObserver == null) {
            // Subscribe before the first read. Only the published name is watched: the writer's
            // .tmp churn is not a version and must not drive reads.
            try {
                projectionObserver = new FileObserver(directory.getAbsolutePath(), FileObserver.MODIFY | FileObserver.CLOSE_WRITE
                    | FileObserver.MOVED_TO | FileObserver.CREATE) {
                    @Override public void onEvent(int eventMask, String pathName) {
                        if (PROJECTION_FILE.equals(pathName)) requestReconnectProjectionRead();
                    }
                };
                projectionObserver.startWatching();
                projectionWatchOk = true;
            } catch (Throwable unavailable) {
                projectionObserver = null;
                projectionWatchOk = false;
                setProjectionState("unavailable", "WATCH_UNAVAILABLE");
            }
        }
        requestReconnectProjectionRead();
    }
    private void stopReconnectProjection() {
        FileObserver watcher = projectionObserver;
        projectionObserver = null;
        projectionWatchOk = false;
        projectionAuthoritative = false;
        projectionSnapshot = null;
        if (watcher != null) try { watcher.stopWatching(); } catch (RuntimeException ignored) { }
        try { projectionReader.shutdownNow(); } catch (RuntimeException ignored) { }
    }
    private void requestReconnectProjectionRead() {
        if (closing) return;
        synchronized (projectionQueueLock) {
            projectionReadPending = true;
            if (projectionReadRunning) return;
            projectionReadRunning = true;
        }
        try {
            projectionReader.execute(() -> {
                try {
                    for (;;) {
                        synchronized (projectionQueueLock) {
                            if (!projectionReadPending) { projectionReadRunning = false; return; }
                            projectionReadPending = false;
                        }
                        readReconnectProjection();
                    }
                } catch (Throwable unavailable) {
                    synchronized (projectionQueueLock) { projectionReadRunning = false; }
                    projectionUnavailable("READER_FAILED");
                }
            });
        } catch (RejectedExecutionException stopped) {
            synchronized (projectionQueueLock) { projectionReadRunning = false; projectionReadPending = false; }
        }
    }
    /** Reads at most limit+1 bytes: the size decision no longer relies on a pre-read length. */
    private byte[] readProjectionBounded(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[PROJECTION_MAX_BYTES + 1];
            int total = 0, read;
            while (total < buffer.length && (read = in.read(buffer, total, buffer.length - total)) > 0) total += read;
            if (total > PROJECTION_MAX_BYTES) return null;
            return java.util.Arrays.copyOf(buffer, total);
        }
    }
    /**
     * Any failure drops authority: a failed attempt must never keep an older source in charge.
     * Only a validated document restores it, so no wall-clock TTL upgrades a stale read.
     */
    private void projectionUnavailable(String code) {
        // Eligibility loss is published on the same boundary as the decision, so an old decision
        // cannot interleave and then resurrect authority from a stale read.
        synchronized (projectionLock) {
            projectionAuthoritative = false;
            projectionSourceEligible = false;
            setProjectionState("unavailable", code);
        }
    }
    private void readReconnectProjection() {
        if (closing) return;
        projectionLastAttemptElapsedMs = SystemClock.elapsedRealtime();
        projectionPathDetail = "";
        // Same convention as the already device-tested private readers (tick profile, health busy
        // join): canonicalise only the trusted files directory, then join the fixed literal
        // "data/PROJECTION_FILE". A ROM may spell the files directory's ancestors through symlinks
        // (/data/data <-> /data/user/0); that accepted spelling is shared by both sides, while a
        // symlink on "data" or on the projection file itself still resolves elsewhere and is
        // refused. This reader must not build the path from the raw getFilesDir() spelling.
        File filesDir;
        try { filesDir = getFilesDir().getCanonicalFile(); }
        catch (Exception unavailable) { projectionUnavailable("PATH_UNREADABLE"); return; }
        File file = new File(new File(filesDir, "data"), PROJECTION_FILE);
        if (!file.isFile()) {
            synchronized (projectionLock) { projectionSnapshot = null; }
            // The accepted generation/revision high-water mark stays: a missing file is not a new
            // publishing generation and may not make a lower revision acceptable.
            projectionUnavailable("MISSING");
            return;
        }
        File canonical;
        try { canonical = file.getCanonicalFile(); } catch (Exception unavailable) { projectionUnavailable("PATH_UNREADABLE"); return; }
        if (!canonical.equals(file.getAbsoluteFile())) {
            projectionPathDetail = file.getAbsolutePath() + " -> " + canonical.getPath();
            projectionUnavailable("PATH_NOT_CANONICAL");
            return;
        }
        byte[] bytes;
        try { bytes = readProjectionBounded(canonical); }
        catch (Exception unavailable) { projectionUnavailable("READ_FAILED"); return; }
        if (bytes == null) { projectionUnavailable("SIZE_LIMIT"); return; }
        if (bytes.length == 0) { projectionUnavailable("EMPTY"); return; }
        projectionLastReadElapsedMs = SystemClock.elapsedRealtime();
        JSONObject document;
        try { document = new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8)); }
        catch (Exception malformed) { projectionUnavailable("MALFORMED"); return; }
        applyReconnectProjection(document);
    }
    /**
     * Identity, schema and revision are checked before anything is scheduled. Doubt never
     * demotes a previously accepted current-generation document: only newer data or a real
     * stop may take the decision back.
     */
    private void applyReconnectProjection(JSONObject document) {
        String invalid = validateReconnectProjection(document);
        if (invalid != null) { projectionUnavailable(invalid); return; }
        long revision = document.optLong("revision", -1L);
        String generation = document.optString("nativeGeneration", "");
        ProjectionSnapshot snapshot;
        boolean idempotent;
        synchronized (projectionLock) {
            ProjectionSnapshot current = projectionSnapshot;
            boolean sameGeneration = generation.equals(projectionAcceptedGeneration) && projectionAcceptedRevision > 0L;
            if (sameGeneration && revision == projectionAcceptedRevision) {
                // A repeated event for the same version is re-decided under the same fence, never
                // trusted as "already fine": a STOP issued in between must still win.
                snapshot = current != null ? current : new ProjectionSnapshot(document.toString(), revision, generation,
                    projectionAcceptedSeq);
                projectionSnapshot = snapshot;
                idempotent = true;
            } else if (sameGeneration && revision < projectionAcceptedRevision) {
                // Older bytes never demote the accepted state; authority is left exactly as it was.
                setProjectionState("regressed", "REVISION_NOT_NEWER");
                return;
            } else {
                snapshot = new ProjectionSnapshot(document.toString(), revision, generation,
                    projectionSourceSequence.incrementAndGet());
                projectionSnapshot = snapshot;
                projectionAcceptedRevision = revision;
                projectionAcceptedGeneration = generation;
                projectionAcceptedSeq = snapshot.sourceSeq;
                projectionAcceptedAtMs = System.currentTimeMillis();
                projectionLastValidatedElapsedMs = SystemClock.elapsedRealtime();
                projectionSourceEligible = true;
                projectionAttempts = 0;
                projectionNextAttemptElapsedMs = 0L;
                idempotent = false;
            }
        }
        if (idempotent) {
            // A same-revision recovery keeps the existing attempt budget: a re-read does not reset
            // the three-attempt/backoff allowance.
            projectionLastValidatedElapsedMs = SystemClock.elapsedRealtime();
            projectionSourceEligible = true;
        }
        decideReconnectProjection(snapshot, false);
    }
    /** Low-frequency real re-read plus a causal (not timed) hand-back when the watch is gone. */
    private void maintainReconnectProjectionSource() {
        if (closing) return;
        long nowElapsed = SystemClock.elapsedRealtime();
        if (nowElapsed - projectionLastAttemptElapsedMs >= PROJECTION_REREAD_MS) requestReconnectProjectionRead();
        // Causal rule: if a real read ran after the last validated source and did not validate,
        // and no watch can announce the next change, hand the decision back with a reason.
        if (!projectionWatchOk && projectionAuthoritative
                && projectionLastAttemptElapsedMs > projectionLastValidatedElapsedMs) {
            projectionUnavailable("SOURCE_STALE_NO_WATCH");
        }
    }
    /**
     * Decides what an accepted snapshot means. Lock order is fixed: projectionLock then
     * stopLatchLock. The snapshot is proven to still be the current accepted source at the
     * decision boundary, so a retry cannot resurrect an intent a newer document cancelled.
     */
    private void decideReconnectProjection(ProjectionSnapshot snapshot, boolean retry) {
        synchronized (projectionLock) {
            if (snapshot == null || snapshot != projectionSnapshot) { setProjectionState("superseded", "SNAPSHOT_NOT_CURRENT"); return; }
            JSONObject document;
            try { document = new JSONObject(snapshot.text); }
            catch (Exception unusable) { projectionUnavailable("ACCEPTED_DOCUMENT_UNREADABLE"); return; }
            synchronized (stopLatchLock) {
                if (retry && !projectionSourceEligible) {
                    // The retry entry check happened outside the lock; inside it the source may have
                    // failed. Only a real, re-validated current file may regain eligibility.
                    setProjectionState("unavailable", "RETRY_SOURCE_INELIGIBLE");
                    return;
                }
                // Re-run the identity comparison here: validate() happened before this lock, and
                // the software may have revoked authorization in between.
                String revoked = identityViolation(document);
                if (revoked != null) { projectionUnavailable(revoked); return; }
                String blocked = projectionSchedulingBlock(document);
                if (blocked != null) {
                    if ("STOP_COMMITTED".equals(blocked) || "STOP_BLOCKED".equals(blocked)) {
                        projectionAuthoritative = false;
                        try { KeepAlive.cancelReconnectWakeup(this, "projection-stop"); } catch (Exception ignored) { }
                        reconnectWakeAtMs = 0L;
                        projectionIntentKey = "";
                        setProjectionState("explicit-stop", blocked);
                    } else {
                        projectionUnavailable(blocked);
                    }
                    return;
                }
                // No "already fine" shortcut: a same-revision re-read after a failed attempt must
                // re-execute the cancel/appointment decision under the current identity. Repeat
                // scheduling is still deduped by the intent key below.
                projectionAuthoritative = true;
                long now = System.currentTimeMillis(), earliest = Long.MAX_VALUE;
                JSONObject selected = null;
                int invalidRows = 0;
                JSONArray accounts = document.optJSONArray("accounts");
                for (int i = 0; accounts != null && i < accounts.length(); i++) {
                    JSONObject row = accounts.optJSONObject(i);
                    if (row == null) { invalidRows++; continue; }
                    // The engine's own publication is what closes a reconnect cycle
                    // as connected again; an open cycle for this subject is the
                    // only one this call can touch. RUNNABLE and WAITING are both
                    // connected fact states.
                    ReconnectTiming.observeConnected(this, row.optString("accountRef", ""),
                        row.optString("scopeHash", ""), row.optString("state", ""), System.currentTimeMillis());
                    if (!row.optBoolean("desiredRunning", false) || row.optBoolean("needsManualStart", false)) continue;
                    if (row.isNull("retryAtMs")) continue;
                    long at = row.optLong("retryAtMs", 0L);
                    if (at <= 0L) continue;
                    if (at < earliest) { earliest = at; selected = row; }
                }
                if (selected == null) {
                    if (invalidRows > 0) { projectionUnavailable("ROWS_INVALID_PRESERVED"); return; }
                    // A complete current document with no future deadline is an explicit cancel and
                    // it keeps governing: the slower status scan may not revive the deadline.
                    try { KeepAlive.cancelReconnectWakeup(this, "projection-no-deadline"); } catch (Exception ignored) { }
                    reconnectWakeAtMs = 0L;
                    projectionIntentKey = "";
                    projectionScheduledKey = "";
                    projectionScheduledRevision = snapshot.revision;
                    try { reconnectSelection = new JSONObject().put("state", "projection-none")
                        .put("revision", snapshot.revision).put("observedAtMs", now).toString(); } catch (Exception ignored) { }
                    setProjectionState("explicit-cancel", "");
                    return;
                }
                String accountRef, scopeHash;
                long runEpoch;
                try {
                    accountRef = selected.getString("accountRef");
                    scopeHash = selected.getString("scopeHash");
                    runEpoch = selected.getLong("runEpoch");
                } catch (Exception unusable) { projectionUnavailable("INTENT_UNREADABLE"); return; }
                String key = snapshot.generation + "|" + document.optLong("controlSeq", -1L)
                    + "|" + accountRef + "|" + scopeHash + "|" + runEpoch + "|" + earliest;
                boolean overdue = earliest <= now;
                if (overdue && key.equals(projectionScheduledKey)) {
                    setProjectionState("overdue-consumed", "ALREADY_APPOINTED");
                    return;
                }
                if (overdue && projectedAlarmStillCurrent(accountRef, scopeHash, runEpoch, earliest,
                        document.optLong("controlSeq", -1L))) {
                    reconnectWakeAtMs = KeepAlive.reconnectAlarmState(this).optLong("triggerAtMs", 0L);
                    projectionScheduledKey = key;
                    projectionScheduledRevision = snapshot.revision;
                    setProjectionState("overdue-awaiting-delivery", "");
                    return;
                }
                if (!retry && key.equals(projectionScheduledKey) && projectionScheduledRevision == snapshot.revision) {
                    setProjectionState(overdue ? "overdue-consumed" : "scheduled", overdue ? "ALREADY_APPOINTED" : "");
                    return;
                }
                if (projectionAttempts >= PROJECTION_MAX_ATTEMPTS) {
                    setProjectionState("appointment-failed", "ATTEMPTS_EXHAUSTED");
                    return;
                }
                // The same fence applies to a fresh read, an idempotent re-read and a retry: a
                // burst of file events cannot burn every attempt within milliseconds.
                if (projectionAttempts > 0 && SystemClock.elapsedRealtime() < projectionNextAttemptElapsedMs) {
                    setProjectionState("appointment-waiting", "BACKOFF");
                    return;
                }
                projectionIntentKey = key;
                projectionIntentDeadlineMs = earliest;
                projectionIntentAccountRef = accountRef;
                projectionIntentScopeHash = scopeHash;
                projectionIntentRunEpoch = runEpoch;
                appointReconnectProjection(snapshot.revision, overdue, now);
            }
        }
    }
    private void appointReconnectProjection(long revision, boolean overdue, long now) {
        try {
            JSONObject selection = new JSONObject().put("deadlineAtMs", projectionIntentDeadlineMs)
                .put("accountRef", projectionIntentAccountRef).put("scopeHash", projectionIntentScopeHash)
                .put("runEpoch", projectionIntentRunEpoch);
            JSONObject receipt = KeepAlive.scheduleReconnectWakeup(this, selection, KeepAlive.epoch(this), nativeGeneration);
            boolean scheduled = "scheduled".equals(receipt.optString("state", "")) && receipt.optBoolean("scheduled", false);
            if (scheduled) {
                reconnectWakeAtMs = receipt.optLong("triggerAtMs", 0L);
                projectionScheduledRevision = revision;
                projectionScheduledKey = projectionIntentKey;
                projectionAttempts = 0;
                projectionNextAttemptElapsedMs = 0L;
                projectionLastScheduledDeadline = projectionIntentDeadlineMs;
                projectionLastScheduledScope = projectionIntentScopeHash;
                setProjectionState(overdue ? "overdue-appointed" : "scheduled", "");
            } else {
                // A failed AlarmManager call is not a consumed version: keep the intent for a
                // bounded retry on the next status tick instead of demanding a new publication.
                projectionAttempts++;
                projectionNextAttemptElapsedMs = SystemClock.elapsedRealtime()
                    + PROJECTION_RETRY_BACKOFF_MS * Math.max(1, projectionAttempts);
                reconnectWakeAtMs = 0L;
                setProjectionState("appointment-failed", "ALARM_REJECTED");
            }
            try { reconnectSelection = new JSONObject().put("state", scheduled ? "projection-selected" : "projection-rejected")
                .put("revision", revision).put("deadlineAtMs", projectionIntentDeadlineMs)
                .put("accountRef", projectionIntentAccountRef).put("scopeHash", projectionIntentScopeHash)
                .put("attempts", projectionAttempts).put("overdue", overdue).put("observedAtMs", now).toString(); } catch (Exception ignored) { }
        } catch (Exception unusable) {
            projectionAttempts++;
            projectionNextAttemptElapsedMs = SystemClock.elapsedRealtime() + PROJECTION_RETRY_BACKOFF_MS * Math.max(1, projectionAttempts);
            setProjectionState("appointment-failed", "SCHEDULE_FAILED");
        }
    }
    /** Bounded retry for the same accepted snapshot; the snapshot identity is re-checked inside. */
    private void retryReconnectProjection() {
        if (closing || !projectionAuthoritative || projectionIntentKey.isEmpty()) return;
        if (projectionScheduledKey.equals(projectionIntentKey)) return;
        if (projectionAttempts >= PROJECTION_MAX_ATTEMPTS) return;
        if (SystemClock.elapsedRealtime() < projectionNextAttemptElapsedMs) return;
        if (stopRequested() || !KeepAlive.engineAllowed(this) || new File(getFilesDir(), "user-stop-request.json").isFile()) return;
        ProjectionSnapshot snapshot = projectionSnapshot;
        if (snapshot == null) return;
        JSONObject document;
        try { document = new JSONObject(snapshot.text); }
        catch (Exception unusable) { projectionUnavailable("ACCEPTED_DOCUMENT_UNREADABLE"); return; }
        String invalid = validateReconnectProjection(document);
        if (invalid != null) { projectionUnavailable(invalid); return; }
        decideReconnectProjection(snapshot, true);
    }
    private boolean integral(JSONObject value, String name) {
        Object raw = value.opt(name);
        if (!(raw instanceof Number)) return false;
        Number number = (Number) raw;
        return number.doubleValue() == number.longValue() && Math.abs(number.longValue()) <= 9_007_199_254_740_991L;
    }
    private boolean booleanField(JSONObject value, String name) { return value.opt(name) instanceof Boolean; }
    private String validateReconnectProjection(JSONObject document) {
        if (!PROJECTION_VERSION.equals(document.optString("version", ""))) return "VERSION_UNSUPPORTED";
        if (!integral(document, "schemaVersion") || document.optLong("schemaVersion", -1L) != 1L) return "SCHEMA_UNSUPPORTED";
        if (!booleanField(document, "complete") || document.optBoolean("complete", false) != true) return "INCOMPLETE";
        if (!PROJECTION_SCOPE_ALGORITHM.equals(document.optString("scopeHashAlgorithm", ""))) return "SCOPE_ALGORITHM_UNSUPPORTED";
        String generation = document.optString("nativeGeneration", "");
        if (!PROJECTION_UUID.matcher(generation).matches()) return "GENERATION_INVALID";
        if (!generation.equals(document.optString("instanceId", ""))) return "INSTANCE_MISMATCH";
        if (nativeGeneration.isEmpty() || !generation.equals(nativeGeneration)) return "STALE_GENERATION";
        if (!integral(document, "pid") || document.optLong("pid", -1L) != (long) android.os.Process.myPid()) return "PID_MISMATCH";
        if (nativeStartToken.isEmpty() || !nativeStartToken.equals(document.optString("processStartToken", ""))) return "START_TOKEN_MISMATCH";
        String bootId = deviceBootId();
        if (bootId.isEmpty() || !bootId.equals(document.optString("bootId", ""))) return "BOOT_ID_MISMATCH";
        if (!booleanField(document, "authorized") || !booleanField(document, "stopCommitted")
                || !booleanField(document, "stopBlocked") || !booleanField(document, "requiresEngineRestart")) return "IDENTITY_INVALID";
        if (!PROJECTION_PUBLISHER_STATES.contains(document.optString("publisherState", ""))) return "PUBLISHER_STATE_INVALID";
        if (!PROJECTION_CONTROL_KINDS.contains(document.optString("controlKind", ""))) return "CONTROL_KIND_INVALID";
        if (!integral(document, "identityEpoch") || document.optLong("identityEpoch", -1L) < 0L) return "IDENTITY_EPOCH_INVALID";
        if (!integral(document, "controlSeq") || document.optLong("controlSeq", -1L) < 0L) return "CONTROL_SEQ_INVALID";
        if (!integral(document, "revision") || document.optLong("revision", 0L) <= 0L) return "REVISION_INVALID";
        // The document may not certify its own identity: compare against the real status payload.
        String identity = identityViolation(document);
        if (identity != null) return identity;
        JSONArray accounts = document.optJSONArray("accounts");
        if (accounts == null || accounts.length() > PROJECTION_MAX_ACCOUNTS) return "ROSTER_LIMIT";
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject row = accounts.optJSONObject(i);
            if (row == null) return "ROW_INVALID";
            Object rawRef = row.opt("accountRef");
            if (!(rawRef instanceof String) || !((String) rawRef).matches("[1-9][0-9]{0,19}")) return "ROW_INVALID";
            if (!seen.add((String) rawRef)) return "ROSTER_DUPLICATE";
            if (!PROJECTION_UUID.matcher(row.optString("scopeHash", "")).matches()) return "ROW_INVALID";
            if (!booleanField(row, "desiredRunning") || !booleanField(row, "needsManualStart")) return "ROW_INVALID";
            if (!PROJECTION_STATES.contains(row.optString("state", ""))) return "ROW_INVALID";
            if (!integral(row, "runEpoch") || row.optLong("runEpoch", -1L) < 0L) return "ROW_INVALID";
            if (!integral(row, "connectionEpoch") || row.optLong("connectionEpoch", -1L) < 0L) return "ROW_INVALID";
            if (row.optBoolean("desiredRunning", false) && row.optLong("runEpoch", 0L) <= 0L) return "ROW_INVALID";
            if (!row.isNull("retryAtMs") && (!integral(row, "retryAtMs") || row.optLong("retryAtMs", 0L) <= 0L)) return "ROW_INVALID";
        }
        return null;
    }
    /**
     * Identity/authorization comparison against the current identity snapshot. Called both on
     * read and again inside the decision boundary, so a revocation after validation cannot
     * still schedule an old authorized document.
     */
    private String identityViolation(JSONObject document) {
        IdentitySnapshot identity = identitySnapshot;
        if (identity == null) return "IDENTITY_SOURCE_UNAVAILABLE";
        if (identity.pid != android.os.Process.myPid() || nativeGeneration.isEmpty()
                || !nativeGeneration.equals(identity.generation)) return "IDENTITY_SOURCE_STALE";
        JSONObject software = identity.software;
        String installId = software.optString("installId", "");
        String ownerRef = software.optString("ownerRef", "");
        if (installId.isEmpty() || ownerRef.isEmpty() || !integral(software, "identityEpoch")) return "IDENTITY_SOURCE_INCOMPLETE";
        if (!("device:" + installId).equals(document.optString("scopeRef", ""))) return "SCOPE_REF_MISMATCH";
        if (!ownerRef.equals(document.optString("ownerRef", ""))) return "OWNER_MISMATCH";
        if (software.optLong("identityEpoch", -1L) != document.optLong("identityEpoch", -2L)) return "IDENTITY_EPOCH_MISMATCH";
        if (software.optBoolean("authorized", false) != document.optBoolean("authorized", !software.optBoolean("authorized", false))) return "AUTHORIZED_MISMATCH";
        if (software.optBoolean("requiresEngineRestart", false) != document.optBoolean("requiresEngineRestart", !software.optBoolean("requiresEngineRestart", false))) return "RESTART_FLAG_MISMATCH";
        JSONObject control = identity.control;
        long controlSeq = control == null ? 0L : control.optLong("controlSeq", 0L);
        if (document.optLong("controlSeq", -1L) != controlSeq) return "CONTROL_SEQ_STALE";
        if (control != null && !control.optString("scopeRef", "").isEmpty()
                && !("device:" + installId).equals(control.optString("scopeRef", ""))) return "CONTROL_SCOPE_MISMATCH";
        if (control != null && control.optBoolean("stopCommitted", false) != document.optBoolean("stopCommitted", !control.optBoolean("stopCommitted", false))) return "STOP_COMMITTED_MISMATCH";
        return null;
    }
    private String projectionSchedulingBlock(JSONObject document) {
        if (closing || stopRequested() || !KeepAlive.engineAllowed(this)
                || new File(getFilesDir(), "user-stop-request.json").isFile()) return "STOP_OR_DESIRED_BLOCKED";
        if (document.optBoolean("stopBlocked", false)) return "STOP_BLOCKED";
        if (document.optBoolean("stopCommitted", false) || "STOP".equals(document.optString("controlKind", ""))) return "STOP_COMMITTED";
        if (!document.optBoolean("authorized", false)) return "UNAUTHORIZED";
        if (document.optBoolean("requiresEngineRestart", false)) return "RESTART_REQUIRED";
        if (!"ready".equals(document.optString("publisherState", ""))) return "PUBLISHER_NOT_READY";
        if (document.optLong("controlSeq", -1L) != KeepAlive.nativeControlState(this).optLong("controlSeq", 0L)) return "CONTROL_SEQ_STALE";
        return null;
    }
    private boolean projectedAlarmStillCurrent(String accountRef, String scopeHash, long runEpoch, long deadline, long controlSeq) {
        JSONObject previous = KeepAlive.reconnectAlarmState(this);
        // The whole intent has to match: the same deadline for another account, scope, run or
        // control command is a different intent and must not count as "already scheduled".
        return "scheduled".equals(previous.optString("state"))
            && previous.optLong("deadlineAtMs", 0L) == deadline
            && accountRef.equals(previous.optString("accountRef", ""))
            && scopeHash.equals(previous.optString("scopeHash", ""))
            && previous.optLong("runEpoch", -1L) == runEpoch
            && previous.optLong("controlSeq", -1L) == controlSeq
            && previous.optInt("epoch", -1) == KeepAlive.epoch(this)
            && previous.optInt("bootCount", -2) == KeepAlive.bootCount(this)
            && !nativeGeneration.isEmpty() && nativeGeneration.equals(previous.optString("generation", ""));
    }
    private JSONObject reconnectProjectionStatus() {
        JSONObject value = new JSONObject();
        try {
            ProjectionSnapshot current = projectionSnapshot;
            value.put("state", projectionState).put("code", projectionCode)
                .put("pathDetail", projectionPathDetail)
                .put("revision", projectionAcceptedRevision).put("generation", projectionAcceptedGeneration)
                .put("acceptedSeq", projectionAcceptedSeq).put("authoritative", projectionAuthoritative)
                .put("watching", projectionObserver != null).put("acceptedAtMs", projectionAcceptedAtMs)
                .put("scheduledRevision", projectionScheduledRevision)
                .put("appointmentAttempts", projectionAttempts)
                .put("snapshotBound", current != null && current.revision == projectionAcceptedRevision)
                .put("scheduledDeadlineAtMs", projectionLastScheduledDeadline);
        } catch (Exception ignored) { }
        return value;
    }
    private void scheduleReconnectWakeup(JSONObject status, long statusRequestSeq) {
        JSONObject statusControl = status.optJSONObject("nativeStopControl");
        long statusControlSeq = statusControl == null ? 0L : statusControl.optLong("controlSeq", 0L);
        // Same boundary and same order as the projection path: projectionLock -> stopLatchLock.
        // The gate is re-evaluated inside, so a projection accept/cancel cannot interleave.
        synchronized (projectionLock) {
        IdentitySnapshot identity = identitySnapshot;
        if (identity == null || identity.pid != android.os.Process.myPid() || nativeGeneration.isEmpty()
                || !nativeGeneration.equals(identity.generation) || !identity.authorized) {
            // No current authorized identity source: the roster scan may not create an alarm.
            setProjectionState("unavailable", "FALLBACK_IDENTITY_UNAVAILABLE");
            return;
        }
        synchronized (stopLatchLock) {
            IdentitySnapshot fresh = identitySnapshot;
            if (fresh != identity || projectionAcceptedSeq > statusRequestSeq) {
                // The source moved while this scan was in flight: the scan may not decide.
                setProjectionState("superseded", "FALLBACK_SOURCE_MOVED");
                return;
            }
            if (statusControlSeq != KeepAlive.nativeControlState(this).optLong("controlSeq", 0L)) {
                // This status was built against another control command; KeepAlive would stamp the
                // new controlSeq onto an old selection and mix sources.
                setProjectionState("unavailable", "FALLBACK_CONTROL_STALE");
                return;
            }
            if (closing || stopRequested() || !KeepAlive.engineAllowed(this)) {
                reconnectWakeAtMs = 0L;
                KeepAlive.cancelReconnectWakeup(this, "stop-or-desired-blocked");
                return;
            }
            // An accepted projection document outranks the slower full-status scan, including when
            // it says "no deadline". A scan that began before the acceptance also cannot act after
            // it: the monotonic source order is the only ordering proof, never a wall-clock TTL.
            // statusRequestSeq is taken before the HTTP request, so an accepted file ordering
            // check is causal: a response that started earlier cannot override a later revision.
            if (projectionAuthoritative || projectionAcceptedSeq > statusRequestSeq) {
                try { reconnectSelection = new JSONObject().put("state", "projection-authoritative")
                    .put("revision", projectionAcceptedRevision)
                    .put("deadlineAtMs", projectionLastScheduledDeadline)
                    .put("scopeHash", projectionLastScheduledScope)
                    .put("observedAtMs", System.currentTimeMillis()).toString(); } catch (Exception ignored) { }
                return;
            }
            JSONObject readiness = status.optJSONObject("engineReadiness");
            JSONArray accounts = status.optJSONArray("accounts");
            if (readiness == null || readiness.optInt("pid", -1) != android.os.Process.myPid()
                    || nativeGeneration.isEmpty() || !nativeGeneration.equals(readiness.optString("instanceId", ""))
                    || accounts == null) {
                reconnectSelection = "{\"state\":\"snapshot-unavailable-or-stale\"}";
                return;
            }
            long observedAt = System.currentTimeMillis();
            long earliest = Long.MAX_VALUE;
            JSONObject selection = null;
            int invalid = 0, eligible = 0, expired = 0;
            boolean overdueAlarmStillCurrent = false;
            JSONObject previous = KeepAlive.reconnectAlarmState(this);
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.optJSONObject(i);
                if (account == null) { invalid++; continue; }
                if (!Boolean.TRUE.equals(account.opt("desiredRunning"))
                        || Boolean.TRUE.equals(account.opt("needsManualStart"))) continue;
                Object retryAt = account.opt("retryAt");
                if (retryAt == null || retryAt == JSONObject.NULL) continue;
                try {
                    Object runEpoch = account.opt("runEpoch");
                    Object accountRef = account.opt("accountRef");
                    Object ownerRef = account.opt("ownerRef"), subjectRef = account.opt("subjectRef");
                    if (!(ownerRef instanceof String) || ((String) ownerRef).isEmpty() || ((String) ownerRef).length() > 160
                            || !(subjectRef instanceof String) || ((String) subjectRef).isEmpty() || ((String) subjectRef).length() > 256
                            || !(retryAt instanceof String) || ((String) retryAt).isEmpty()
                            || ((String) retryAt).length() > 64
                            || !(runEpoch instanceof Number) || ((Number) runEpoch).longValue() <= 0
                            || ((Number) runEpoch).doubleValue() != ((Number) runEpoch).longValue()
                            || !(accountRef instanceof String) || !((String) accountRef).matches("[0-9]{1,20}")) {
                        invalid++;
                        continue;
                    }
                    long at = java.time.Instant.parse((String) retryAt).toEpochMilli();
                    if (at <= 0L) { invalid++; continue; }
                    String scope = UUID.nameUUIDFromBytes((ownerRef + "\u0000" + accountRef + "\u0000" + subjectRef)
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();
                    if (at <= observedAt) {
                        expired++;
                        overdueAlarmStillCurrent |= "scheduled".equals(previous.optString("state"))
                            && previous.optLong("deadlineAtMs", 0L) == at
                            && scope.equals(previous.optString("scopeHash", ""))
                            && ((Number) runEpoch).longValue() == previous.optLong("runEpoch", -1L)
                            && nativeGeneration.equals(previous.optString("generation", ""))
                            && previous.optInt("epoch", -1) == KeepAlive.epoch(this)
                            && previous.optInt("bootCount", -2) == KeepAlive.bootCount(this)
                            && previous.optLong("controlSeq", -1L) == KeepAlive.nativeControlState(this).optLong("controlSeq", 0L);
                        continue;
                    }
                    eligible++;
                    if (at < earliest) {
                        earliest = at;
                        selection = new JSONObject().put("deadlineAtMs", at).put("accountRef", accountRef)
                            .put("scopeHash", scope).put("runEpoch", ((Number) runEpoch).longValue());
                    }
                } catch (Exception invalidAccount) { invalid++; }
            }
            if (overdueAlarmStillCurrent) {
                reconnectWakeAtMs = previous.optLong("triggerAtMs", 0L);
                try { reconnectSelection = new JSONObject().put("state", "overdue-awaiting-delivery")
                    .put("observedAtMs", observedAt).put("invalidAccountCount", invalid)
                    .put("eligibleAccountCount", eligible).put("expiredAccountCount", expired).toString(); }
                catch (Exception ignored) { }
                return;
            }
            // An invalid row cannot revoke another account's last accepted alarm.
            // A complete, valid snapshot with no deadline is an explicit cancellation.
            if (selection == null) {
                try { reconnectSelection = new JSONObject().put("state", invalid == 0 ? "none" : "invalid-preserved")
                    .put("invalidAccountCount", invalid).put("expiredAccountCount", expired)
                    .put("observedAtMs", observedAt).toString(); }
                catch (Exception ignored) { }
                if (invalid == 0 && !overdueAlarmStillCurrent) {
                    reconnectWakeAtMs = 0L;
                    KeepAlive.cancelReconnectWakeup(this, "no-eligible-deadline");
                }
                return;
            }
            try { selection.put("state", "selected").put("invalidAccountCount", invalid).put("eligibleAccountCount", eligible)
                .put("expiredAccountCount", expired).put("observedAtMs", observedAt).put("scanIntervalMs", 15_000L);
                reconnectSelection = selection.toString(); }
            catch (Exception ignored) { }
            JSONObject receipt = KeepAlive.scheduleReconnectWakeup(this, selection, KeepAlive.epoch(this), nativeGeneration);
            reconnectWakeAtMs = "scheduled".equals(receipt.optString("state", ""))
                && receipt.optBoolean("scheduled", false) ? receipt.optLong("triggerAtMs", 0L) : 0L;
        }
        }
    }
    private void refreshStatus() {
        if (closing) return;
        try {
            long statusRequestSeq = projectionSourceSequence.incrementAndGet();
            JSONObject status = request("GET", "/api/local/status");
            captureIdentitySource(status, statusRequestSeq);
            clearConfirmedStopLatch(status);
            confirmUserStartControl();
            JSONObject runtime = status.optJSONObject("runtime");
            int active = runtime == null ? 0 : runtime.optInt("runningCount", 0);
            int pending = runtime == null ? 0 : runtime.optInt("pendingCount", 0);
            PrivateFiles.write(new File(getFilesDir(), "engine-heartbeat.json"), new JSONObject().put("at", System.currentTimeMillis())
                .put("pid", android.os.Process.myPid()).put("active", active).toString());
            String state = active > 0 ? active + " 个游戏号正在本机运行" : pending > 0 ? pending + " 个游戏号正在等待连接或恢复" : "本机执行器已就绪，等待开始任务";
            // Hold the CPU lock only while real work or a near deadline needs it.
            // A pending account that is waiting on a far retry deadline is woken by
            // its own alarm (already armed below), so the lock is released there
            // instead of keeping the process busy for the whole backoff window.
            boolean inFlight = active > 0;
            // Only an exact alarm is trusted to wake this process at the retry
            // deadline; an inexact alarm can drift in Doze, so the lock stays.
            JSONObject armedAlarm = KeepAlive.reconnectAlarmState(this);
            boolean exactArmedFarAhead = reconnectWakeAtMs > 0L
                && reconnectWakeAtMs - System.currentTimeMillis() > CPU_LOCK_HORIZON_MS
                && "exact-allow-while-idle".equals(armedAlarm.optString("mode", ""));
            boolean waitingWithoutNearDeadline = pending > 0 && !"offline".equals(DeviceProfile.transport(this))
                && !inFlight && !exactArmedFarAhead;
            if (inFlight || waitingWithoutNearDeadline) cpu.acquire(CPU_LOCK_TIMEOUT_MS);
            else if (cpu.isHeld()) cpu.release();
            noteLockReason(inFlight, pending, exactArmedFarAhead);
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(state, active > 0 || pending > 0));
            retryReconnectProjection();
            maintainReconnectProjectionSource();
            scheduleReconnectWakeup(status, statusRequestSeq);
            reportEngineState("running", active, pending);
        } catch (Exception e) {
            // Missing state is never advertised as running. Wake lock expires after one minute.
            // A failed status cannot leave the previous identity in charge: eligibility and the
            // projection source both go through the real unavailable/re-read path.
            synchronized (projectionLock) {
                // Failure publication shares the decision boundary: a reader that just passed the
                // identity check cannot be followed by an out-of-lock revocation.
                identitySnapshot = null;
                projectionUnavailable("STATUS_UNAVAILABLE");
            }
            maintainReconnectProjectionSource();
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification("正在核对本机执行器状态"));
        }
        // Full equipment capture only when the observation could have changed. The
        // profile is otherwise a static 488-byte rewrite every fifteen seconds.
        if (!closing) try {
            String transport = DeviceProfile.transport(this);
            if (!transport.equals(lastProfileTransport)) {
                PrivateFiles.write(new File(getFilesDir(), "device-profile.json"), DeviceProfile.capture(this).toString());
                lastProfileTransport = transport;
            }
        }
        catch (Exception profileUnavailable) { /* Reporting and STOP remain independent. */ }
    }
    private void shutdown() {
        final String latchId;
        final boolean initialLatchSaved;
        final int stopEpoch;
        synchronized (stopLatchLock) {
            if (closing) return;
            closing = true;
            SharedPreferences preferences = safetyPreferences();
            String existingId = preferences.getString(STOP_LATCH_ID, "");
            latchId = preferences.getBoolean(STOP_REQUESTED, false) && !existingId.isEmpty()
                ? existingId : UUID.randomUUID().toString();
            int bumpedEpoch = KeepAlive.bumpEpoch(this);
            stopEpoch = bumpedEpoch > 0 ? bumpedEpoch : Math.max(0, KeepAlive.epoch(this));
            // Make STOP durable before returning from the notification action.
            // A concurrent engine failure therefore cannot queue a sticky retry
            // ahead of this user's explicit stop request.
            initialLatchSaved = preferences.edit().putBoolean(STOP_REQUESTED, true)
                .putString(STOP_LATCH_ID, latchId).putInt(KeepAlive.STOP_LATCH_EPOCH, stopEpoch)
                .putBoolean(ENGINE_DESIRED, false).commit();
            reconnectWakeAtMs = 0L;
            projectionAuthoritative = false;
            KeepAlive.cancelReconnectWakeup(this, "user-stop");
        }
        // The UI process may cache safety preferences and miss the latch write above.
        // Publish the same STOP marker synchronously so its automatic reconnect gate
        // sees a fresh cross-process signal; the shutdown thread still retries it.
        try {
            PrivateFiles.write(new File(getFilesDir(), "user-stop-request.json"), new JSONObject()
                .put("at", System.currentTimeMillis()).put("latchId", latchId).toString());
        } catch (Exception ignored) { /* The shutdown thread retries below. */ }
        // The durable latch is committed above. Stop health admission and cancel it asynchronously;
        // the independent STOP lane gets its own five-second budget and never waits on health.
        healthRequestLane.stopAcceptingAndCancelActive();
        new Thread(() -> {
            // Independent durable paths: either marker or preferences is enough
            // to cancel old intents when a stuck/unavailable engine next starts.
            boolean markerSaved = false;
            boolean latchSaved = initialLatchSaved;
            boolean backendCommitted = false;
            boolean backendDrained = false;
            boolean backendSuperseded = false;
            try {
                synchronized (stopLatchLock) {
                    SharedPreferences preferences = safetyPreferences();
                    String pendingId = preferences.getString(STOP_LATCH_ID, "");
                    if (preferences.getBoolean(STOP_REQUESTED, false) && !pendingId.isEmpty() && !latchId.equals(pendingId)) {
                        // Never overwrite a newer durable STOP identity.
                        latchSaved = false;
                    } else if (!latchSaved) {
                        latchSaved = preferences.edit().putBoolean(STOP_REQUESTED, true).putString(STOP_LATCH_ID, latchId)
                            .putInt(KeepAlive.STOP_LATCH_EPOCH, stopEpoch).putBoolean(ENGINE_DESIRED, false).commit();
                    }
                }
            }
            catch (Exception storageFailure) { /* Still try the authenticated API. */ }
            try { markerSaved = writeStopMarker(latchId); }
            catch (Exception storageFailure) { /* A saved preference latch is consumed on next launch. */ }
            long stopStartedAtElapsed = SystemClock.elapsedRealtime();
            try {
                JSONObject response = stopControlRequest(latchId);
                lastStopLatencyMs = SystemClock.elapsedRealtime() - stopStartedAtElapsed;
                boolean matches = latchId.equals(response.optString("commandId", ""));
                backendSuperseded = response.optBoolean("superseded", false)
                    || safetyPreferences().getInt(KeepAlive.USER_START_EPOCH, 0) > stopEpoch;
                backendCommitted = matches && response.optBoolean("stopCommitted", false) && !backendSuperseded;
                backendDrained = backendCommitted && response.optBoolean("cleanupComplete", false);
                if (backendCommitted) {
                    KeepAlive.recordBackendStopReceipt(this, latchId, true, backendDrained,
                        response.optLong("controlSeq", 0L), nativeGeneration, response.optString("instanceId", ""));
                }
            } catch (Exception unavailable) { /* A saved marker/latch is consumed before recovery next launch. */ }
            // The authenticated stop may already have committed while the local data
            // directories were temporarily unwritable. Retry the durable latch and
            // marker for a bounded window so a transient failure does not lose the
            // user's STOP intent; a permanent failure keeps the existing API-only stop.
            if (backendCommitted && !markerSaved && !latchSaved) {
                for (int attempt = 0; attempt < 10 && !markerSaved && !latchSaved; attempt += 1) {
                    try { Thread.sleep(1000L); }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
                    if (!latchSaved) {
                        try {
                            synchronized (stopLatchLock) {
                                SharedPreferences preferences = safetyPreferences();
                                String pendingId = preferences.getString(STOP_LATCH_ID, "");
                                if (preferences.getBoolean(STOP_REQUESTED, false) && !pendingId.isEmpty() && !latchId.equals(pendingId)) {
                                    // A newer durable STOP already owns the identity.
                                    latchSaved = true;
                                } else {
                                    latchSaved = preferences.edit().putBoolean(STOP_REQUESTED, true).putString(STOP_LATCH_ID, latchId)
                                        .putInt(KeepAlive.STOP_LATCH_EPOCH, stopEpoch).putBoolean(ENGINE_DESIRED, false).commit();
                                }
                            }
                        } catch (Exception storageFailure) { /* Retry the marker below. */ }
                    }
                    if (!markerSaved) {
                        try {
                            PrivateFiles.write(new File(getFilesDir(), "user-stop-request.json"), new JSONObject()
                                .put("at", System.currentTimeMillis()).put("latchId", latchId).toString());
                            markerSaved = true;
                        } catch (Exception storageFailure) { /* Next attempt. */ }
                    }
                }
            }
            boolean supersededNow = backendSuperseded || userStartSupersedePending
                || KeepAlive.epoch(this) > stopEpoch;
            if (supersededNow) {
                if (userStartSupersedePending && KeepAlive.epoch(this) > stopEpoch) {
                    // A foreground user start in this process replaced the STOP
                    // while its drain was in flight. Keep this management engine.
                    closing = false;
                    healthRequestLane.resumeAccepting();
                    stopRequestLane.resumeAccepting();
                    restartRequestLane.resumeAccepting();
                    KeepAlive.scheduleSelfCheck(this, false);
                    reportEngineState("running", -1, -1);
                } else {
                    // A newer process owns the control; retire this old instance
                    // without claiming a stop or touching the new engine.
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf();
                }
                return;
            }
            if (!markerSaved && !latchSaved) {
                if (!backendCommitted) {
                    failure("停止要求未能持久保存，本机接口也未确认停止；请重新打开应用核对任务");
                } else if (!backendDrained) {
                    failure("停止意愿已由本机服务耐久确认，但连接或在途操作尚未排空；请重新打开应用核对任务");
                } else {
                    failure("当前任务已停止；停止意愿已由本机服务耐久确认，本地停止标记未能写入");
                }
                return;
            }
            KeepAlive.clearRecoveryNotification(EngineService.this);
            KeepAlive.cancelProbeTick(EngineService.this);
            applyScreenWakeLock(false);
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        }, "garden-stop").start();
    }
    @Override public void onDestroy() {
        reportEngineState("stopped", -1, -1);
        closing = true; monitor.shutdownNow(); healthMonitor.shutdownNow(); watchdogDeadlineMonitor.shutdownNow(); recoveryJournalMonitor.shutdownNow(); networkReporter.shutdownNow();
        stopReconnectProjection();
        healthRequestLane.stopAcceptingAndCancelActive(); stopRequestLane.stopAcceptingAndCancelActive(); restartRequestLane.stopAcceptingAndCancelActive(); recoveryJournalLane.stopAcceptingAndCancelActive();
        FutureTask<JSONObject> pendingHttp = networkHttpTask;
        if (pendingHttp != null) pendingHttp.cancel(true);
        HttpURLConnection pendingConnection = networkHttpConnection;
        if (pendingConnection != null) {
            Thread cancel = new Thread(pendingConnection::disconnect, "garden-network-destroy");
            cancel.setDaemon(true); cancel.start();
        }
        if (connectivity != null) { try { connectivity.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) { } }
        if (wifiReceiverRegistered) { try { unregisterReceiver(wifiStateReceiver); } catch (Exception ignored) { } wifiReceiverRegistered = false; }
                if (idleRefreshRegistered) { try { unregisterReceiver(networkRefreshReceiver); } catch (Exception ignored) { } idleRefreshRegistered = false; }
        if (cpu != null && cpu.isHeld()) cpu.release();
        if (screen != null && screen.isHeld()) screen.release();
        super.onDestroy();
        // Node has one lifetime per process. Kill only our dedicated engine process.
        android.os.Process.killProcess(android.os.Process.myPid());
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
