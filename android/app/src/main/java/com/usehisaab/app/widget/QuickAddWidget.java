package com.usehisaab.app.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import com.usehisaab.app.MainActivity;
import com.usehisaab.app.R;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONObject;

/**
 * Home-screen widget for the daily-logging habit: a one-line status for today
 * plus "Add expense" and "Close today" buttons.
 *
 * PRIVACY: the widget is visible to anyone who looks at the phone. It shows
 * only what JS put in the snapshot — today's entry COUNT and the close streak
 * (src/lib/widgetSnapshot.ts). Never add amounts, balances, payees or names.
 *
 * Data: JS writes a JSON snapshot with @capacitor/preferences, which stores it
 * in the SharedPreferences file "CapacitorStorage" under "widget_snapshot".
 * All text in it is already localized in the user's in-app language; the
 * English string resources are only the fallback before the app has run (or
 * after sign-out, which removes the snapshot).
 *
 * Buttons are explicit ACTION_VIEW intents at MainActivity carrying the same
 * https URLs as the launcher shortcuts (res/xml/shortcuts.xml); Capacitor's
 * App plugin hands them to JS (getLaunchUrl cold / appUrlOpen warm).
 */
public class QuickAddWidget extends AppWidgetProvider {

    private static final String PREFS_FILE = "CapacitorStorage";
    private static final String SNAPSHOT_KEY = "widget_snapshot";
    private static final String URL_ADD_EXPENSE = "https://usehisaab.com/?add=expense";
    private static final String URL_CLOSE_TODAY = "https://usehisaab.com/?close=today";

    private static final int REQUEST_OPEN = 7101;
    private static final int REQUEST_ADD = 7102;
    private static final int REQUEST_CLOSE = 7103;

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        RemoteViews views = buildViews(context);
        for (int appWidgetId : appWidgetIds) {
            appWidgetManager.updateAppWidget(appWidgetId, views);
        }
    }

    /** Redraw every placed instance now (called by HisaabWidgetPlugin). */
    public static void refreshAll(Context context) {
        Context app = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        if (manager == null) {
            return;
        }
        int[] ids = manager.getAppWidgetIds(new ComponentName(app, QuickAddWidget.class));
        if (ids == null || ids.length == 0) {
            return;
        }
        RemoteViews views = buildViews(app);
        for (int id : ids) {
            manager.updateAppWidget(id, views);
        }
    }

    private static RemoteViews buildViews(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_quick_add);

        String status = context.getString(R.string.widget_status_neutral);
        String addLabel = context.getString(R.string.widget_add_expense);
        String closeLabel = context.getString(R.string.widget_close_today);
        boolean showClose = true;

        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE);
            String json = prefs.getString(SNAPSHOT_KEY, null);
            if (json != null) {
                JSONObject snap = new JSONObject(json);
                String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
                String day = snap.optString("day", "");
                String neutral = snap.optString("neutral", "");
                if (neutral.length() > 0) {
                    status = neutral;
                }
                // A snapshot from an earlier day describes a finished day —
                // show the neutral prompt until the app writes today's.
                String snapStatus = snap.optString("status", "");
                if (today.equals(day) && snapStatus.length() > 0) {
                    status = snapStatus;
                }
                String add = snap.optString("addLabel", "");
                if (add.length() > 0) {
                    addLabel = add;
                }
                String close = snap.optString("closeLabel", "");
                if (close.length() > 0) {
                    closeLabel = close;
                }
                showClose = snap.optBoolean("showClose", true);
            }
        } catch (Exception e) {
            // Malformed snapshot: fall back to the neutral English defaults.
        }

        views.setTextViewText(R.id.widget_status, status);
        views.setTextViewText(R.id.widget_add, addLabel);
        views.setTextViewText(R.id.widget_close, closeLabel);
        views.setViewVisibility(R.id.widget_close, showClose ? View.VISIBLE : View.GONE);

        views.setOnClickPendingIntent(R.id.widget_header, openAppIntent(context));
        views.setOnClickPendingIntent(R.id.widget_add, deepLinkIntent(context, URL_ADD_EXPENSE, REQUEST_ADD));
        views.setOnClickPendingIntent(R.id.widget_close, deepLinkIntent(context, URL_CLOSE_TODAY, REQUEST_CLOSE));
        return views;
    }

    private static PendingIntent openAppIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(
            context,
            REQUEST_OPEN,
            intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    private static PendingIntent deepLinkIntent(Context context, String url, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url), context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
    }
}
