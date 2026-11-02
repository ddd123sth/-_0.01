package online.ainiannian.garden;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Deterministic bounds for the app's own diagnostic files. The Node side owns
 * the generation-scoped budget (see runtime/backend/observability/file-capacity.mjs);
 * this class only covers what the native layer writes before or beside it:
 * probe captures, per-generation restart receipts and SQLite scratch files.
 *
 * Reclaim order is fixed: oldest capture first, whole capture only, and the
 * newest capture of a probe plus the generation that is running are never
 * touched. Nothing here reads or changes run intent.
 */
final class DiagnosticStorage {
    static final long PROBE_BUDGET_BYTES = 8L * 1024L * 1024L;
    static final int PROBE_KEEP_NEWEST = 3;
    static final long PROBE_CAPTURE_ADMISSION_BYTES = 24L * 1024L * 1024L;
    static final int RESTART_DECISION_KEEP_NEWEST = 64;
    static final long SCRATCH_MAX_AGE_MS = 24L * 60L * 60L * 1000L;
    private static final String[] PROTECTED_PREFIXES = { "keepalive-", "stop-request", "native-stop", "credential-",
        "user-stop", "account-stop" };

    private DiagnosticStorage() { }

    private static boolean protectedName(String name) {
        if (name == null || name.isEmpty()) return true;
        for (String prefix : PROTECTED_PREFIXES) if (name.startsWith(prefix)) return true;
        return name.equals("engine") || name.equals(".asset-version") || name.equals("garden.db")
            || name.equals("file-capacity-status.json") || name.equals("file-capacity-lease.json");
    }

    private static boolean insideRoot(File root, File candidate) throws IOException {
        String prefix = root.getCanonicalPath() + File.separator;
        return candidate.getCanonicalPath().startsWith(prefix);
    }

    /** Logical size of a file or a bounded directory tree; symlinks are never followed. */
    private static long sizeOf(File target, int depth) {
        if (target == null) return 0L;
        if (depth > 4) return 0L;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children == null) return 0L;
            long total = 0L;
            for (File child : children) total += sizeOf(child, depth + 1);
            return total;
        }
        return target.isFile() ? target.length() : 0L;
    }

    private static long newestModified(File target, int depth) {
        if (target == null || depth > 4) return 0L;
        long newest = target.lastModified();
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) for (File child : children) newest = Math.max(newest, newestModified(child, depth + 1));
        }
        return newest;
    }

    private static boolean deleteTree(File target, int depth) {
        if (target == null || depth > 4) return false;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) for (File child : children) deleteTree(child, depth + 1);
        }
        return target.delete() || !target.exists();
    }

    private static String childName(File root, File child) {
        String rootPath = root.getPath() + File.separator;
        return child.getPath().startsWith(rootPath) ? child.getPath().substring(rootPath.length()) : child.getName();
    }

    /**
     * Applies the probe-capture budget. `keepGeneration` is the running engine
     * generation; its capture stays even when the class is over budget.
     */
    static synchronized String pruneProbeCaptures(File filesDir, String keepGeneration) {
        File diagnostics = new File(filesDir, "diagnostics");
        if (!diagnostics.isDirectory()) return "absent";
        File[] probes = diagnostics.listFiles();
        if (probes == null) return "unreadable";
        long reclaimed = 0L;
        int removed = 0;
        for (File probe : probes) {
            try {
                if (!probe.isDirectory() || protectedName(probe.getName()) || !insideRoot(diagnostics, probe)) continue;
                File[] captures = probe.listFiles();
                if (captures == null || captures.length == 0) { probe.delete(); continue; }
                List<File> ordered = new ArrayList<>();
                for (File capture : captures) if (capture.isDirectory() && !protectedName(capture.getName())) ordered.add(capture);
                ordered.sort(Comparator.comparingLong((File one) -> newestModified(one, 0)).thenComparing(File::getName));
                int keep = Math.min(ordered.size(), PROBE_KEEP_NEWEST);
                long bytes = 0L;
                for (File capture : ordered) bytes += sizeOf(capture, 0);
                int index = 0;
                while (index < ordered.size() - keep && (bytes > PROBE_BUDGET_BYTES || ordered.size() - index > PROBE_KEEP_NEWEST)) {
                    File capture = ordered.get(index);
                    boolean runningGeneration = keepGeneration != null && keepGeneration.equals(capture.getName());
                    if (!runningGeneration) {
                        long size = sizeOf(capture, 0);
                        if (deleteTree(capture, 0)) { bytes -= size; reclaimed += size; removed += 1; }
                    }
                    index += 1;
                }
                // One capture larger than the whole class budget cannot be kept
                // only because it is newest; the running generation is exempt.
                for (int position = 0; position < ordered.size(); position++) {
                    File capture = ordered.get(position);
                    boolean runningGeneration = keepGeneration != null && keepGeneration.equals(capture.getName());
                    if (runningGeneration || !capture.exists()) continue;
                    long size = sizeOf(capture, 0);
                    if (size <= PROBE_BUDGET_BYTES) continue;
                    if (deleteTree(capture, 0)) { bytes -= size; reclaimed += size; removed += 1; }
                }
            } catch (Exception ignored) { /* A single unreadable probe cannot block the bound. */ }
        }
        return "probe-captures removed=" + removed + " bytes=" + reclaimed;
    }

    /**
     * Admits one profiling capture. A probe root that already exceeds the hard
     * admission cap keeps the diagnostic unavailable instead of growing without
     * bound; the previous capture is still readable until reclaimed.
     */
    static synchronized boolean admitProfileCapture(File captureRoot) {
        long bytes = sizeOf(captureRoot, 0);
        if (bytes <= PROBE_CAPTURE_ADMISSION_BYTES) return true;
        File[] captures = captureRoot.listFiles();
        if (captures == null) return false;
        List<File> ordered = new ArrayList<>();
        for (File capture : captures) if (capture.isDirectory()) ordered.add(capture);
        ordered.sort(Comparator.comparingLong((File one) -> newestModified(one, 0)).thenComparing(File::getName));
        for (int index = 0; index < ordered.size(); index++) {
            if (bytes <= PROBE_CAPTURE_ADMISSION_BYTES) break;
            long size = sizeOf(ordered.get(index), 0);
            if (deleteTree(ordered.get(index), 0)) bytes -= size;
        }
        return bytes <= PROBE_CAPTURE_ADMISSION_BYTES;
    }

    /** Keeps the newest restart receipts so a restart storm cannot fill the private directory. */
    static synchronized String pruneRestartDecisions(File filesDir) {
        File root = new File(filesDir, "engine-restart-decisions");
        File[] files = root.listFiles();
        if (files == null) return "absent";
        List<File> receipts = new ArrayList<>();
        for (File file : files) if (file.isFile() && !protectedName(file.getName())) receipts.add(file);
        if (receipts.size() <= RESTART_DECISION_KEEP_NEWEST) return "within-budget";
        receipts.sort(Comparator.comparingLong(File::lastModified).thenComparing(File::getName));
        int removed = 0;
        for (int index = 0; index < receipts.size() - RESTART_DECISION_KEEP_NEWEST; index++)
            if (receipts.get(index).delete()) removed += 1;
        return "restart-decisions removed=" + removed;
    }

    /** SQLite scratch files are safe to drop once stale; a live database never uses them. */
    static synchronized String pruneScratch(File cacheDir) {
        File root = new File(cacheDir, "sqlite");
        File[] files = root.listFiles();
        if (files == null) return "absent";
        long cutoff = System.currentTimeMillis() - SCRATCH_MAX_AGE_MS;
        int removed = 0;
        for (File file : files) {
            if (protectedName(file.getName())) continue;
            if (file.isFile() && file.lastModified() < cutoff && file.delete()) removed += 1;
            else if (file.isDirectory() && newestModified(file, 0) < cutoff && deleteTree(file, 0)) removed += 1;
        }
        return "scratch removed=" + removed;
    }

    /** One bounded pass at engine launch, before Node starts. */
    static synchronized void boundPrivateStorage(android.content.Context context) {
        try {
            File files = context.getFilesDir().getCanonicalFile();
            pruneProbeCaptures(files, null);
            pruneRestartDecisions(files);
            pruneScratch(context.getCacheDir().getCanonicalFile());
        } catch (Exception ignored) { /* A storage bound never blocks engine start. */ }
    }
}