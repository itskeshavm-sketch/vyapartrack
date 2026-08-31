package com.vyapartrack.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Immersive, edge-to-edge feel
        getWindow().setStatusBarColor(Color.parseColor("#0b3d2e"));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0b0f14"));

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage persistence
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setBackgroundColor(Color.parseColor("#0b0f14"));
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());

        // Expose a tiny native bridge for the dashboard to call:
        //   window.Native.shareOnWhatsApp(text) -> opens WhatsApp
        webView.addJavascriptInterface(new NativeBridge(), "Native");

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        webView.loadUrl("file:///android_asset/dashboard/index.html");
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
    }
}