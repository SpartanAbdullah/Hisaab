# Updating & Releasing the Hisaab Android App

How to ship updates **after the first release**. (For the very first publish — keystore,
Play Console setup, store listing, testing — see [`RELEASE.md`](../RELEASE.md) and
[`play-store-launch-tracker.md`](play-store-launch-tracker.md).)

---

## The mental model (it's not like Vercel)

The **web app** updates like you're used to: push → Vercel rebuilds → users get it on next load.

The **Android app** is a **native package (an `.aab`)** installed on the phone that **bundles a copy
of your web app inside it**. Pushing code does **not** automatically reach installed phones — you
rebuild the package and re-publish (or push an over-the-air web update; see Part B).

### Two kinds of changes

| Change type | Examples | How it ships |
|---|---|---|
| **Web-only** (≈95% of work) | React / TypeScript / CSS — features, copy, styling, bug fixes | New `.aab` release **or** over-the-air (Part B) |
| **Native** (rare) | New Capacitor plugin, new Android permission, Capacitor version bump, app icon/splash, app name, `targetSdk` | **Must** be a new Play Store release (Part A) |

---

## Part A — Standard release (always works; required for native changes)

Do this whenever you want to publish an update to the Play Store.

### 1. Bump the version
Play **rejects** an upload that reuses a `versionCode`. Every release needs a strictly higher one.

Edit **`android/app/build.gradle`**:
```gradle
versionCode 2          // was 1 — increase by 1 every release, never reset
versionName "1.0.1"    // user-facing, any string; follow semver
```
Edit **`package.json`** to match the versionName:
```json
"version": "1.0.1"
```

### 2. Build the signed AAB
Run in your **own PowerShell terminal**, in the project root
(`C:\personal\Hisaab-2.0`):

```powershell
npm run build
npx cap sync android
cd android
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
.\gradlew.bat bundleRelease
cd ..
```

Output: `android\app\build\outputs\bundle\release\app-release.aab`

> **Why a separate JDK (2026-10-17):** the Android Studio bundled runtime is now Java 25 and
> Gradle 8.14.3 refuses it ("Unsupported class file major version 69"). Temurin 21 was installed with
> `winget install --id EclipseAdoptium.Temurin.21.JDK -e`; if the version folder differs, point
> `JAVA_HOME` at whatever `C:\Program Files\Eclipse Adoptium\jdk-21*` exists. The Android SDK itself
> comes from Android Studio > SDK Manager (Platform 36, Build-Tools, Platform-Tools) at the path in
> `android/local.properties`.

> The signing is automatic — Gradle reads `android/keystore.properties` (your upload key).
> That file and `android/app/hisaab-upload.jks` are **git-ignored**; keep your offline backup safe.
> If you lose the keystore, you can never update the app again.
> See `docs/ops-checklist.md` §1 for the backup-location and restore-verification steps —
> a backup you haven't restored-and-tested with `keytool` is a hope, not a backup.

### 3. (Optional) Verify it's signed with your upload key
```powershell
& "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot\bin\keytool.exe" -printcert -jarfile android\app\build\outputs\bundle\release\app-release.aab
```
The `Owner:` line should be **your** cert (`CN=abdullah …`), not `CN=Android Debug`.

### 4. Upload to Play Console
- Play Console → your app → **Production** (or a testing track) → **Create new release**.
- Drop in `app-release.aab`.
- Write release notes (what changed).
- **Save → Review release → Roll out**.

### 5. Rollout
Users get the update automatically via the Play Store (auto-update is on by default, usually within
a day). You can do a **staged rollout** (e.g. 20% → 50% → 100%) and watch crash-free metrics in
Play Console → Quality → Android vitals.

For a release that also ships a database migration or a coordinated web deploy, follow
`docs/release-and-rollback.md` instead of freelancing the ordering — it covers the full
apply-migrations → deploy-web → staged-rollout → raise-the-`app_config`-floor sequence, and
what "halting" a rollout can and can't undo.

---

## Part B — Over-the-air web updates (optional, post-launch)

Because the app is web-assets-in-a-wrapper, you can push **web-only** changes straight to installed
phones with **no Play Store round-trip** — the Vercel-style instant update.

- **Tools:** [Capgo](https://capgo.app) (open-source, affordable — the popular Capacitor choice) or
  Ionic **Appflow Live Updates** (official, paid).
- **How it works:** on launch the app checks an update server, downloads the new web bundle, and
  applies it — no new `.aab`, no review.

### The rules (important)
- Only **JS / HTML / CSS** can go over-the-air. **Native** changes (plugins, permissions, Capacitor
  upgrade, icon, `targetSdk`) still require a **full Play release** (Part A).
- Google Play **allows** OTA updates of interpreted web code, **as long as** you don't change the
  app's core purpose or use it to bypass review for policy-violating content. Stay within your
  stated purpose and you're fine.
- Set this up **after** v1 is stable — it's not needed to launch.

See `docs/release-and-rollback.md` §6 for the full Capgo-vs-Appflow evaluation (recommendation:
Capgo, once the P0 SQL/client remediation batch has stabilized and at least one full Play release
cycle has run cleanly — not before) and how OTA relates to the `app_config` version-floor kill
switch (`src/lib/versionGate.ts`) — they solve different problems and neither replaces the other.

---

## Version numbering reference

| Field | File | Rule |
|---|---|---|
| `versionCode` | `android/app/build.gradle` | Integer. **Strictly increasing** every upload (1, 2, 3 …). Never reset or reuse. |
| `versionName` | `android/app/build.gradle` | User-facing string, e.g. `1.0.1`. Follow [semver](https://semver.org). |
| `version` | `package.json` | Keep equal to `versionName`. |

---

## Cheat sheet

```powershell
# 1. bump versionCode + versionName in android/app/build.gradle (and package.json)

# 2. build the signed bundle (in your own terminal)
npm run build
npx cap sync android
cd android
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
.\gradlew.bat bundleRelease
cd ..

# 3. upload android\app\build\outputs\bundle\release\app-release.aab to Play Console
```

To test a change on a device **without** publishing: `npx cap open android` → press ▶ Run.

---

## Gotchas / notes for this machine

- **Build in your own terminal**, not via an agent/CI sandbox that blocks loopback sockets — Gradle's
  engine needs a localhost socket and will fail with *"Unable to establish loopback connection"* in
  restricted environments. Your normal PowerShell window is fine.
- `JAVA_HOME` isn't set globally; the commands above point it at Android Studio's bundled JDK for the
  session. (Or set it permanently in System → Environment Variables.)
- The first `gradlew` run after a clean checkout downloads the Gradle toolchain — give it a few minutes.
- New Android Studio? Re-open the `android` folder and let it sync; `local.properties` (SDK path) and
  the keystore files are git-ignored, so re-create `keystore.properties` from your backup if you move
  machines.
- If a build complains about **SDK licenses**, run Android Studio → SDK Manager and accept them, or
  `sdkmanager --licenses`.

---

## Quick decision guide

- **Changed only React/TS/CSS and want it live fast?** → Part A now; consider Part B (OTA) for the future.
- **Added a plugin / permission / icon / bumped Capacitor?** → Part A (full Play release), no shortcuts.
- **Just want to see a change on your phone?** → `npx cap open android` → ▶ Run (no release needed).
