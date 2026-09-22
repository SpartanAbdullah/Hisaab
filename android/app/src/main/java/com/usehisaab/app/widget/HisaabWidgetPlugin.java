package com.usehisaab.app.widget;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS bridge for the home-screen widget (src/lib/widgetBridge.ts). JS writes
 * the snapshot through @capacitor/preferences first, then calls refresh() so
 * every placed widget redraws now instead of at the next 30-minute update.
 */
@CapacitorPlugin(name = "HisaabWidget")
public class HisaabWidgetPlugin extends Plugin {

    @PluginMethod
    public void refresh(PluginCall call) {
        try {
            QuickAddWidget.refreshAll(getContext());
        } catch (Exception e) {
            // A widget redraw must never surface as an app error; the
            // periodic update will catch up.
        }
        call.resolve();
    }
}
