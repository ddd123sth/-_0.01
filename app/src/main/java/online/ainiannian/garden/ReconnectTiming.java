package online.ainiannian.garden;

import android.content.Context;
import java.io.File;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One bounded record per reconnect cycle, with the layer boundaries the 35 s
 * target is measured at. The start point is stated, not inferred:
 *
 *   deadlineAtMs      the account's own retry deadline published by the engine
 *   armedAtMs         the alarm was accepted by AlarmManager
 *   firedAtMs         the broadcast reached this process
 *   deliveredAtMs     the service accepted the wake (passive recovery allowed)
 *   handledAtMs       the reconnect path finished (accepted or rejected)
 *   runnableAtMs      the engine next published this subject as RUNNABLE
 *
 * `deadlineToFiredMs` is the dominant layer: it is how much later than the due
 * instant Android actually delivered its own alarm. A failure is recorded as the
 * real value; nothing here invents a pass.
 */
final class ReconnectTiming {
    static final String FILE = "reconnect-timings.json";
    private static final int MAX_CYCLES = 16;
    private static final Object LOCK = new Object();

    private ReconnectTiming() { }

    private static JSONObject read(Context context) {
        JSONObject document = KeepAlive.readJsonState(context, FILE);
        try {
            if (document.optJSONArray("cycles") == null) document.put("cycles", new JSONArray());
            document.put("schemaVersion", 1);
        } catch (Exception ignored) { /* An unwritable document is reported as absent. */ }
        return document;
    }

    private static JSONObject find(JSONArray cycles, String id) {
        for (int i = 0; i < cycles.length(); i++) {
            JSONObject cycle = cycles.optJSONObject(i);
            if (cycle != null && id.equals(cycle.optString("id", ""))) return cycle;
        }
        return null;
    }

    private static void write(Context context, JSONObject document, JSONArray cycles) {
        try {
            JSONArray kept = new JSONArray();
            int from = Math.max(0, cycles.length() - MAX_CYCLES);
            for (int i = from; i < cycles.length(); i++) kept.put(cycles.getJSONObject(i));
            document.put("cycles", kept).put("updatedAtMs", System.currentTimeMillis());
            PrivateFiles.write(new File(context.getFilesDir(), FILE), document.toString());
        } catch (Exception ignored) { /* Timing evidence never gates recovery. */ }
    }

    /** A cycle begins when AlarmManager accepted the deadline. */
    static void armed(Context context, JSONObject receipt) {
        if (receipt == null || receipt.optBoolean("scheduled", false) != true) return;
        synchronized (LOCK) {
            try {
                JSONObject document = read(context);
                JSONArray cycles = document.optJSONArray("cycles");
                String id = receipt.optString("id", "");
                if (id.isEmpty()) return;
                JSONObject cycle = find(cycles, id);
                if (cycle == null) {
                    cycle = new JSONObject().put("id", id);
                    cycles.put(cycle);
                }
                // A newer deadline replaces the old appointment; the replaced one is
                // recorded as superseded instead of staying "armed" forever.
                String replaces = receipt.optString("replacesId", "");
                if (!replaces.isEmpty()) {
                    JSONObject replaced = find(cycles, replaces);
                    if (replaced != null && replaced.optLong("firedAtMs", 0L) == 0L) {
                        replaced.put("state", "superseded").put("supersededBy", id)
                            .put("supersededAtMs", System.currentTimeMillis());
                    }
                }
                cycle.put("accountRef", receipt.optString("accountRef", ""))
                    .put("scopeHash", receipt.optString("scopeHash", ""))
                    .put("runEpoch", receipt.optLong("runEpoch", 0L))
                    .put("generation", receipt.optString("generation", ""))
                    .put("controlSeq", receipt.optLong("controlSeq", 0L))
                    .put("mode", receipt.optString("mode", ""))
                    .put("deadlineAtMs", receipt.optLong("deadlineAtMs", 0L))
                    .put("requestedAtMs", receipt.optLong("requestedAtMs", 0L))
                    .put("armedAtMs", receipt.optLong("acceptedAtMs", System.currentTimeMillis()))
                    .put("triggerAtMs", receipt.optLong("triggerAtMs", 0L))
                    .put("state", "armed");
                write(context, document, cycles);
            } catch (Exception ignored) { /* bounded telemetry */ }
        }
    }

    static void fired(Context context, String id, long atMs, String outcome) {
        if (id == null || id.isEmpty()) return;
        update(context, id, cycle -> {
            cycle.put("firedAtMs", atMs).put("deliveryOutcome", outcome == null ? "" : outcome);
            if ("rejected".equals(outcome)) cycle.put("state", "rejected");
            delta(cycle, "deadlineToFiredMs", cycle.optLong("deadlineAtMs", 0L), atMs);
            delta(cycle, "triggerLatenessMs", cycle.optLong("triggerAtMs", 0L), atMs);
        });
    }

    static void delivered(Context context, String id, long atMs) {
        if (id == null || id.isEmpty()) return;
        update(context, id, cycle -> {
            cycle.put("deliveredAtMs", atMs).put("state", "delivered");
            delta(cycle, "deadlineToDeliveredMs", cycle.optLong("deadlineAtMs", 0L), atMs);
            delta(cycle, "firedToDeliveredMs", cycle.optLong("firedAtMs", 0L), atMs);
        });
    }

    static void handled(Context context, String id, long atMs, String outcome) {
        if (id == null || id.isEmpty()) return;
        update(context, id, cycle -> {
            cycle.put("handledAtMs", atMs).put("outcome", outcome == null ? "" : outcome).put("state", "handled");
            delta(cycle, "deadlineToHandledMs", cycle.optLong("deadlineAtMs", 0L), atMs);
            delta(cycle, "deliveredToHandledMs", cycle.optLong("deliveredAtMs", 0L), atMs);
        });
    }

    /**
     * The engine's own publication is the only authority for "this subject is
     * connected again"; the newest handled cycle for that account is closed here.
     * RUNNABLE and WAITING are both connected fact states (WAITING means the
     * session is up and has nothing due), so requiring only RUNNABLE would leave
     * almost every cycle open after a real recovery.
     */
    static void observeConnected(Context context, String accountRef, String scopeHash, String state, long atMs) {
        if (accountRef == null || accountRef.isEmpty()) return;
        if (!"RUNNABLE".equals(state) && !"WAITING".equals(state)) return;
        synchronized (LOCK) {
            try {
                JSONObject document = read(context);
                JSONArray cycles = document.optJSONArray("cycles");
                JSONObject newest = null, unhandled = null;
                for (int i = 0; i < cycles.length(); i++) {
                    JSONObject cycle = cycles.optJSONObject(i);
                    if (cycle == null || !accountRef.equals(cycle.optString("accountRef", ""))) continue;
                    if (!scopeHash.isEmpty() && !scopeHash.equals(cycle.optString("scopeHash", ""))) continue;
                    if (cycle.optLong("runnableAtMs", 0L) > 0L) continue;
                    // Only a cycle whose wake path actually ran may be measured. A cycle
                    // that was armed and never delivered was recovered by another path
                    // (usually the network callback); counting it would report a
                    // reconnect latency that the alarm never produced.
                    if (cycle.optLong("handledAtMs", 0L) > 0L || cycle.optLong("deliveredAtMs", 0L) > 0L) {
                        if (newest == null || cycle.optLong("handledAtMs", 0L) >= newest.optLong("handledAtMs", 0L)) newest = cycle;
                    } else if (unhandled == null || cycle.optLong("armedAtMs", 0L) >= unhandled.optLong("armedAtMs", 0L)) unhandled = cycle;
                }
                if (newest == null) {
                    if (unhandled != null) {
                        unhandled.put("state", "recovered-without-alarm").put("accountConnectedAtMs", atMs)
                            .put("connectedState", state);
                        write(context, document, cycles);
                    }
                    return;
                }
                newest.put("runnableAtMs", atMs).put("connectedState", state).put("state", "recovered");
                delta(newest, "deadlineToRunnableMs", newest.optLong("deadlineAtMs", 0L), atMs);
                if (newest.optLong("requestedAtMs", 0L) > 0L && newest.optLong("deadlineAtMs", 0L) > 0L)
                    delta(newest, "armToDeadlineMs", newest.optLong("requestedAtMs", 0L), newest.optLong("deadlineAtMs", 0L));
                write(context, document, cycles);
            } catch (Exception ignored) { /* bounded telemetry */ }
        }
    }

    private static void delta(JSONObject cycle, String name, long fromMs, long toMs) {
        try {
            if (fromMs <= 0L || toMs <= 0L || toMs < fromMs) return;
            cycle.put(name, toMs - fromMs);
        } catch (Exception ignored) { /* one absent layer keeps the others */ }
    }

    private interface Mutation { void apply(JSONObject cycle) throws Exception; }

    private static void update(Context context, String id, Mutation mutation) {
        synchronized (LOCK) {
            try {
                JSONObject document = read(context);
                JSONArray cycles = document.optJSONArray("cycles");
                JSONObject cycle = find(cycles, id);
                if (cycle == null) return;
                mutation.apply(cycle);
                write(context, document, cycles);
            } catch (Exception ignored) { /* bounded telemetry */ }
        }
    }

    /** Newest cycle, for the merged fifteen-second status sample. */
    static JSONObject latest(Context context) {
        try {
            JSONArray cycles = read(context).optJSONArray("cycles");
            for (int i = cycles.length() - 1; i >= 0; i--) {
                JSONObject cycle = cycles.optJSONObject(i);
                if (cycle != null) return cycle;
            }
        } catch (Exception ignored) { /* absent */ }
        return null;
    }
}