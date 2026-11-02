package online.ainiannian.garden;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

/**
 * Passive recovery entry points: boot, package update, user unlock and the periodic self check.
 * None of them may create user intent. Each one only asks the engine service to resume an
 * already-desired run, and stops asking as soon as the durable STOP latch is present.
 * A self-check alarm carries the control epoch it was scheduled under, so an alarm delivered
 * after a STOP is dropped instead of reviving the engine.
 */
public final class KeepAliveReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        try {
            String action = intent.getAction();
            if (KeepAlive.ACTION_CHECK.equals(action)) {
                onSelfCheck(context, intent);
                return;
            }
            if (KeepAlive.ACTION_PROBE_DUE.equals(action)) {
                KeepAliveProbe.tick(context, intent.getStringExtra(KeepAlive.EXTRA_PROBE_ID));
                return;
            }
            if (BuildConfig.DEBUG && KeepAlive.ACTION_DEBUG_VPN_REVOKE.equals(action)) {
                try { context.startService(new Intent(context, KeepAliveVpnService.class).setAction(KeepAlive.ACTION_DEBUG_VPN_REVOKE)); }
                catch (RuntimeException ignored) { }
                return;
            }
            if (BuildConfig.DEBUG && (KeepAlive.ACTION_DEBUG_VPN_DROP_FD.equals(action)
                    || KeepAlive.ACTION_DEBUG_VPN_FAIL_NEXT.equals(action))) {
                Intent forward = new Intent(context, KeepAliveVpnService.class).setAction(action);
                if (KeepAlive.ACTION_DEBUG_VPN_FAIL_NEXT.equals(action)) {
                    forward.putExtra("count", intent.getIntExtra("count", 1));
                }
                try { context.startService(forward); } catch (RuntimeException ignored) { }
                return;
            }
            if (BuildConfig.DEBUG && KeepAlive.ACTION_DEBUG_STALE_RECOVER.equals(action)) {
                Intent stale = new Intent(context, EngineService.class).setAction(KeepAlive.ACTION_RECOVER)
                    .putExtra(KeepAlive.EXTRA_EPOCH, KeepAlive.epoch(context) - 1)
                    .putExtra(KeepAlive.EXTRA_REASON, "debug-stale");
                try { context.startForegroundService(stale); } catch (RuntimeException denied) { }
                return;
            }
            if (BuildConfig.DEBUG && KeepAlive.ACTION_DEBUG_REAL_STOP.equals(action)) {
                context.startService(new Intent(context, EngineService.class).setAction("STOP"));
                return;
            }
            if (BuildConfig.DEBUG && KeepAlive.ACTION_DEBUG_RECOVERY_PROMPT.equals(action)) {
                KeepAlive.postRecoveryNotification(context, "debug-prompt");
                return;
            }
            if (BuildConfig.DEBUG && KeepAlive.ACTION_DEBUG_PROBE_START.equals(action)) {
                KeepAliveProbe.start(context);
                return;
            }
            if (BuildConfig.DEBUG && KeepAlive.ACTION_DEBUG_STATUS_SNAPSHOT.equals(action)) {
                try {
                    PrivateFiles.write(new java.io.File(context.getFilesDir(), "keepalive-status-debug.json"),
                        KeepAlive.status(context).toString());
                } catch (Exception ignored) { /* Debug evidence only. */ }
                return;
            }
            if (KeepAlive.ACTION_RECONNECT_DUE.equals(action)) {
                onReconnectDue(context, intent);
                return;
            }
            boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_USER_UNLOCKED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
            if (!boot) return;
            if (!KeepAlive.engineAllowed(context)) {
                KeepAlive.cancelSelfCheck(context);
                return;
            }
            KeepAlive.scheduleSelfCheck(context, true);
            KeepAlive.requestRecovery(context, "boot");
        } catch (RuntimeException ignored) {
            // A recovery broadcast must never crash the host process. The next alarm retries.
            try { KeepAlive.scheduleSelfCheck(context, true); } catch (RuntimeException unavailable) { }
        }
    }
    private void onReconnectDue(Context context, Intent intent) {
        JSONObject receipt = KeepAlive.readJsonState(context, KeepAlive.RECONNECT_STATE_FILE);
        JSONObject delivery = new JSONObject();
        boolean matching = KeepAlive.reconnectMatches(context, intent, receipt);
        String deliveryFile = matching ? KeepAlive.RECONNECT_DELIVERY_FILE : KeepAlive.RECONNECT_REJECTED_FILE;
        try {
            delivery.put("schemaVersion", 1).put("receivedAtMs", System.currentTimeMillis())
                .put("id", KeepAlive.reconnectEventId(intent))
                .put("state", "received");
            if (!KeepAlive.writeReconnectState(context, deliveryFile, delivery)) return;
            ReconnectTiming.fired(context, KeepAlive.reconnectEventId(intent), delivery.optLong("receivedAtMs", 0L),
                matching ? "forwarding" : "stale-or-cancelled");
            if (!matching) {
                delivery.put("outcome", "stale-or-cancelled");
                return;
            }
            if (new java.io.File(context.getFilesDir(), "user-stop-request.json").isFile()
                    || KeepAlive.backendStopBlocksPassive(context)) {
                delivery.put("outcome", "stop-blocked");
                return;
            }
            JSONObject engine = KeepAlive.engineState(context);
            if (engine.optBoolean("engineAlive", false)
                    && !receipt.optString("generation", "").equals(engine.optString("generation", ""))) {
                delivery.put("outcome", "newer-engine");
                return;
            }
            // Only the service process reads fresh engine-safety preferences. Forward
            // the identity, never establish desire from the receiver's cached prefs.
            Intent forward = new Intent(context, EngineService.class).setAction(KeepAlive.ACTION_RECONNECT_DUE)
                .putExtra(KeepAlive.EXTRA_EPOCH, receipt.getInt("epoch"))
                .putExtra(KeepAlive.EXTRA_RECONNECT_ID, receipt.getString("id"))
                .putExtra(KeepAlive.EXTRA_RECONNECT_GENERATION, receipt.getString("generation"));
            try {
                if (android.os.Build.VERSION.SDK_INT >= 26) context.startForegroundService(forward);
                else context.startService(forward);
                delivery.put("outcome", "forward-accepted");
            } catch (RuntimeException denied) {
                delivery.put("outcome", "background-start-denied")
                    .put("failureKind", denied.getClass().getSimpleName());
                KeepAlive.postRecoveryNotification(context, "reconnect_due");
            }
        } catch (Exception unavailable) {
            try { delivery.put("outcome", "delivery-failed").put("failureKind", unavailable.getClass().getSimpleName()); }
            catch (Exception ignored) { }
        } finally {
            KeepAlive.writeReconnectState(context, deliveryFile, delivery);
        }
    }
    private void onSelfCheck(Context context, Intent intent) {
        // The app process can cache a stale control epoch; the engine's fresh
        // desired/STOP state is the authority for a passive recovery.
        try {
            if (new java.io.File(context.getFilesDir(), "user-stop-request.json").isFile()) {
                KeepAlive.cancelSelfCheck(context);
                return;
            }
        } catch (RuntimeException ignored) { }
        KeepAlive.scheduleSelfCheck(context, true);
        JSONObject engine = KeepAlive.engineState(context);
        if (engine.optBoolean("engineAlive", false)) {
            KeepAlive.writeSelfCheckOutcome(context, "process-alive", engine.optLong("heartbeatAgeMs", -1L));
            return;
        }
        KeepAlive.requestRecovery(context, "self_check");
    }
}