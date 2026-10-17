# Bank-alert capture — share sheet + Android notification listener

Added 2026-10-17 (founder: "whenever user receives an email about the transaction, our app
records it, or offers to record it" — decision: **offers**, never records silently).

## What ships

| Route | How the text reaches Hisaab | Permission | Platforms |
|---|---|---|---|
| **Share to Hisaab** | User selects/shares a bank email, SMS, WhatsApp or app message → "Record in Hisaab" in the share sheet → `MainActivity` rewrites `ACTION_SEND` into `https://usehisaab.com/?capture=<text>` (`ShareIntentRewriter.java`) → `App.tsx` opens `CaptureSheet` | none | Android now; iOS later via a share extension |
| **Auto-capture** | `HisaabNotificationListener` (Notification access) sees a bank/wallet app's or mail app's notification, keeps it if it looks like a money alert (`AlertHeuristics`), queues it on-device (`CaptureStore`) and posts "Record this transaction?" → tap opens `/?capture_id=<id>` → `App.tsx` takes it from the queue → `CaptureSheet` | `BIND_NOTIFICATION_LISTENER_SERVICE` (user grants on Android's page) + the app's own notification permission | Android only |

Both end in the same place: `src/components/CaptureSheet.tsx` shows what the parser understood
and hands a prefilled preset to **Quick Entry**. Quick Entry remains the only place money is
written, with all its guards (both app modes, account currency, overpayment, undo).

## The parser (`src/lib/bankAlertParser.ts`, tested)

Keyword heuristics for English alerts from UAE / Pakistan / Gulf banks and wallets:
amount + currency (`AED`, `Dhs`, `Rs.`, `PKR`, `SAR`, `$`, any ISO code), direction
(debit/credit words; "credit card" is not a credit), merchant (`at X`, `to/from X`,
`Merchant: X`), card/account last-4, date (DD/MM order), balance-after.

Refuses (returns null): OTPs / verification codes, declined / failed / insufficient-funds,
future tense ("will be debited", "payment due", "minimum due"), balance-only messages.

`src/lib/captureOffer.ts` matches the account **conservatively**: last-4 must match exactly one
live account *in the same currency*; without digits, only an unambiguous single account in
that currency. Anything else → the user picks in Quick Entry. A wrong account moves money in
the wrong book silently, so ambiguity never guesses.

**Real samples are the next step.** The templates in `bankAlertParser.test.ts` are shapes, not
verbatim bank copy. Founder to supply ~10 alerts per bank (ENBD, Mashreq, CBD, Emirates
Islamic, RAK, Wio, HBL, Meezan, JazzCash, Easypaisa) with amounts redacted; each becomes a
test case and, where needed, a rule.

## Privacy and Play policy

- **Never SMS.** The listener excludes the default SMS app (`Telephony.Sms.getDefaultSmsPackage`)
  and a list of messaging apps by package, so a bank SMS is never read automatically; the user
  can still share one in by hand. This keeps Hisaab outside Play's READ_SMS / SMS-based money
  management declaration entirely (the September research in memory: founder declined SMS).
- **Prominent disclosure** before the OS page, every time the switch goes on
  (`SettingsPage` → `capture_disclosure_*`): what is read, what is excluded, nothing uploaded
  until Record, off any time. This is what Play's "Permissions and APIs that Access Sensitive
  Information" policy asks of Notification-access apps.
- **On-device only.** `CaptureStore` is private SharedPreferences, excluded from backup
  (`allowBackup=false`). Candidates are removed when taken, on sign-out
  (`teardownCapture()` in the auth store's device teardown), or after 20 newer ones.
- **The tray shows no money.** The offer notification carries no amount, merchant or bank —
  same rule as the home-screen widget (lock-screen visible).
- **Telemetry** (`capture_offered`, `capture_resolved`, `capture_listener_toggled`) never
  carries the text, amount or merchant.
- **Data Safety form:** no new *collected* data type — the raw alert never leaves the device,
  and a recorded transaction is already disclosed under *Financial info → Other financial info*
  as user-entered. `docs/play-store-data-safety.md` §1.2 "Messages → Emails / SMS" row now
  explains the on-device reading. Privacy policy (`PublicInfoPages.tsx`) has the matching bullet.

## Device checklist (founder, after the AAB rebuild)

1. Share a bank SMS from Messages → "Record in Hisaab" → sheet shows amount, direction, card
   match → Record → Quick Entry prefilled → save.
2. Settings → Auto-capture → disclosure → Continue → Android list → switch Hisaab on → back:
   the row reads ON (no reload).
3. Trigger a bank app / Gmail notification with a transaction → "Record this transaction?"
   appears (no amount in the tray) → tap → sheet. Tap the same notification again after
   recording → "That alert is no longer available."
4. Receive a bank SMS with auto-capture on → **no** offer (SMS excluded).
5. An OTP email → no offer. A declined-transaction alert → no offer.
6. Sign out → Settings shows the switch OFF for the next account; no stale offers.
7. Switch language → the offer notification's text follows on the next alert.

---

## Route 3 — forward a bank email to your own Hisaab address (2026-10-18)

The cross-platform route (iOS, desktop mail, any phone). Each user has a private address
`hisaab-<token>@in.usehisaab.com` (Settings → Capture from email). A mail forwarded there — by
hand or by a Gmail/Outlook filter — reaches the `inbound-email` edge function through the
inbound-mail provider's webhook, which calls `_capture_candidate_received()` with the service
role. The database queues one `capture_candidates` row (text only, HTML stripped, ≤ 8000 chars)
and writes one `capture_email` notification (money channel, reader's language, **no amount or
subject in the tray**) whose tap opens `/?capture_email=<id>` → the same `CaptureSheet` → Quick
Entry. The client parses with the same `bankAlertParser`; the server never interprets money.

| Piece | Where |
|---|---|
| Tables, RPCs, guard trigger, flood cap, prune + cron | `supabase-migration-email-capture.sql` (PENDING manual apply, then re-run the grants sweep) |
| Allow-list of the two client RPCs | `supabase-migration-p3-rpc-execute-grants.sql` `v_client_rpcs` |
| Webhook function | `supabase/functions/inbound-email/index.ts` |
| Payload normaliser (Postmark JSON, Mailgun/SendGrid form posts, generic JSON) | `supabase/functions/_shared/inboundEmail.ts` (tested from `src/lib/inboundEmail.test.ts`) |
| Address helper, URL param, client data access | `src/lib/captureAddress.ts`, `src/lib/captureOffer.ts`, `captureDb` in `src/lib/supabaseDb.ts` |
| Settings row, sheet source, inbox icon, notification keys | `SettingsPage.tsx`, `CaptureSheet.tsx`, `InboxPage.tsx`, `notificationContent.ts` |
| DB test | `supabase/tests/tests/8td-email-capture.sql` |

**Privacy, deliberately different from routes 1–2:** the forwarded text is stored server-side.
Data Safety "Messages → Emails" is therefore **Collected = Yes, not shared, optional**
(`docs/play-store-data-safety.md`), the privacy policy has the matching bullet, and retention is
enforced by `prune_capture_candidates()` nightly: 7 days after recorded/dismissed, 30 days if
never opened. Rotating the address kills the old one on the next message. A per-user flood cap
(60 per rolling day) stops a runaway filter or a leaked address from filling the inbox.

### Runbook (founder) — bring the route live

1. **Provider account.** Postmark is the reference (inbound JSON webhook, basic-auth URL). Create
   a server, open *Inbound* and set the inbound domain to `in.usehisaab.com`.
2. **DNS (Vercel → Domains → usehisaab.com → DNS records).** Add the MX record Postmark shows for
   `in` (host `in`, value `inbound.postmarkapp.com`, priority 10). Verify in Postmark. Nothing
   else on the apex changes — mail to `@usehisaab.com` is unaffected.
3. **Deploy the function + secret** (project ref `nnhwxjrgxsefywalwvaq`):
   ```bash
   supabase functions deploy inbound-email --no-verify-jwt
   supabase secrets set INBOUND_EMAIL_SECRET="$(openssl rand -hex 32)"
   ```
4. **Webhook URL in Postmark** (Inbound → Webhook):
   `https://hisaab:<INBOUND_EMAIL_SECRET>@nnhwxjrgxsefywalwvaq.functions.supabase.co/inbound-email`
   (basic auth; the function also accepts the `x-hisaab-inbound-secret` header for providers that
   allow custom headers). Tick "include raw email content" OFF — only the parsed fields are used.
5. **Apply the migration** in Studio, re-run `supabase-migration-p3-rpc-execute-grants.sql`, and
   confirm `capture_config.inbound_domain` = `in.usehisaab.com` (change it there if the domain
   differs — the app composes the address from that row).
6. **Test:** Settings → Capture from email → Copy. Forward any bank alert to it from your own
   mailbox. Within a few seconds: a "Record this bank email?" push/inbox row → tap → sheet shows
   the parsed amount → Record → Quick Entry prefilled. Forward the same mail again after
   recording: a second candidate (that is correct — it is a new email). Make a new address and
   forward to the OLD one: nothing arrives.
7. **Gmail filter for users** (the in-app tip): Settings → Filters → Create → From: the bank's
   sender → "Forward it to" the Hisaab address (Gmail asks to verify a forwarding address the
   first time; Hisaab does not click confirmation links, so the user must use the
   "Forward it to" flow with their address already verified, or forward by hand).
   > Open item: Gmail's forwarding-address verification sends a code to the address. Decide
   > whether the function should surface that code to the user (a `capture_email` notification
   > with the code in the body) so auto-forwarding can be set up without manual forwarding.
   > Not built; manual forwarding works today.
8. **Data Safety form + privacy page** must be updated in Play Console before the build that
   ships this route reaches testers (the policy text is already in the app).

### Device / web checklist for this route

- Settings shows the address, Copy works, "New address" asks first and changes it.
- Before the migration is applied the row says "not switched on yet" rather than erroring.
- A forwarded email with an OTP → sheet refuses ("Won't record this"); a declined-transaction
  mail → refuses; a balance-only mail → "Couldn't read an amount" with Enter by hand.
- Tap the same notification on a second device after recording → "no longer here".
