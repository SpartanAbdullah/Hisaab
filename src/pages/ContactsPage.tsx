import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { hasWhatsAppNumber } from '../lib/whatsappReminder';
import { usePersonStore } from '../stores/personStore';
import { useContactLinkStore } from '../stores/contactLinkStore';
import { usePhoneDiscoveryStore } from '../stores/phoneDiscoveryStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { QRScanner } from '../components/QRScanner';
import { codeLookupBudgetSpent, resolveProfileByCode } from '../lib/collaboration';
import { formatLinkError, retryAfterMinutes } from '../lib/contactLinkStatus';
import { formatConnectCode } from '../lib/connectQr';
import { useLoanStore } from '../stores/loanStore';
import { NavyHero, TopBar } from '../components/NavyHero';
import { LanguageToggle } from '../components/LanguageToggle';
import { UserAvatar } from '../components/UserAvatar';
import { VerifiedBadge } from '../components/VerifiedBadge';
import { isConsentVerifiedLink } from '../lib/contactVerification';
import { useToast } from '../components/Toast';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { ContactDetailSheet } from './ContactDetailSheet';
import { MyConnectCode } from '../components/MyConnectCode';
import { useT } from '../lib/i18n';
import { Glyph } from '../components/Glyph';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { personsDb } from '../lib/supabaseDb';
import type { Person } from '../db';

// Sukoon screen 10. Full-screen replacement for the old ContactsModal.
// Contacts live in two flavours:
//   • Unlinked — a name the user keeps for their own ledger. Loans, splits
//     and reminders can still be recorded against them; the other person
//     isn't notified and there's no two-way confirmation.
//   • Linked — paired with another Hisaab user via their public code.
//     Loan/split records flow both ways: the linked user gets an inbox
//     request, confirms or declines, and the ledgers stay in sync.
// The Add flow on this page creates an unlinked contact. The user can link
// later by tapping the contact row — the existing ContactDetailSheet still
// hosts the code-lookup → confirm flow.
export function ContactsPage() {
  const persons = usePersonStore((s) => s.persons);
  // Archived contacts load ON DEMAND (they're excluded from the normal
  // fetch) and live page-local — the store only ever holds active rows.
  const [archived, setArchived] = useState<Person[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedBusyId, setArchivedBusyId] = useState<string | null>(null);
  const loadPersons = usePersonStore((s) => s.loadPersons);
  const createPerson = usePersonStore((s) => s.createPerson);
  const linkToProfile = usePersonStore((s) => s.linkToProfile);
  const linkToDiscoveredProfile = usePersonStore((s) => s.linkToDiscoveredProfile);
  const loans = useLoanStore((s) => s.loans);
  const loadLoans = useLoanStore((s) => s.loadLoans);
  const t = useT();
  const toast = useToast();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');

  // Add-contact form state. Inline expand-in-place form rather than a sheet
  // so the user keeps the page's letter sections visible as context.
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creating, setCreating] = useState(false);
  // After a successful add we surface a short-lived "Link them now?" banner
  // so the user immediately understands they CAN link, without forcing it.
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);
  const [showLinkHelp, setShowLinkHelp] = useState(false);

  // ── Link-at-add ──────────────────────────────────────────────────────
  // The old flow saved a local contact and left the user to discover
  // linking later, so most contacts stayed unlinked forever. Now the add
  // form asks the question directly — and answering it is one tap, because
  // scanning their QR is right there.
  const [linkMode, setLinkMode] = useState<'ask' | 'code'>('ask');
  const [linkCode, setLinkCode] = useState('');
  const [resolvingCode, setResolvingCode] = useState(false);
  // `code` is null for a phone-discovery hit — there is no code behind a
  // number match, and the server's link RPC verifies a code (audit C6).
  const [linkTarget, setLinkTarget] = useState<
    { profileId: string; displayName: string; code: string | null } | null
  >(null);
  const [linkError, setLinkError] = useState('');
  const [showScanner, setShowScanner] = useState(false);

  // Double-tap guard (audit C10/F-8): add-contact submit creates a person
  // plus an optional cross-user link request. See src/lib/useSubmitGuard.ts.
  const createGuard = useSubmitGuard();

  const myId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const contactLinks = useContactLinkStore((s) => s.requests);
  const loadContactLinks = useContactLinkStore((s) => s.loadRequests);
  const discover = usePhoneDiscoveryStore((s) => s.discover);
  const discoveryResults = usePhoneDiscoveryStore((s) => s.results);
  const matchFor = usePhoneDiscoveryStore((s) => s.matchFor);

  const load = useCallback(async () => {
    // Loans drive the Settled / Unsettled status chip per contact.
    // Contact links drive the "waiting for them to add you back" row hint.
    await Promise.all([loadPersons(), loadLoans(), loadContactLinks().catch(() => {})]);
  }, [loadPersons, loadLoans, loadContactLinks]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  // One batched lookup for every saved number, so unlinked contacts who are
  // already on Hisaab surface themselves. Runs on the contact list changing,
  // and the store dedupes against what it already resolved — a re-render or
  // a second visit costs nothing.
  useEffect(() => {
    const phones = persons.filter((p) => !p.linkedProfileId).map((p) => p.phone);
    if (phones.length === 0) return;
    void discover(phones);
  }, [persons, discover]);

  // Live check on the number being typed into the add form. Debounced hard:
  // the lookup RPC is rate-limited, and a per-keystroke call would burn the
  // hourly budget on one contact.
  useEffect(() => {
    if (!showAdd) return;
    const phone = newPhone.trim();
    if (!phone) return;
    const timer = window.setTimeout(() => { void discover([phone]); }, 700);
    return () => window.clearTimeout(timer);
  }, [newPhone, showAdd, discover]);

  // Discovery hit on the number in the add form. `discoveryResults` is in the
  // dep list (not just read through matchFor) so the chip appears the moment
  // the lookup lands.
  const phoneMatch = useMemo(
    () => (showAdd && newPhone.trim() ? matchFor(newPhone) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [newPhone, showAdd, discoveryResults, matchFor],
  );

  // Contacts I linked who haven't added me back yet. Rendered as a quiet
  // "waiting" hint rather than a full "Linked" seal, because until they
  // accept, the connection genuinely only exists on my side.
  const awaitingProfileIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of contactLinks) {
      if (r.fromUserId === myId && r.status === 'pending') set.add(r.toUserId);
    }
    return set;
  }, [contactLinks, myId]);

  // Filter then alphabetise. Search is case-insensitive on name only — link
  // status / external handles aren't part of the visible name so they don't
  // need to be queryable.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? persons.filter((p) => p.name.toLowerCase().includes(q))
      : persons;
    return [...base].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [persons, query]);

  // Group by first letter. Special bucket for non-alpha leads (#, digits,
  // emoji-starting names) so they always have a header rather than getting
  // tucked under "A".
  const groups = useMemo(() => {
    const map = new Map<string, Person[]>();
    for (const p of filtered) {
      const first = (p.name[0] ?? '?').toUpperCase();
      const key = /[A-Z]/.test(first) ? first : '#';
      const bucket = map.get(key) ?? [];
      bucket.push(p);
      map.set(key, bucket);
    }
    const ordered = [...map.entries()].sort(([a], [b]) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    });
    return ordered;
  }, [filtered]);

  const linkedCount = useMemo(
    () => persons.filter((p) => Boolean(p.linkedProfileId)).length,
    [persons],
  );

  // A contact is "unsettled" when they have at least one active loan with an
  // open balance. Match by personId; fall back to name only for legacy loans
  // that predate person linking (so a same-named contact isn't mis-flagged).
  const { openIds, openNames } = useMemo(() => {
    const openIds = new Set<string>();
    const openNames = new Set<string>();
    for (const l of loans) {
      if (l.status !== 'active' || l.remainingAmount <= 0.01) continue;
      if (l.personId) openIds.add(l.personId);
      else if (l.personName) openNames.add(l.personName.trim().toLowerCase());
    }
    return { openIds, openNames };
  }, [loans]);
  const isUnsettled = useCallback(
    (p: Person) => openIds.has(p.id) || openNames.has(p.name.trim().toLowerCase()),
    [openIds, openNames],
  );
  const openCount = useMemo(() => persons.filter(isUnsettled).length, [persons, isUnsettled]);

  const lastCreated = useMemo(
    () => persons.find((p) => p.id === lastCreatedId) ?? null,
    [persons, lastCreatedId],
  );

  const selected: Person | null = selectedId
    ? persons.find((p) => p.id === selectedId) ?? null
    : null;

  const resetAddForm = () => {
    setShowAdd(false);
    setNewName('');
    setNewPhone('');
    setLinkMode('ask');
    setLinkCode('');
    setLinkTarget(null);
    setLinkError('');
    setResolvingCode(false);
  };

  // Resolve a code (typed or scanned) into the account it belongs to. We
  // only ever RESOLVE here — the link itself happens on submit, so the user
  // sees who they're about to connect to before anything is written.
  const resolveForAdd = async (rawCode: string) => {
    setLinkError('');
    setLinkTarget(null);
    const trimmed = rawCode.trim();
    if (!trimmed) return;
    setResolvingCode(true);
    try {
      const found = await resolveProfileByCode(trimmed);
      if (!found) {
        // Zero rows means "no such code" OR "throttled" — the server refuses
        // to say which, so lean on our own count of charges this hour.
        setLinkError(
          codeLookupBudgetSpent()
            ? t('clink_err_rate_limited').replace('{minutes}', String(retryAfterMinutes(undefined)))
            : t('addc_link_err_notfound'),
        );
        return;
      }
      setLinkTarget({ ...found, code: trimmed });
      // Adopt their Hisaab display name when the user hasn't typed one —
      // saves a step, and a name they'd have typed anyway.
      if (!newName.trim()) setNewName(found.displayName);
    } catch {
      setLinkError(t('addc_link_err_lookup'));
    } finally {
      setResolvingCode(false);
    }
  };

  // Soft warning (not a block — two real people can share a name): a duplicate
  // contact name collides with the name-based loan matching used elsewhere.
  const duplicateName =
    newName.trim().length > 0 &&
    persons.some((p) => p.name.trim().toLowerCase() === newName.trim().toLowerCase());

  const handleCreate = () => createGuard.run(runCreate);
  const runCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const created = await createPerson(trimmed, newPhone.trim() || null);
      if (linkTarget) {
        // The contact row already exists at this point. If linking fails we
        // must NOT report a failed add — the contact is real and saved; only
        // the link didn't happen. Saying otherwise would send the user
        // looking for a contact that's sitting right there.
        try {
          // Code path sends the CODE (server re-verifies it); the resolved
          // profile rides along only as the pre-migration fallback. A phone
          // discovery hit has no code, and the server re-runs the number match
          // itself — the profile id is a claim it checks, not a credential.
          const linked = linkTarget.code
            ? await linkToProfile(created.id, linkTarget.code, {
                profileId: linkTarget.profileId,
                displayName: linkTarget.displayName,
              })
            : await linkToDiscoveredProfile(created.id, linkTarget.profileId, linkTarget.displayName);
          toast.show({
            type: 'success',
            title: t('cts_added_connected').replace('{name}', trimmed),
            subtitle:
              linked.linkState === 'mutual'
                ? t('clink_mutual')
                : t('clink_waiting').replace('{name}', linked.displayName || linkTarget.displayName),
          });
        } catch (err) {
          toast.show({
            type: 'info',
            title: t('cts_added'),
            // Say WHY the link didn't happen (wrong code, stale discovery
            // match, rate limit) instead of the old blanket "linking failed".
            subtitle: `${t('addc_link_partial')} ${formatLinkError(err, t, linkTarget.code ? 'code' : 'discovery')}`,
          });
        }
      } else {
        toast.show({
          type: 'success',
          title: t('cts_added'),
          subtitle: t('cts_added_local_sub'),
        });
      }
      setLastCreatedId(created.id);
      resetAddForm();
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('cts_err_add'),
        subtitle: err instanceof Error ? err.message : t('common_please_try_again'),
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      {/* 1d (handoff §6): the pink Contacts hero — back, title, a search
          square and the violet "+ Add" — over the counts line, which also
          carries the EN/UR switcher. */}
      <NavyHero accent="pink">
        <TopBar
          title={t('contacts_title')}
          back
          action={
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSearch((v) => !v)}
                className="m-ctl relative w-9 h-9 flex items-center justify-center before:absolute before:-inset-1 before:content-['']"
                aria-label={t('a11y_search')}
                aria-pressed={showSearch}
              >
                <Glyph name="search" size={15} className="text-white/90" />
              </button>
              <button
                onClick={() => {
                  setShowAdd(true);
                  setShowSearch(false);
                }}
                className="m-key m-violet h-9 px-3 rounded-[12px] flex items-center gap-1.5 text-[12px] font-semibold"
                aria-label={t('cts_a11y_add')}
              >
                <Glyph name="plus" size={13} strokeWidth={2.8} /> {t('common_add')}
              </button>
            </div>
          }
        />
        {/* EN/UR sits on the counts row, not in the header: back, title,
            search, + Add and the bell already fill the TopBar, and one more
            control there cut "Your Contacts" to "Your…" on a 360–390px phone.
            The counts wrap to a second line on narrow phones; the switcher
            stays put. */}
        <div className="px-5 pb-6 flex items-center justify-between gap-3">
          <p className="m-label text-white/70 min-w-0">
            {persons.length === 1
              ? t('cts_count_one')
              : t('cts_count_many').replace('{n}', String(persons.length))}
            {linkedCount > 0 && <> · {t('cts_linked_count').replace('{n}', String(linkedCount))}</>}
            {openCount > 0 && (
              <> · <span className="text-warn-700">{t('cts_unsettled_count').replace('{n}', String(openCount))}</span></>
            )}
          </p>
          <LanguageToggle />
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {/* Your own connect code — front and centre so sharing it to get
            connected is the easiest thing on the page. */}
        {!showSearch && !showAdd && <MyConnectCode />}

        {showSearch && (
          <div className="relative">
            <Glyph
              name="search"
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none z-[1]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('cts_search_placeholder')}
              className="input-field pl-10 pr-10"
              autoFocus
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-ink-400 active:text-ink-800"
                aria-label={t('a11y_clear_search')}
              >
                <Glyph name="close" size={14} />
              </button>
            )}
          </div>
        )}

        {/* Add-contact inline form. The explanatory copy here is the most
            common moment a user is asking themselves "should I link this?",
            so the linked-vs-unlinked distinction lives here, not buried
            below in a hint card. */}
        {showAdd && (
          <div className="m-card p-4 space-y-3.5 animate-fade-in">
            <div className="flex items-start gap-3">
              <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0" aria-hidden>
                <Glyph name="user-plus" tone="pink" size={19} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-ink-900 tracking-tight">
                  {t('cts_add_title')}
                </p>
                <p className="text-[11px] text-ink-600 mt-0.5 leading-relaxed">
                  {t('cts_add_desc')}
                </p>
              </div>
              <button
                onClick={resetAddForm}
                className="m-ctl w-9 h-9 flex items-center justify-center shrink-0"
                aria-label={t('cancel')}
              >
                <Glyph name="close" size={14} className="text-ink-600" />
              </button>
            </div>

            <div>
              <label htmlFor="contacts-add-name" className="form-label">
                {t('cts_name_label')}
              </label>
              <input
                id="contacts-add-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('cts_name_placeholder')}
                autoFocus
                className="input-field"
              />
              {duplicateName && (
                <p className="text-[11px] text-warn-700 mt-1.5 flex items-start gap-1.5">
                  <Glyph name="alert" size={13} className="mt-px" />
                  {t('contact_dup_warning').replace('{name}', newName.trim())}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="contacts-add-phone" className="form-label">
                {t('cts_phone_label')}
              </label>
              <input
                id="contacts-add-phone"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="+971 50 123 4567"
                inputMode="tel"
                className="input-field"
              />
              {/* Discovery hit. The number the user just typed belongs to a
                  Hisaab account that opted in to being findable — offering
                  the link here saves them hunting for a code that already
                  resolved itself.
                  NO verified seal (audit 2026-09 SEC-09): nothing verifies
                  that the account claiming this number actually owns it. */}
              {phoneMatch && !linkTarget && (
                <button
                  type="button"
                  onClick={() => {
                    setLinkTarget({
                      profileId: phoneMatch.profileId,
                      displayName: phoneMatch.displayName,
                      code: null,
                    });
                    setLinkError('');
                    if (!newName.trim()) setNewName(phoneMatch.displayName);
                  }}
                  className="m-tile mt-2.5 px-3 py-2.5 flex items-start gap-2.5 text-left"
                >
                  <Glyph name="phone" size={15} className="mt-0.5 text-ink-500" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[11.5px] text-ink-800 leading-snug">
                      {t('disc_found').replace('{name}', phoneMatch.displayName)}
                    </span>
                    <span className="block text-[10px] text-ink-600 leading-relaxed mt-0.5">
                      {t('disc_unverified_note')}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] font-bold text-accent-600 mt-0.5">
                    {t('disc_link_cta')}
                  </span>
                </button>
              )}
            </div>

            {/* THE question the app never used to ask. Kept above the submit
                button so it's answered before the contact exists, not
                discovered afterwards — but every branch is skippable, because
                most contacts genuinely aren't on Hisaab. */}
            <div className="m-inset p-3 space-y-2.5">
              {linkTarget ? (
                <div className="flex items-center gap-2.5">
                  {/* Neutral link glyph, not the verified seal: this target
                      may have come from an unverified phone match, and even a
                      code lookup is not yet an accepted, two-way link. */}
                  <Glyph name="link" tone="violet" size={16} />
                  <span className="flex-1 min-w-0 text-[12px] font-semibold text-ink-900 truncate">
                    {t('addc_link_found').replace('{name}', linkTarget.displayName)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setLinkTarget(null);
                      setLinkMode('ask');
                      setLinkCode('');
                    }}
                    className="shrink-0 min-h-[32px] text-[11px] font-semibold text-accent-600"
                  >
                    {t('addc_link_change')}
                  </button>
                </div>
              ) : (
                <>
                  <div>
                    <p className="text-[12px] font-semibold text-ink-900">{t('addc_link_q')}</p>
                    <p className="text-[10.5px] text-ink-600 leading-relaxed mt-0.5">
                      {t('addc_link_q_desc')}
                    </p>
                  </div>
                  {linkMode === 'ask' ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowScanner(true)}
                        className="m-btn m-btn-plain flex-1 px-3 py-2.5 text-[11.5px]"
                      >
                        <Glyph name="qr" tone="violet" size={14} /> {t('addc_link_scan')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setLinkMode('code')}
                        className="m-btn m-btn-plain flex-1 px-3 py-2.5 text-[11.5px]"
                      >
                        <Glyph name="edit" size={14} className="text-ink-600" /> {t('addc_link_code')}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <input
                          value={linkCode}
                          onChange={(e) => {
                            setLinkCode(e.target.value);
                            if (linkError) setLinkError('');
                          }}
                          placeholder={t('cds_code_placeholder')}
                          autoCapitalize="characters"
                          autoCorrect="off"
                          autoComplete="off"
                          className="input-field flex-1 min-w-0 py-2.5"
                        />
                        <button
                          type="button"
                          onClick={() => void resolveForAdd(linkCode)}
                          disabled={resolvingCode || !linkCode.trim()}
                          className="m-btn m-btn-plain shrink-0 px-4 text-[12px] text-accent-600"
                        >
                          {resolvingCode ? '…' : t('cts_find_cta')}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setLinkMode('ask'); setLinkCode(''); setLinkError(''); }}
                        className="min-h-[32px] text-[11px] font-semibold text-ink-600"
                      >
                        {t('addc_link_skip')}
                      </button>
                    </div>
                  )}
                </>
              )}
              {linkError && (
                <p className="text-[11px] text-pay-text font-semibold">{linkError}</p>
              )}
            </div>

            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="m-btn m-btn-primary w-full py-3 text-[13.5px]"
            >
              {creating ? t('cts_adding') : linkTarget ? t('addc_cta_linked') : t('addc_cta_plain')}
            </button>

            {/* Inline guidance — the heart of "users shall be guided about
                the difference". Always-visible so a new user reading the
                Add form learns the model before submitting. */}
            <button
              type="button"
              onClick={() => setShowLinkHelp((v) => !v)}
              aria-expanded={showLinkHelp}
              className="m-tile px-3.5 py-2.5 flex items-center justify-between gap-2 text-left"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Glyph name="info" tone="violet" size={14} />
                <span className="text-[11.5px] font-semibold text-ink-800 truncate">
                  {t('cts_link_help_q')}
                </span>
              </span>
              <span className="text-[10.5px] font-semibold text-ink-500 shrink-0">
                {showLinkHelp ? t('cts_hide') : t('cts_show')}
              </span>
            </button>

            {showLinkHelp && (
              <div className="m-inset p-3 space-y-3 animate-fade-in">
                <div className="flex items-start gap-2.5">
                  <div className="m-ctl w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0" aria-hidden>
                    <Glyph name="person" tone="neutral" size={14} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-ink-900">
                      {t('cts_unlinked')}
                    </p>
                    <p className="text-[11px] text-ink-600 leading-relaxed mt-0.5">
                      {t('cts_unlinked_desc')}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5">
                  <div className="m-ctl w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0" aria-hidden>
                    <Glyph name="link" tone="violet" size={14} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-ink-900">
                      {t('cts_linked')}
                    </p>
                    <p className="text-[11px] text-ink-600 leading-relaxed mt-0.5">
                      {t('cts_linked_desc')}
                    </p>
                  </div>
                </div>
                <p className="text-[10.5px] text-ink-500 leading-relaxed">
                  {t('cts_link_later')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* "Just-created" prompt — fires once after a successful add, gives
            the user an obvious one-tap path to start linking the new
            contact. They can dismiss without linking; the contact stays
            unlinked which is a perfectly valid steady state. */}
        {lastCreated && !showAdd && (
          <div className="m-card m-pink p-3.5 flex items-center gap-3 animate-fade-in">
            <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0" aria-hidden>
              <Glyph name="check" tone="green" size={18} strokeWidth={2.8} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold text-ink-900 tracking-tight">
                {t('cts_added_banner').replace('{name}', lastCreated.name)}
              </p>
              <p className="text-[11px] text-ink-600 mt-0.5 leading-relaxed">
                {t('cts_added_banner_sub')}
              </p>
            </div>
            <button
              onClick={() => {
                setSelectedId(lastCreated.id);
                setLastCreatedId(null);
              }}
              className="m-btn m-btn-primary shrink-0 min-h-[34px] rounded-xl px-3 py-1.5 text-[11px] gap-1.5"
            >
              <Glyph name="link" size={12} strokeWidth={2.6} /> {t('cts_link_cta')}
            </button>
            <button
              onClick={() => setLastCreatedId(null)}
              className="relative w-7 h-7 flex items-center justify-center text-ink-400 active:text-ink-800 shrink-0 before:absolute before:-inset-1.5 before:content-['']"
              aria-label={t('a11y_dismiss')}
            >
              <Glyph name="close" size={13} />
            </button>
          </div>
        )}

        {/* Linked-summary card — quiet steady-state reminder of how linking
            works, shown once the user has at least one contact. The chain
            link: this card counts contacts linked to a real Hisaab account. */}
        {persons.length > 0 && !showAdd && !lastCreated && (
          <div className="m-card m-pink px-4 py-3.5 flex items-center gap-3">
            <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0" aria-hidden>
              <Glyph name="link" tone="pink" size={19} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
                {(persons.length === 1 ? t('cts_linked_of_one') : t('cts_linked_of_many'))
                  .replace('{linked}', String(linkedCount))
                  .replace('{persons}', String(persons.length))}
              </p>
              <p className="text-[11px] text-ink-600 mt-0.5 leading-relaxed">
                {t('cts_linked_of_desc')}
              </p>
            </div>
          </div>
        )}

        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('cts_err_load')}
            message={loadError ?? t('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {/* Empty state — no contacts at all, or none match the query. Gated
            on loadStatus so we never flash "No contacts yet" before the
            persons fetch finishes. */}
        {loadStatus === 'loading' && persons.length === 0 ? (
          <ListSkeleton rows={4} />
        ) : persons.length === 0 ? (
          loadStatus === 'ready' ? (
            // A `person` on the pink plate — an empty contacts list is
            // missing PEOPLE.
            <EmptyState
              icon={UserPlus}
              clayIcon="person"
              tone="pink"
              title={t('cts_empty_title')}
              description={t('cts_empty_desc')}
              actionLabel={!showAdd ? t('cts_add_first') : undefined}
              onAction={!showAdd ? () => setShowAdd(true) : undefined}
            />
          ) : null
        ) : filtered.length === 0 ? (
          <p className="text-[13px] text-ink-500 text-center py-10">
            {t('cts_no_matches').replace('{query}', query)}
          </p>
        ) : (
          // Wrapped in its OWN stagger container rather than staggering the
          // page body: the body also holds the connect-code card, the add
          // form and the banners, and those must not fly in behind a list.
          //
          // Staggered by LETTER GROUP, not by contact — a 60-contact list
          // delayed per row would still be arriving after the user has
          // started scrolling. Not keyed on `query`, so typing a search
          // filters in place instead of re-animating on every keystroke.
          <div className="space-y-5 pt-2 stagger-in">
          {groups.map(([letter, people]) => (
            <div key={letter}>
              <h2 className="m-label text-[11px] tracking-[0.16em] mb-2 px-1">
                {letter}
              </h2>
              <div className="m-card overflow-hidden divide-y divide-cream-hairline">
                {people.map((person) => {
                  const unsettled = isUnsettled(person);
                  return (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => setSelectedId(person.id)}
                      className="w-full flex items-center gap-3 px-4 py-[13px] text-left active:bg-cream-soft transition-colors"
                    >
                      <UserAvatar name={person.name} size={36} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0">
                          <p className="text-[14px] font-medium text-ink-900 truncate tracking-tight max-w-full">
                            {person.name}
                          </p>
                          {/* Verified seal right after the name — only once the
                              other account has ACCEPTED the link. A
                              linked_profile_id alone is my own claim about them
                              (audit 2026-09 SEC-09). */}
                          {isConsentVerifiedLink(contactLinks, myId, person.linkedProfileId) && (
                            <VerifiedBadge size={14} title={t('contact_linked_pill')} />
                          )}
                          {/* WhatsApp badge — at a glance, whether this contact
                              has a number saved for reminders. */}
                          {hasWhatsAppNumber(person.phone) && (
                            <Glyph name="whatsapp" tone="green" size={13} label={t('cts_a11y_whatsapp_added')} />
                          )}
                          {person.linkedProfileId ? (
                            <span className="m-chip m-chip-violet m-chip-caps shrink-0">
                              {t('contact_linked_pill')}
                            </span>
                          ) : (
                            // A saved number that resolved to a Hisaab account
                            // replaces the flat "local" chip: this contact is
                            // linkable RIGHT NOW, which is worth surfacing on
                            // the row rather than only inside the sheet.
                            matchFor(person.phone) ? (
                              // Phone glyph, never the seal: the number match is
                              // an unverified claim (audit 2026-09 SEC-09). The
                              // sheet spells that out before the user links.
                              <span className="m-chip m-chip-neutral m-chip-caps shrink-0">
                                <Glyph name="phone" size={10} strokeWidth={2.6} />
                                {t('disc_badge')}
                              </span>
                            ) : (
                              <span className="m-chip m-chip-neutral m-chip-caps shrink-0 text-ink-500">
                                {t('cts_local_chip')}
                              </span>
                            )
                          )}
                        </div>
                        {/* Linked, but they haven't accepted yet — say so
                            instead of implying a two-way connection that
                            doesn't exist on their side. */}
                        {person.linkedProfileId && awaitingProfileIds.has(person.linkedProfileId) ? (
                          <p className="text-[10.5px] text-ink-600 mt-[3px] truncate flex items-center gap-1">
                            <Glyph name="clock" size={11} className="shrink-0" />
                            {t('clink_waiting').replace('{name}', person.name)}
                          </p>
                        ) : person.phone ? (
                          <p className="text-[10.5px] text-ink-600 mt-[3px] truncate tabular-nums">
                            {person.phone}
                          </p>
                        ) : null}
                      </div>
                      {/* Settled / Unsettled — at-a-glance: gold = an open
                          balance needs action, green = all clear / calm. The
                          word carries the meaning; the dot only echoes it. */}
                      <span
                        className={`m-chip m-chip-caps shrink-0 gap-[5px] px-2 py-1 ${
                          unsettled ? 'm-chip-gold' : 'm-chip-receive'
                        }`}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden />
                        {unsettled ? t('status_unsettled') : t('status_settled')}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          </div>
        )}

        {/* Archived contacts — merged-away duplicates and removed locals.
            Hidden by default (and while a search is active — its rows don't
            follow the query); refetched on EVERY open so a merge or archive
            from the detail sheet shows up without a remount. */}
        {!(showSearch && query.trim()) && (
        <div className="pt-3">
          <button
            type="button"
            onClick={() => {
              const next = !showArchived;
              setShowArchived(next);
              if (next) {
                void personsDb.getArchived()
                  .then(setArchived)
                  .catch(() => {
                    // Keep null so the next open refetches — an error must
                    // never masquerade as "no archived contacts".
                    setArchived(null);
                    setShowArchived(false);
                    toast.show({ type: 'error', title: t('contacts_archived_error') });
                  });
              }
            }}
            aria-expanded={showArchived}
            className="m-tile min-h-[44px] px-3.5 flex items-center gap-2.5 text-left"
          >
            <Glyph name="archive" size={14} className="text-ink-400" />
            <span className="text-[12px] font-semibold text-ink-600 flex-1">{t('contacts_archived_toggle')}</span>
            <Glyph
              name="chevron-down"
              size={14}
              className={`text-ink-400 transition-transform ${showArchived ? 'rotate-180' : ''}`}
            />
          </button>
          {showArchived && (
            <div className="mt-3 space-y-2">
              {archived === null ? (
                <ListSkeleton rows={2} withAvatar={false} />
              ) : archived.length === 0 ? (
                <p className="text-[11.5px] text-ink-500 px-2 py-2">{t('contacts_archived_empty')}</p>
              ) : (
                archived.map((p) => (
                  <div
                    key={p.id}
                    className="m-card px-4 py-3 flex items-center gap-2.5"
                  >
                    <span className="m-ctl w-8 h-8 rounded-[10px] text-ink-500 flex items-center justify-center text-[12px] font-bold shrink-0" aria-hidden>
                      {(p.name[0] ?? '?').toUpperCase()}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-ink-600">{p.name}</span>
                    <button
                      type="button"
                      disabled={archivedBusyId === p.id}
                      onClick={() => {
                        void (async () => {
                          // Restoring a name that now exists again creates two
                          // active same-named contacts — allowed, but never
                          // silently (name-fallback rows would show on both).
                          const collision = persons.some(
                            (x) => x.name.trim().toLowerCase() === p.name.trim().toLowerCase(),
                          );
                          if (collision) {
                            const ok = await confirmDestructive({
                              title: t('contacts_unarchive_dup_title').replace('{name}', p.name),
                              description: t('contact_dup_warning'),
                              confirmLabel: t('contacts_unarchive'),
                              tone: 'warning',
                            });
                            if (!ok) return;
                          }
                          setArchivedBusyId(p.id);
                          try {
                            const ok = await usePersonStore.getState().unarchive(p.id);
                            if (ok) {
                              setArchived((list) => (list ?? []).filter((x) => x.id !== p.id));
                              toast.show({ type: 'success', title: t('contacts_unarchive_done').replace('{name}', p.name) });
                            } else {
                              // Already restored elsewhere (row no longer archived).
                              setArchived((list) => (list ?? []).filter((x) => x.id !== p.id));
                              toast.show({ type: 'info', title: t('contacts_unarchive_gone') });
                            }
                          } catch {
                            toast.show({ type: 'error', title: t('error') });
                          } finally {
                            setArchivedBusyId(null);
                          }
                        })();
                      }}
                      className="m-pill shrink-0 px-3 text-[11px] text-accent-600 disabled:opacity-50"
                    >
                      <Glyph name="undo" size={12} strokeWidth={2.6} />
                      {t('contacts_unarchive')}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        )}
      </div>

      <ContactDetailSheet
        open={!!selected}
        person={selected}
        onClose={() => setSelectedId(null)}
      />

      {/* Scanner is a sibling of the page, not a child of the add card —
          it's a full-screen fixed overlay and must not inherit the card's
          stacking context. */}
      <QRScanner
        open={showScanner}
        onClose={() => setShowScanner(false)}
        onCode={(code) => {
          setShowScanner(false);
          // The scanner hands back a NORMALISED code; render it in the
          // familiar HSB- form so the input matches what the other person
          // sees on their screen.
          setLinkCode(formatConnectCode(code));
          setLinkMode('code');
          void resolveForAdd(code);
        }}
        onManualEntry={() => setLinkMode('code')}
      />
    </main>
  );
}
