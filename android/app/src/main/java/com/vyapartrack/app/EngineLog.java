package com.vyapartrack.app;

import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Durable engine log: every whatsmeow protocol line + engine event is
 * appended here so pairing can be diagnosed WITHOUT logcat. The file lives in
 * getExternalFilesDir (Android/data/com.vyapartrack.app/files/logs/engine.log)
 * so it is copyable over USB MTP or `adb pull` with zero permissions.
 */
final class EngineLog {

    private static final Object LOCK = new Object();
    private static final long MAX_BYTES = 2 * 1024 * 1024; // rotate at 2 MB
    private static File logFile;
    private static boolean initFailed;

    private EngineLog() {}

    static void init(File externalDir, File fallbackDir) {
        synchronized (LOCK) {
            File dir = null;
            try {
                if (externalDir != null) {
                    dir = new File(externalDir, "logs");
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    if (!dir.canWrite()) dir = null;
                }
                if (dir == null) {
                    dir = new File(fallbackDir, "logs");
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                }
                logFile = new File(dir, "engine.log");
                write("=== VyaparTrack engine log session start ===");
            } catch (Exception e) {
                initFailed = true;
                Log.w("VyaparEngine", "engine log init failed: " + e.getMessage());
            }
        }
    }

    /** Appends one line. Never throws. Rotates to engine.log.old at 2 MB. */
    static void write(String line) {
        if (logFile == null || initFailed) return;
        synchronized (LOCK) {
            try {
                if (logFile.length() > MAX_BYTES) {
                    File old = new File(logFile.getParentFile(), "engine.log.old");
                    if (old.exists()) //noinspection ResultOfMethodCallIgnored
                        old.delete();
                    //noinspection ResultOfMethodCallIgnored
                    logFile.renameTo(old);
                }
                String stamped = new java.text.SimpleDateFormat("MM-dd HH:mm:ss.SSS", java.util.Locale.US)
                        .format(new java.util.Date()) + " " + line + "\n";
                try (FileOutputStream out = new FileOutputStream(logFile, true)) {
                    out.write(stamped.getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception e) {
                initFailed = true;
            }
        }
    }

    static String path() {
        return logFile == null ? null : logFile.getAbsolutePath();
    }

    /** Current content (for debugging via /api/health if ever needed). */
    static String tail(int maxLines) {
        synchronized (LOCK) {
            if (logFile == null || !logFile.exists()) return "";
            try (FileInputStream in = new FileInputStream(logFile)) {
                byte[] buf = new byte[(int) Math.min(logFile.length(), 256 * 1024)];
                int n = in.read(buf);
                String all = new String(buf, 0, Math.max(n, 0), StandardCharsets.UTF_8);
                String[] lines = all.split("\n");
                StringBuilder sb = new StringBuilder();
                for (int i = Math.max(0, lines.length - maxLines); i < lines.length; i++) {
                    sb.append(lines[i]).append('\n');
                }
                return sb.toString();
            } catch (Exception e) {
                return "";
            }
        }
    }
}
