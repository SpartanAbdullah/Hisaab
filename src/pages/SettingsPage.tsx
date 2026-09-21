import { useEffect, useRef, useState } from "react";
import { Unlock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useSupabaseAuthStore } from "../stores/supabaseAuthStore";
import { NavyHero, TopBar } from "../components/NavyHero";
import { UserAvatar } from "../components/UserAvatar";
import { LanguageToggle } from "../components/LanguageToggle";
import { Glyph } from "../components/Glyph";
import type { GlyphName, GlyphTone } from "../lib/glyphs";
import { useAppModeStore } from "../stores/appModeStore";
import { useAccountStore } from "../stores/accountStore";
import { useAuthStore } from "../stores/authStore";
import { useToast } from "../components/Toast";
import { isNativeRuntime } from "../lib/runtime";
import { enableRemindersFlow, remindersEnabled, rescheduleNotifications, REMINDERS_KEY } from "../lib/notificationScheduler";
import { requestPushPermissionAndRegister } from "../lib/pushRegistration";
import { MyPhoneField, PhoneDiscoverySection } from "../components/PhoneDiscoverySection";
import { TelemetryConsentToggle } from "../components/TelemetryConsentToggle";
import { FeedbackCard } from "../components/FeedbackCard";
import { useBlockStore } from "../stores/blockStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePersonStore } from "../stores/personStore";
import { useSubmitGuard } from "../lib/useSubmitGuard";
import { confirmDestructive } from "../components/ConfirmDestructiveSheet";
import { ManageCategoriesModal } from "../components/ManageCategoriesModal";
import { useThemeStore, type ThemeMode } from "../stores/themeStore";
import { useT, useI18nStore } from "../lib/i18n";
import { validatePassword, PASSWORD_MIN_LENGTH } from "../lib/passwordPolicy";
import { exportAllData, importData, downloadJSON } from "../lib/dataExport";
import { phoneDiscoveryDb, profilesDb } from "../lib/supabaseDb";
import { supabase } from "../lib/supabase";
import {
  LEGACY_MOBILE_KEY,
  discoverableForSave,
  legacyPhoneDraft,
  readMyPhone,
  type MyPhone,
} from "../lib/myPhone";
import {
  buildAppShareUrl,
  generatePublicCodeCandidate,
  normalizePublicCode,
} from "../lib/collaboration";

function copyWithTextareaFallback(text: string): Promise<void> {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  } finally {
    document.body.removeChild(textarea);
  }
}

// Quiet hours are stored as whole local hours (0-23) per
// docs/notifications.md §3 — `notification_prefs.quiet_hours_start/_end`.
// The pickers are <input type="time">, which round-trips "HH:MM"; only the
// hour is kept, on the minute-precision-would-lie-about-what's-stored theory.
const DEFAULT_QUIET_START_HOUR = 22;
const DEFAULT_QUIET_END_HOUR = 7;

function hourToTimeInput(hour: number | null, fallback: number): string {
  const h = hour ?? fallback;
  return `${String(h).padStart(2, "0")}:00`;
}

function timeInputToHour(value: string): number | null {
  const match = /^(\d{1,2}):/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function copyShareText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithTextareaFallback(text));
  }

  return copyWithTextareaFallback(text);
}

// The old My Account "Mobile" field only ever wrote this device's
// localStorage (never the server). Read it once: while the server holds no
// number it seeds the "Add" draft; otherwise the server's number — the one
// discovery actually uses — wins and the leftover is dropped.
function takeLegacyPhoneDraft(phone: MyPhone | null): string {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_MOBILE_KEY);
  } catch {
    /* storage off */
  }
  const seed = legacyPhoneDraft(legacy, phone);
  if (phone && !seed) clearLegacyPhone();
  return seed;
}

function clearLegacyPhone() {
  try {
    localStorage.removeItem(LEGACY_MOBILE_KEY);
  } catch {
    /* storage off */
  }
}

// Audit C2 (client half): `delete_current_user` refuses to run when the caller
// still owns groups that have other members, RAISEing with this marker and a
// detail listing the group names. Without mapping, the user sees a raw Postgres
// string. Everything the driver gives us is searched — PostgrestError splits the
// RAISE across message/details/hint depending on how it was thrown.
const OWNED_GROUPS_MARKER = "OWNED_GROUPS_WITH_MEMBERS";

// Founder decision D1 (2026-09-04, supabase-migration-p3-account-deletion-
// balance-gate.sql): the same RPC also refuses while the caller has a non-zero
// net position in a shared group that still has a counterparty — the rule
// leave_group already applies. DETAIL is a server-composed English list
// ("Flatmates: owes AED 20.00; Trip: is owed PKR 1,500.00"), shown as
// supporting detail under localized copy, the GROUP_HAS_OUTSTANDING_BALANCES
// convention.
const UNSETTLED_BALANCES_MARKER = "UNSETTLED_GROUP_BALANCES";

function readUnsettledBalancesBlocker(error: unknown): { blocked: boolean; detail: string } {
  const parts: string[] = [];
  if (typeof error === "string") {
    parts.push(error);
  } else if (error && typeof error === "object") {
    for (const key of ["message", "details", "hint", "code"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  if (!parts.join(" | ").includes(UNSETTLED_BALANCES_MARKER)) return { blocked: false, detail: "" };
  const details =
    error && typeof error === "object" && typeof (error as Record<string, unknown>).details === "string"
      ? ((error as Record<string, unknown>).details as string).trim()
      : "";
  return { blocked: true, detail: details.includes(UNSETTLED_BALANCES_MARKER) ? "" : details };
}

// ── 1d row anatomy (handoff §5 Settings) ────────────────────────────────
// Every row: a 36px raised control square holding a toned 3c glyph, a
// 13.5px/600 title over an 11px ink-600 subtitle, and a chevron glyph when the
// row navigates. Hoisted so the page body stays a list of rows.
function RowIcon({ glyph, tone }: { glyph: GlyphName; tone: GlyphTone }) {
  return (
    <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0" aria-hidden>
      <Glyph name={glyph} tone={tone} size={18} />
    </div>
  );
}

function RowText({ title, sub, danger = false }: { title: React.ReactNode; sub?: React.ReactNode; danger?: boolean }) {
  return (
    <div className="flex-1 min-w-0">
      <p className={`text-[13.5px] font-semibold tracking-[-0.005em] ${danger ? "text-pay-text" : "text-ink-900"}`}>
        {title}
      </p>
      {sub ? <p className="text-[11px] text-ink-600 mt-0.5 leading-snug">{sub}</p> : null}
    </div>
  );
}

function RowChevron({ open = false, danger = false }: { open?: boolean; danger?: boolean }) {
  return (
    <Glyph
      name="chevron-right"
      size={15}
      className={`transition-transform ${danger ? "text-pay-text" : "text-ink-400"} ${open ? "rotate-90" : ""}`}
    />
  );
}

function readOwnedGroupsBlocker(error: unknown): { blocked: boolean; names: string } {
  const parts: string[] = [];
  if (typeof error === "string") {
    parts.push(error);
  } else if (error && typeof error === "object") {
    for (const key of ["message", "details", "hint", "code"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  const blob = parts.join(" | ");
  const at = blob.indexOf(OWNED_GROUPS_MARKER);
  if (at === -1) return { blocked: false, names: "" };
  // The RPC raises the marker as the message and puts the comma-separated
  // group names in DETAIL (PostgrestError.details). Fall back to whatever
  // trails the marker in the same fragment for other transports.
  const trailing = blob
    .slice(at + OWNED_GROUPS_MARKER.length)
    .split(" | ")[0]
    .replace(/^[\s:;,—–-]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  const details =
    error && typeof error === "object" && typeof (error as Record<string, unknown>).details === "string"
      ? ((error as Record<string, unknown>).details as string).trim()
      : "";
  const names = trailing || (details.includes(OWNED_GROUPS_MARKER) || /joined one of your groups/i.test(details) ? "" : details);
  return { blocked: true, names };
}

export function SettingsPage() {
  const t = useT();
  const toast = useToast();
  const { mode, setMode } = useAppModeStore();
  const { accounts } = useAccountStore();
  const lang = useI18nStore((st) => st.lang);
  const { hasPin, setPin, removePin } = useAuthStore();
  const { signOut, deleteAccount, user } = useSupabaseAuthStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const navigate = useNavigate();
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [exporting, setExporting] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const [dailyQuoteOn, setDailyQuoteOn] = useState(() => localStorage.getItem("hisaab_daily_quote_enabled") !== "false");
  // Payment reminders (Android local notifications). Native-only surface;
  // the toggle drives REMINDERS_KEY and the permission flow.
  const [remindersOn, setRemindersOn] = useState(() => remindersEnabled());
  const [remindersBusy, setRemindersBusy] = useState(false);
  // M5 quiet hours + real push opt-in (docs/notifications.md §8.2, audit N-6).
  // Quiet hours mirror `notification_prefs`' global row through the store;
  // both null (no window configured yet) shows the DEFAULT_QUIET_* fallback
  // in the pickers without writing anything until the user actually changes
  // one — a silent auto-write on first render would surprise a user who never
  // touched this screen.
  const quietHours = useNotificationStore((s) => s.quietHours);
  const loadNotificationPrefs = useNotificationStore((s) => s.loadPrefs);
  const setQuietHoursPref = useNotificationStore((s) => s.setQuietHours);
  const [quietHoursBusy, setQuietHoursBusy] = useState(false);
  // Global mute (docs/notifications.md §8.2) — the group_id-null prefs row.
  // Mode-agnostic like the rest of the notification system (§7): it reads
  // and writes the same global row regardless of full_tracker/splits_only.
  const globalMuted = useNotificationStore((s) => s.globalMuted);
  const setGlobalMutedPref = useNotificationStore((s) => s.setGlobalMuted);
  const [globalMuteBusy, setGlobalMuteBusy] = useState(false);
  // Push permission state — read straight off the Capacitor plugin (native
  // only) rather than duplicating registration logic; pushRegistration.ts
  // already owns the actual register/token flow.
  const [pushPermission, setPushPermission] = useState<"granted" | "denied" | "prompt" | "unknown">("unknown");
  const [pushBusy, setPushBusy] = useState(false);
  const [email] = useState(
    () => user?.email ?? localStorage.getItem("hisaab_email") ?? "",
  );
  // One phone number (founder 2026-09-19 — src/lib/myPhone.ts):
  // `profiles.phone_e164` is its only home. My Account edits it; the
  // discovery card only flips `phone_discoverable` for it, so the two can
  // never disagree. `undefined` while the profile loads (both surfaces hold
  // their place, inert); `null` when the phone columns aren't there
  // (migration not applied) — both are hidden then rather than show a
  // control that silently fails.
  const [myPhone, setMyPhoneState] = useState<MyPhone | null | undefined>(undefined);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneEditing, setPhoneEditing] = useState(false);
  // What the old device-only field held — the starting draft for "Add"
  // while the server has no number (takeLegacyPhoneDraft).
  const [legacyPhone, setLegacyPhone] = useState("");
  const phoneFieldRef = useRef<HTMLDivElement>(null);
  const [newPassword, setNewPassword] = useState("");
  // Re-auth (audit SEC-12): both the password change and the account deletion
  // now demand the CURRENT password. Separate fields so neither flow leaks the
  // other's typed secret into a form the user didn't intend to submit.
  const [currentPassword, setCurrentPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [publicCode, setPublicCode] = useState("");
  // Blocked people (audit M17). Names are resolved from local contacts where a
  // linked row exists; a block can outlive the contact row, so an unresolved id
  // renders as a neutral "Hisaab user" rather than a raw UUID.
  const blocks = useBlockStore((s) => s.blocks);
  const blocksLoading = useBlockStore((s) => s.loading);
  const loadBlocks = useBlockStore((s) => s.loadBlocks);
  const unblock = useBlockStore((s) => s.unblock);
  const persons = usePersonStore((s) => s.persons);
  const loadPersons = usePersonStore((s) => s.loadPersons);
  const unblockGuard = useSubmitGuard();
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteSaving, setDeleteSaving] = useState(false);
  const userName = localStorage.getItem("hisaab_user_name") ?? "";

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    // One read of the profile row serves the phone number and the user code.
    const loadProfile = async () => {
      const profile = await profilesDb.getCurrent();
      if (cancelled) return;

      // The phone first, so it never waits on the public-code write below.
      const phone = readMyPhone(profile);
      setMyPhoneState(phone);
      setLegacyPhone(takeLegacyPhoneDraft(phone));
      if (!profile) return;

      const existing =
        typeof profile.public_code === "string" ? profile.public_code : "";
      if (existing) {
        setPublicCode(existing);
        return;
      }

      const nextCode = generatePublicCodeCandidate();
      await profilesDb.updateCurrent({
        public_code: nextCode,
        public_code_normalized: normalizePublicCode(nextCode),
      });

      if (!cancelled) setPublicCode(nextCode);
    };

    void loadProfile().catch(() => {
      if (cancelled) return;
      setPublicCode("");
      setMyPhoneState((current) => (current === undefined ? null : current));
    });

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Blocked-people list + the contacts that give those ids names. Both stores
  // gate on their own freshness window, so this is cheap on a re-visit.
  useEffect(() => {
    void loadBlocks();
    void loadPersons().catch(() => {});
  }, [loadBlocks, loadPersons]);

  // Notification prefs (quiet hours) — best-effort, tolerates the M5
  // migration not being applied yet (loadPrefs swallows that itself).
  useEffect(() => {
    void loadNotificationPrefs();
  }, [loadNotificationPrefs]);

  // Current push permission, native only. Re-checked after the opt-in button
  // runs so the row reflects what the OS dialog actually decided.
  const refreshPushPermission = async () => {
    if (!isNativeRuntime()) return;
    try {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      const perm = await PushNotifications.checkPermissions();
      const receive = String(perm.receive);
      setPushPermission(receive === "granted" || receive === "denied" || receive === "prompt" ? receive : "unknown");
    } catch {
      setPushPermission("unknown");
    }
  };
  useEffect(() => {
    void refreshPushPermission();
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await exportAllData();
      const date = new Date().toISOString().slice(0, 10);
      downloadJSON(data, `hisaab_backup_${date}.json`);
      toast.show({
        type: "success",
        title: t("settings_export"),
        subtitle: `hisaab_backup_${date}.json`,
      });
    } catch {
      toast.show({ type: "error", title: t("error") });
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = await confirmDestructive({
      title: t("settings_import_warn"),
      description: t('set_import_warn_body'),
      confirmLabel: t('set_import_cta'),
      tone: 'warning',
    });
    if (!ok) {
      e.target.value = "";
      return;
    }
    try {
      const text = await file.text();
      const result = await importData(text);
      if (result.success) {
        toast.show({ type: "success", title: t("settings_import_success") });
        setTimeout(() => window.location.reload(), 1000);
      } else {
        // Audit M8: importData now validates the file before touching a row,
        // so the reason is a localised key ("nothing was deleted") rather than
        // a raw Postgres/JSON error string.
        toast.show({
          type: "error",
          title: t("settings_import_fail"),
          subtitle: t(result.messageKey),
          duration: 7000,
        });
      }
    } catch {
      toast.show({ type: "error", title: t("settings_import_fail") });
    }
    e.target.value = "";
  };

  const handleSetPin = async () => {
    if (pin1.length !== 4 || pin2.length !== 4) return;
    if (pin1 !== pin2) {
      toast.show({ type: "error", title: t("pin_mismatch") });
      return;
    }
    try {
      await setPin(pin1);
    } catch {
      // WebCrypto missing (insecure origin / ancient WebView) — say so instead
      // of claiming a PIN was set, which is the exact false promise the audit
      // flagged in the first place.
      toast.show({ type: "error", title: t("pin_set_failed") });
      return;
    }
    toast.show({ type: "success", title: t("pin_set_success") });
    setShowPinSetup(false);
    setPin1("");
    setPin2("");
  };

  const handleRemovePin = async () => {
    const ok = await confirmDestructive({
      title: t("pin_remove_confirm_title"),
      description: t("pin_remove_confirm_body"),
      confirmLabel: t("pin_remove_confirm_cta"),
      cancelLabel: t("cancel"),
      tone: "warning",
    });
    if (!ok) return;
    removePin();
    toast.show({ type: "success", title: t("pin_removed") });
  };

  // ── The phone number: every write goes through setMyPhone, which stores
  // the number and its findability together (profiles.phone_e164 +
  // phone_discoverable). Online-required like every write: a failure says
  // so and nothing on screen changes.
  const saveMyPhone = async (e164: string) => {
    if (!myPhone) return;
    // First number on file → findable (the editor said so before Save);
    // replacing a number keeps the user's choice.
    const discoverable = discoverableForSave(myPhone);
    const turnedOn = discoverable && !myPhone.discoverable;
    setPhoneBusy(true);
    try {
      await phoneDiscoveryDb.setMyPhone(e164, discoverable);
      setMyPhoneState({ e164, discoverable });
      clearLegacyPhone();
      setLegacyPhone("");
      setPhoneEditing(false);
      toast.show({
        type: "success",
        title: t("disc_my_phone_saved"),
        ...(turnedOn ? { subtitle: t("setph_saved_findable") } : {}),
      });
    } catch {
      toast.show({ type: "error", title: t("setph_save_failed") });
    } finally {
      setPhoneBusy(false);
    }
  };

  const removeMyPhone = async () => {
    setPhoneBusy(true);
    try {
      // No number means unfindable too (setMyPhone forces the flag off).
      await phoneDiscoveryDb.setMyPhone(null, false);
      setMyPhoneState({ e164: null, discoverable: false });
      clearLegacyPhone();
      setLegacyPhone("");
      setPhoneEditing(false);
      toast.show({ type: "success", title: t("disc_my_phone_removed") });
    } catch {
      toast.show({ type: "error", title: t("setph_save_failed") });
    } finally {
      setPhoneBusy(false);
    }
  };

  const setPhoneDiscoverable = async (next: boolean) => {
    const number = myPhone?.e164;
    if (!number) return;
    setPhoneBusy(true);
    try {
      await phoneDiscoveryDb.setMyPhone(number, next);
      setMyPhoneState({ e164: number, discoverable: next });
    } catch {
      toast.show({ type: "error", title: t("setph_save_failed") });
    } finally {
      setPhoneBusy(false);
    }
  };

  // The discovery card's "Add number": open My Account on the number editor
  // and bring it to the middle of the screen (the editor focuses itself).
  const openPhoneEditor = () => {
    setShowProfile(true);
    setPhoneEditing(true);
    requestAnimationFrame(() => {
      phoneFieldRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const handleShareApp = async () => {
    const shareUrl = buildAppShareUrl();
    const shareText = t("settings_share_app_text");

    try {
      if (navigator.share) {
        await navigator.share({
          // Brand name — identical in both languages, not a copy string.
          // eslint-disable-next-line no-restricted-syntax
          title: "Hisaab",
          text: shareText,
          url: shareUrl,
        });
        return;
      }

      await copyShareText(`${shareText}\n${shareUrl}`);
      toast.show({
        type: "success",
        title: t("settings_share_app_copied"),
        subtitle: shareUrl,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.show({ type: "error", title: t("settings_share_app_failed") });
    }
  };

  // Proof-of-identity for the two irreversible actions on this page. With only
  // the anon key, re-signing in with the session's own email is the way to
  // check a password; it mints a fresh session for the SAME user, so nothing
  // else in the app is disturbed. (audit SEC-12 / M2)
  const verifyCurrentPassword = async (
    password: string,
  ): Promise<{ ok: boolean; message: string }> => {
    if (!email) return { ok: false, message: t("reauth_check_failed") };
    if (!password) return { ok: false, message: t("reauth_required") };
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error) return { ok: true, message: "" };
      const text = (error.message ?? "").toLowerCase();
      const wrongPassword =
        error.status === 400 ||
        text.includes("invalid login") ||
        text.includes("credential");
      return {
        ok: false,
        message: wrongPassword ? t("reauth_wrong_password") : t("reauth_check_failed"),
      };
    } catch {
      return { ok: false, message: t("reauth_check_failed") };
    }
  };

  const handlePasswordReset = async () => {
    const policy = validatePassword(newPassword);
    if (!policy.valid) {
      toast.show({
        type: "error",
        title: policy.code === "too_short"
          ? t("password_too_short")
          : t("password_missing_complexity"),
      });
      return;
    }
    setPasswordSaving(true);
    try {
      const reauth = await verifyCurrentPassword(currentPassword);
      if (!reauth.ok) {
        toast.show({ type: "error", title: reauth.message });
        return;
      }
      const { changePassword } = useSupabaseAuthStore.getState();
      await changePassword(newPassword);
      toast.show({ type: "success", title: t("password_updated") });
      setNewPassword("");
      setCurrentPassword("");
      setShowPasswordChange(false);
    } catch {
      toast.show({ type: "error", title: t("password_update_failed") });
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirm !== "DELETE") return;
    setDeleteSaving(true);
    try {
      const reauth = await verifyCurrentPassword(deletePassword);
      if (!reauth.ok) {
        toast.show({ type: "error", title: reauth.message });
        setDeleteSaving(false);
        return;
      }
      await deleteAccount();
      window.location.assign("/");
    } catch (error) {
      // The RPC refuses while the user still owns groups with other members —
      // deleting them would strand everyone else's shared ledger. Tell them
      // exactly which groups, and what to do about it.
      const owned = readOwnedGroupsBlocker(error);
      const unsettled = readUnsettledBalancesBlocker(error);
      if (owned.blocked) {
        toast.show({
          type: "error",
          title: t("del_account_owned_groups_title"),
          subtitle: owned.names
            ? t("del_account_owned_groups_body").replace("{names}", owned.names)
            : t("del_account_owned_groups_generic"),
        });
      } else if (unsettled.blocked) {
        // D1: the same rule as leaving a group — settle first. The server's
        // DETAIL already names each group with the direction and amount.
        toast.show({
          type: "error",
          title: t("del_account_unsettled_title"),
          subtitle: unsettled.detail
            ? t("del_account_unsettled_body").replace("{details}", unsettled.detail)
            : t("del_account_unsettled_generic"),
        });
      } else {
        toast.show({
          type: "error",
          title: t("del_account_failed"),
          subtitle: error instanceof Error ? error.message : t("del_account_retry"),
        });
      }
      setDeleteSaving(false);
    }
  };

  // 1d: a settings group is the standard card surface (lit face + ambient
  // shadow, 18px) holding hairline-divided rows — the group itself is not
  // pressable, so it is a card, never a tile. overflow-hidden keeps the row
  // press-flash clipped to the radius. Shared with PhoneDiscoverySection.
  const sectionClass =
    "m-card overflow-hidden divide-y divide-cream-hairline";
  const rowClass =
    "row-base row-interactive px-4 py-3.5";
  const groupLabelClass = "m-label px-1 pt-3";

  // A window is "on" only when both edges are set and distinct — matches the
  // server's own reading of the global row (docs/notifications.md §3: "Both
  // null, or equal, means no window").
  const quietHoursEnabled =
    quietHours.start !== null && quietHours.end !== null && quietHours.start !== quietHours.end;
  const quietHoursTz =
    quietHours.tz ||
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return "Asia/Karachi";
      }
    })();

  const blockedName = (profileId: string): string =>
    persons.find((p) => p.linkedProfileId === profileId)?.name ?? t('blk_unknown_person');

  const handleUnblock = (profileId: string) => unblockGuard.run(async () => {
    const name = blockedName(profileId);
    const ok = await confirmDestructive({
      title: t('blk_unblock_confirm_title').replace('{name}', name),
      description: t('blk_unblock_confirm_body'),
      confirmLabel: t('blk_action_unblock'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await unblock(profileId);
      toast.show({ type: 'success', title: t('blk_unblocked_toast').replace('{name}', name) });
    } catch {
      toast.show({ type: 'error', title: t('blk_failed') });
    }
  });

  const copyUserCode = async () => {
    if (!publicCode) return;
    try {
      await copyShareText(`@${publicCode}`);
      toast.show({ type: "success", title: t('set_code_copied') });
    } catch {
      toast.show({ type: "error", title: t('set_code_copy_failed') });
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t("settings_title")}
          back
          action={<LanguageToggle />}
        />
        {/* Profile header (handoff §5): the violet self-avatar, name + email,
            then the copyable user-code chip on a raised control. */}
        <div className="px-5 pb-[26px]">
          <div className="flex items-center gap-3.5">
            <UserAvatar name={userName || email || "User"} size={56} self />
            <div className="min-w-0 flex-1">
              <p className="text-white text-[16px] font-semibold tracking-[-0.01em] truncate">
                {userName || t("blk_unknown_person")}
              </p>
              {email && (
                <p className="text-[11px] text-white/70 truncate mt-[3px]">{email}</p>
              )}
            </div>
          </div>

          {/* Copyable user-code chip — the identity surface. Stays minimal
              until the public_code is ready; tap copies @code. */}
          <button
            onClick={copyUserCode}
            disabled={!publicCode}
            className="m-ctl mt-4 inline-flex items-center gap-2 rounded-full px-3 py-[7px] disabled:opacity-50"
          >
            <span className="text-white/60 uppercase tracking-[0.12em] text-[9px] font-semibold">
              {t('set_code_chip_label')}
            </span>
            <span className="text-[11px] font-semibold text-white tabular-nums">
              {publicCode ? `@${publicCode}` : "—"}
            </span>
            {publicCode && <Glyph name="copy" tone="violet" size={11} strokeWidth={2.6} />}
          </button>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {/* ── Account & security ─────────────────────────────────────── */}
        <p className="m-label px-1 pt-0.5">
          {t('settings_grp_account')}
        </p>

        {/* My Account · Language · Appearance */}
        <div className={sectionClass}>
          <div>
            <button
              onClick={() => {
                // Folding the panel away abandons an open number edit.
                if (showProfile) setPhoneEditing(false);
                setShowProfile(!showProfile);
              }}
              className={rowClass + " w-full text-left"}
              aria-expanded={showProfile}
            >
              <RowIcon glyph="person" tone="violet" />
              <RowText
                title={t("settings_my_account")}
                sub={userName || t("settings_my_account_desc")}
              />
              <RowChevron open={showProfile} />
            </button>
            {showProfile && (
              <div className="px-4 pb-4 pt-1 space-y-3.5 animate-fade-in">
                <div>
                  <label htmlFor="settings-email" className="form-label">{t("settings_email")}</label>
                  <input
                    id="settings-email"
                    type="email"
                    value={email}
                    readOnly
                    className="input-field text-ink-600 cursor-not-allowed"
                  />
                </div>
                {/* The ONE place the account's phone number is typed. The
                    discovery card under this one only switches findability
                    for this same number. */}
                {myPhone !== null && (
                  <div ref={phoneFieldRef}>
                    <MyPhoneField
                      phone={myPhone}
                      busy={phoneBusy}
                      editing={phoneEditing}
                      onEditingChange={setPhoneEditing}
                      draftSeed={legacyPhone}
                      onSave={saveMyPhone}
                      onRemove={removeMyPhone}
                    />
                  </div>
                )}
                <div>
                  <label htmlFor="settings-user-code" className="form-label">{t('set_user_code_label')}</label>
                  <div className="flex gap-2">
                    <input
                      id="settings-user-code"
                      type="text"
                      value={publicCode ? `@${publicCode}` : ""}
                      readOnly
                      placeholder={t('set_code_generating')}
                      className="input-field flex-1 min-w-0 text-accent-600 font-semibold tabular-nums"
                    />
                    <button
                      onClick={async () => {
                        if (!publicCode) return;
                        await navigator.clipboard.writeText(`@${publicCode}`);
                        toast.show({
                          type: "success",
                          title: t('set_code_copied'),
                        });
                      }}
                      disabled={!publicCode}
                      className="m-btn m-btn-plain shrink-0 px-4 text-[12px]"
                    >
                      <Glyph name="copy" size={14} className="text-ink-600" />
                      {t('set_copy')}
                    </button>
                  </div>
                  <p className="text-[10.5px] text-ink-600 mt-1.5 leading-relaxed">
                    {t('set_code_help')}
                  </p>
                </div>
                <div>
                  <label htmlFor="settings-password" className="form-label">{t("settings_password")}</label>
                  <input
                    id="settings-password"
                    type="password"
                    value="••••••••"
                    readOnly
                    className="input-field text-ink-600 cursor-not-allowed"
                  />
                  <button
                    onClick={() => setShowPasswordChange(!showPasswordChange)}
                    className="text-[11.5px] text-accent-600 font-semibold mt-2 min-h-[32px]"
                  >
                    {t("settings_reset_password")}
                  </button>
                </div>
                {showPasswordChange && (() => {
                  const policy = validatePassword(newPassword);
                  return (
                    <div className="space-y-2.5 animate-fade-in rounded-[16px] bg-accent-50 p-3.5">
                      {/* Re-auth: the current password must be proven before the
                          new one is accepted (audit SEC-12). */}
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder={t("reauth_current_password")}
                        className="input-field"
                      />
                      <p className="text-[10.5px] text-ink-600 leading-relaxed">
                        {t("reauth_why")}
                      </p>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={t("set_pw_new_ph").replace("{n}", String(PASSWORD_MIN_LENGTH))}
                        className="input-field"
                      />
                      <p className={`text-[10.5px] leading-relaxed ${
                        newPassword.length === 0 ? 'text-ink-600'
                        : policy.valid ? 'text-receive-text font-semibold'
                        : 'text-pay-text font-semibold'
                      }`}>
                        {newPassword.length === 0
                          ? t('password_hint_12')
                          : policy.code === 'too_short'
                            ? t('password_too_short')
                            : policy.code === 'missing_complexity'
                              ? t('password_missing_complexity')
                              : t('password_hint_12')}
                      </p>
                      <button
                        onClick={handlePasswordReset}
                        disabled={passwordSaving || !policy.valid || !currentPassword}
                        className="m-btn m-btn-primary w-full py-2.5 text-[12.5px]"
                      >
                        {passwordSaving ? t("cds_working") : t("set_pw_update_cta")}
                      </button>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Language — the handoff's EN/UR segmented switch, in-row. */}
          <div className="row-base px-4 py-3.5">
            <RowIcon glyph="globe" tone="neutral" />
            <RowText
              title={t("settings_language")}
              sub={lang === "ur" ? t("lang_ur") : t("lang_en")}
            />
            <LanguageToggle tone="on-cream" />
          </div>

          {/* Appearance — Light / Dark / System on a segmented track. */}
          <div>
            <div className="row-base px-4 pt-3.5 pb-3">
              <RowIcon glyph="sun" tone="violet" />
              <RowText title={t("settings_appearance")} sub={t("settings_appearance_desc")} />
            </div>
            <div className="px-4 pb-4">
              <div role="group" aria-label={t("settings_appearance")} className="m-seg flex w-full">
                {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setThemeMode(m)}
                    aria-pressed={themeMode === m}
                    className="flex-1"
                  >
                    {m === "light" ? t("theme_light") : m === "dark" ? t("theme_dark") : t("theme_system")}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Phone discovery — opt-in, and the ONLY contact-matching Hisaab
            does. No address-book access anywhere in the app. Sits right under
            My Account because it uses My Account's number: only the switch
            lives here, never a second number field. */}
        {myPhone !== null && (
          <PhoneDiscoverySection
            sectionClass={sectionClass}
            rowClass={rowClass}
            phone={myPhone}
            busy={phoneBusy}
            onToggle={setPhoneDiscoverable}
            onAddNumber={openPhoneEditor}
          />
        )}

        {/* Notifications — daily wisdom, reminders, mute, quiet hours, push.
            One card of switches (handoff §5); each switch is the 48×28
            material control, role="switch", green when on. */}
        <div className={sectionClass}>
          {/* Daily money wisdom */}
          <div className={rowClass}>
            <RowIcon glyph="sparkle" tone="violet" />
            <RowText title={t("settings_daily_quote")} sub={t("settings_daily_quote_desc")} />
            <button
              type="button"
              role="switch"
              onClick={() => {
                const next = !dailyQuoteOn;
                setDailyQuoteOn(next);
                localStorage.setItem("hisaab_daily_quote_enabled", next ? "true" : "false");
              }}
              aria-checked={dailyQuoteOn}
              aria-label={t("settings_daily_quote")}
              className="m-switch"
            />
          </div>

          {/* Payment reminders — Android local notifications, derived from
              live state (a paid bill never rings). Native-only surface. */}
          {isNativeRuntime() && (
            <div className={rowClass}>
              <RowIcon glyph="calendar" tone="blue" />
              <RowText title={t("settings_reminders")} sub={t("settings_reminders_desc")} />
              <button
                type="button"
                role="switch"
                disabled={remindersBusy}
                onClick={() => {
                  void (async () => {
                    setRemindersBusy(true);
                    try {
                      const next = !remindersOn;
                      if (next) {
                        // The flow OWNS the REMINDERS_KEY write (it must be
                        // true before its internal reschedule runs, or that
                        // run schedules nothing) — we only mirror the result.
                        const enabled = await enableRemindersFlow();
                        setRemindersOn(enabled);
                        if (!enabled) {
                          toast.show({ type: "error", title: t("settings_reminders_denied") });
                        } else {
                          // Android 13+ has ONE notification permission for
                          // the whole app, so the moment the user grants it
                          // here we also register for push. Asking twice for
                          // the same grant is how apps train people to deny.
                          void requestPushPermissionAndRegister((to) => navigate(to));
                        }
                      } else {
                        try {
                          localStorage.setItem(REMINDERS_KEY, "false");
                        } catch { /* storage off */ }
                        setRemindersOn(false);
                        // Cancels everything pending immediately.
                        await rescheduleNotifications({ force: true });
                      }
                    } finally {
                      setRemindersBusy(false);
                    }
                  })();
                }}
                aria-checked={remindersOn}
                aria-label={t("settings_reminders")}
                className="m-switch"
              />
            </div>
          )}

          {/* Global mute — M5 (docs/notifications.md §8.2). Same server-side
              row as the per-group mute in GroupDetailPage, just group_id null:
              suppresses every `notifications` row (and therefore every push)
              for this user. The in-app Inbox / Activity feed are unaffected —
              copy below says so explicitly, same honesty rule as the per-group
              mute. Mode-agnostic like the rest of §3/§7. */}
          <div className={rowClass}>
            <RowIcon glyph="bell" tone="coral" />
            <RowText title={t("settings_mute_all")} sub={t("settings_mute_all_desc")} />
            <button
              type="button"
              role="switch"
              disabled={globalMuteBusy}
              onClick={() => {
                void (async () => {
                  setGlobalMuteBusy(true);
                  try {
                    await setGlobalMutedPref(!globalMuted);
                  } catch {
                    toast.show({ type: "error", title: t("settings_mute_all_failed") });
                  } finally {
                    setGlobalMuteBusy(false);
                  }
                })();
              }}
              aria-checked={globalMuted}
              aria-label={t("settings_mute_all")}
              className="m-switch"
            />
          </div>

          {/* Quiet hours — M5 (docs/notifications.md §8.2). Mode-agnostic and
              not native-only: it governs a server-side push delivery decision,
              so a web user can set it even though they'll never see the effect
              themselves. Mute suppresses the notifications row entirely; quiet
              hours only soften how a push rings — the in-app Inbox always gets
              every item regardless. */}
          <div>
            <div className={rowClass}>
              <RowIcon glyph="moon" tone="violet" />
              <RowText title={t("settings_quiet_hours")} sub={t("settings_quiet_hours_desc")} />
              <button
                type="button"
                role="switch"
                disabled={quietHoursBusy}
                onClick={() => {
                  void (async () => {
                    setQuietHoursBusy(true);
                    try {
                      if (quietHoursEnabled) {
                        await setQuietHoursPref(null, null);
                      } else {
                        await setQuietHoursPref(DEFAULT_QUIET_START_HOUR, DEFAULT_QUIET_END_HOUR);
                      }
                    } catch {
                      toast.show({ type: "error", title: t("settings_quiet_hours_failed") });
                    } finally {
                      setQuietHoursBusy(false);
                    }
                  })();
                }}
                aria-checked={quietHoursEnabled}
                aria-label={t("settings_quiet_hours")}
                className="m-switch"
              />
            </div>
            {quietHoursEnabled && (
              <div className="px-4 pb-4 animate-fade-in">
                <div className="flex items-center gap-3">
                  <label className="flex-1">
                    <span className="form-label">
                      {t("settings_quiet_hours_start")}
                    </span>
                    <input
                      type="time"
                      step={3600}
                      disabled={quietHoursBusy}
                      value={hourToTimeInput(quietHours.start, DEFAULT_QUIET_START_HOUR)}
                      onChange={(e) => {
                        const hour = timeInputToHour(e.target.value);
                        if (hour === null) return;
                        void setQuietHoursPref(hour, quietHours.end ?? DEFAULT_QUIET_END_HOUR).catch(() =>
                          toast.show({ type: "error", title: t("settings_quiet_hours_failed") }),
                        );
                      }}
                      className="input-field py-2.5 tabular-nums disabled:opacity-50"
                    />
                  </label>
                  <label className="flex-1">
                    <span className="form-label">
                      {t("settings_quiet_hours_end")}
                    </span>
                    <input
                      type="time"
                      step={3600}
                      disabled={quietHoursBusy}
                      value={hourToTimeInput(quietHours.end, DEFAULT_QUIET_END_HOUR)}
                      onChange={(e) => {
                        const hour = timeInputToHour(e.target.value);
                        if (hour === null) return;
                        void setQuietHoursPref(quietHours.start ?? DEFAULT_QUIET_START_HOUR, hour).catch(() =>
                          toast.show({ type: "error", title: t("settings_quiet_hours_failed") }),
                        );
                      }}
                      className="input-field py-2.5 tabular-nums disabled:opacity-50"
                    />
                  </label>
                </div>
                <p className="pt-2.5 text-[10.5px] text-ink-500 leading-relaxed">
                  {t("settings_quiet_hours_tz").replace("{tz}", quietHoursTz)}
                </p>
              </div>
            )}
          </div>

          {/* Dedicated push opt-in — audit N-6: push used to be welded to the
              local-reminders toggle above with no way to enable one without the
              other. Native only; a PWA tab has no OS-level push channel here. */}
          {isNativeRuntime() && (
            <div className={rowClass}>
              <RowIcon glyph="send" tone="green" />
              <RowText title={t("push_title")} sub={t("push_desc")} />
              {pushPermission === "granted" ? (
                <span className="m-chip m-chip-receive m-chip-caps shrink-0">
                  {t("push_status_on")}
                </span>
              ) : pushPermission === "denied" ? (
                <span className="m-chip m-chip-pay m-chip-caps shrink-0">
                  {t("push_status_denied")}
                </span>
              ) : (
                <button
                  disabled={pushBusy}
                  onClick={() => {
                    void (async () => {
                      setPushBusy(true);
                      try {
                        await requestPushPermissionAndRegister((to) => navigate(to));
                        await refreshPushPermission();
                      } finally {
                        setPushBusy(false);
                      }
                    })();
                  }}
                  className="m-btn m-btn-primary shrink-0 min-h-[36px] rounded-xl px-3.5 py-2 text-[11.5px]"
                >
                  {pushBusy ? t("cds_working") : t("push_enable_cta")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Blocked people — audit M17. Users must be able to see and undo what
            they did; a block with no visible list is an action they can never
            take back. The blocked party can never read these rows. */}
        <div className={sectionClass}>
          <div className="row-base px-4 py-3.5">
            <RowIcon glyph="shield" tone="coral" />
            <RowText title={t('blk_list_title')} sub={t('blk_list_sub')} />
          </div>
          {blocks.length === 0 ? (
            <p className="px-4 py-3.5 text-[11.5px] text-ink-600 leading-relaxed">
              {blocksLoading ? t('gdp_loading') : t('blk_list_empty')}
            </p>
          ) : (
            blocks.map((entry) => (
              <div key={entry.blockedId} className="row-base px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-ink-900 truncate">
                    {blockedName(entry.blockedId)}
                  </p>
                  <p className="text-[10.5px] text-ink-600 tabular-nums">
                    {t('blk_list_since').replace(
                      '{date}',
                      new Date(entry.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
                    )}
                  </p>
                  {entry.reason && (
                    <p className="text-[10.5px] text-ink-500 italic truncate">{entry.reason}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleUnblock(entry.blockedId)}
                  className="m-btn m-btn-plain shrink-0 min-h-[36px] rounded-xl px-3 py-2 text-[11px]"
                >
                  {t('blk_action_unblock')}
                </button>
              </div>
            ))
          )}
        </div>

        {/* App Mode */}
        <div className={sectionClass}>
          <div>
            <div className="row-base px-4 pt-3.5 pb-3">
              <RowIcon glyph="sliders" tone="blue" />
              <RowText
                title={t("settings_app_mode")}
                sub={
                  <>
                    {t("settings_mode_current")}:{" "}
                    {mode === "splits_only"
                      ? t("mode_splits_title")
                      : t("mode_full_title")}
                  </>
                }
              />
            </div>
            <div className="px-4 pb-4">
              <div role="group" aria-label={t("settings_app_mode")} className="m-seg flex w-full">
                <button
                  type="button"
                  onClick={() => {
                    const unsettled = accounts.filter((a) => a.balance !== 0);
                    if (unsettled.length > 0) {
                      toast.show({
                        type: "error",
                        title: t("mode_switch_blocked"),
                        subtitle: t("mode_switch_blocked_desc"),
                      });
                      return;
                    }
                    setMode("splits_only");
                    void profilesDb.updateCurrent({ app_mode: "splits_only" }).catch(() => {});
                  }}
                  aria-pressed={mode === "splits_only"}
                  className="flex-1"
                >
                  {t("mode_splits_title")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("full_tracker");
                    void profilesDb.updateCurrent({ app_mode: "full_tracker" }).catch(() => {});
                  }}
                  aria-pressed={mode === "full_tracker"}
                  className="flex-1"
                >
                  {t("mode_full_title")}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Security — the device PIN (handoff "App Lock"). */}
        <div className={sectionClass}>
          <div>
            <div className="row-base px-4 pt-3.5 pb-3">
              <RowIcon glyph="lock" tone="blue" />
              <RowText title={t("settings_security")} sub={t("settings_pin_desc")} />
            </div>
            {showPinSetup ? (
              <div className="px-4 pb-4 space-y-2.5">
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={t("pin_set_title")}
                  value={pin1}
                  onChange={(e) => setPin1(e.target.value.replace(/\D/g, ""))}
                  className="input-field text-center tracking-[0.5em] font-bold"
                />
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={t("pin_confirm")}
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                  className="input-field text-center tracking-[0.5em] font-bold"
                />
                <div className="flex gap-2.5 pt-1">
                  <button
                    onClick={() => {
                      setShowPinSetup(false);
                      setPin1("");
                      setPin2("");
                    }}
                    className="m-btn m-btn-plain flex-1 py-2.5 text-[12.5px]"
                  >
                    {t('set_pin_cancel')}
                  </button>
                  <button
                    onClick={handleSetPin}
                    disabled={pin1.length !== 4 || pin2.length !== 4}
                    className="m-btn m-btn-primary flex-1 py-2.5 text-[12.5px]"
                  >
                    {t('set_pin_save')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="px-4 pb-4 flex gap-2.5">
                {hasPin ? (
                  <>
                    <button
                      onClick={() => setShowPinSetup(true)}
                      className="m-btn m-btn-plain flex-1 py-2.5 text-[12px]"
                    >
                      <Glyph name="lock" size={13} className="text-ink-600" /> {t("settings_change_pin")}
                    </button>
                    <button
                      onClick={handleRemovePin}
                      className="m-btn m-btn-danger flex-1 py-2.5 text-[12px]"
                    >
                      <Unlock size={13} strokeWidth={2.4} aria-hidden /> {t("settings_remove_pin")}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setShowPinSetup(true)}
                    className="m-btn m-btn-primary flex-1 py-2.5 text-[12.5px]"
                  >
                    <Glyph name="lock" size={14} strokeWidth={2.6} /> {t("settings_set_pin")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Your money ──────────────────────────────────────────────── */}
        <p className={groupLabelClass}>
          {t('settings_grp_money')}
        </p>

        {/* Money tools (full_tracker only — each presupposes accounts) plus
            Contacts, Kameti and the share-invite row, one card. */}
        <div className={sectionClass}>
          {mode === 'full_tracker' && (
            <>
              <button
                onClick={() => navigate('/budgets')}
                className={rowClass + " w-full text-left"}
              >
                <RowIcon glyph="wallet" tone="violet" />
                <RowText title={t('set_row_budgets')} sub={t('set_row_budgets_sub')} />
                <RowChevron />
              </button>
              <button
                onClick={() => navigate('/subscriptions')}
                className={rowClass + " w-full text-left"}
              >
                <RowIcon glyph="card" tone="blue" />
                <RowText title={t('set_row_subs')} sub={t('set_row_subs_sub')} />
                <RowChevron />
              </button>
              <button
                onClick={() => setShowCategories(true)}
                className={rowClass + " w-full text-left"}
              >
                <RowIcon glyph="tag" tone="green" />
                <RowText title={t('cat_manage_row')} sub={t('cat_manage_sub')} />
                <RowChevron />
              </button>
            </>
          )}
          <button
            onClick={() => navigate('/contacts')}
            className={rowClass + " w-full text-left"}
          >
            <RowIcon glyph="person" tone="pink" />
            <RowText title={t("settings_contacts_tile")} sub={t("settings_contacts_tile_desc")} />
            <RowChevron />
          </button>
          <button
            onClick={() => navigate('/kameti')}
            className={rowClass + " w-full text-left"}
          >
            <RowIcon glyph="coins" tone="gold" />
            <RowText title={t('kameti_title')} sub={t('kameti_tile_desc')} />
            <RowChevron />
          </button>
          <button
            onClick={handleShareApp}
            className={rowClass + " w-full text-left"}
          >
            <RowIcon glyph="arrow-up" tone="green" />
            <RowText
              title={
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{t("settings_share_app")}</span>
                  <span className="m-chip m-chip-violet m-chip-caps shrink-0">
                    {t("settings_share_app_badge")}
                  </span>
                </span>
              }
              sub={t("settings_share_app_desc")}
            />
            <RowChevron />
          </button>
        </div>

        {/* ── Data & backup ───────────────────────────────────────────── */}
        <p className={groupLabelClass}>
          {t('settings_grp_data')}
        </p>

        {/* Backup */}
        <div className={sectionClass}>
          <button
            onClick={handleExport}
            disabled={exporting}
            className={rowClass + " w-full text-left disabled:opacity-60"}
          >
            <RowIcon glyph="download" tone="violet" />
            <RowText title={t("settings_export")} sub={t("settings_export_desc")} />
            <RowChevron />
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className={rowClass + " w-full text-left"}
          >
            <RowIcon glyph="database" tone="neutral" />
            <RowText title={t("settings_import")} sub={t("settings_import_desc")} />
            <RowChevron />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </div>

        {/* Opt-in usage stats — device-level, default OFF, no free text and no
            amounts (audit report 10 §5.2). Self-contained card. */}
        <TelemetryConsentToggle />

        {/* ── About & legal ───────────────────────────────────────────── */}
        <p className={groupLabelClass}>
          {t('settings_grp_about')}
        </p>

        {/* Talk to us — the only in-app channel a confused-but-not-crashed
            user has (audit report 10, F3). Self-contained card. */}
        <FeedbackCard />

        {/* About + Trust — the security/philosophy work translated into
            human sentences, plus the business-model-as-feature answer to
            "why is this free?". Plain-speech, both languages. */}
        <div className={sectionClass}>
          <div className="row-base px-4 py-3.5">
            <RowIcon glyph="info" tone="neutral" />
            <RowText title={t("settings_about")} sub={t("settings_about_desc")} />
          </div>
          <div className="px-4 py-3.5">
            <p className="text-[13px] font-semibold text-ink-900 mb-2.5">{t('trust_title')}</p>
            <div className="space-y-2">
              {[t('trust_line_1'), t('trust_line_2'), t('trust_line_3'), t('trust_line_4')].map((line) => (
                <div key={line} className="flex items-start gap-2.5">
                  <Glyph name="check" tone="green" size={13} strokeWidth={3} className="mt-[3px]" />
                  <p className="text-[12px] text-ink-700 leading-relaxed">{line}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="px-4 py-3.5">
            <p className="text-[13px] font-semibold text-ink-900 mb-1">{t('trust_why_free_title')}</p>
            <p className="text-[12px] text-ink-600 leading-relaxed">{t('trust_why_free_body')}</p>
          </div>
        </div>

        {/* Legal and support */}
        <div className={sectionClass}>
          <button
            onClick={() => navigate('/privacy')}
            className={rowClass + " w-full text-left"}
          >
            <RowIcon glyph="shield-check" tone="green" />
            <RowText title={t('set_row_privacy')} sub={t('set_row_privacy_sub')} />
            <RowChevron />
          </button>
          <button
            onClick={() => navigate('/terms')}
            className={rowClass + " w-full text-left"}
          >
            <RowIcon glyph="document" tone="neutral" />
            <RowText title={t('set_row_terms')} sub={t('set_row_terms_sub')} />
            <RowChevron />
          </button>
          <button
            onClick={() => navigate('/contact')}
            className={rowClass + " w-full text-left"}
          >
            <RowIcon glyph="mail" tone="blue" />
            <RowText title={t('set_row_contact')} sub={t('set_row_contact_sub')} />
            <RowChevron />
          </button>
          <button
            onClick={() => navigate('/delete-account')}
            className={rowClass + " w-full text-left"}
          >
            <RowIcon glyph="trash" tone="coral" />
            <RowText title={t('set_row_deletion')} sub={t('set_row_deletion_sub')} danger />
            <RowChevron danger />
          </button>
        </div>

        {/* Danger Zone — coral-tinted card; the form expands inside it. */}
        {user && (
          <div className="m-card m-coral overflow-hidden">
            <button
              onClick={() => setShowDeleteAccount(!showDeleteAccount)}
              className="row-base row-interactive px-4 py-3.5 w-full text-left"
              aria-expanded={showDeleteAccount}
            >
              <RowIcon glyph="alert" tone="coral" />
              <RowText title={t('set_delete_account')} sub={t('set_delete_account_sub')} danger />
              <RowChevron open={showDeleteAccount} danger />
            </button>
            {showDeleteAccount && (
              <div className="px-4 pb-4 pt-1 space-y-3.5 animate-fade-in">
                <div className="m-inset px-3.5 py-3">
                  <p className="text-[12px] font-bold text-pay-text">
                    {t('set_delete_irreversible')}
                  </p>
                  <p className="text-[11px] text-ink-600 mt-1 leading-relaxed">
                    {t('set_delete_body')}
                  </p>
                </div>
                <div>
                  <label htmlFor="settings-delete-confirm" className="form-label text-pay-text">
                    {t('set_delete_type_label')}
                  </label>
                  <input
                    id="settings-delete-confirm"
                    value={deleteConfirm}
                    onChange={(event) => setDeleteConfirm(event.target.value)}
                    disabled={deleteSaving}
                    className="input-field"
                    placeholder={t('set_delete_placeholder')}
                  />
                </div>
                {/* Re-auth: irreversible destruction of years of khata history
                    must not be one tap away on an unlocked phone (SEC-12). */}
                <div>
                  <label htmlFor="settings-delete-password" className="form-label text-pay-text">
                    {t("reauth_current_password")}
                  </label>
                  <input
                    id="settings-delete-password"
                    type="password"
                    autoComplete="current-password"
                    value={deletePassword}
                    onChange={(event) => setDeletePassword(event.target.value)}
                    disabled={deleteSaving}
                    className="input-field"
                    placeholder={t("reauth_current_password")}
                  />
                  <p className="text-[10.5px] text-ink-600 mt-1.5 leading-relaxed">
                    {t("reauth_why")}
                  </p>
                </div>
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleteConfirm !== "DELETE" || !deletePassword || deleteSaving}
                  className="m-btn m-btn-coral w-full py-3 text-[12.5px]"
                >
                  <Glyph name="trash" size={14} strokeWidth={2.6} />
                  {deleteSaving ? t("cds_working") : t("set_delete_account")}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Sign Out */}
        {user && (
          <div className={sectionClass}>
            <button
              onClick={async () => {
                const ok = await confirmDestructive({
                  title: t("logout_confirm_title"),
                  description: t("logout_confirm_body"),
                  confirmLabel: t("logout_confirm_yes"),
                  tone: "warning",
                });
                if (!ok) return;
                await signOut();
                window.location.reload();
              }}
              className={rowClass + " w-full text-left"}
            >
              <RowIcon glyph="logout" tone="coral" />
              <RowText title={t('set_logout')} sub={user.email} danger />
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="text-center pt-3 pb-2">
          <p className="text-[10.5px] text-ink-500">
            {t('set_footer_credit')}
          </p>
        </div>
      </div>

      <ManageCategoriesModal open={showCategories} onClose={() => setShowCategories(false)} />
    </main>
  );
}
