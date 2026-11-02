package online.ainiannian.garden;

import android.content.Context;
import android.os.SystemClock;
import org.json.JSONObject;
import java.util.UUID;

/**
 * The five-minute keep-alive probe. It is deliberately separate from the periodic
 * self check: the probe samples the same engine identity while the phone is actually
 * locked, and it never starts, stops or reconfigures any business execution.
 *
 * <p>A probe is "passed" only when the same engine process/generation survived the whole
 * interval, its heartbeat kept advancing, and the screen was really off for a meaningful
 * part of the interval. An alarm arriving is just one sample, never a pass by itself.
 */
final class KeepAliveProbe {
    static final String STATUS = "probe_status";
    static final String ID = "probe_id";
    static final String STARTED_AT_MS = "probe_started_at_ms";
    static final String STARTED_ELAPSED_MS = "probe_started_elapsed_ms";
    static final String ENGINE_PID = "probe_engine_pid";
    static final String ENGINE_GENERATION = "probe_engine_generation";
    static final String SCREEN_OFF_TOTAL_MS = "probe_screen_off_total_ms";
    static final String CONTINUOUS_SCREEN_OFF_MS = "probe_continuous_screen_off_ms";
    static final String SCREEN_OFF_SAMPLES = "probe_screen_off_samples";
    static final String INTERACTIVE_SAMPLES = "probe_interactive_samples";
    static final String LAST_SAMPLE_ELAPSED_MS = "probe_last_sample_elapsed_ms";
    static final String LAST_SAMPLE_INTERACTIVE = "probe_last_sample_interactive";
    static final String MAX_HEARTBEAT_GAP_MS = "probe_max_heartbeat_gap_ms";
    static final String LAST_SAMPLE_AT_MS = "probe_last_sample_at_ms";
    static final String FINISHED_AT_MS = "probe_finished_at_ms";
    static final String RESULT_REASON = "probe_result_reason";
    static final String SAMPLE_COUNT = "probe_sample_count";

    static final long DURATION_MS = 5 * 60 * 1000L;
    static final long SAMPLE_INTERVAL_MS = 60 * 1000L;
    // A heartbeat older than this during the probe means the engine was not progressing,
    // even if its process still existed.
    static final long HEARTBEAT_STALE_MS = 120 * 1000L;
    // Passing requires one observed uninterrupted screen-off interval covering the
    // whole five-minute window. A run that only glimpsed the lock screen says
    // "not locked" instead of upgrading a partial interval into a full pass.
    static final long MIN_SCREEN_OFF_MS = 5 * 60 * 1000L;

    static final String STATE_RUNNING = "running";
    static final String STATE_PASSED = "passed";
    static final String STATE_FAILED = "failed";
    static final String STATE_NOT_LOCKED = "not-locked";
    static final String STATE_CANCELLED = "cancelled";
    static final String STATE_INTERRUPTED = "interrupted";

    private KeepAliveProbe() { }

    static boolean running(Context context) {
        return running(KeepAlive.controlPreferences(context));
    }
    private static boolean running(android.content.SharedPreferences preferences) {
        return STATE_RUNNING.equals(preferences.getString(STATUS, ""));
    }
    static JSONObject status(Context context) {
        JSONObject out = new JSONObject();
        try {
            android.content.SharedPreferences p = KeepAlive.controlPreferences(context);
            String state = p.getString(STATUS, "");
            long startedAt = p.getLong(STARTED_AT_MS, 0L), startedElapsed = p.getLong(STARTED_ELAPSED_MS, 0L);
            long finishedAt = p.getLong(FINISHED_AT_MS, 0L);
            long nowElapsed = SystemClock.elapsedRealtime();
            boolean live = STATE_RUNNING.equals(state) && startedElapsed > 0L && nowElapsed >= startedElapsed;
            long elapsed = live ? nowElapsed - startedElapsed : 0L;
            out.put("status", state)
                .put("startedAtMs", startedAt)
                .put("finishedAtMs", finishedAt)
                .put("elapsedMs", elapsed)
                .put("remainingMs", live ? Math.max(0L, DURATION_MS - elapsed) : 0L)
                .put("screenOffTotalMs", p.getLong(SCREEN_OFF_TOTAL_MS, 0L))
                .put("continuousScreenOffMs", p.getLong(CONTINUOUS_SCREEN_OFF_MS, 0L))
                .put("screenOffSamples", p.getInt(SCREEN_OFF_SAMPLES, 0))
                .put("interactiveSamples", p.getInt(INTERACTIVE_SAMPLES, 0))
                .put("maxHeartbeatGapMs", p.getLong(MAX_HEARTBEAT_GAP_MS, -1L))
                .put("sampleCount", p.getInt(SAMPLE_COUNT, 0))
                .put("enginePid", p.getInt(ENGINE_PID, -1))
                .put("engineGeneration", p.getString(ENGINE_GENERATION, ""))
                .put("reason", p.getString(RESULT_REASON, ""));
        } catch (Exception ignored) { /* The UI shows unread. */ }
        return out;
    }

    static JSONObject start(Context context) {
        JSONObject result = new JSONObject();
        try {
            if (!KeepAlive.engineAllowed(context)) return result.put("started", false).put("reason", "engine-not-allowed");
            if (running(context)) return result.put("started", false).put("reason", "already-running");
            JSONObject engine = KeepAlive.engineState(context);
            int pid = engine.optInt("pid", -1);
            String generation = engine.optString("generation", "");
            if (!engine.optBoolean("engineAlive", false) || pid <= 0 || generation.isEmpty()) {
                return result.put("started", false).put("reason", "engine-not-alive");
            }
            String id = UUID.randomUUID().toString();
            long now = System.currentTimeMillis(), elapsed = SystemClock.elapsedRealtime();
            KeepAlive.controlPreferences(context).edit()
                .putString(STATUS, STATE_RUNNING).putString(ID, id)
                .putLong(STARTED_AT_MS, now).putLong(STARTED_ELAPSED_MS, elapsed)
                .putInt(ENGINE_PID, pid).putString(ENGINE_GENERATION, generation)
                .putLong(SCREEN_OFF_TOTAL_MS, 0L).putLong(CONTINUOUS_SCREEN_OFF_MS, 0L)
                .putInt(SCREEN_OFF_SAMPLES, 0).putInt(INTERACTIVE_SAMPLES, 0)
                .putLong(LAST_SAMPLE_ELAPSED_MS, elapsed).putBoolean(LAST_SAMPLE_INTERACTIVE, interactive(context))
                .putLong(MAX_HEARTBEAT_GAP_MS, 0L).putLong(LAST_SAMPLE_AT_MS, now)
                .putLong(FINISHED_AT_MS, 0L).putString(RESULT_REASON, "").putInt(SAMPLE_COUNT, 0)
                .commit();
            sample(context, id, now);
            KeepAlive.scheduleProbeTick(context, SAMPLE_INTERVAL_MS, id);
            return result.put("started", true).put("probeId", id).put("enginePid", pid).put("engineGeneration", generation);
        } catch (Exception unavailable) { return result; }
    }

    static JSONObject cancel(Context context, String reason) {
        JSONObject result = new JSONObject();
        try {
            android.content.SharedPreferences p = KeepAlive.controlPreferences(context);
            if (!running(context)) return result.put("cancelled", false).put("reason", "not-running");
            accumulateScreenOff(p, context, SystemClock.elapsedRealtime());
            p.edit().putString(STATUS, STATE_CANCELLED).putLong(FINISHED_AT_MS, System.currentTimeMillis())
                .putString(RESULT_REASON, reason == null ? "user-cancelled" : reason)
                .putString(ID, "").commit();
            KeepAlive.cancelProbeTick(context);
            return result.put("cancelled", true);
        } catch (Exception unavailable) { return result; }
    }

    /** Authoritative screen state; a manifest broadcast is not required (and OEMs may drop it). */
    private static boolean interactive(Context context) {
        try {
            android.os.PowerManager power = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
            return power == null || power.isInteractive();
        } catch (RuntimeException unavailable) { return true; }
    }
    /**
     * Accumulate intervals observed at both ends as screen-off. An interval is
     * only counted when the previous sample was already non-interactive, so a
     * screen that was on at the start is never included. A wake and re-lock
     * entirely between two samples is not observable here; the result therefore
     * reports a sample-observed continuous interval, not an exact event log.
     */
    private static void accumulateScreenOff(android.content.SharedPreferences p, Context context, long nowElapsed) {
        long lastElapsed = p.getLong(LAST_SAMPLE_ELAPSED_MS, 0L);
        boolean lastInteractive = p.getBoolean(LAST_SAMPLE_INTERACTIVE, true);
        long total = p.getLong(SCREEN_OFF_TOTAL_MS, 0L);
        long continuous = p.getLong(CONTINUOUS_SCREEN_OFF_MS, 0L);
        boolean nowInteractive = interactive(context);
        long delta = lastElapsed > 0L && nowElapsed > lastElapsed ? nowElapsed - lastElapsed : 0L;
        if (!lastInteractive) total += delta;
        if (nowInteractive) continuous = 0L;
        else if (!lastInteractive) continuous += delta;
        p.edit().putLong(SCREEN_OFF_TOTAL_MS, total).putLong(CONTINUOUS_SCREEN_OFF_MS, continuous)
            .putInt(SCREEN_OFF_SAMPLES, p.getInt(SCREEN_OFF_SAMPLES, 0) + (nowInteractive ? 0 : 1))
            .putInt(INTERACTIVE_SAMPLES, p.getInt(INTERACTIVE_SAMPLES, 0) + (nowInteractive ? 1 : 0))
            .putLong(LAST_SAMPLE_ELAPSED_MS, nowElapsed)
            .putBoolean(LAST_SAMPLE_INTERACTIVE, nowInteractive).commit();
    }

    /** One bounded sample; called by the probe alarm. */
    static void tick(Context context, String probeId) {
        android.content.SharedPreferences p = KeepAlive.controlPreferences(context);
        if (!running(p) || !probeId.equals(p.getString(ID, ""))) return;
        long startedElapsed = p.getLong(STARTED_ELAPSED_MS, 0L);
        long nowElapsed = SystemClock.elapsedRealtime();
        if (startedElapsed <= 0L || nowElapsed < startedElapsed) {
            p.edit().putString(STATUS, STATE_INTERRUPTED).putLong(FINISHED_AT_MS, System.currentTimeMillis())
                .putString(RESULT_REASON, "clock-reset-or-reboot").putString(ID, "").commit();
            return;
        }
        sample(context, probeId, System.currentTimeMillis());
        if (nowElapsed - startedElapsed >= DURATION_MS) finish(context, probeId);
        else KeepAlive.scheduleProbeTick(context, SAMPLE_INTERVAL_MS, probeId);
    }
    private static void sample(Context context, String probeId, long nowMs) {
        android.content.SharedPreferences p = KeepAlive.controlPreferences(context);
        if (!running(p)) return;
        JSONObject engine = KeepAlive.engineState(context);
        long age = engine.optLong("heartbeatAgeMs", -1L);
        long maxGap = Math.max(p.getLong(MAX_HEARTBEAT_GAP_MS, 0L), Math.max(0L, age));
        p.edit().putLong(MAX_HEARTBEAT_GAP_MS, maxGap).putLong(LAST_SAMPLE_AT_MS, nowMs)
            .putInt(SAMPLE_COUNT, p.getInt(SAMPLE_COUNT, 0) + 1).commit();
        accumulateScreenOff(p, context, SystemClock.elapsedRealtime());
    }
    private static void finish(Context context, String probeId) {
        android.content.SharedPreferences p = KeepAlive.controlPreferences(context);
        if (!running(p) || !probeId.equals(p.getString(ID, ""))) return;
        accumulateScreenOff(p, context, SystemClock.elapsedRealtime());
        JSONObject engine = KeepAlive.engineState(context);
        int startPid = p.getInt(ENGINE_PID, -1);
        String startGeneration = p.getString(ENGINE_GENERATION, "");
        long continuousScreenOff = p.getLong(CONTINUOUS_SCREEN_OFF_MS, 0L);
        long maxGap = p.getLong(MAX_HEARTBEAT_GAP_MS, 0L);
        long startedElapsed = p.getLong(STARTED_ELAPSED_MS, 0L);
        long elapsed = Math.max(0L, SystemClock.elapsedRealtime() - startedElapsed);
        boolean sameEngine = engine.optBoolean("engineAlive", false)
            && engine.optInt("pid", -2) == startPid
            && startGeneration.equals(engine.optString("generation", ""));
        String status, reason;
        if (!sameEngine) { status = STATE_FAILED; reason = "engine-changed-or-unresponsive"; }
        else if (maxGap > HEARTBEAT_STALE_MS) { status = STATE_FAILED; reason = "heartbeat-gap"; }
        else if (continuousScreenOff < MIN_SCREEN_OFF_MS) { status = STATE_NOT_LOCKED; reason = "screen-not-continuously-off"; }
        else if (elapsed < DURATION_MS - 30_000L) { status = STATE_INTERRUPTED; reason = "short-interval"; }
        else { status = STATE_PASSED; reason = "same-engine-heartbeat-screen-off"; }
        p.edit().putString(STATUS, status).putLong(FINISHED_AT_MS, System.currentTimeMillis())
            .putString(RESULT_REASON, reason).putString(ID, "").commit();
        KeepAlive.cancelProbeTick(context);
    }
}