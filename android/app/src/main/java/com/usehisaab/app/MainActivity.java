package com.usehisaab.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.usehisaab.app.capture.HisaabCapturePlugin;
import com.usehisaab.app.capture.ShareIntentRewriter;
import com.usehisaab.app.widget.HisaabWidgetPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Local (in-app) plugins must be registered BEFORE super.onCreate,
        // which builds the Capacitor bridge. HisaabWidget lets JS redraw the
        // home-screen widget right after it writes a new snapshot;
        // HisaabCapture is the bank-alert capture bridge.
        registerPlugin(HisaabWidgetPlugin.class);
        registerPlugin(HisaabCapturePlugin.class);
        // A cold start from the share sheet: turn the ACTION_SEND into the
        // /?capture= deep link before the bridge reads the launch intent
        // (App.getLaunchUrl reads getIntent().getData()).
        Intent shared = ShareIntentRewriter.rewrite(getIntent());
        if (shared != null) setIntent(shared);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // Warm start (singleTask): same rewrite, then Capacitor's App plugin
        // fires appUrlOpen with the deep link.
        Intent shared = ShareIntentRewriter.rewrite(intent);
        super.onNewIntent(shared != null ? shared : intent);
    }
}
