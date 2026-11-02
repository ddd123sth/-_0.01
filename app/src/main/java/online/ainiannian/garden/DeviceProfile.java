package online.ainiannian.garden;

import android.app.ActivityManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import org.json.JSONObject;
import java.util.Locale;
import java.util.TimeZone;

final class DeviceProfile {
    // Keep only immutable, non-sensitive facts from a callback's supplied arguments.
    static final class NetworkState {
        final Network network;
        final boolean online;
        final String transport;
        final String profileTransport;
        NetworkState(Network network, boolean online, String transport, String profileTransport) {
            this.network = network;
            this.online = online;
            this.transport = transport;
            this.profileTransport = profileTransport;
        }
        boolean sameObservation(NetworkState other) {
            return other != null && online == other.online && transport.equals(other.transport)
                && (network == null ? other.network == null : network.equals(other.network));
        }
    }
    static NetworkState networkState(Network network, NetworkCapabilities caps) {
        if (network == null) return new NetworkState(null, false, "none", "offline");
        if (caps != null) {
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return new NetworkState(network, true, "wifi", "WIFI");
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return new NetworkState(network, true, "cellular", "CELLULAR");
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return new NetworkState(network, true, "ethernet", "ETHERNET");
        }
        // A present but unclassified network (or capabilities not yet known) is not "none".
        return new NetworkState(network, true, "unknown", "OTHER");
    }
    static NetworkState networkState(Context context) {
        return networkState(context, WifiManager.WIFI_STATE_UNKNOWN);
    }
    static NetworkState networkState(Context context, int broadcastWifiState) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) throw new IllegalStateException("Connectivity service unavailable");
        Network network = manager.getActiveNetwork();
        NetworkCapabilities caps = network == null ? null : manager.getNetworkCapabilities(network);
        NetworkState state = networkState(network, caps);
        // A stale default WIFI network must not assert online after the real
        // WIFI radio is disabling/disabled. Never override a current cellular
        // or ethernet path, an unclassified path, or an unreadable WIFI state.
        if (!state.online || !"wifi".equals(state.transport)) return state;
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return state;
        try {
            WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return state;
            int actual = wifi.getWifiState();
            boolean actuallyUnavailable = actual == WifiManager.WIFI_STATE_DISABLED || actual == WifiManager.WIFI_STATE_DISABLING;
            boolean disabledBroadcast = broadcastWifiState == WifiManager.WIFI_STATE_DISABLED || broadcastWifiState == WifiManager.WIFI_STATE_DISABLING;
            if ((broadcastWifiState == WifiManager.WIFI_STATE_UNKNOWN || disabledBroadcast) && actuallyUnavailable && !wifi.isWifiEnabled()) {
                return networkState(null, null);
            }
        } catch (SecurityException unreadable) { /* Missing permission is not an offline observation. */ }
        return state;
    }
    static String transport(Context context) {
        return networkState(context).profileTransport;
    }
    static JSONObject capture(Context context) throws Exception {
        DisplayMetrics display = new DisplayMetrics();
        ((WindowManager) context.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(display);
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        ((ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE)).getMemoryInfo(memory);
        JSONObject equipment = new JSONObject()
            .put("deviceId", Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID))
            .put("brand", Build.BRAND).put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
            .put("osVersion", Build.VERSION.RELEASE).put("cpuType", Build.SUPPORTED_ABIS[0])
            .put("memoryState", Long.toString(memory.totalMem / (1024L * 1024L)))
            .put("screenWidth", display.widthPixels).put("screenHeight", display.heightPixels)
            .put("networkType", transport(context)).put("sysLanguage", Locale.getDefault().toString())
            .put("buildFingerprint", Build.FINGERPRINT).put("deviceProduct", Build.PRODUCT)
            .put("timezone", TimeZone.getDefault().getID());
        try {
            String officialVersion = context.getPackageManager().getPackageInfo("cn.lbwdhysj.gf", 0).versionName;
            if (officialVersion != null && !officialVersion.isEmpty()) equipment.put("appVersion", officialVersion);
        } catch (android.content.pm.PackageManager.NameNotFoundException absent) { /* Use the vendored protocol version; do not invent a version. */ }
        return new JSONObject().put("source", "android-native-api")
            .put("capturedAt", java.time.Instant.now().toString()).put("equipment", equipment);
    }
    // Public diagnostics deliberately omit ANDROID_ID and fingerprints.
    static JSONObject publicInfo(Context context) throws Exception {
        android.os.PowerManager power = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
        boolean engineAlive = false;
        try {
            JSONObject heartbeat = new JSONObject(PrivateFiles.text(new java.io.File(context.getFilesDir(), "engine-heartbeat.json")));
            if (System.currentTimeMillis() - heartbeat.getLong("at") < 45000L) {
                android.system.Os.kill(heartbeat.getInt("pid"), 0); engineAlive = true;
            }
        } catch (Exception stopped) { }
        return new JSONObject().put("brand", Build.BRAND).put("model", Build.MODEL)
            .put("androidVersion", Build.VERSION.RELEASE).put("apiLevel", Build.VERSION.SDK_INT)
            .put("abi", Build.SUPPORTED_ABIS[0]).put("network", transport(context))
            .put("hyperOS", Build.DISPLAY)
            .put("serviceRunning", engineAlive).put("foregroundServiceRunning", engineAlive)
            .put("notificationsEnabled", context.getSystemService(android.app.NotificationManager.class).areNotificationsEnabled())
            .put("batteryUnrestricted", power.isIgnoringBatteryOptimizations(context.getPackageName()))
            .put("keepAlive", KeepAlive.status(context));
    }
}
