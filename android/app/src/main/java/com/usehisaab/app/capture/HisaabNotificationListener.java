package com.usehisaab.app.capture;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Telephony;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.text.TextUtils;
import com.usehisaab.app.MainActivity;
import com.usehisaab.app.R;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Android notification access → "Record this?" offers.
 *
 * Reads the notifications other apps post, keeps the ones that look like a
 * bank / wallet transaction alert (AlertHeuristics), queues them on the device
 * (CaptureStore) and posts one Hisaab notification per alert whose tap opens
 * the app at /?capture_id=<id>. The app then shows the CaptureSheet; nothing is
 * recorded until the user taps Record there.
 *
 * Boundaries, on purpose:
 *   - Runs only while the user has switched auto-capture on in Settings
 *     (CaptureStore.isEnabled) AND granted Notification access. The OS grant
 *     alone does nothing.
 *   - Never reads SMS: the default SMS app and the common messaging apps are
 *     excluded by package, so a bank SMS surfaces here only if the user
 *     shares it into Hisaab themselves. This keeps the app outside Play's
 *     READ_SMS policy by construction (docs/play-store-data-safety.md).
 *   - The offer notification carries NO amount, merchant or bank name — the
 *     tray is visible on a locked phone, same rule as the home-screen widget.
 *   - Nothing leaves the phone from here.
 */
public class HisaabNotificationListener extends NotificationListenerService {

    static final String CHANNEL_ID = "capture";
    private static final String OFFER_URL = "https://usehisaab.com/?capture_id=";

    private static final Set<String> MESSAGING_APPS = new HashSet<>(Arrays.asList(
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.android.mms",
        "com.android.messaging",
        "com.whatsapp",
        "com.whatsapp.w4b",
        "org.telegram.messenger",
        "com.facebook.orca",
        "com.facebook.mlite",
        "com.viber.voip",
        "com.imo.android.imoim",
        "com.snapchat.android",
        "com.instagram.android",
        "com.discord",
        "org.thoughtcrime.securesms"
    ));

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            handle(sbn);
        } catch (Exception e) {
            // A listener crash would be restarted by the system and could
            // spam logs; a missed alert is the cheaper failure.
        }
    }

    private void handle(StatusBarNotification sbn) {
        Context ctx = getApplicationContext();
        if (sbn == null || !CaptureStore.isEnabled(ctx)) return;
        String pkg = sbn.getPackageName();
        if (pkg == null || pkg.equals(ctx.getPackageName()) || isMessagingApp(ctx, pkg)) return;
        if (sbn.isOngoing()) return;
        Notification n = sbn.getNotification();
        if (n == null || n.extras == null) return;
        // Group summaries repeat their children's text.
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;

        Bundle extras = n.extras;
        String title = str(extras.getCharSequence(Notification.EXTRA_TITLE));
        String text = str(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        if (text.isEmpty()) text = str(extras.getCharSequence(Notification.EXTRA_TEXT));
        if (text.isEmpty()) {
            CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null && lines.length > 0) text = TextUtils.join("\n", lines);
        }
        if (text.isEmpty()) return;
        if (text.length() > 4000) text = text.substring(0, 4000);

        String combined = title.isEmpty() ? text : title + "\n" + text;
        if (!AlertHeuristics.looksLikeMoneyAlert(combined)) return;

        long now = System.currentTimeMillis();
        if (CaptureStore.seenRecently(ctx, (pkg + "|" + combined).hashCode(), now)) return;

        String id = CaptureStore.enqueue(ctx, pkg, title, text, sbn.getPostTime());
        postOffer(ctx, id);
    }

    private static boolean isMessagingApp(Context ctx, String pkg) {
        if (MESSAGING_APPS.contains(pkg)) return true;
        try {
            String defaultSms = Telephony.Sms.getDefaultSmsPackage(ctx);
            return defaultSms != null && defaultSms.equals(pkg);
        } catch (Exception e) {
            return false;
        }
    }

    private static String str(CharSequence cs) {
        return cs == null ? "" : cs.toString().trim();
    }

    private static void postOffer(Context ctx, String id) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, ctx.getString(R.string.capture_channel_name), NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(channel);
            b = new Notification.Builder(ctx, CHANNEL_ID);
        } else {
            b = new Notification.Builder(ctx);
        }

        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(OFFER_URL + Uri.encode(id)), ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(
            ctx, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        String title = CaptureStore.labelTitle(ctx);
        String body = CaptureStore.labelBody(ctx);
        if (title == null) title = ctx.getString(R.string.capture_notif_title);
        if (body == null) body = ctx.getString(R.string.capture_notif_body);

        b.setSmallIcon(R.drawable.ic_stat_hisaab)
            .setColor(ctx.getColor(R.color.hisaab_notification))
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER);

        nm.notify(id.hashCode(), b.build());
    }

    /** Dismiss the offer once the app has taken the candidate. */
    static void cancelOffer(Context ctx, String id) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && id != null) nm.cancel(id.hashCode());
    }
}
