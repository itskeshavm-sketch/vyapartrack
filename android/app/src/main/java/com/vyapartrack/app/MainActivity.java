package com.vyapartrack.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private WebView webView;
    private final ExecutorService httpExecutor = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Immersive, edge-to-edge feel
        getWindow().setStatusBarColor(Color.parseColor("#ffffff"));
        int uiFlags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 26) uiFlags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        getWindow().getDecorView().setSystemUiVisibility(uiFlags);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#f4f7fb"));

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage persistence
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        // The dashboard runs from file:// but must call the https API.
        // Without these, every fetch() throws "TypeError: Failed to fetch".
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setBackgroundColor(Color.parseColor("#f4f7fb"));
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());

        // Expose a tiny native bridge for the dashboard to call:
        //   window.Native.shareOnWhatsApp(text) -> opens WhatsApp
        webView.addJavascriptInterface(new NativeBridge(), "Native");

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        webView.loadUrl("file:///android_asset/dashboard/index.html");

        // Keep the WhatsApp engine + localhost API alive while the app is closed.
        ensureNotificationPermission();
        try {
            startForegroundService(new Intent(this, VyaparService.class));
        } catch (Exception e) {
            Toast.makeText(this, "Engine start failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
        requestIgnoreBatteryOptimizations();
    }

    /** Android 13+ requires a runtime grant for the service's status notification;
     *  READ_CONTACTS gives the engine saved names (whatsmeow has no address-book sync). */
    private void ensureNotificationPermission() {
        java.util.List<String> needed = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            needed.add("android.permission.POST_NOTIFICATIONS");
        }
        if (checkSelfPermission("android.permission.READ_CONTACTS")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            needed.add("android.permission.READ_CONTACTS");
        }
        if (!needed.isEmpty()) requestPermissions(needed.toArray(new String[0]), 100);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        for (int i = 0; i < permissions.length; i++) {
            if ("android.permission.READ_CONTACTS".equals(permissions[i])
                    && results[i] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                ContactNames.invalidate(); // retry the (previously failed/denied) load now
            }
        }
    }

    /** OEM battery killers are the #1 way an on-phone engine dies - ask once. */
    private void requestIgnoreBatteryOptimizations() {
        try {
            if (!getSystemService(android.os.PowerManager.class).isIgnoringBatteryOptimizations(getPackageName())) {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName())));
            }
        } catch (Exception e) {
            // Some OEMs hide the intent - user must exempt manually in settings.
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** JavaScript-callable bridge exposed to the WebView. */
    private class NativeBridge {
        @JavascriptInterface
        public void shareOnWhatsApp(String text) {
            if (text == null || text.length() == 0) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Nothing to share", Toast.LENGTH_SHORT).show());
                return;
            }
            try {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text);
                // Prefer WhatsApp specifically
                send.setPackage("com.whatsapp");
                Intent chooser = Intent.createChooser(send, "Share order via");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(chooser);
            } catch (Exception e) {
                // Fallback: generic share
                try {
                    Intent generic = new Intent(Intent.ACTION_SEND);
                    generic.setType("text/plain");
                    generic.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(generic, "Share"));
                } catch (Exception inner) {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                            "No app available to share", Toast.LENGTH_SHORT).show());
                }
            }
        }

        @JavascriptInterface
        public String getAppVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "unknown";
            }
        }

        @JavascriptInterface
        public void openWhatsApp() {
            try {
                Intent launch = getPackageManager().getLaunchIntentForPackage("com.whatsapp");
                if (launch != null) startActivity(launch);
                else runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "WhatsApp not installed", Toast.LENGTH_SHORT).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Could not open WhatsApp", Toast.LENGTH_SHORT).show());
            }
        }

        /** Generic text share (log diagnostics etc.) - no WhatsApp dependency. */
        @JavascriptInterface
        public void shareText(String text) {
            if (text == null || text.length() == 0) return;
            try {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text);
                Intent chooser = Intent.createChooser(send, "Share");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(chooser);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "No app available to share", Toast.LENGTH_SHORT).show());
            }
        }

        /**
         * Native HTTP for the dashboard. Newer WebViews block fetch() from
         * file:// origins (CORS), so all server calls go through here.
         * Returns JSON: {"status":200,"body":"..."} or {"status":0,"error":"..."}.
         */
        @JavascriptInterface
        public void http(String method, String urlStr, String body, String headersJson, String callback) {
            httpExecutor.execute(() -> {
                String result;
                try {
                    HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                    conn.setRequestMethod(method);
                    conn.setConnectTimeout(25000);
                    conn.setReadTimeout(25000);
                    if (headersJson != null && headersJson.length() > 0) {
                        org.json.JSONObject headers = new org.json.JSONObject(headersJson);
                        java.util.Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String key = keys.next();
                            conn.setRequestProperty(key, headers.getString(key));
                        }
                    }
                    if (body != null && body.length() > 0) {
                        conn.setDoOutput(true);
                        conn.setRequestProperty("Content-Type", "application/json");
                        byte[] out = body.getBytes(StandardCharsets.UTF_8);
                        conn.setFixedLengthStreamingMode(out.length);
                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(out);
                        }
                    }
                    int status = conn.getResponseCode();
                    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    StringBuilder sb = new StringBuilder();
                    if (in != null) {
                        try (BufferedReader reader = new BufferedReader(
                                new InputStreamReader(in, StandardCharsets.UTF_8))) {
                            String line;
                            while ((line = reader.readLine()) != null) {
                                sb.append(line).append('\n');
                            }
                        }
                    }
                    result = "{\"status\":" + status + ",\"body\":"
                            + org.json.JSONObject.quote(sb.toString()) + "}";
                } catch (Exception e) {
                    result = "{\"status\":0,\"error\":"
                            + org.json.JSONObject.quote(String.valueOf(e.getMessage())) + "}";
                }
                    final String js = "__vyaparHttpResult('" + callback + "'," + result + ")";
                    runOnUiThread(() -> webView.evaluateJavascript(js, null));
            });
        }
    }
}