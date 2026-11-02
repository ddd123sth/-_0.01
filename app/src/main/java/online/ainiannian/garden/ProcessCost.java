package online.ainiannian.garden;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Debug;
import android.os.SystemClock;
import java.io.File;
import org.json.JSONObject;

/**
 * Per-sample cost of the engine process, merged into the existing fifteen-second
 * status write. Every field is a delta since the previous sample so a reader can
 * separate "the engine is awake because work is in flight" from "the engine is
 * awake for its own probes"; a missing kernel counter stays absent instead of
 * being reported as zero.
 */
final class ProcessCost {
    private long lastCpuTicks = -1L;
    private long lastElapsedMs = -1L;
    private long lastReadBytes = -1L;
    private long lastWriteBytes = -1L;
    private final ActivityManager manager;
    private final int pid;

    ProcessCost(Context context) {
        this.manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        this.pid = android.os.Process.myPid();
    }

    private static long[] cpuTicks() {
        try {
            String stat = PrivateFiles.text(new File("/proc/self/stat"));
            int end = stat.lastIndexOf(')');
            if (end < 0) return null;
            String[] fields = stat.substring(end + 1).trim().split("\\s+");
            // After the comm field, utime is field 14 and stime is 15 (0-based 11 and 12 here).
            if (fields.length < 13) return null;
            long utime = Long.parseLong(fields[11]), stime = Long.parseLong(fields[12]);
            return new long[] { utime + stime };
        } catch (Exception unavailable) { return null; }
    }

    private static long[] ioBytes() {
        try {
            String io = PrivateFiles.text(new File("/proc/self/io"));
            long read = -1L, write = -1L;
            for (String line : io.split("\n")) {
                String trimmed = line.trim();
                if (trimmed.startsWith("read_bytes:")) read = Long.parseLong(trimmed.substring(11).trim());
                else if (trimmed.startsWith("write_bytes:")) write = Long.parseLong(trimmed.substring(12).trim());
            }
            return read < 0L && write < 0L ? null : new long[] { read, write };
        } catch (Exception unavailable) { return null; }
    }

    private long pssKb() {
        try {
            Debug.MemoryInfo[] info = manager.getProcessMemoryInfo(new int[] { pid });
            return info == null || info.length == 0 ? -1L : info[0].getTotalPss();
        } catch (Exception unavailable) { return -1L; }
    }

    /**
     * Returns the current sample. `cpuHz` is the kernel clock tick rate; on
     * Android it is 100 Hz, and an unexpected value is reported instead of
     * being guessed so a wrong percentage is never published.
     */
    synchronized JSONObject sample() {
        JSONObject cost = new JSONObject();
        try {
            long elapsed = SystemClock.elapsedRealtime();
            long[] ticks = cpuTicks();
            if (ticks != null) {
                long cpuMs = ticks[0] * 10L;
                cost.put("cpuMsTotal", cpuMs).put("cpuTicksPerSecond", 100);
                if (lastCpuTicks >= 0L && lastElapsedMs > 0L && elapsed > lastElapsedMs) {
                    long cpuDelta = (ticks[0] - lastCpuTicks) * 10L;
                    long wallDelta = elapsed - lastElapsedMs;
                    cost.put("sampleWindowMs", wallDelta).put("cpuMsDelta", Math.max(0L, cpuDelta));
                    cost.put("cpuPercentOfOneCore", Math.max(0L, Math.min(10000L, cpuDelta * 1000L / Math.max(1L, wallDelta))) / 10.0);
                }
                lastCpuTicks = ticks[0];
            }
            long[] io = ioBytes();
            if (io != null) {
                if (io[0] >= 0L) cost.put("diskReadBytesTotal", io[0]);
                if (io[1] >= 0L) cost.put("diskWriteBytesTotal", io[1]);
                if (lastReadBytes >= 0L && io[0] >= lastReadBytes) cost.put("diskReadBytesDelta", io[0] - lastReadBytes);
                if (lastWriteBytes >= 0L && io[1] >= lastWriteBytes) cost.put("diskWriteBytesDelta", io[1] - lastWriteBytes);
                lastReadBytes = io[0]; lastWriteBytes = io[1];
            }
            long pss = pssKb();
            if (pss >= 0L) cost.put("pssKb", pss);
            cost.put("sampledAtElapsed", elapsed);
            lastElapsedMs = elapsed;
        } catch (Exception unavailable) { /* A cost sample never gates the engine. */ }
        return cost;
    }
}