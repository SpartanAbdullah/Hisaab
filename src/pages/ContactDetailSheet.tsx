import { useEffect, useMemo, useState } from 'react';
import { Ban, Flag, Merge } from 'lucide-react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { UserAvatar } from '../components/UserAvatar';
import type { GlyphName, GlyphTone } from '../lib/glyphs';
import { QRScanner } from '../components/QRScanner';
import { formatConnectCode } from '../lib/connectQr';
import { usePersonStore, ContactLinkError, DuplicateLinkedContactError } from '../stores/personStore';
import { useContactLinkStore } from '../stores/contactLinkStore';
import { usePhoneDiscoveryStore, findPhoneMatch } from '../stores/phoneDiscoveryStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useLoanStore } from '../stores/loanStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from '../components/Toast';
import { codeLookupBudgetSpent, resolveProfileByCode } from '../lib/collaboration';
import { formatLinkError, retryAfterMinutes } from '../lib/contactLinkStatus';
import { buildWhatsAppUrl, hasWhatsAppNumber } from '../lib/whatsappReminder';
import { formatMoney } from '../lib/constants';
import { computeTrustScore, trustLevelStyle } from '../lib/trustScore';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { markMirrorStale } from '../lib/mirrorCache';
import { VerifiedBadge } from '../components/VerifiedBadge';
import { isConsentVerifiedLink } from '../lib/contactVerification';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useBlockStore } from '../stores/blockStore';
import { BlockReportSheet, type BlockReportMode } from '../components/BlockReportSheet';
import type { Person } from '../db';
import { QuickEntry, type QuickEntryPreset } from './QuickEntry';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { SendStatementModal } from '../components/SendStatementModal';
import { ShareKhataLinkSheet } from '../components/ShareKhataLinkSheet';
import { useT } from '../lib/i18n';
import { getActionLabel } from '../lib/transactionLabel';
import type { Transaction } from '../db';

interface Props {
  open: boolean;
  person: Person | null;
  onClose: () => void;
}

type Mode = 'idle' | 'entering' | 'resolved';

// Phase 2A: per-contact sheet. Shows name, linked state, and one action —
// "Link to Hisaab user" or "Unlink". The code lookup only runs on explicit
// Resolve button press, never on keystrokes.
export function ContactDetailSheet({ open, person, onClose }: Props) {
  const { linkToProfile, linkToDiscoveredProfile, unlinkFromProfile, archiveIfSettled, updatePhone } =
    usePersonStore();
  const persons = usePersonStore((s) => s.persons);
  const syncableBreakdownFor = useLinkedRequestStore((s) => s.syncableBreakdownFor);
  const syncPastRecords = useLinkedRequestStore((s) => s.syncPastRecords);
  // Subscribe to requests so the syncable count updates after a sync fires.
  const requests = useLinkedRequestStore((s) => s.requests);
  // Loans + transactions feed the private trust score. Reads stay subscribed
  // so the score live-updates if a loan settles while this sheet is open.
  const loans = useLoanStore((s) => s.loans);
  const transactions = useTransactionStore((s) => s.transactions);
  const toast = useToast();
  const t = useT();

  const [mode, setMode] = useState<Mode>('idle');
  const [code, setCode] = useState('');
  const [resolving, setResolving] = useState(false);
  // `code` is the raw code this preview came from — the link RPC verifies it
  // server-side, so it must be carried through to the confirm step. A
  // discovery hit has no code (null) and can only use the legacy write path.
  const [resolved, setResolved] = useState<
    { profileId: string; displayName: string; code: string | null } | null
  >(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [showMergePicker, setShowMergePicker] = useState(false);
  const [merging, setMerging] = useState(false);
  const [showMoneyEntry, setShowMoneyEntry] = useState(false);
  const [moneyPreset, setMoneyPreset] = useState<QuickEntryPreset | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [savingPhone, setSavingPhone] = useState(false);
  const [showStatement, setShowStatement] = useState(false);
  const [showKhataLink, setShowKhataLink] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  // Trust & safety (audit M17). Only meaningful for a LINKED contact — an
  // unlinked row is a private note in this user's own ledger, with no account
  // on the other end to block.
  const [safetyMode, setSafetyMode] = useState<BlockReportMode | null>(null);
  const blocks = useBlockStore((s) => s.blocks);
  const loadBlocks = useBlockStore((s) => s.loadBlocks);
  const unblock = useBlockStore((s) => s.unblock);
  const unblockGuard = useSubmitGuard();

  // Double-tap guards (audit C10/F-8) — one per independent money/request
  // mutating action on this sheet. See src/lib/useSubmitGuard.ts.
  const syncGuard = useSubmitGuard();
  const linkGuard = useSubmitGuard();
  const unlinkGuard = useSubmitGuard();
  const archiveGuard = useSubmitGuard();
  const mergeGuard = useSubmitGuard();

  // Whether THEY have added this user back. A link is one-sided until the
  // other person accepts, and the sheet used to claim otherwise.
  const myId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const contactLinks = useContactLinkStore((s) => s.requests);
  const discover = usePhoneDiscoveryStore((s) => s.discover);
  const discoveryResults = usePhoneDiscoveryStore((s) => s.results);

  const savePhone = async () => {
    if (!person) return;
    setSavingPhone(true);
    try {
      await updatePhone(person.id, phoneDraft);
      setEditingPhone(false);
      toast.show({ type: 'success', title: phoneDraft.trim() ? t('contact_whatsapp_saved') : t('contact_whatsapp_removed') });
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setSavingPhone(false);
    }
  };

  useEffect(() => {
    if (!open) {
      // Reset any in-flight link flow when the sheet closes.
      setMode('idle');
      setCode('');
      setResolving(false);
      setResolved(null);
      setError('');
      setSaving(false);
      setSyncing(false);
      setArchiving(false);
      setEditingPhone(false);
      setShowStatement(false);
      setShowKhataLink(false);
      setShowScanner(false);
      setSafetyMode(null);
    }
  }, [open]);

  // Warm the block list so the sheet opens showing Block or Unblock, never the
  // wrong one. Store-level freshness gate makes a re-open free.
  useEffect(() => {
    if (open) void loadBlocks();
  }, [open, loadBlocks]);

  // Check this contact's saved number against opted-in Hisaab accounts, so
  // an unlinked contact who is already a user can be linked in one tap
  // instead of a code exchange. Store-level dedupe makes a re-open free.
  useEffect(() => {
    if (!open || !person?.phone || person.linkedProfileId) return;
    void discover([person.phone]);
  }, [open, person?.phone, person?.linkedProfileId, discover]);

  // Compute the syncable set here so the card can show an honest
  // per-currency preview. Re-runs when requests change so the card hides
  // itself after a successful sync without needing manual refresh.
  const { syncable } = useMemo(
    () => (person ? syncableBreakdownFor(person.id) : { syncable: [], skipped: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [person?.id, requests, syncableBreakdownFor],
  );
  // Bucket the open balance by currency so we never quietly add PKR into
  // an AED total (different units). The sync action sends each loan as
  // its own request with its own currency — we just need the preview
  // to be honest about it.
  const syncableByCurrency = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const loan of syncable) {
      const bucket = map.get(loan.currency) ?? { total: 0, count: 0 };
      bucket.total += loan.remainingAmount;
      bucket.count += 1;
      map.set(loan.currency, bucket);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [syncable]);

  // Private trust score. Computed only against this person's loans, so the
  // dependency list is precise — re-runs when their loans or repayments
  // change but not when unrelated loans mutate. The score is never sent
  // anywhere: it exists only in the current user's view of this contact.
  const trustScore = useMemo(
    () => (person ? computeTrustScore(person.id, person.name, loans, transactions) : null),
    [person, loans, transactions],
  );

  if (!person) return null;

  const isLinked = !!person.linkedProfileId;
  // The seal — and the "connected both ways" prose — needs CONSENT, not a
  // linked_profile_id I wrote myself — see src/lib/contactVerification.ts
  // (audit 2026-09 SEC-09). An unaccepted or legacy link falls through to
  // the waiting copy below instead of claiming a mutual connection.
  const linkVerified = isConsentVerifiedLink(contactLinks, myId, person.linkedProfileId);
  // Derived from the subscribed snapshot (not a store read) so the badge
  // repaints on the render where the lookup landed.
  const discoveryHit = isLinked ? null : findPhoneMatch(discoveryResults, person.phone);
  const trustStyle = trustScore ? trustLevelStyle(trustScore.level) : null;
  const relationshipBalances = (() => {
    const byCurrency = new Map<string, number>();
    for (const loan of loans.filter((entry) => entry.personId === person.id && entry.status === 'active')) {
      const delta = loan.type === 'given' ? loan.remainingAmount : -loan.remainingAmount;
      byCurrency.set(loan.currency, (byCurrency.get(loan.currency) ?? 0) + delta);
    }
    return [...byCurrency.entries()].filter(([, value]) => Math.abs(value) > 0.00001);
  })();
  // Trust & safety derivations. `isBlocked` reads MY block list only — there is
  // deliberately no way to ask whether THEY blocked ME (docs/trust-and-safety
  // RULE 1), and nothing here should ever try.
  const isBlocked = !!person.linkedProfileId && blocks.some((b) => b.blockedId === person.linkedProfileId);
  // RULE 2's nudge: a live balance means "settle to zero, then block" is the
  // cleaner sequence. Blocking with money open is still allowed — freezing an
  // existing debt would turn a safety feature into a collection weapon.
  const openBalanceText = (() => {
    const first = relationshipBalances.find(([, value]) => Math.abs(value) > 0.00001);
    return first ? formatMoney(Math.abs(first[1]), first[0]) : null;
  })();

  const handleUnblock = () => unblockGuard.run(async () => {
    if (!person.linkedProfileId) return;
    const ok = await confirmDestructive({
      title: t('blk_unblock_confirm_title').replace('{name}', person.name),
      description: t('blk_unblock_confirm_body'),
      confirmLabel: t('blk_action_unblock'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await unblock(person.linkedProfileId);
      toast.show({ type: 'success', title: t('blk_unblocked_toast').replace('{name}', person.name) });
    } catch {
      toast.show({ type: 'error', title: t('blk_failed') });
    }
  });

  // All of this contact's loans (personId, with a name fallback for legacy
  // loans created before the contact record existed) — the raw material for a
  // statement that spans every loan direction and currency with this person.
  const personLoans = loans.filter(
    (loan) =>
      !loan.deletedAt &&
      (loan.personId === person.id ||
        (!loan.personId && loan.personName.trim().toLowerCase() === person.name.trim().toLowerCase())),
  );
  const recentEntries = transactions
    .filter((transaction) => transaction.personId === person.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  const openMoneyEntry = (entryPreset: QuickEntryPreset) => {
    setMoneyPreset({
      ...entryPreset,
      contact: { id: person.id, name: person.name },
      lockContact: true,
    });
    setShowMoneyEntry(true);
  };

  // Guarded: syncPastRecords loops createRequest via Promise.all internally —
  // a double tap would send 2N cross-user requests (audit C10/F-8).
  const handleSyncPastRecords = () => syncGuard.run(runSyncPastRecords);
  const runSyncPastRecords = async () => {
    if (!person) return;
    const ok = await confirmDestructive({
      title: t('contact_sync_confirm_title').replace('{name}', person.name),
      description: t('contact_sync_confirm_body'),
      confirmLabel: t('contact_sync_confirm_cta'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    setSyncing(true);
    try {
      const result = await syncPastRecords(person.id);
      if (result.created.length > 0) {
        const skippedNote =
          result.skipped.length > 0
            ? t('cds_sync_skipped_note').replace('{n}', String(result.skipped.length))
            : '';
        toast.show({
          type: 'success',
          title:
            result.created.length === 1
              ? t('cds_sync_sent_one')
              : t('cds_sync_sent_many').replace('{n}', String(result.created.length)),
          subtitle: t('cds_sync_sent_sub').replace('{extra}', skippedNote),
        });
      }
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('cds_sync_err'),
        subtitle: err instanceof Error ? err.message : t('common_try_again_soon'),
      });
    } finally {
      setSyncing(false);
    }
  };

  // A throttled lookup returns zero rows, exactly like a genuine miss, so the
  // only hint we have is our own count of charges this hour.
  const noPreviewMessage = () =>
    codeLookupBudgetSpent()
      ? t('clink_err_rate_limited').replace('{minutes}', String(retryAfterMinutes(undefined)))
      : t('clink_err_no_match');

  const handleResolve = async () => {
    setError('');
    setResolved(null);
    const trimmed = code.trim();
    if (!trimmed) {
      setError(t('clink_err_invalid_code'));
      return;
    }
    setResolving(true);
    try {
      const found = await resolveProfileByCode(trimmed);
      if (!found) {
        setError(noPreviewMessage());
        return;
      }
      setResolved({ ...found, code: trimmed });
      setMode('resolved');
    } catch {
      setError(t('addc_link_err_lookup'));
    } finally {
      setResolving(false);
    }
  };

  const handleConfirmLink = () => linkGuard.run(runConfirmLink);
  const runConfirmLink = async () => {
    if (!resolved) return;
    setSaving(true);
    setError('');
    try {
      // Both paths are server-verified now; only the PROOF differs. Code path:
      // the server re-resolves the code (the resolved profile rides along only
      // as the pre-migration fallback). Discovery path: no code exists, so the
      // server re-runs the phone match itself against this contact's saved
      // number — the profile id below is a claim it checks, not a credential.
      const linked = resolved.code
        ? await linkToProfile(person.id, resolved.code, {
            profileId: resolved.profileId,
            displayName: resolved.displayName,
          })
        : await linkToDiscoveredProfile(person.id, resolved.profileId, resolved.displayName);
      toast.show({
        type: 'success',
        title: t('clink_added_toast').replace('{name}', linked.displayName || resolved.displayName),
        // Honest about consent: linked on your side; theirs is their call.
        subtitle:
          linked.linkState === 'mutual'
            ? t('clink_mutual')
            : t('clink_waiting').replace('{name}', linked.displayName || resolved.displayName),
      });
      onClose();
    } catch (err) {
      if (err instanceof DuplicateLinkedContactError) {
        // Name the contact that's already linked to this person — a common case
        // when both sides exchange codes and a reciprocal contact was auto-made,
        // so the user isn't stuck on an opaque "already linked" message.
        const existing = persons.find((p) => p.linkedProfileId === resolved.profileId && p.id !== person.id);
        setError(
          existing
            ? t('contact_dup_link_named').replace('{name}', existing.name)
            : t('contact_dup_link_generic'),
        );
      } else {
        // Same statuses either way, but NO_MATCH / RATE_LIMITED need discovery
        // wording — "check the code" is meaningless when there was no code.
        setError(formatLinkError(err, t, resolved.code ? 'code' : 'discovery'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUnlink = () => unlinkGuard.run(runUnlink);
  const runUnlink = async () => {
    const ok = await confirmDestructive({
      title: t('contact_unlink_confirm_title').replace('{name}', person.name),
      description: t('contact_unlink_confirm_body'),
      confirmLabel: t('contact_unlink_confirm_cta'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      await unlinkFromProfile(person.id);
      onClose();
    } catch (err) {
      // Unlink has its own copy for the generic case; a specific server status
      // (not signed in, contact gone) still gets its own message.
      const status = err instanceof ContactLinkError ? err.status : 'UNKNOWN';
      setError(status === 'UNKNOWN' ? t('clink_err_unlink') : formatLinkError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = () => archiveGuard.run(runArchive);
  const runArchive = async () => {
    const confirmed = await confirmDestructive({
      title: t('cds_remove_confirm_title'),
      description: t('del_contact_body'),
      confirmLabel: t('cds_remove_confirm_cta'),
    });
    if (!confirmed) return;

    setArchiving(true);
    setError('');
    try {
      const result = await archiveIfSettled(person.id);
      if (!result.success) {
        setError(result.userMessage);
        return;
      }
      toast.show({
        type: 'success',
        title: t('cds_removed_title'),
        subtitle: t('cds_removed_sub'),
      });
      onClose();
    } catch {
      setError(t('cds_remove_err'));
    } finally {
      setArchiving(false);
    }
  };

  // Fold this LOCAL duplicate into another contact: one atomic server-side
  // RPC reassigns every loan/transaction (id-keyed AND name-fallback rows),
  // then archives this row. Loans/transactions are mirrored stores — mark
  // them stale and refetch so the reassignment is visible immediately.
  const handleMerge = (target: Person) => mergeGuard.run(() => runMerge(target));
  const runMerge = async (target: Person) => {
    const confirmed = await confirmDestructive({
      title: t('merge_confirm_title').replace('{target}', target.name),
      description: t('merge_confirm_body')
        .replace('{source}', person.name)
        .replace('{target}', target.name),
      confirmLabel: t('merge_cta'),
      tone: 'warning',
    });
    if (!confirmed) return;
    setMerging(true);
    setError('');
    try {
      const result = await usePersonStore.getState().mergePerson(person.id, target.id);
      if (!result.success) {
        setShowMergePicker(false);
        // The RPC returns structured reason codes precisely so the client
        // owns the words — never surface the server's English strings.
        setError(
          result.reasonCode === 'LINKED_CONTACT' ? t('merge_err_linked')
          : result.reasonCode === 'SAME_CONTACT' ? t('merge_err_same')
          : t('merge_err_not_found'),
        );
        return;
      }
      markMirrorStale('loans');
      markMirrorStale('transactions');
      void useLoanStore.getState().loadLoans().catch(() => {});
      void useTransactionStore.getState().loadTransactions().catch(() => {});
      toast.show({
        type: 'success',
        title: t('merge_done').replace('{target}', target.name),
        subtitle: t('merge_done_sub')
          .replace('{n}', String(result.movedLoans))
          .replace('{m}', String(result.movedTransactions)),
      });
      setShowMergePicker(false);
      onClose();
    } catch (err) {
      setShowMergePicker(false);
      // PGRST202 = the merge RPC doesn't exist yet (SQL migration not
      // applied). Everything else gets the generic bilingual message —
      // raw PostgREST/network text never reaches the user.
      const code = (err as { code?: string } | null)?.code;
      setError(code === 'PGRST202' ? t('merge_err_migration') : t('merge_err_generic'));
    } finally {
      setMerging(false);
    }
  };

  const moneyActions: Array<
    Pick<QuickEntryPreset, 'type' | 'repaymentDirection'> & { label: string; glyph: GlyphName; tone: GlyphTone }
  > = [
    { label: t('person_gave'), type: 'loan_given', glyph: 'banknote', tone: 'coral' },
    { label: t('person_borrowed'), type: 'loan_taken', glyph: 'coins', tone: 'green' },
    { label: t('person_paid_me_back'), type: 'repayment', repaymentDirection: 'received', glyph: 'arrow-down', tone: 'green' },
    { label: t('person_i_paid_back'), type: 'repayment', repaymentDirection: 'paid', glyph: 'arrow-up', tone: 'coral' },
  ];

  return (
    <>
    <Modal open={open} onClose={onClose} title={person.name}>
      <div className="space-y-3.5">
        <div className="flex items-center gap-3">
          <UserAvatar name={person.name} size={44} />
          <div className="flex-1 min-w-0">
            {/* Inner span carries `truncate` — ellipsis doesn't work on flex
                containers, and a bare text node can't shrink (min-content),
                which clipped the badge off-screen for long names. */}
            <p className="text-[14px] font-semibold text-ink-900 flex items-center gap-1.5 min-w-0">
              <span className="truncate">{person.name}</span>
              {linkVerified && <VerifiedBadge size={15} title={t('contact_linked_pill')} />}
            </p>
            {isLinked && person.linkedProfileId ? (
              // Surface WHICH Hisaab account this contact is paired with so the
              // user can verify before syncing or unlinking. The display name
              // is the contact's own name; the short account ref (font-mono)
              // is the stable, comparable identifier for that account.
              <p className="text-[11px] text-ink-600 truncate mt-0.5">
                {t('contact_linked_to')} <span className="font-semibold text-ink-800">{person.name}</span>
                {' · '}
                <span className="font-mono text-ink-600">{person.linkedProfileId.slice(0, 8)}</span>
              </p>
            ) : (
              <p className="text-[11px] text-ink-600 mt-0.5">
                {t('contact_not_linked')}
              </p>
            )}
          </div>
          {isLinked && (
            <span className="m-chip m-chip-violet m-chip-caps shrink-0">
              {t('contact_linked_pill')}
            </span>
          )}
        </div>

        {/* Where we stand with this person — the pink (contacts / khata)
            tinted card. */}
        <div className="m-card m-pink p-4">
          <p className="m-label text-blush-text">{t('current_balance')}</p>
          {relationshipBalances.length === 0 ? (
            <p className="text-[14px] font-semibold text-ink-900 mt-1.5">{t('cds_settled_with').replace('{name}', person.name)}</p>
          ) : (
            <div className="space-y-1 mt-1.5">
              {relationshipBalances.map(([currency, balance]) => (
                <p key={currency} className="text-[14px] font-semibold text-ink-900">
                  {balance > 0
                    ? t('loan_done_owes_you')
                        .replace('{person}', person.name)
                        .replace('{amount}', formatMoney(balance, currency))
                    : t('loan_done_you_owe')
                        .replace('{person}', person.name)
                        .replace('{amount}', formatMoney(Math.abs(balance), currency))}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Send a full Statement of Account with this contact — spans every
            loan (both directions) and currency, delivered as a one-page PDF or
            a WhatsApp text ping. Shown once there's any loan history. */}
        {personLoans.length > 0 && (
          <button
            type="button"
            onClick={() => setShowStatement(true)}
            className="m-btn m-btn-plain w-full py-3 text-[13px]"
          >
            <Glyph name="document" tone="violet" size={15} /> {t('soa_cta')}
          </button>
        )}

        {/* Khata link — the always-live shareable balance page (audit P3 L2).
            Distinct from the statement above: this is a standing link, not a
            one-off send. Archived contacts can't open this sheet in the normal
            flow, but the guard is kept explicit here since ContactDetailSheet
            can be handed an archived Person directly. */}
        {!person.archivedAt && (
          <button
            type="button"
            onClick={() => setShowKhataLink(true)}
            className="m-btn m-btn-plain w-full py-3 text-[13px]"
          >
            <Glyph name="link" tone="pink" size={15} /> {t('khata_share_open_cta')}
          </button>
        )}

        {/* WhatsApp number — add it once so payment reminders go straight to
            their chat, and so the contact list shows the WhatsApp badge. */}
        <div className="m-card p-3.5">
          <div className="flex items-center gap-2.5">
            <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0" aria-hidden>
              <Glyph
                name="whatsapp"
                tone={hasWhatsAppNumber(person.phone) ? 'green' : 'current'}
                size={17}
                className={hasWhatsAppNumber(person.phone) ? undefined : 'text-ink-400'}
              />
            </div>
            {editingPhone ? (
              <div className="flex-1 flex items-center gap-2">
                <input
                  autoFocus
                  value={phoneDraft}
                  onChange={(e) => setPhoneDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void savePhone(); } if (e.key === 'Escape') setEditingPhone(false); }}
                  placeholder="+971 50 123 4567"
                  inputMode="tel"
                  className="input-field flex-1 min-w-0 py-2"
                />
                <button type="button" disabled={savingPhone} onClick={() => void savePhone()} className="m-ctl w-9 h-9 shrink-0 flex items-center justify-center disabled:opacity-40" aria-label={t('cat_save')}><Glyph name="check" tone="green" size={16} strokeWidth={2.8} /></button>
                <button type="button" onClick={() => setEditingPhone(false)} className="m-ctl w-9 h-9 shrink-0 flex items-center justify-center" aria-label={t('cancel')}><Glyph name="close" size={15} className="text-ink-500" /></button>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <p className="text-[12.5px] font-semibold text-ink-900">{t('contact_whatsapp')}</p>
                  <p className="text-[11px] text-ink-600 truncate tabular-nums">{person.phone || t('contact_whatsapp_none')}</p>
                </div>
                {hasWhatsAppNumber(person.phone) && (
                  <a href={buildWhatsAppUrl(person.phone, '')} target="_blank" rel="noopener noreferrer" className="relative shrink-0 w-8 h-8 flex items-center justify-center" aria-label={t('a11y_whatsapp')}>
                    <Glyph name="whatsapp" tone="green" size={18} />
                  </a>
                )}
                <button type="button" onClick={() => { setPhoneDraft(person.phone ?? ''); setEditingPhone(true); }} className="text-accent-600 text-[11.5px] font-semibold shrink-0 min-h-[32px]">
                  {person.phone ? t('contact_whatsapp_edit') : t('contact_whatsapp_add')}
                </button>
              </>
            )}
          </div>
        </div>

        <div>
          <p className="m-label px-1 mb-2">{t('add_money_entry')}</p>
          {/* Four pressable tiles; the glyph tone says which way money
              moves (coral = out of your pocket, green = into it). */}
          <div className="grid grid-cols-2 gap-2.5">
            {moneyActions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => openMoneyEntry({ type: action.type, repaymentDirection: action.repaymentDirection })}
                className="m-tile px-3 py-3 text-left"
              >
                <Glyph name={action.glyph} tone={action.tone} size={18} className="mb-2" />
                <span className="block text-[12.5px] font-semibold text-ink-900 leading-snug">{action.label}</span>
              </button>
            ))}
          </div>
        </div>

        {recentEntries.length > 0 && (
          <div className="m-card p-3.5">
            <p className="m-label mb-2">{t('recent_money_history')}</p>
            <div className="space-y-2">
              {recentEntries.map((entry) => {
                const linkedLoan = entry.relatedLoanId ? loans.find((l) => l.id === entry.relatedLoanId) ?? null : null;
                const label = getActionLabel(entry, t, { personName: person.name, loan: linkedLoan });
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setEditingTransaction(entry)}
                    className="w-full flex justify-between gap-3 text-[12.5px] text-left rounded-lg py-1 min-h-[32px] items-center active:bg-cream-soft transition-colors"
                  >
                    <span className="text-ink-800 truncate">{label}</span>
                    <span className="font-semibold text-ink-900 shrink-0 tabular-nums">{formatMoney(entry.amount, entry.currency)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {recentEntries.length === 0 && (
          <p className="m-inset text-[12px] text-ink-600 px-3.5 py-3 leading-relaxed">
            {t('cds_no_history').replace('{name}', person.name)}
          </p>
        )}

        {/* Private trust history card. Visible only when there's at least one
            prior loan with this person — for fresh contacts the score is
            empty and hiding the card keeps the sheet clean. */}
        {trustScore && trustStyle && trustScore.totalLoans > 0 && (
          <div className="m-card p-3.5">
            <div className="flex items-start gap-3">
              <div className="m-ctl w-9 h-9 flex items-center justify-center shrink-0" aria-hidden>
                <Glyph name="shield-check" tone="neutral" size={17} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[12.5px] font-semibold text-ink-900 tracking-tight">
                    {t('cds_private_history')}
                  </p>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-widest rounded-full px-2 py-0.5 border ${trustStyle.badgeClass} flex items-center gap-1.5`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${trustStyle.dot}`} />
                    {trustStyle.label}
                  </span>
                </div>
                <p className="text-[11px] text-ink-600 mt-1 leading-relaxed">
                  {trustScore.summary}
                </p>
                <div className="grid grid-cols-3 gap-2 mt-2.5">
                  <div className="m-inset px-2.5 py-2">
                    <p className="m-label text-[9.5px]">
                      {t('cds_stat_total')}
                    </p>
                    <p className="text-[14px] text-ink-900 font-semibold tabular-nums mt-0.5">
                      {trustScore.totalLoans}
                    </p>
                  </div>
                  <div className="m-inset px-2.5 py-2">
                    <p className="m-label text-[9.5px]">
                      {t('cds_stat_settled')}
                    </p>
                    <p className="text-[14px] text-receive-text font-semibold tabular-nums mt-0.5">
                      {trustScore.settledLoans}
                    </p>
                  </div>
                  <div className="m-inset px-2.5 py-2">
                    <p className="m-label text-[9.5px]">
                      {t('cds_stat_open')}
                    </p>
                    <p className="text-[14px] text-ink-900 font-semibold tabular-nums mt-0.5">
                      {trustScore.activeLoans}
                    </p>
                  </div>
                </div>
                <p className="text-[10.5px] text-ink-500 mt-2 italic leading-relaxed">
                  {t('cds_private_note')}
                </p>
              </div>
            </div>
          </div>
        )}

        {isLinked ? (
          <div className="space-y-3">
            {/* Phase 2D: Sync past records. Surfaces only after linking,
                only when there's something to share. Each loan becomes one
                linked request in the recipient's Inbox; the sender's
                existing loan history (repayments, EMI, notes) stays
                intact — the RPC reuses it on accept. */}
            {syncable.length > 0 && (
              <div className="m-card m-violet p-4">
                <div className="flex items-start gap-3">
                  <div className="m-ctl w-10 h-10 rounded-[14px] flex items-center justify-center shrink-0" aria-hidden>
                    <Glyph name="recurring" tone="violet" size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
                      {(syncable.length === 1
                        ? t('cds_past_records_one')
                        : t('cds_past_records_many').replace('{n}', String(syncable.length))
                      ).replace('{name}', person.name)}
                    </p>
                    <p className="text-[11px] text-ink-600 mt-0.5 leading-relaxed">
                      {t('cds_past_records_desc')}
                    </p>
                  </div>
                </div>
                {syncableByCurrency.length > 0 && (
                  <div className="text-[11px] text-ink-600 mt-2.5 pl-[52px] space-y-0.5">
                    <p className="text-ink-600">{t('cds_open_balance')}</p>
                    {syncableByCurrency.map(([currency, { total, count }]) => (
                      <p
                        key={currency}
                        className="tabular-nums flex items-baseline justify-between gap-3"
                      >
                        <span className="font-semibold text-ink-900">
                          {formatMoney(total, currency)}
                        </span>
                        <span className="text-ink-600 text-[10.5px]">
                          {count === 1
                            ? t('common_loan_one')
                            : t('common_loan_many').replace('{n}', String(count))}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
                <button
                  onClick={handleSyncPastRecords}
                  disabled={syncing}
                  className="m-btn m-btn-primary mt-3.5 w-full py-2.5 text-[12.5px]"
                >
                  <Glyph name="refresh" size={13} strokeWidth={2.6} />
                  {syncing
                    ? t('cds_sending')
                    : syncable.length === 1
                    ? t('cds_sync_cta_one')
                    : t('cds_sync_cta_many').replace('{n}', String(syncable.length))}
                </button>
              </div>
            )}

            {linkVerified ? (
              <p className="text-[11px] text-ink-600 leading-relaxed">
                {t('clink_mutual')} &mdash;{' '}
                {t('cds_mutual_desc').replace('{name}', person.name)}
              </p>
            ) : (
              // Honest intermediate state. Claiming a mutual connection that
              // the other side hasn't consented to (still pending, or a
              // legacy link predating the consent flow) is exactly the
              // confusion that made people ask "why can't they see me?" —
              // see src/lib/contactVerification.ts (audit 2026-09 SEC-09).
              <div className="m-card m-violet p-3.5 flex items-start gap-2.5">
                <Glyph name="clock" tone="violet" size={16} className="mt-0.5" />
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-ink-900">
                    {t('clink_waiting').replace('{name}', person.name)}
                  </p>
                  <p className="text-[11px] text-ink-600 mt-0.5 leading-relaxed">
                    {t('clink_waiting_desc')}
                  </p>
                </div>
              </div>
            )}
            <button
              onClick={handleUnlink}
              disabled={saving}
              className="cta-destructive"
            >
              {saving ? t('cds_working') : t('cds_unlink')}
            </button>
          </div>
        ) : mode === 'idle' ? (
          <div className="space-y-2">
            {/* One-tap link when this contact's saved number already resolved
                to a Hisaab account — no code exchange needed at all.
                NO verified seal here (audit 2026-09 SEC-09): phone numbers are
                self-claimed with zero ownership check, so this match proves
                only that SOME account claims this number. A neutral phone
                glyph plus an explicit caption, so nobody links a stranger
                believing Hisaab vouched for them. */}
            {discoveryHit && (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  // No code behind a phone match — see handleConfirmLink.
                  setResolved({
                    profileId: discoveryHit.profileId,
                    displayName: discoveryHit.displayName,
                    code: null,
                  });
                  setMode('resolved');
                }}
                className="m-tile px-3.5 py-3 flex items-start gap-2.5 text-left"
              >
                <Glyph name="phone" size={16} className="mt-0.5 text-ink-500" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] text-ink-800 leading-snug">
                    {t('disc_found').replace('{name}', discoveryHit.displayName)}
                  </span>
                  <span className="block text-[10.5px] text-ink-600 leading-relaxed mt-0.5">
                    {t('disc_unverified_note')}
                  </span>
                </span>
                <span className="shrink-0 text-[11.5px] font-bold text-accent-600 mt-0.5">
                  {t('disc_link_cta')}
                </span>
              </button>
            )}
            <div className="flex gap-2.5">
              <button
                onClick={() => setShowScanner(true)}
                className="m-btn m-btn-primary flex-1 px-3 py-3 text-[12.5px]"
              >
                <Glyph name="qr" size={15} strokeWidth={2.6} /> {t('qr_scan_cta')}
              </button>
              <button
                onClick={() => setMode('entering')}
                className="m-btn m-btn-plain flex-1 px-3 py-3 text-[12.5px]"
              >
                <Glyph name="edit" size={14} className="text-ink-600" /> {t('addc_link_code')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label htmlFor="cds-link-code" className="form-label">
                {t('cds_user_code_label')}
              </label>
              <input
                id="cds-link-code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  // Invalidate any prior resolved state on every edit so the
                  // user must press Resolve again for the new value.
                  if (resolved) setResolved(null);
                  if (mode === 'resolved') setMode('entering');
                  if (error) setError('');
                }}
                placeholder={t('cds_code_placeholder')}
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                className="input-field"
              />
              <p className="text-[11px] text-ink-600 mt-1.5">
                {t('cds_code_help')}
              </p>
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                className="mt-2 min-h-[32px] inline-flex items-center gap-1.5 text-[11.5px] font-bold text-accent-600"
              >
                <Glyph name="qr" size={14} strokeWidth={2.6} /> {t('qr_scan_cta')}
              </button>
            </div>

            {mode === 'resolved' && resolved ? (
              <div className="m-card m-mint p-3.5">
                <p className="m-label text-receive-text">{t('cds_found')}</p>
                <p className="text-[14px] font-semibold text-ink-900 mt-1">{resolved.displayName}</p>
                <p className="text-[11px] text-ink-600 mt-1 leading-relaxed">
                  {/* Precise about what confirming does and doesn't do: the
                      link is yours immediately; appearing in THEIR contacts
                      is their call, not something this button decides. */}
                  {t('cds_confirm_explainer').replace('{name}', resolved.displayName)}
                </p>
              </div>
            ) : (
              <button
                onClick={handleResolve}
                disabled={resolving || !code.trim()}
                className="m-btn m-btn-primary w-full py-3 text-[13px]"
              >
                {resolving ? t('cds_looking_up') : t('cds_resolve')}
              </button>
            )}

            {mode === 'resolved' && resolved && (
              <div className="flex gap-2.5">
                <button
                  onClick={() => {
                    setMode('entering');
                    setResolved(null);
                  }}
                  disabled={saving}
                  className="m-btn m-btn-plain px-4 py-3 text-[12.5px]"
                >
                  {t('cancel')}
                </button>
                <button
                  onClick={handleConfirmLink}
                  disabled={saving}
                  className="m-btn m-btn-primary flex-1 py-3 text-[13px]"
                >
                  {saving ? t('cds_linking') : t('cds_confirm_link')}
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="m-card m-coral text-[12px] text-pay-text font-semibold px-3.5 py-3 leading-relaxed">{error}</p>
        )}

        {!isLinked && (
          <div className="pt-1 border-t border-cream-hairline">
            {/* Merge: a local duplicate is the only legal merge SOURCE —
                linked contacts can only ever absorb, never be merged away. */}
            <button
              type="button"
              onClick={() => setShowMergePicker(true)}
              disabled={merging || archiving || saving}
              className="m-btn m-btn-plain w-full mt-3.5 py-3 text-[12.5px]"
            >
              <Merge size={14} strokeWidth={2.4} className="text-ink-600" aria-hidden />
              {t('merge_button')}
            </button>
            <button
              type="button"
              onClick={handleArchive}
              disabled={archiving || saving}
              className="m-btn m-btn-danger w-full mt-2.5 py-3 text-[12.5px]"
            >
              <Glyph name="trash" size={14} strokeWidth={2.6} />
              {archiving ? t('cds_removing') : t('cds_remove_local')}
            </button>
            <p className="text-[10.5px] text-ink-500 mt-2 text-center leading-relaxed">
              {t('cds_remove_after_settled')}
            </p>
          </div>
        )}

        {/* Block / report — audit M17. Sits below Archive/Unlink because it is
            the last resort, not a routine action. Linked contacts only: an
            unlinked row has no account on the other end. */}
        {isLinked && person.linkedProfileId && (
          <div className="pt-1 border-t border-cream-hairline space-y-2.5">
            <button
              type="button"
              onClick={isBlocked ? handleUnblock : () => setSafetyMode('block')}
              className={`m-btn w-full mt-3.5 py-3 text-[12.5px] ${
                isBlocked ? 'm-btn-plain' : 'm-btn-danger'
              }`}
            >
              <Ban size={14} strokeWidth={2.4} aria-hidden />
              {isBlocked ? t('blk_action_unblock') : t('blk_action_block')}
            </button>
            <button
              type="button"
              onClick={() => setSafetyMode('report')}
              className="m-btn m-btn-plain w-full py-3 text-[12.5px]"
            >
              <Flag size={14} strokeWidth={2.4} className="text-ink-600" aria-hidden />
              {t('blk_action_report')}
            </button>
          </div>
        )}
      </div>
    </Modal>
    <BlockReportSheet
      open={!!safetyMode}
      mode={safetyMode ?? 'block'}
      targetUserId={person.linkedProfileId ?? null}
      targetName={person.name}
      contextType="contact"
      contextId={person.id}
      openBalanceText={openBalanceText}
      onClose={() => setSafetyMode(null)}
    />
    <QuickEntry
      open={showMoneyEntry}
      preset={moneyPreset}
      onClose={() => {
        setShowMoneyEntry(false);
        setMoneyPreset(null);
      }}
    />
    <EditTransactionModal
      open={!!editingTransaction}
      transaction={editingTransaction}
      onClose={() => setEditingTransaction(null)}
    />
    <SendStatementModal
      open={showStatement}
      onClose={() => setShowStatement(false)}
      partyName={person.name}
      loans={personLoans}
      transactions={transactions}
      scope="contact"
      phone={person.phone}
    />
    <ShareKhataLinkSheet
      open={showKhataLink}
      onClose={() => setShowKhataLink(false)}
      personId={person.id}
      personName={person.name}
      phone={person.phone}
    />
    {/* Scanner overlays the whole screen, so it lives outside the Modal's
        transformed container (a fixed child of a transformed ancestor is
        positioned against that ancestor, not the viewport). */}
    <QRScanner
      open={showScanner}
      onClose={() => setShowScanner(false)}
      onCode={(scanned) => {
        setShowScanner(false);
        setCode(formatConnectCode(scanned));
        setMode('entering');
        // Resolve straight away: the user pointed a camera at a specific
        // person's code — making them then press "Resolve" is a step with
        // no decision in it.
        void (async () => {
          setError('');
          setResolved(null);
          setResolving(true);
          try {
            const found = await resolveProfileByCode(scanned);
            if (!found) {
              setError(noPreviewMessage());
              return;
            }
            setResolved({ ...found, code: scanned });
            setMode('resolved');
          } catch {
            setError(t('addc_link_err_lookup'));
          } finally {
            setResolving(false);
          }
        })();
      }}
      onManualEntry={() => setMode('entering')}
    />
    {/* Merge target picker — sibling of the sheet (fixed overlays must not
        nest inside a transformed modal). */}
    <Modal open={showMergePicker} onClose={() => setShowMergePicker(false)} title={t('merge_pick_title')}>
      <div className="space-y-2.5">
        <p className="text-[12px] text-ink-600 leading-relaxed pb-1">
          {t('merge_pick_desc').replace('{source}', person.name)}
        </p>
        {(() => {
          // Cards are not people: legacy card-named person rows (pre-rebuild
          // cash advances) must never absorb a human's history. Exclude any
          // contact whose name matches an account.
          const accountNames = new Set(
            useAccountStore.getState().accounts.map((a) => a.name.trim().toLowerCase()),
          );
          const targets = persons.filter(
            (p) => p.id !== person.id && !accountNames.has(p.name.trim().toLowerCase()),
          );
          if (targets.length === 0) {
            return <p className="text-[12px] text-ink-500 px-1 py-3">{t('merge_pick_empty')}</p>;
          }
          return targets.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={merging}
              onClick={() => void handleMerge(p)}
              className="m-tile px-4 py-3 flex items-center gap-2.5 text-left"
            >
              <UserAvatar name={p.name} size={32} />
              <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-ink-900">{p.name}</span>
              {isConsentVerifiedLink(contactLinks, myId, p.linkedProfileId) && (
                <VerifiedBadge size={14} title={t('contact_linked_pill')} />
              )}
            </button>
          ));
        })()}
      </div>
    </Modal>
    </>
  );
}
