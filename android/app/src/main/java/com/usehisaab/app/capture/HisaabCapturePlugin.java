package com.usehisaab.app.capture;

import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * JS bridge for bank-alert capture (src/lib/captureBridge.ts).
 *
 *   getStatus    → { granted, enabled }  — OS Notification access + in-app opt-in
 *   setEnabled   → persists the opt-in and the localised notification text
 *   openSettings → Android's Notification-access page (Hisaab's row on 11+)
 *   take         → removes + returns one queued candidate (cancels its offer)
 *   clear        → drops the queue (sign-out)
 */
@CapacitorPlugin(name = "HisaabCapture")
public class HisaabCapturePlugin extends Plugin {

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", isListenerGranted(getContext()));
        r.put("enabled", CaptureStore.isEnabled(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        CaptureStore.setEnabled(getContext(), enabled);
        JSObject labels = call.getObject("labels");
        if (labels != null) {
            CaptureStore.setLabels(getContext(), labels.getString("title"), labels.getString("body"));
        }
        call.resolve();
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Context ctx = getContext();
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            intent.putExtra(
                Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                new ComponentName(ctx, HisaabNotificationListener.class).flattenToString());
        } else {
            intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            // Some OEM builds lack the per-app page; fall back to the list.
            try {
                Intent list = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(list);
            } catch (ActivityNotFoundException ignored) {
                // Nothing more to try; the JS hint tells the user where to look.
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void take(PluginCall call) {
        String id = call.getString("id");
        JSONObject c = CaptureStore.take(getContext(), id);
        JSObject r = new JSObject();
        r.put("found", c != null);
        if (c != null) {
            JSObject candidate = new JSObject();
            candidate.put("id", c.optString("id"));
            candidate.put("text", c.optString("text"));
            candidate.put("title", c.isNull("title") ? null : c.optString("title"));
            candidate.put("packageName", c.isNull("packageName") ? null : c.optString("packageName"));
            candidate.put("postedAt", c.optLong("postedAt"));
            r.put("candidate", candidate);
            HisaabNotificationListener.cancelOffer(getContext(), id);
        }
        call.resolve(r);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        CaptureStore.clear(getContext());
        call.resolve();
    }

    /** Framework-only check (no androidx dependency): the colon-separated list
     *  of enabled listener components names our package. */
    static boolean isListenerGranted(Context ctx) {
        String flat = Settings.Secure.getString(ctx.getContentResolver(), "enabled_notification_listeners");
        if (flat == null || flat.isEmpty()) return false;
        String pkg = ctx.getPackageName();
        for (String entry : flat.split(":")) {
            ComponentName cn = ComponentName.unflattenFromString(entry);
            if (cn != null && pkg.equals(cn.getPackageName())) return true;
        }
        return false;
    }
}
