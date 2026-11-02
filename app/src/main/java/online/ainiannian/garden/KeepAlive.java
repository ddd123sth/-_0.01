package online.ainiannian.garden;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.system.Os;
import org.json.JSONObject;
import java.io.File;
import java.util.Locale;
import java.util.UUID;

/**
 * Durable keep-alive state shared by the UI process, the recovery receiver and the engine service.
 * Every passive recovery carries the control epoch it was scheduled under; a STOP bumps the epoch,
 * so an alarm or boot broadcast queued before that STOP can never revive the engine afterwards.
 */
final class KeepAlive {
    static final String PREFS = "engine-safety";
    static final String CONTROL_PREFS = "keepalive-control";
    static final String STOP_REQUESTED = "stop_requested";
    static final String STOP_LATCH_ID = "stop_latch_id";
    static final String ENGINE_DESIRED = "engine_desired";
    static final String CONTROL_EPOCH = "control_epoch";
    static final String SELF_CHECK_AT_MS = "self_check_at_ms";
    static final String SELF_CHECK_FAILED_AT_MS = "self_check_failed_at_ms";
    static final String LAST_RECOVERY_REASON = "last_recovery_reason";
    static final String LAST_RECOVERY_AT_MS = "last_recovery_at_ms";
    static final String LAST_RECOVERY_OUTCOME = "last_recovery_outcome";
    static final String LAST_RECOVERY_DETAIL = "last_recovery_detail";
    static final String BACKGROUND_START_DENIED_AT_MS = "background_start_denied_at_ms";
    static final String VPN_ENABLED = "keepalive_vpn_enabled";
    static final String SELF_CHECK_RESULT_AT_MS = "self_check_result_at_ms";
    static final String SELF_CHECK_RESULT = "self_check_result";
    static final String SELF_CHECK_HEARTBEAT_AGE_MS = "self_check_heartbeat_age_ms";
    static final String SCREEN_KEEP_ON = "keepalive_screen_keep_on";
    static final String VPN_EPOCH = "keepalive_vpn_epoch";
    static final String VPN_FAILURE_COUNT = "keepalive_vpn_failure_count";
    static final String VPN_LAST_ERROR = "keepalive_vpn_last_error";
    // Ordered native STOP/USER_START control records. The backend journal is a
    // read-only projection written after its SQLite commit; passive recovery
    // consults it before it starts an engine.
    static final String STOP_LATCH_EPOCH = "stop_latch_epoch";
    static final String USER_START_EPOCH = "user_start_epoch";
    static final String BACKEND_STOP_SEQ = "backend_stop_control_seq";
    static final String BACKEND_STOP_COMMAND = "backend_stop_command_id";
    static final String BACKEND_STOP_COMMITTED = "backend_stop_committed";
    static final String BACKEND_STOP_CLEANUP = "backend_stop_cleanup_complete";
    static final String BACKEND_STOP_GENERATION = "backend_stop_source_generation";
    static final String BACKEND_STOP_INSTANCE = "backend_stop_instance";
    static final String BACKEND_STOP_AT_MS = "backend_stop_recorded_at_ms";
    static final String NATIVE_START_CONFIRMED_SEQ = "native_start_confirmed_seq";
    static final String NATIVE_START_COMMAND = "native_start_command_id";
    static final String NATIVE_CONTROL_FILE = "native-stop-control.json";

    static final String ACTION_RECOVER = "online.ainiannian.garden.action.RECOVER";
    static final String ACTION_CHECK = "online.ainiannian.garden.action.SELF_CHECK";
    static final String ACTION_VPN_STOP = "online.ainiannian.garden.action.VPN_STOP";
    static final String ACTION_RECONNECT_DUE = "online.ainiannian.garden.action.RECONNECT_DUE";
    static final String ACTION_PROBE_DUE = "online.ainiannian.garden.action.PROBE_DUE";
    // Debug builds only: posts the real recovery prompt so its one-shot consumption can be
    // exercised without waiting for an OEM to refuse a background start.
    static final String ACTION_DEBUG_RECOVERY_PROMPT = "online.ainiannian.garden.action.DEBUG_RECOVERY_PROMPT";
    // Debug builds only: delivers the same STOP Intent the notification action uses.
    static final String ACTION_DEBUG_REAL_STOP = "online.ainiannian.garden.action.DEBUG_REAL_STOP";
    // Debug builds only: exercises the service's real onRevoke handler without another VPN app.
    static final String ACTION_DEBUG_VPN_REVOKE = "online.ainiannian.garden.action.DEBUG_VPN_REVOKE";
    // Debug builds only: drops the tun FD while the service stays alive (V14).
    static final String ACTION_DEBUG_VPN_DROP_FD = "online.ainiannian.garden.action.DEBUG_VPN_DROP_FD";
    // Debug builds only: makes the next N establish attempts fail (V12/V14 backoff).
    static final String ACTION_DEBUG_VPN_FAIL_NEXT = "online.ainiannian.garden.action.DEBUG_VPN_FAIL_NEXT";
    // Debug builds only: delivers a passive recovery with an older control epoch (V02).
    static final String ACTION_DEBUG_STALE_RECOVER = "online.ainiannian.garden.action.DEBUG_STALE_RECOVER";
    // Debug builds only: starts the probe while the screen is already off, so
    // the full five-minute window can be observed as one locked interval.
    static final String ACTION_DEBUG_PROBE_START = "online.ainiannian.garden.action.DEBUG_PROBE_START";
    // Debug builds only: writes the full keep-alive status (including engine
    // liveness and stop confirmation) where the tester can read it.
    static final String ACTION_DEBUG_STATUS_SNAPSHOT = "online.ainiannian.garden.action.DEBUG_STATUS_SNAPSHOT";
    static final String EXTRA_EPOCH = "controlEpoch";
    static final String EXTRA_REASON = "recoveryReason";
    static final String EXTRA_PROBE_ID = "probeId";
    static final String EXTRA_RECOVERY_NONCE = "recoveryNonce";
    static final String EXTRA_SCREEN_ON = "screenKeepOn";
    static final String EXTRA_AUTO_RECONNECT = "autoReconnect";
    static final String EXTRA_USER_START = "userStart";
    static final String EXTRA_RECONNECT_ID = "reconnectId";
    static final String EXTRA_RECONNECT_GENERATION = "reconnectGeneration";
    static final String RECONNECT_STATE_FILE = "keepalive-reconnect.json";
    static final String RECONNECT_DELIVERY_FILE = "keepalive-reconnect-delivery.json";
    static final String RECONNECT_HANDLING_FILE = "keepalive-reconnect-handling.json";
    static final String RECONNECT_REJECTED_FILE = "keepalive-reconnect-rejected.json";

    static final long SELF_CHECK_INTERVAL_MS = 15 * 60 * 1000L;
    // refreshStatus rewrites the heartbeat every 15 s. A five-minute gap means the
    // engine service process is gone or wedged, not that a task is merely waiting.
    static final long HEARTBEAT_STALE_MS = 5 * 60 * 1000L;
    static final String ENGINE_STATE_FILE = "keepalive-engine.json";
    static final String SELF_CHECK_FILE = "keepalive-selfcheck.json";
    static final String VPN_STATE_FILE = "keepalive-vpn.json";
    static final String UI_HEARTBEAT_FILE = "ui-heartbeat.json";
    static final String RECOVERY_STATE_FILE = "keepalive-recovery.json";
    static final int RECOVERY_NOTIFICATION_ID = 10;
    private static final int SELF_CHECK_REQUEST = 2001;
    private static final int RECONNECT_REQUEST = 2002;
    private static final int PROBE_REQUEST = 2003;
    private static final int TASK_REMOVED_REQUEST = 2004;

    private KeepAlive() { }

    /** Written only by the :engine service process (desired/stop/latch/backoff/epoch). */
    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
    /**
     * Written only by the UI/receiver process (self-check result, recovery reason, VPN choice).
     * Keeping a separate file is what stops the two processes' SharedPreferences caches from
     * rewriting each other: a clobbered STOP latch would break the user's stop guarantee, and a
     * clobbered VPN choice made the switch silently forget itself.
     */
    static SharedPreferences controlPreferences(Context context) {
        return context.getSharedPreferences(CONTROL_PREFS, Context.MODE_PRIVATE);
    }
    static int epoch(Context context) { return preferences(context).getInt(CONTROL_EPOCH, 0); }
    /** Returns the new epoch, or -1 when the bump could not be made durable. */
    static int bumpEpoch(Context context) {
        SharedPreferences preferences = preferences(context);
        int next = preferences.getInt(CONTROL_EPOCH, 0) + 1;
        if (next <= 0) next = 1;
        return preferences.edit().putInt(CONTROL_EPOCH, next).commit() ? next : -1;
    }
    static boolean engineAllowed(Context context) {
        SharedPreferences preferences = preferences(context);
        return preferences.getBoolean(ENGINE_DESIRED, false) && !preferences.getBoolean(STOP_REQUESTED, false)
            && !backendStopBlocksPassive(context);
    }
    /**
     * Latest ordered device control. The backend writes its journal only after
     * the SQLite transaction commits, so this is safe to read before an engine
     * exists. Preferences remain a fallback when the journal is missing.
     */
    static JSONObject nativeControlState(Context context) {
        try {
            File journal = new File(new File(context.getFilesDir(), "data"), NATIVE_CONTROL_FILE);
            if (journal.isFile()) {
                JSONObject stored = new JSONObject(PrivateFiles.text(journal));
                if (stored.optLong("controlSeq", 0L) > 0L) return stored;
            }
        } catch (Exception unavailable) { /* Fall back to the acknowledged receipt. */ }
        try {
            SharedPreferences preferences = preferences(context);
            long seq = preferences.getLong(BACKEND_STOP_SEQ, 0L);
            if (seq > 0L && preferences.getBoolean(BACKEND_STOP_COMMITTED, false)) {
                return new JSONObject().put("controlSeq", seq).put("kind", "STOP")
                    .put("commandId", preferences.getString(BACKEND_STOP_COMMAND, ""))
                    .put("stopCommitted", true)
                    .put("cleanupComplete", preferences.getBoolean(BACKEND_STOP_CLEANUP, false))
                    .put("sourceGeneration", preferences.getString(BACKEND_STOP_GENERATION, ""))
                    .put("instanceRef", preferences.getString(BACKEND_STOP_INSTANCE, ""));
            }
        } catch (Exception unavailable) { /* No authoritative control. */ }
        return new JSONObject();
    }
    static boolean backendStopBlocksPassive(Context context) {
        try {
            JSONObject control = nativeControlState(context);
            if (!"STOP".equals(control.optString("kind", "")) || !control.optBoolean("stopCommitted", false)) return false;
            long stopSeq = control.optLong("controlSeq", 0L);
            if (stopSeq <= 0L) return false;
            return stopSeq > preferences(context).getLong(NATIVE_START_CONFIRMED_SEQ, 0L);
        } catch (Exception unavailable) { return false; }
    }
    static JSONObject stopConfirmation(Context context) {
        JSONObject out = new JSONObject();
        try {
            SharedPreferences preferences = preferences(context);
            boolean stopRequested = preferences.getBoolean(STOP_REQUESTED, false);
            boolean desired = preferences.getBoolean(ENGINE_DESIRED, false);
            JSONObject control = nativeControlState(context);
            boolean backendStop = "STOP".equals(control.optString("kind", ""))
                && control.optBoolean("stopCommitted", false);
            out.put("source", backendStop ? "backend-control-record" : stopRequested ? "local-latch" : "none")
                .put("durable", backendStop || stopRequested)
                .put("cleanupComplete", control.optBoolean("cleanupComplete", false))
                .put("controlSeq", control.optLong("controlSeq", 0L))
                // Residual desire after a backend-confirmed STOP is exactly the
                // state where local STOP writes failed; the UI must say so.
                .put("residualDesired", desired && backendStop && !stopRequested)
                .put("backendStopped", backendStop);
        } catch (Exception unavailable) { /* The panel shows unread. */ }
        return out;
    }
    static boolean recordBackendStopReceipt(Context context, String commandId, boolean stopCommitted,
            boolean cleanupComplete, long controlSeq, String sourceGeneration, String instanceId) {
        try {
            return preferences(context).edit()
                .putLong(BACKEND_STOP_SEQ, Math.max(0L, controlSeq))
                .putString(BACKEND_STOP_COMMAND, commandId == null ? "" : commandId)
                .putBoolean(BACKEND_STOP_COMMITTED, stopCommitted)
                .putBoolean(BACKEND_STOP_CLEANUP, cleanupComplete)
                .putString(BACKEND_STOP_GENERATION, sourceGeneration == null ? "" : sourceGeneration)
                .putString(BACKEND_STOP_INSTANCE, instanceId == null ? "" : instanceId)
                .putLong(BACKEND_STOP_AT_MS, System.currentTimeMillis()).commit();
        } catch (RuntimeException unavailable) { return false; }
    }
    static boolean recordUserStartControl(Context context, String commandId, long controlSeq, int epoch) {
        try {
            return preferences(context).edit()
                .putString(NATIVE_START_COMMAND, commandId == null ? "" : commandId)
                .putLong(NATIVE_START_CONFIRMED_SEQ, Math.max(0L, controlSeq))
                .putInt(USER_START_EPOCH, Math.max(0, epoch)).commit();
        } catch (RuntimeException unavailable) { return false; }
    }
    /**
     * Only an ordered newer user start may clear an older latch. An
     * unreadable or un-ordered control identity never clears it.
     */
    static boolean clearSupersededStopLatch(Context context, int userEpoch, long backendSeq) {
        try {
            SharedPreferences preferences = preferences(context);
            if (!preferences.getBoolean(STOP_REQUESTED, false)) return true;
            int stopEpoch = preferences.getInt(STOP_LATCH_EPOCH, 0);
            long recordedStopSeq = preferences.getLong(BACKEND_STOP_SEQ, 0L);
            boolean ordered = stopEpoch > 0 && userEpoch > stopEpoch ||
                backendSeq > 0L && backendSeq > recordedStopSeq;
            if (!ordered) return false;
            return preferences.edit().remove(STOP_REQUESTED).remove(STOP_LATCH_ID)
                .remove(STOP_LATCH_EPOCH).commit();
        } catch (RuntimeException unavailable) { return false; }
    }

    private static PendingIntent selfCheckIntent(Context context, int epoch) {
        Intent intent = new Intent(context, KeepAliveReceiver.class).setAction(ACTION_CHECK)
            .putExtra(EXTRA_EPOCH, epoch);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, SELF_CHECK_REQUEST, intent, flags);
    }
    /** persist=false from the engine service: only the UI process writes control preferences. */
    static void scheduleSelfCheck(Context context, boolean persist) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        long at = System.currentTimeMillis() + SELF_CHECK_INTERVAL_MS;
        PendingIntent pending = selfCheckIntent(context, epoch(context));
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                if (alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
                // An inexact alarm still wakes a dozing phone. Android 12+ may refuse a
                // foreground-service start from it; requestRecovery() records that refusal.
                else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            } else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            // The time lives in a small atomic file so both processes can update it without
            // clobbering the single-writer preference files.
            try { PrivateFiles.write(new File(context.getFilesDir(), SELF_CHECK_FILE), new JSONObject().put("at", at).toString()); }
            catch (Exception ignored) { }
            if (persist) controlPreferences(context).edit().putLong(SELF_CHECK_AT_MS, at).commit();
        } catch (RuntimeException unavailable) {
            if (persist) controlPreferences(context).edit().putLong(SELF_CHECK_FAILED_AT_MS, System.currentTimeMillis()).commit();
        }
    }
    static void cancelSelfCheck(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) {
            try { alarms.cancel(selfCheckIntent(context, epoch(context))); }
            catch (RuntimeException unavailable) { /* The stale epoch still fences a late delivery. */ }
        }
        try { new File(context.getFilesDir(), SELF_CHECK_FILE).delete(); } catch (Exception ignored) { }
    }
    private static long scheduledSelfCheckAtMs(Context context) {
        long fromFile = readJsonState(context, SELF_CHECK_FILE).optLong("at", 0L);
        return fromFile > 0L ? fromFile : controlPreferences(context).getLong(SELF_CHECK_AT_MS, 0L);
    }
    static void writeSelfCheckOutcome(Context context, String outcome, long heartbeatAgeMs) {
        try {
            controlPreferences(context).edit().putLong(SELF_CHECK_RESULT_AT_MS, System.currentTimeMillis())
                .putString(SELF_CHECK_RESULT, outcome == null ? "" : outcome)
                .putLong(SELF_CHECK_HEARTBEAT_AGE_MS, heartbeatAgeMs).commit();
        } catch (RuntimeException unavailable) { /* Reporting only. */ }
    }
    static boolean exactAlarmsAllowed(Context context) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        try { return alarms != null && alarms.canScheduleExactAlarms(); }
        catch (RuntimeException unavailable) { return false; }
    }

    /**
     * Start the engine for a non-user reason. Never establishes or clears user intent:
     * desired=false or a pending STOP simply means no recovery is allowed.
     */
    static boolean requestRecovery(Context context, String reason) {
        if (!engineAllowed(context)) return false;
        // Do not carry the app process's cached epoch: it can lag the engine's
        // fresh control epoch and make a valid passive recovery look stale.
        // The service re-checks its own desired/STOP state before starting.
        Intent intent = new Intent(context, EngineService.class).setAction(ACTION_RECOVER)
            .putExtra(EXTRA_REASON, reason);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
            recordRecovery(context, reason, "started", "");
            return true;
        } catch (RuntimeException denied) {
            String detail = denied.getClass().getSimpleName();
            recordRecovery(context, reason, "background-start-denied", detail);
            controlPreferences(context).edit().putLong(BACKGROUND_START_DENIED_AT_MS, System.currentTimeMillis()).commit();
            postRecoveryNotification(context, reason);
            return false;
        }
    }
    private static void recordRecovery(Context context, String reason, String outcome, String detail) {
        controlPreferences(context).edit().putString(LAST_RECOVERY_REASON, reason == null ? "" : reason)
            .putLong(LAST_RECOVERY_AT_MS, System.currentTimeMillis())
            .putString(LAST_RECOVERY_OUTCOME, outcome)
            .putString(LAST_RECOVERY_DETAIL, detail == null ? "" : detail).commit();
    }

    /** A recovery prompt that survives until the user actually opens the app once. */
    static void postRecoveryNotification(Context context, String reason) {
        try {
            String nonce = UUID.randomUUID().toString();
            JSONObject state = new JSONObject().put("nonce", nonce).put("reason", reason == null ? "" : reason)
                .put("at", System.currentTimeMillis());
            PrivateFiles.write(new File(context.getFilesDir(), RECOVERY_STATE_FILE), state.toString());
            NotificationManager notifications = context.getSystemService(NotificationManager.class);
            if (notifications == null) return;
            notifications.createNotificationChannel(new NotificationChannel("keepalive-recovery", "后台恢复提醒", NotificationManager.IMPORTANCE_DEFAULT));
            Intent open = new Intent(context, MainActivity.class).putExtra(EXTRA_RECOVERY_NONCE, nonce)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pending = PendingIntent.getActivity(context, 3, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification note = new Notification.Builder(context, "keepalive-recovery")
                .setSmallIcon(android.R.drawable.ic_menu_myplaces).setContentTitle("无尽夏")
                .setContentText("后台恢复被系统拦下，点按打开应用继续本机任务")
                .setContentIntent(pending).setAutoCancel(true).setOngoing(false).build();
            notifications.notify(RECOVERY_NOTIFICATION_ID, note);
        } catch (Exception ignored) { /* The in-app status still reports the refusal. */ }
    }
    /** Clears the prompt once the engine is actually ready or the user stopped everything. */
    static void clearRecoveryNotification(Context context) {
        try {
            NotificationManager notifications = context.getSystemService(NotificationManager.class);
            if (notifications != null) notifications.cancel(RECOVERY_NOTIFICATION_ID);
        } catch (RuntimeException ignored) { /* Nothing to clear. */ }
        try { new File(context.getFilesDir(), RECOVERY_STATE_FILE).delete(); } catch (Exception ignored) { }
    }
    /**
     * Consume the notification exactly once. A repeated click, an old notification or an
     * Activity recreation with the same Intent returns false and never replays a recovery.
     */
    static boolean consumeRecoveryNotification(Context context, Intent intent) {
        if (intent == null) return false;
        String nonce = intent.getStringExtra(EXTRA_RECOVERY_NONCE);
        if (nonce == null || nonce.isEmpty()) return false;
        String expected = readJsonState(context, RECOVERY_STATE_FILE).optString("nonce", "");
        if (!nonce.equals(expected)) return false;
        intent.removeExtra(EXTRA_RECOVERY_NONCE);
        clearRecoveryNotification(context);
        return true;
    }
    /** Cheap no-op unless a prompt is actually pending; safe to call on every healthy sample. */
    static void clearRecoveryNotificationIfPending(Context context) {
        if (!pendingRecovery(context)) return;
        clearRecoveryNotification(context);
    }
    private static boolean pendingRecovery(Context context) {
        try { return new File(context.getFilesDir(), RECOVERY_STATE_FILE).isFile(); }
        catch (Exception unavailable) { return false; }
    }

    private static final Object reconnectLock = new Object();

    private static Intent reconnectIntent(Context context) {
        return new Intent(context, KeepAliveReceiver.class).setAction(ACTION_RECONNECT_DUE);
    }
    static int bootCount(Context context) {
        return Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, -1);
    }
    static boolean writeReconnectState(Context context, String file, JSONObject state) {
        try {
            PrivateFiles.write(new File(context.getFilesDir(), file), state.toString());
            return true;
        } catch (Exception unavailable) {
            android.util.Log.w("GardenReconnect", "receipt-write-failed " + file);
            return false;
        }
    }
    static JSONObject reconnectAlarmState(Context context) {
        JSONObject receipt = readJsonState(context, RECONNECT_STATE_FILE);
        JSONObject delivery = readJsonState(context, RECONNECT_DELIVERY_FILE);
        try {
            if (!receipt.optString("id", "").isEmpty()
                    && receipt.optString("id", "").equals(delivery.optString("id", ""))
                    && delivery.optLong("receivedAtMs", 0L) >= receipt.optLong("requestedAtMs", Long.MAX_VALUE)
                    && ("scheduled".equals(receipt.optString("state")) || "requested".equals(receipt.optString("state")))) {
                receipt.put("state", "broadcast-received").put("scheduled", false)
                    .put("receivedAtMs", delivery.getLong("receivedAtMs"));
            }
        } catch (Exception ignored) { }
        return receipt;
    }
    static JSONObject scheduleReconnectWakeup(Context context, JSONObject selection, int epoch, String generation) {
        synchronized (reconnectLock) {
            JSONObject receipt = new JSONObject();
            PendingIntent pending = null;
            AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            try {
                long deadline = selection.getLong("deadlineAtMs");
                long now = System.currentTimeMillis();
                long controlSeq = nativeControlState(context).optLong("controlSeq", 0L);
                JSONObject old = reconnectAlarmState(context);
                boolean same = old.optInt("epoch", -1) == epoch
                    && generation.equals(old.optString("generation", ""))
                    && old.optLong("controlSeq", -1L) == controlSeq
                    && old.optInt("bootCount", -2) == bootCount(context)
                    && deadline == old.optLong("deadlineAtMs", 0L)
                    && selection.getString("accountRef").equals(old.optString("accountRef", ""))
                    && selection.getString("scopeHash").equals(old.optString("scopeHash", ""))
                    && selection.getLong("runEpoch") == old.optLong("runEpoch", -1L);
                if (same && ("scheduled".equals(old.optString("state"))
                        || "delivered".equals(old.optString("state"))
                        || "broadcast-received".equals(old.optString("state")))) return old;
                receipt = new JSONObject(selection.toString()).put("schemaVersion", 1)
                    .put("id", UUID.randomUUID().toString()).put("epoch", epoch)
                    .put("generation", generation).put("controlSeq", controlSeq)
                    .put("bootCount", bootCount(context)).put("requestedAtMs", now)
                    .put("triggerAtMs", Math.max(now, deadline)).put("overdueAtSelection", deadline <= now)
                    .put("replacesId", old.optString("id", "")).put("state", "requested")
                    .put("scheduled", false);
                if (!writeReconnectState(context, RECONNECT_STATE_FILE, receipt))
                    throw new java.io.IOException("receipt-unavailable");
                if (alarms == null) throw new IllegalStateException("alarm-service-unavailable");
                Intent intent = reconnectIntent(context).putExtra(EXTRA_EPOCH, epoch)
                    .putExtra(EXTRA_RECONNECT_ID, receipt.getString("id"))
                    .putExtra(EXTRA_RECONNECT_GENERATION, generation);
                pending = PendingIntent.getBroadcast(context, RECONNECT_REQUEST, intent,
                    PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                boolean exact = Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms();
                if (exact) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, receipt.getLong("triggerAtMs"), pending);
                else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, receipt.getLong("triggerAtMs"), pending);
                receipt.put("state", "scheduled").put("scheduled", true)
                    .put("mode", exact ? "exact-allow-while-idle" : "inexact-allow-while-idle")
                    .put("acceptedAtMs", System.currentTimeMillis());
                if (!writeReconnectState(context, RECONNECT_STATE_FILE, receipt))
                    throw new java.io.IOException("receipt-unavailable");
                ReconnectTiming.armed(context, receipt);
            } catch (Exception unavailable) {
                if (pending != null) {
                    try { if (alarms != null) alarms.cancel(pending); pending.cancel(); }
                    catch (RuntimeException ignored) { }
                }
                try { receipt.put("state", "failed").put("scheduled", false)
                    .put("failureKind", unavailable.getClass().getSimpleName()); }
                catch (Exception ignored) { }
                writeReconnectState(context, RECONNECT_STATE_FILE, receipt);
            }
            return receipt;
        }
    }
    static void cancelReconnectWakeup(Context context) { cancelReconnectWakeup(context, "no-deadline"); }
    static void cancelReconnectWakeup(Context context, String reason) {
        synchronized (reconnectLock) {
            JSONObject receipt = readJsonState(context, RECONNECT_STATE_FILE);
            if (("cancelled".equals(receipt.optString("state")) || receipt.length() == 0)
                    && reason.equals(receipt.optString("cancelReason"))) return;
            boolean cancelled = false;
            try {
                AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
                PendingIntent pending = PendingIntent.getBroadcast(context, RECONNECT_REQUEST, reconnectIntent(context),
                    PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                if (pending != null) {
                    if (alarms == null) throw new IllegalStateException("alarm-service-unavailable");
                    alarms.cancel(pending);
                    pending.cancel();
                }
                cancelled = true;
                receipt.put("state", "cancelled");
            } catch (Exception unavailable) {
                try { receipt.put("state", "cancel-failed").put("failureKind", unavailable.getClass().getSimpleName()); }
                catch (Exception ignored) { }
            }
            try { receipt.put("scheduled", false).put("cancelConfirmed", cancelled)
                .put("cancelReason", reason).put("cancelledAtMs", System.currentTimeMillis()); }
            catch (Exception ignored) { }
            writeReconnectState(context, RECONNECT_STATE_FILE, receipt);
        }
    }
    static String reconnectEventId(Intent intent) {
        String id = intent.getStringExtra(EXTRA_RECONNECT_ID);
        return id != null && id.length() == 36 && id.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") ? id : "";
    }
    static boolean reconnectMatches(Context context, Intent intent, JSONObject receipt) {
        String id = reconnectEventId(intent);
        String generation = intent.getStringExtra(EXTRA_RECONNECT_GENERATION);
        String state = receipt.optString("state", "");
        return id != null && !id.isEmpty() && id.equals(receipt.optString("id", ""))
            && generation != null && !generation.isEmpty() && generation.equals(receipt.optString("generation", ""))
            && intent.getIntExtra(EXTRA_EPOCH, -1) == receipt.optInt("epoch", -2)
            && receipt.optInt("bootCount", -2) >= 0 && receipt.optInt("bootCount", -2) == bootCount(context)
            && receipt.optLong("controlSeq", -1L) == nativeControlState(context).optLong("controlSeq", 0L)
            && ("requested".equals(state) || "scheduled".equals(state) || "broadcast-received".equals(state));
    }
    /** One short extra check after the task is swiped away; it never creates user intent. */
    static void scheduleCheckAfter(Context context, long delayMs) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        Intent intent = new Intent(context, KeepAliveReceiver.class).setAction(ACTION_CHECK)
            .putExtra(EXTRA_EPOCH, epoch(context));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getBroadcast(context, TASK_REMOVED_REQUEST, intent, flags);
        try {
            if (Build.VERSION.SDK_INT >= 31 && alarms.canScheduleExactAlarms())
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + Math.max(5_000L, delayMs), pending);
            else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + Math.max(15_000L, delayMs), pending);
        } catch (RuntimeException unavailable) { /* The periodic alarm remains. */ }
    }
    static void scheduleProbeTick(Context context, long delayMs, String probeId) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        long at = System.currentTimeMillis() + Math.max(15_000L, delayMs);
        Intent intent = new Intent(context, KeepAliveReceiver.class).setAction(ACTION_PROBE_DUE)
            .putExtra(EXTRA_PROBE_ID, probeId == null ? "" : probeId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getBroadcast(context, PROBE_REQUEST, intent, flags);
        try {
            if (Build.VERSION.SDK_INT >= 31 && alarms.canScheduleExactAlarms())
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } catch (RuntimeException unavailable) { KeepAliveProbe.cancel(context, "probe-alarm-unavailable"); }
    }
    static void cancelProbeTick(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        Intent intent = new Intent(context, KeepAliveReceiver.class).setAction(ACTION_PROBE_DUE);
        int flags = PendingIntent.FLAG_NO_CREATE;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getBroadcast(context, PROBE_REQUEST, intent, flags);
        if (pending != null) { try { alarms.cancel(pending); } catch (RuntimeException ignored) { } }
    }

    static int vpnEpoch(Context context) { return controlPreferences(context).getInt(VPN_EPOCH, 0); }
    static int bumpVpnEpoch(Context context) {
        SharedPreferences preferences = controlPreferences(context);
        int next = preferences.getInt(VPN_EPOCH, 0) + 1;
        preferences.edit().putInt(VPN_EPOCH, next).commit();
        return next;
    }
    static boolean vpnConsentGranted(Context context) {
        try { return android.net.VpnService.prepare(context) == null; }
        catch (RuntimeException unavailable) { return false; }
    }
    private static JSONObject notificationChannelState(Context context) {
        JSONObject out = new JSONObject();
        try {
            NotificationManager notifications = context.getSystemService(NotificationManager.class);
            NotificationChannel channel = notifications == null ? null : notifications.getNotificationChannel("local-automation");
            if (channel == null) out.put("known", false);
            else out.put("known", true).put("importance", channel.getImportance())
                .put("blocked", channel.getImportance() == NotificationManager.IMPORTANCE_NONE);
            return out;
        } catch (Exception unavailable) { return out; }
    }
    static JSONObject uiHeartbeat(Context context) {
        JSONObject state = readJsonState(context, UI_HEARTBEAT_FILE);
        try {
            long at = state.optLong("at", 0L);
            long age = at > 0L ? Math.max(0L, System.currentTimeMillis() - at) : -1L;
            state.put("ageMs", age)
                .put("active", state.optBoolean("resumed", false) && age >= 0L && age < 45_000L && processAlive(state.optInt("pid", -1)));
        } catch (Exception ignored) { /* Unread. */ }
        return state;
    }

    static boolean processAlive(int pid) {
        if (pid <= 0) return false;
        try { Os.kill(pid, 0); return true; }
        catch (Exception stopped) { return false; }
    }
    static JSONObject readJsonState(Context context, String name) {
        try { return new JSONObject(PrivateFiles.text(new File(context.getFilesDir(), name))); }
        catch (Exception missing) { return new JSONObject(); }
    }
    static void writeEngineState(Context context, JSONObject state) {
        try {
            JSONObject bounded = new JSONObject(state.toString());
            bounded.put("at", System.currentTimeMillis())
                .put("atElapsed", android.os.SystemClock.elapsedRealtime())
                .put("pid", android.os.Process.myPid());
            PrivateFiles.write(new File(context.getFilesDir(), ENGINE_STATE_FILE), bounded.toString());
        } catch (Exception ignored) { /* Status reporting never gates the engine. */ }
    }
    static JSONObject engineState(Context context) {
        JSONObject state = readJsonState(context, ENGINE_STATE_FILE);
        try {
            long at = state.optLong("at", 0L);
            long atElapsed = state.optLong("atElapsed", -1L);
            int pid = state.optInt("pid", -1);
            long nowElapsed = android.os.SystemClock.elapsedRealtime();
            long age;
            String clock;
            if (atElapsed >= 0L && nowElapsed >= atElapsed) { age = nowElapsed - atElapsed; clock = "monotonic"; }
            else if (atElapsed >= 0L) { age = -1L; clock = "boot-changed"; }
            else {
                long wall = System.currentTimeMillis() - at;
                // A negative wall age is a clock jump, not fresh evidence.
                age = at > 0L && wall >= 0L ? wall : -1L;
                clock = "wall";
            }
            String expectedToken = state.optString("startToken", "");
            String actualToken = readProcessStartToken(pid);
            // Only a readable mismatch disproves liveness; an unreadable token must not turn
            // a healthy engine into a false negative.
            boolean tokenChecked = !expectedToken.isEmpty() && !actualToken.isEmpty();
            boolean tokenMatches = !tokenChecked || expectedToken.equals(actualToken);
            state.put("engineAlive", at > 0L && age >= 0L && age < HEARTBEAT_STALE_MS && processAlive(pid) && tokenMatches);
            state.put("heartbeatAgeMs", age).put("heartbeatClock", clock)
                .put("startTokenChecked", tokenChecked).put("startTokenMatches", tokenMatches);
        } catch (Exception ignored) { /* Keep the raw snapshot. */ }
        return state;
    }
    private static String readProcessStartToken(int pid) {
        if (pid <= 0) return "";
        try {
            String stat = PrivateFiles.text(new File("/proc/" + pid + "/stat"));
            int end = stat.lastIndexOf(')');
            if (end < 0) return "";
            String[] fields = stat.substring(end + 1).trim().split("\\s+");
            return fields.length > 19 && fields[19].matches("[0-9]{1,32}") ? fields[19] : "";
        } catch (Exception unavailable) { return ""; }
    }
    static void writeVpnState(Context context, boolean established, String reason) {
        try {
            PrivateFiles.write(new File(context.getFilesDir(), VPN_STATE_FILE), new JSONObject()
                .put("established", established).put("reason", reason == null ? "" : reason)
                .put("at", System.currentTimeMillis()).put("pid", android.os.Process.myPid()).toString());
        } catch (Exception ignored) { /* Reporting only. */ }
    }
    static JSONObject vpnState(Context context) {
        JSONObject state = readJsonState(context, VPN_STATE_FILE);
        boolean enabled = controlPreferences(context).getBoolean(VPN_ENABLED, false);
        try {
            long at = state.optLong("at", 0L);
            // The tunnel lives in the app's main process; a dead pid means the system
            // already dropped it, however fresh the last state file looks.
            boolean processAlive = processAlive(state.optInt("pid", -1));
            SharedPreferences control = controlPreferences(context);
            state.put("enabled", enabled)
                .put("consentGranted", vpnConsentGranted(context))
                .put("failureCount", control.getInt(VPN_FAILURE_COUNT, 0))
                .put("lastError", control.getString(VPN_LAST_ERROR, ""))
                .put("epoch", control.getInt(VPN_EPOCH, 0))
                .put("active", state.optBoolean("established", false) && processAlive)
                .put("stateAgeMs", at > 0L ? Math.max(0L, System.currentTimeMillis() - at) : -1L);
        } catch (Exception ignored) { /* Keep the raw snapshot. */ }
        return state;
    }

    static JSONObject status(Context context) {
        SharedPreferences preferences = preferences(context);
        SharedPreferences control = controlPreferences(context);
        JSONObject out = new JSONObject();
        try {
            long nextCheck = scheduledSelfCheckAtMs(context);
            boolean stopRequested = preferences.getBoolean(STOP_REQUESTED, false);
            out.put("desired", preferences.getBoolean(ENGINE_DESIRED, false))
                .put("stopRequested", stopRequested)
                .put("controlEpoch", preferences.getInt(CONTROL_EPOCH, 0))
                .put("nextSelfCheckAtMs", nextCheck)
                // A STOP cancels the alarm; the persisted time alone must not claim one is still armed.
                .put("selfCheckScheduled", !stopRequested && nextCheck > System.currentTimeMillis())
                .put("exactAlarmsAllowed", exactAlarmsAllowed(context))
                .put("notificationAllowed", context.getSystemService(NotificationManager.class).areNotificationsEnabled())
                .put("notificationChannel", notificationChannelState(context))
                .put("lastRecoveryReason", control.getString(LAST_RECOVERY_REASON, ""))
                .put("lastRecoveryAtMs", control.getLong(LAST_RECOVERY_AT_MS, 0L))
                .put("lastRecoveryOutcome", control.getString(LAST_RECOVERY_OUTCOME, ""))
                .put("lastRecoveryDetail", control.getString(LAST_RECOVERY_DETAIL, ""))
                .put("backgroundStartDeniedAtMs", control.getLong(BACKGROUND_START_DENIED_AT_MS, 0L))
                .put("selfCheckResultAtMs", control.getLong(SELF_CHECK_RESULT_AT_MS, 0L))
                .put("selfCheckResult", control.getString(SELF_CHECK_RESULT, ""))
                .put("selfCheckHeartbeatAgeMs", control.getLong(SELF_CHECK_HEARTBEAT_AGE_MS, -1L))
                .put("engine", engineState(context))
                .put("reconnectAlarm", reconnectAlarmState(context))
                .put("reconnectDelivery", readJsonState(context, RECONNECT_DELIVERY_FILE))
                .put("reconnectRejected", readJsonState(context, RECONNECT_REJECTED_FILE))
                .put("reconnectHandling", readJsonState(context, RECONNECT_HANDLING_FILE))
                .put("backendStopControl", nativeControlState(context))
                .put("passiveRecoveryBlocked", backendStopBlocksPassive(context))
                .put("stopConfirmation", stopConfirmation(context))
                .put("recoveryPending", pendingRecovery(context))
                .put("uiHeartbeat", uiHeartbeat(context))
                .put("probe", KeepAliveProbe.status(context))
                .put("screenKeepOn", control.getBoolean(SCREEN_KEEP_ON, false))
                .put("vpn", vpnState(context))
                .put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER)
                .put("manufacturerAutoStartReadable", false);
            return out;
        } catch (Exception unavailable) { return new JSONObject(); }
    }

    // Manufacturer auto-start pages are not readable through any public API, so the
    // only honest outcome is which settings page actually opened.
    static JSONObject openManufacturerSettings(Activity activity) {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(Locale.ROOT);
        String[][] routes;
        if (manufacturer.contains("xiaomi") || manufacturer.contains("redmi")) routes = new String[][] {
            { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" } };
        else if (manufacturer.contains("huawei") || manufacturer.contains("honor")) routes = new String[][] {
            { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
            { "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity" } };
        else if (manufacturer.contains("oppo") || manufacturer.contains("oneplus") || manufacturer.contains("realme")) routes = new String[][] {
            { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
            { "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity" } };
        else if (manufacturer.contains("vivo") || manufacturer.contains("iqoo")) routes = new String[][] {
            { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
            { "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity" } };
        else if (manufacturer.contains("samsung")) routes = new String[][] {
            { "com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity" } };
        else if (manufacturer.contains("meizu")) routes = new String[][] {
            { "com.meizu.safe", "com.meizu.safe.permission.SmartBGActivity" } };
        else routes = new String[0][];
        JSONObject result = new JSONObject();
        try {
            for (String[] route : routes) {
                try {
                    activity.startActivity(new Intent().setComponent(new ComponentName(route[0], route[1])));
                    return result.put("target", route[1]).put("result", "intent-accepted")
                        .put("readable", false).put("manualConfirmationRequired", true);
                } catch (ActivityNotFoundException missing) { /* Try the next known route. */ }
                catch (SecurityException denied) { /* Try the next known route. */ }
            }
            activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + activity.getPackageName())));
            return result.put("target", "app-details").put("result", "intent-accepted")
                .put("readable", false).put("manualConfirmationRequired", true);
        } catch (Exception unavailable) {
            return settingsFailure(unavailable.getClass().getSimpleName(), true);
        }
    }
    private static JSONObject settingsFailure(String reason, boolean manual) {
        try {
            return new JSONObject().put("target", JSONObject.NULL).put("result", "failed")
                .put("reason", reason).put("readable", false)
                .put("manualConfirmationRequired", manual);
        } catch (Exception impossible) { return new JSONObject(); }
    }
    static JSONObject openExactAlarmSettings(Activity activity) {
        JSONObject result = new JSONObject();
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                try {
                    activity.startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        Uri.parse("package:" + activity.getPackageName())));
                    return result.put("target", "exact-alarm").put("result", "intent-accepted");
                } catch (ActivityNotFoundException missing) { /* Fall back to app details. */ }
            }
            activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + activity.getPackageName())));
            return result.put("target", "app-details").put("result", "intent-accepted");
        } catch (Exception unavailable) {
            return settingsFailure(unavailable.getClass().getSimpleName(), false);
        }
    }
}