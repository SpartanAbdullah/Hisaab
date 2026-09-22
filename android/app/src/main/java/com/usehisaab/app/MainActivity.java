package com.usehisaab.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.usehisaab.app.widget.HisaabWidgetPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Local (in-app) plugins must be registered BEFORE super.onCreate,
        // which builds the Capacitor bridge. HisaabWidget lets JS redraw the
        // home-screen widget right after it writes a new snapshot.
        registerPlugin(HisaabWidgetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
