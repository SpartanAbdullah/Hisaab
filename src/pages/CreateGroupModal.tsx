import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useSplitStore, type GuestMemberInput, type ResolvedMemberInput } from '../stores/splitStore';
import {
  MAX_GROUP_GUESTS,
  MAX_GUEST_NAME_LENGTH,
  guestNameProblemMessage,
  validateGuestName,
} from '../lib/groupGuests';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { type Currency, type SplitGroup } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { CurrencyPicker } from '../components/CurrencyPicker';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { profilesDb } from '../lib/supabaseDb';
import { normalizePublicCode } from '../lib/collaboration';
import { track } from '../lib/telemetry';
import { bucketCount } from '../lib/telemetryEvents';

const EMOJIS = ['✈️', '🍕', '🏠', '🎉', '🛒', '💼', '🎓', '🏖️', '⚽', '🎮', '🍔', '☕', '🎬', '🚗', '💊', '🎁', '👨‍👩‍👧‍👦', '🏋️', '📱', '🎵', '🍳', '🧳', '🎃', '❤️'];

interface Props {
  open: boolean;
  onClose: () => void;
  // Optional override of the post-create behaviour. Default: navigate to
  // the new group's detail page (so the user lands on the activation
  // loop). QuickEntry's "Group expense → Create new" flow passes this
  // to redirect into AddGroupExpenseModal instead, carrying the amount
  // the user already typed.
  onCreated?: (group: SplitGroup) => void;
}

export function CreateGroupModal({ open, onClose, onCreated }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  const { createGroup } = useSplitStore();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('✈️');
  const [currency, setCurrency] = useState<Currency>(() => getPrimaryCurrency());
  // Ranks the CurrencyPicker's five inline chips from the currencies this
  // user already holds money in. accountStore is a global store that is
  // already loaded app-wide, so this subscribes to data in memory — no fetch.
  const accounts = useAccountStore((s) => s.accounts);
  const usedCurrencies = useMemo(() => [...new Set(accounts.map((a) => a.currency))], [accounts]);
  const [codeInput, setCodeInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [members, setMembers] = useState<ResolvedMemberInput[]>([]);
  // People who will never install Hisaab (audit G6 / O4, July blocker B6).
  // Staged locally and written by createGroup through add_group_guest once the
  // group row exists — a guest seat needs a group_id, and the phone hash needs
  // the definer RPC.
  const [guests, setGuests] = useState<GuestMemberInput[]>([]);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName(''); setEmoji('✈️'); setCodeInput(''); setMembers([]);
    setGuests([]); setGuestName(''); setGuestPhone('');
  };

  const currentUserId = localStorage.getItem('hisaab_supabase_uid');
  const ownerName = localStorage.getItem('hisaab_user_name') ?? 'You';

  const addMember = async () => {
    const normalized = normalizePublicCode(codeInput);
    if (!normalized) {
      toast.show({ type: 'error', title: t('group_code_err_empty') });
      return;
    }
    if (members.some(m => normalizePublicCode(m.publicCode) === normalized)) {
      toast.show({ type: 'error', title: t('group_code_err_dup') });
      return;
    }
    setResolving(true);
    try {
      const match = await profilesDb.findByPublicCode(normalized);
      if (!match) {
        toast.show({ type: 'error', title: t('group_code_err_not_found'), subtitle: t('group_code_err_not_found_sub') });
        return;
      }
      if (match.id === currentUserId) {
        toast.show({ type: 'error', title: t('group_code_err_self'), subtitle: t('group_code_err_self_sub') });
        return;
      }
      setMembers(prev => [...prev, { profileId: match.id, name: match.name || match.publicCode, publicCode: match.publicCode }]);
      setCodeInput('');
    } catch {
      toast.show({ type: 'error', title: t('group_code_err_lookup_failed') });
    } finally {
      setResolving(false);
    }
  };

  const removeMember = (profileId: string) => setMembers(members.filter(m => m.profileId !== profileId));

  // Staging only — no network, so no submit guard is needed here, but the
  // duplicate check has to see BOTH the resolved code members and the guests
  // already staged: wherever a profile is absent the app keys people by name
  // (docs/who-owes-me.md §3 rule 3), so two same-named seats would silently
  // merge into one person's money. Same rule the server enforces.
  const addGuest = () => {
    if (guests.length >= MAX_GROUP_GUESTS) {
      toast.show({ type: 'error', title: t('guest_err_too_many') });
      return;
    }
    const problem = validateGuestName(
      guestName,
      [
        { name: ownerName, status: 'connected' },
        ...members.map(m => ({ name: m.name, status: 'invited' as const })),
      ],
      guests.map(g => g.name),
    );
    if (problem) {
      toast.show({ type: 'error', title: guestNameProblemMessage(problem) });
      return;
    }
    setGuests(prev => [...prev, { name: guestName.trim(), phone: guestPhone.trim() || undefined }]);
    setGuestName('');
    setGuestPhone('');
  };

  const removeGuest = (index: number) => setGuests(guests.filter((_, i) => i !== index));

  // Ref-backed entry re-check; `saving` state stays for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    if (!name.trim()) {
      toast.show({ type: 'error', title: t('fill_all') });
      return;
    }
    setSaving(true);
    try {
      const created = await createGroup(name.trim(), emoji, members, currency, guests);
      // Catalog #15. Size travels as a BUCKET and the group name never leaves
      // the device — a group created with 1 member is the "empty shell" signal
      // report 10 wants, and that needs no identifying detail. Guests count
      // toward the size: a trip with three named non-app people is not an
      // empty shell, and reading it as one would misdiagnose activation.
      track('group_created', {
        member_count_bucket: bucketCount(members.length + guests.length + 1),
        currency,
      });
      // Guide the user straight into the activation loop: created → add
      // first expense or share code. Longer duration so the nudge outlives
      // the page transition.
      toast.show({
        type: 'success',
        title: t('group_created'),
        subtitle: t('group_created_subtitle'),
        duration: 5000,
      });
      reset();
      onClose();
      // Caller-provided override (e.g. QuickEntry → AddGroupExpense flow)
      // wins over the default group-detail navigate. Default keeps the
      // existing GroupsPage-tap-Create-button behaviour intact.
      if (onCreated) {
        onCreated(created);
      } else {
        // Replace the sheet's own history entry (useBackStackLayer), so Back
        // from the new group returns to where the sheet was opened.
        navigate(`/group/${created.id}`, { replace: true });
      }
    } catch (err) {
      // createGroup throws an already-translated message when a guest seat is
      // refused (duplicate name, cap) and rolls the group back, so surfacing it
      // beats a bare "error" the user cannot act on.
      const message = err instanceof Error && err.message ? err.message : t('error');
      toast.show({ type: 'error', title: t('error'), subtitle: message });
    } finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('group_new')}
      confirmClose={() => guardClose(!!name.trim() || members.length > 0 || guests.length > 0 || !!codeInput.trim() || !!guestName.trim() || emoji !== '✈️')}
      footer={
      <button onClick={handleSubmit} disabled={saving || !name.trim()} className="cta-primary">
        {saving ? t('group_creating') : t('group_create')}
      </button>
    }>
      <div className="space-y-5 p-5">
        {/* Emoji picker — a grid of pressable tiles; the chosen one wears the
            violet selected ring. */}
        <div>
          <label className="form-label">{t('group_emoji')}</label>
          <div className="flex flex-wrap gap-2.5">
            {EMOJIS.map(e => (
              <button key={e} type="button" onClick={() => setEmoji(e)} aria-pressed={emoji === e}
                className={`m-tile w-10 h-10 min-h-0 p-0 rounded-[12px] flex items-center justify-center text-lg leading-none ${emoji === e ? 'm-tile-selected' : ''}`}>
                {e}
              </button>
            ))}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="form-label">{t('group_name')}</label>
          <input className="input-field" value={name} onChange={e => setName(e.target.value)} placeholder={t('group_name_placeholder')} />
        </div>

        {/* Currency */}
        <div>
          <label className="form-label">{t('common_currency')}</label>
          <CurrencyPicker
            value={currency}
            onChange={setCurrency}
            primary={getPrimaryCurrency()}
            used={usedCurrencies}
          />
        </div>

        {/* Members — by user code */}
        <div>
          <label className="form-label">{t('group_members')}</label>
          <p className="text-[11px] text-ink-600 -mt-0.5 leading-relaxed">
            {t('group_code_hint')}
          </p>
          <div className="flex gap-2.5 mt-2.5">
            <input
              className="input-field font-mono text-[12px]"
              value={codeInput}
              onChange={e => setCodeInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addMember(); } }}
              placeholder={t('group_code_placeholder')}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            {/* The composer's add button is the brand-violet primary, like the
                handoff's member composer. */}
            <button
              type="button"
              onClick={() => void addMember()}
              disabled={resolving || !codeInput.trim()}
              aria-label={t('group_add_member')}
              className="m-btn m-btn-primary shrink-0 w-12 h-12 min-h-0 p-0 rounded-[14px]"
            >
              {resolving
                ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : <Glyph name="user-plus" size={19} strokeWidth={2.6} />}
            </button>
          </div>

          {/* Owner chip + resolved member chips + staged guests */}
          <div className="flex flex-wrap gap-2 mt-3.5">
            <span className="m-chip m-chip-violet px-3 py-1.5 text-[12px]">
              {ownerName} <span className="text-[10px] font-medium opacity-80">{t('group_owner_you_tag')}</span>
            </span>
            {members.map(m => (
              <span key={m.profileId} className="m-chip m-chip-receive ps-3 pe-1 py-1 text-[12px]">
                <Glyph name="check" size={11} strokeWidth={3} />
                {m.name}
                <button
                  type="button"
                  onClick={() => removeMember(m.profileId)}
                  aria-label={t('split_remove_person').replace('{name}', m.name)}
                  className="w-6 h-6 rounded-full flex items-center justify-center opacity-70 active:opacity-100"
                >
                  <Glyph name="close" size={12} />
                </button>
              </span>
            ))}
            {guests.map((g, i) => (
              <span key={`guest-${i}`} className="m-chip m-chip-neutral ps-3 pe-1 py-1 text-[12px]">
                <Glyph name="user-plus" size={11} strokeWidth={2.6} />
                {g.name}
                <span className="text-[10px] uppercase tracking-[0.06em] text-ink-500">{t('guest_tag')}</span>
                <button
                  type="button"
                  onClick={() => removeGuest(i)}
                  aria-label={t('split_remove_person').replace('{name}', g.name)}
                  className="w-6 h-6 rounded-full flex items-center justify-center opacity-70 active:opacity-100"
                >
                  <Glyph name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
          {members.length === 0 && guests.length === 0 && (
            <p className="text-[11px] text-ink-500 mt-2.5 leading-relaxed">
              {t('group_no_members_yet_hint')}
            </p>
          )}
        </div>

        {/* ── Guests: people who will never install Hisaab ────────────────────
            The gap this closes is audit G6/O4 (July blocker B6): the group
            container silently required a Hisaab code for everyone, and nothing
            on screen said so. A guest is a full ledger participant — shares,
            payer, settlements — recorded on their behalf by real members. */}
        <div className="pt-1">
          <label className="form-label">{t('guest_add_title')}</label>
          <p className="text-[11px] text-ink-600 -mt-0.5 leading-relaxed">{t('guest_add_hint')}</p>
          <div className="flex gap-2.5 mt-2.5">
            <input
              className="input-field"
              value={guestName}
              maxLength={MAX_GUEST_NAME_LENGTH}
              onChange={e => setGuestName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGuest(); } }}
              placeholder={t('guest_name_placeholder')}
            />
            <button
              type="button"
              onClick={addGuest}
              disabled={!guestName.trim() || guests.length >= MAX_GROUP_GUESTS}
              className="m-ctl shrink-0 w-12 h-12 rounded-[14px] flex items-center justify-center disabled:opacity-40"
              aria-label={t('guest_add_cta')}
            >
              <Glyph name="user-plus" size={19} tone="neutral" />
            </button>
          </div>
          <input
            className="input-field mt-2.5"
            value={guestPhone}
            onChange={e => setGuestPhone(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGuest(); } }}
            placeholder={t('guest_phone_placeholder')}
            inputMode="tel"
            autoComplete="off"
          />
          <p className="text-[11px] text-ink-500 mt-2 leading-relaxed">{t('guest_phone_hint')}</p>
        </div>
      </div>
    </Modal>
  );
}
