package com.vyapartrack.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.File;

import wabridge.Wabridge;

/**
 * Foreground service that keeps the WhatsApp engine (Go/whatsmeow via
 * wabridge) and the localhost dashboard API alive while the app is closed.
 */
public class VyaparService extends Service {

    private static final String TAG = "VyaparService";
    private static final String CHANNEL_ID = "vyapartrack_engine";
    private static final int NOTIF_ID = 1;
    private static final int API_TIMEOUT_MS = 5000;

    private static LocalApi api;
    private static boolean engineStarted = false;

    @Override
    public void onCreate() {
        super.onCreate();
        startForegroundCompat();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat(); // re-assert in case of restarts

        // Orders/catalog live next to the WhatsApp session db.
        File waDir = new File(getFilesDir(), "whatsapp");
        //noinspection ResultOfMethodCallIgnored
        waDir.mkdirs();
        OrdersStore.init(new File(waDir, "data"));
        // Durable diagnostics: engine.log in app-specific external storage
        // (Android/data/com.vyapartrack.app/files/logs/) - pullable over USB.
        EngineLog.init(getExternalFilesDir(null), getFilesDir());

        if (api == null || !api.isListening()) {
            try {
                api = new LocalApi(3000);
                api.start(API_TIMEOUT_MS, false);
                Log.i(TAG, "Local API listening on 127.0.0.1:3000");
            } catch (Exception e) {
                Log.e(TAG, "Local API start failed: " + e.getMessage());
            }
        }

        if (!engineStarted) {
            engineStarted = true;
            Thread t = new Thread(() -> {
                try {
                    Wabridge.setHandler(new EngineHandler(VyaparService.this));
                    Wabridge.startClient(waDir.getAbsolutePath());
                    EngineLog.write("[ENGINE] startClient ok, log file: " + EngineLog.path());
                    Log.i(TAG, "WhatsApp engine started");
                } catch (Exception e) {
                    EngineLog.write("[ENGINE] startClient FAILED: " + e.getMessage());
                    Log.e(TAG, "engine start failed: " + e.getMessage());
                    engineStarted = false;
                }
            }, "vyapar-engine-start");
            t.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (api != null) {
            api.stop();
            api = null;
        }
        try { Wabridge.stop(); } catch (Exception ignored) {}
        engineStarted = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "VyaparTrack Engine",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps WhatsApp order tracking alive");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification n = b
                .setContentTitle("VyaparTrack चालू है")
                .setContentText("WhatsApp ऑर्डर ट्रैक हो रहे हैं")
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setOngoing(true)
                .build();
        startForeground(NOTIF_ID, n);
    }
}
