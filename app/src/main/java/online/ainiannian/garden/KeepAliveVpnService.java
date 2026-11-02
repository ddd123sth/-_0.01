package online.ainiannian.garden;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Optional keep-alive enhancement. It establishes a tun with no routes and no DNS,
 * so no traffic is captured or redirected: it only gives the app process the
 * system-managed VPN lifetime that OEM battery managers treat as user-visible work.
 * It never loads a second Node runtime and never executes game business.
 *
 * <p>The tunnel is checked and rebuilt in place: an invalid FD closes the old descriptor
 * and tries again without touching the normal engine. A temporary establish failure stays
 * a temporary failure (the user's switch stays on and is reported as not connected); only
 * their explicit action or a system revoke turns the switch off.
 */
public final class KeepAliveVpnService extends VpnService {
    private static final long MAINTENANCE_MS = 60_000L;
    private static final long[] RETRY_DELAYS_MS = { 60_000L, 120_000L, 300_000L, 600_000L, 900_000L };

    private ParcelFileDescriptor tunnel;
    private ScheduledExecutorService maintainer;
    private int failureCount;
    private int forcedFailures;
    private long nextAttemptElapsedMs;

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (BuildConfig.DEBUG && intent != null && KeepAlive.ACTION_DEBUG_VPN_REVOKE.equals(intent.getAction())) {
            onRevoke();
            return START_NOT_STICKY;
        }
        if (BuildConfig.DEBUG && intent != null && KeepAlive.ACTION_DEBUG_VPN_FAIL_NEXT.equals(intent.getAction())) {
            forcedFailures = Math.max(0, intent.getIntExtra("count", 1));
            return START_STICKY;
        }
        if (BuildConfig.DEBUG && intent != null && KeepAlive.ACTION_DEBUG_VPN_DROP_FD.equals(intent.getAction())) {
            // Simulate the descriptor going away while this service keeps running.
            closeTunnel();
            KeepAlive.writeVpnState(this, false, "debug-fd-dropped");
            startMaintenance();
            return START_STICKY;
        }
        if (intent != null && KeepAlive.ACTION_VPN_STOP.equals(intent.getAction())) {
            shutdown("user-disabled");
            return START_NOT_STICKY;
        }
        if (!KeepAlive.controlPreferences(this).getBoolean(KeepAlive.VPN_ENABLED, false)) {
            shutdown("not-enabled");
            return START_NOT_STICKY;
        }
        if (fdValid()) {
            KeepAlive.writeVpnState(this, true, "already-established");
            startMaintenance();
            return START_STICKY;
        }
        establishOrRecordFailure();
        startMaintenance();
        return START_STICKY;
    }

    private boolean fdValid() {
        ParcelFileDescriptor current = tunnel;
        if (current == null) return false;
        try { return current.getFileDescriptor() != null && current.getFileDescriptor().valid(); }
        catch (RuntimeException invalid) { return false; }
    }

    private void establishOrRecordFailure() {
        if (!KeepAlive.controlPreferences(this).getBoolean(KeepAlive.VPN_ENABLED, false)) { shutdown("not-enabled"); return; }
        if (BuildConfig.DEBUG && forcedFailures > 0) {
            forcedFailures -= 1;
            recordFailure("debug-forced");
            return;
        }
        closeTunnel();
        ParcelFileDescriptor established = null;
        String reason = "";
        try {
            Builder builder = new Builder();
            builder.setSession("无尽夏后台保护");
            // An address without routes: packets to anything else keep using the
            // normal networks. This is a lifetime holder, not a traffic path.
            builder.addAddress("10.111.0.2", 32);
            builder.setBlocking(false);
            try { builder.addDisallowedApplication(getPackageName()); }
            catch (PackageManager.NameNotFoundException unavailable) { /* Own package always exists. */ }
            established = builder.establish();
            if (established == null) reason = "consent-required";
        } catch (Exception failure) {
            reason = failure.getClass().getSimpleName();
        }
        if (established == null) {
            recordFailure(reason);
            return;
        }
        tunnel = established;
        failureCount = 0;
        nextAttemptElapsedMs = 0L;
        KeepAlive.controlPreferences(this).edit().putInt(KeepAlive.VPN_FAILURE_COUNT, 0)
            .putString(KeepAlive.VPN_LAST_ERROR, "").commit();
        KeepAlive.writeVpnState(this, true, "established");
    }

    private void recordFailure(String reason) {
        closeTunnel();
        // Keep the user's switch as it was. This is reported as "enabled but not connected"
        // so a temporary failure never silently becomes a permanent user choice.
        failureCount = Math.min(RETRY_DELAYS_MS.length, failureCount + 1);
        long delay = RETRY_DELAYS_MS[Math.max(0, failureCount - 1)];
        nextAttemptElapsedMs = android.os.SystemClock.elapsedRealtime() + delay;
        KeepAlive.controlPreferences(this).edit().putInt(KeepAlive.VPN_FAILURE_COUNT, failureCount)
            .putString(KeepAlive.VPN_LAST_ERROR, reason).commit();
        KeepAlive.writeVpnState(this, false, reason.isEmpty() ? "establish-failed" : reason);
    }

    private void startMaintenance() {
        if (maintainer != null && !maintainer.isShutdown()) return;
        maintainer = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "garden-vpn-maintenance"));
        try {
            maintainer.scheduleWithFixedDelay(this::maintain, MAINTENANCE_MS, MAINTENANCE_MS, TimeUnit.MILLISECONDS);
        } catch (RuntimeException unavailable) { /* The service still reports its current state. */ }
    }

    private void maintain() {
        try {
            if (!KeepAlive.controlPreferences(this).getBoolean(KeepAlive.VPN_ENABLED, false)) { shutdown("not-enabled"); return; }
            if (fdValid()) {
                if (failureCount != 0) {
                    failureCount = 0;
                    KeepAlive.controlPreferences(this).edit().putInt(KeepAlive.VPN_FAILURE_COUNT, 0)
                        .putString(KeepAlive.VPN_LAST_ERROR, "").commit();
                    KeepAlive.writeVpnState(this, true, "recovered");
                } else KeepAlive.writeVpnState(this, true, "maintained");
                return;
            }
            if (android.os.SystemClock.elapsedRealtime() < nextAttemptElapsedMs) return;
            establishOrRecordFailure();
        } catch (RuntimeException unavailable) { /* Maintenance never crashes the host process. */ }
    }

    @Override public void onRevoke() {
        // A system revoke (another VPN took over, or access was withdrawn) needs the consent
        // dialog again. Recording the reason keeps it apart from a temporary establish failure.
        KeepAlive.controlPreferences(this).edit().putBoolean(KeepAlive.VPN_ENABLED, false)
            .putString(KeepAlive.VPN_LAST_ERROR, "revoked").commit();
        KeepAlive.bumpVpnEpoch(this);
        shutdown("revoked");
    }

    @Override public void onDestroy() {
        closeTunnel("destroyed");
        shutdownMaintainer();
        super.onDestroy();
    }

    private void shutdown(String reason) {
        closeTunnel(reason);
        shutdownMaintainer();
        stopSelf();
    }
    private void shutdownMaintainer() {
        ScheduledExecutorService current = maintainer;
        maintainer = null;
        if (current != null) { try { current.shutdownNow(); } catch (RuntimeException ignored) { } }
    }
    private void closeTunnel() {
        ParcelFileDescriptor current = tunnel;
        tunnel = null;
        if (current != null) { try { current.close(); } catch (Exception ignored) { /* Already closed. */ } }
    }
    private void closeTunnel(String reason) {
        closeTunnel();
        KeepAlive.writeVpnState(this, false, reason);
    }
}