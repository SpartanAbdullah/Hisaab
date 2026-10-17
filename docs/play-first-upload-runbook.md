# Hisaab — first AAB to Google Play (founder runbook)

<!-- Generated 2026-09-05 by the Play-readiness audit. Pair it with
docs/play-console-answer-sheet.md for what to paste into each Play form.
Step 0.4 (dropping the placeholder fingerprint) was applied in the same
commit that added this file. -->

FOUNDER RUNBOOK — first AAB to Google Play closed testing (do in this order)

PHASE 0 — Web/Vercel (before touching Play; ~15 min, no code change)
0.1  Vercel → project → Settings → Domains.
     - usehisaab.com: set to serve the deployment directly (no "Redirect to").
     - www.usehisaab.com: set "Redirect to usehisaab.com", 308 permanent.
     Rationale: manifest host, VITE_PUBLIC_APP_URL, canonical/og:url and every generated invite/QR/witness/auth link already use the apex; the DAL verifier won't follow the apex→www 307. Do NOT add www to AndroidManifest.
0.2  Verify from PowerShell:
     curl.exe -sI https://usehisaab.com/.well-known/assetlinks.json   → HTTP 200, content-type: application/json, NO location header
     curl.exe -sI https://www.usehisaab.com/                          → 308, location: https://usehisaab.com/
     curl.exe -sI https://usehisaab.com/privacy  (and /terms, /delete-account, /support) → 200
0.3  Supabase → Authentication → URL Configuration: Site URL = https://usehisaab.com; Redirect URLs include https://usehisaab.com/** . (Auth emails redirect there.)
0.4  Edit public/.well-known/assetlinks.json: delete the "REPLACE_WITH_PLAY_SIGNING_KEY_SHA256" line so only the upload-key fingerprint (0B:B6:45:…:6D:A5) remains. Commit to main, let Vercel deploy, re-run the curl in 0.2.
0.5  Confirm Vercel → Settings → Environment Variables (Production) has VITE_PUBLIC_APP_URL = https://usehisaab.com (no trailing slash) and redeploy if you had to change it.

PHASE 1 — Rebuild the AAB (the one on disk is stale: built 16:51, before the 17:46 sync and the 18:40 glyph fix)
1.1  git checkout main (at a5fe530 or newer). Confirm .env has VITE_PUBLIC_APP_URL=https://usehisaab.com.
1.2  In your own PowerShell, project root:
       npm run build
       npx cap sync android
       cd android
       $env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
       .\gradlew.bat bundleRelease
       cd ..
1.3  Sanity:
       Get-Item android\app\build\outputs\bundle\release\app-release.aab | Select LastWriteTime   → must be just now
       & "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot\bin\keytool.exe" -printcert -jarfile android\app\build\outputs\bundle\release\app-release.aab   → SHA256 must be 0B:B6:45:86:3D:98:A4:E4:91:10:D5:FD:F0:66:34:F4:EA:FE:2D:71:08:77:02:F1:C5:93:5B:82:9D:47:6D:A5
     Keep versionCode 1 / 1.0.0 ONLY for this first upload. After it succeeds, every future AAB must bump versionCode (2, 3, …) in android/app/build.gradle and versionName in build.gradle + package.json.

PHASE 2 — Play Console: create app + upload
2.1  Play Console → Create app: name "Hisaab", default language, App (not game), Free. Declarations: no ads.
2.2  Test and release → Testing → Closed testing → create track (e.g. "Alpha") → Create new release.
2.3  Play App Signing: it is mandatory for AAB — accept "Let Google manage and protect your app signing key" (the default). Your hisaab-upload.jks stays the upload key.
2.4  Upload app-release.aab. Release name 1.0.0 (1). Release notes: short, in en + Roman Urdu. Save (do not roll out yet).
2.5  Immediately: Test and release → Setup → App signing → "App signing key certificate" → copy the SHA-256.

PHASE 3 — Close the assetlinks loop (before any tester installs)
3.1  Add the Play app-signing SHA-256 from 2.5 as the SECOND entry in sha256_cert_fingerprints in public/.well-known/assetlinks.json (keep the upload-key one first). Commit to main, wait for Vercel.
3.2  Verify:
       curl.exe -s https://usehisaab.com/.well-known/assetlinks.json     → both fingerprints present, no placeholder
       Open https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://usehisaab.com&relation=delegate_permission/common.handle_all_urls  → lists com.usehisaab.app with no error
3.3  Only now invite testers. Anyone who installed earlier must update/reinstall (Android verifies at install), or on a dev device: adb shell pm verify-app-links --re-verify com.usehisaab.app ; adb shell pm get-app-links com.usehisaab.app → usehisaab.com: verified.

PHASE 4 — Play Console: app content (must be complete before rollout)
4.1  Policy → App content: Privacy policy = https://usehisaab.com/privacy.
4.2  Ads: No. Target audience: 18+ (adults). News app: No. COVID: No. Government app: No.
4.3  Data safety: collected — email, name, phone (opt-in discovery), financial info entered by the user (transactions/loans/kameti, user-entered, not from bank), photos (receipts, user-provided), device push token, crash logs (Sentry, if DSN set). Data encrypted in transit: yes. Deletion: in-app at Settings → Delete account AND https://usehisaab.com/delete-account (note the refusal rule: shared groups with members / open shared balances must be resolved first — say so on that page). Advertising ID: not collected (verified: no AD_ID permission in the merged manifest). Analytics: PostHog only if the key is set AND user opts in — declare as optional analytics, or leave off if VITE_POSTHOG_KEY is empty in prod.
4.4  Financial features declaration: "My app doesn't provide any financial features" (record-keeping only, no custody, no lending). Kameti = savings rotation among friends, not gambling.
4.5  Content rating (IARC questionnaire): no gambling, no violence → Everyone / PEGI 3.
4.6  Store listing: short/full description from docs/play-store-listing.md AFTER updating the currency line to "all ISO 4217 currencies" (the tracker still says 8); mention online-required for saving (no offline queue); icon 512×512, feature graphic 1024×500, ≥2 phone screenshots (en + ur).
4.7  App access: provide the reviewer test account (RELEASE.md §7) — email + password that works on prod Supabase with email already confirmed and onboarding completed.
4.8  Contact details: support email (support@usehisaab.com), website https://usehisaab.com.

PHASE 5 — Roll out closed test
5.1  Closed testing track → add testers (email list or Google Group; 12+ if this is a new personal developer account — they must stay opted in 14 consecutive days before production access is granted).
5.2  Review release → Start rollout to Closed testing. Share the opt-in link.
5.3  On a tester device after install: tap a WhatsApp invite link (https://usehisaab.com/join/…) → must open Hisaab, not Chrome. Send yourself a push with the app killed → status bar shows the "h" glyph, not a bell. Scan a Connect QR with the phone's camera app → opens Hisaab /u/….
5.4  Supabase → app_config: leave min_supported_version 1.0.0 / code 1 until a build exists that you would force people onto.

FOR EVERY LATER UPLOAD
- Bump versionCode (+1) and versionName in android/app/build.gradle, versionName in package.json → npm run build → npx cap sync android → gradlew.bat bundleRelease → upload. Never reuse a versionCode; assetlinks.json needs no change (same upload key + same Play key).