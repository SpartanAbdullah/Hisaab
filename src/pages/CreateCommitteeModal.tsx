import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { UserAvatar } from '../components/UserAvatar';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useToast } from '../components/Toast';
import { useCommitteeStore, type NewCommitteeMember } from '../stores/committeeStore';
import { usePersonStore } from '../stores/personStore';
import { poolAmount } from '../lib/committeeMath';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { track } from '../lib/telemetry';
import { bucketCount } from '../lib/telemetryEvents';
import { type Currency, type CommitteeCadence, type CommitteePayoutMethod } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { CurrencyPicker } from '../components/CurrencyPicker';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { localIso } from '../lib/localDate';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
}

// A member already added to the list. `id` is a local React key only — it
// never reaches the store.
type Row = { id: number; name: string; phone: string };

// Quick-add is a row of the most recent saved contacts, not a directory.
const QUICK_ADD_LIMIT = 6;

// Same normalisation as the app-wide person key (lowercased, trimmed name).
const nameKey = (name: string) => name.trim().toLocaleLowerCase();

// "New kameti" — the data-entry screen the client asked to be EASY: one
// column, 44px+ targets, and members entered through a composer (type a name
// and an optional number, press Enter or the gold +, keep going) that feeds
// a running list with a live count. A summary strip pinned above the Create
// button keeps members × amount = pool in view the whole time.
export function CreateCommitteeModal({ open, onClose, onCreated }: Props) {
  const t = useT();
  const toast = useToast();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  const createCommittee = useCommitteeStore((s) => s.createCommittee);

  const myName = localStorage.getItem('hisaab_user_name') || '';
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>(() => getPrimaryCurrency());
  // Ranks the CurrencyPicker's five inline chips from the currencies this
  // user already holds money in. accountStore is a global store that is
  // already loaded app-wide, so this subscribes to data in memory — no fetch.
  const accounts = useAccountStore((s) => s.accounts);
  const usedCurrencies = useMemo(() => [...new Set(accounts.map((a) => a.currency))], [accounts]);
  // Saved contacts for the quick-add chips. personStore is boot-loaded in
  // App.tsx for every signed-in user, so this too reads data already in
  // memory — read-only, nothing is written back to Contacts.
  const persons = usePersonStore((s) => s.persons);
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<CommitteeCadence>('monthly');
  const [startDate, setStartDate] = useState(() => localIso(new Date()));
  const [method, setMethod] = useState<CommitteePayoutMethod>('fixed');
  // The organizer (you) is always first; `rows` are everyone added after,
  // in the order added — which is the payout order for a fixed kameti.
  const [organizerName, setOrganizerName] = useState(myName);
  const [rows, setRows] = useState<Row[]>([]);
  // The composer: typed but not added yet.
  const [draftName, setDraftName] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const nextRowId = useRef(0);
  const draftNameRef = useRef<HTMLInputElement>(null);

  // A name still sitting in the composer counts as a member — exactly as a
  // typed row did before the composer. Tapping Create with "Ayesha" typed but
  // not yet added must not silently drop her; the count and the pool say so
  // before the tap.
  const entered: { name: string; phone: string }[] = draftName.trim()
    ? [...rows, { name: draftName, phone: draftPhone }]
    : rows;
  const memberCount = 1 + entered.filter((r) => r.name.trim()).length;
  const amt = parseFloat(amount) || 0;

  const reset = () => {
    setName(''); setAmount(''); setCadence('monthly'); setMethod('fixed');
    setStartDate(localIso(new Date()));
    setOrganizerName(myName);
    setRows([]);
    setDraftName(''); setDraftPhone('');
  };

  const addMember = (rawName: string, rawPhone: string): boolean => {
    const trimmed = rawName.trim();
    if (!trimmed) return false;
    const id = nextRowId.current++;
    setRows((rs) => [...rs, { id, name: trimmed, phone: rawPhone.trim() }]);
    return true;
  };
  const removeRow = (id: number) => setRows((rs) => rs.filter((r) => r.id !== id));

  const commitDraft = (): boolean => {
    if (!addMember(draftName, draftPhone)) return false;
    setDraftName('');
    setDraftPhone('');
    return true;
  };

  // Enter in either composer field adds the member and puts the cursor back
  // on Name for the next one. Enter with nothing to add: a number with no name
  // goes back to Name; an empty composer means "done adding", so the
  // keyboard drops and the Create button is in view. (Both inputs carry an
  // explicit enterKeyHint — without one, Android's IME "Next" key moves focus
  // instead of sending Enter.)
  const onComposerKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (commitDraft()) {
      draftNameRef.current?.focus();
      return;
    }
    if (draftPhone.trim()) draftNameRef.current?.focus();
    else e.currentTarget.blur();
  };

  const handleAddClick = () => {
    commitDraft();
    // Added or not, the next thing to type is a name.
    draftNameRef.current?.focus();
  };

  // Most recently touched saved contacts that aren't in the list yet — and
  // never a card: legacy card-named person rows (pre-rebuild cash advances)
  // are not people, so any contact named after an account is skipped (the
  // same rule ContactDetailSheet's merge picker uses).
  const quickAdd = useMemo(() => {
    const taken = new Set(rows.map((r) => nameKey(r.name)));
    const accountNames = new Set(accounts.map((a) => nameKey(a.name)));
    return persons
      .filter((p) => !p.archivedAt && !taken.has(nameKey(p.name)) && !accountNames.has(nameKey(p.name)))
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
      .slice(0, QUICK_ADD_LIMIT);
  }, [persons, rows, accounts]);

  // Disable-until-valid: a name, a positive contribution, and at least one
  // named member (you're added as organizer automatically).
  const canCreate = !!name.trim() && amt > 0 && entered.some((r) => r.name.trim());
  const isDirty = !!name.trim() || !!amount.trim() || rows.length > 0 || !!draftName.trim() || !!draftPhone.trim();

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleCreate = () => submitGuard.run(runCreate);

  const runCreate = async () => {
    if (!name.trim()) { toast.show({ type: 'error', title: t('kameti_name') }); return; }
    if (!(amt > 0)) { toast.show({ type: 'error', title: t('val_need_amount') }); return; }
    const named = entered.filter((r) => r.name.trim());
    // You're added automatically as organizer, so one named row = 2 people.
    // (The old copy said "add 2 members" which didn't match this threshold.)
    if (named.length < 1) { toast.show({ type: 'error', title: t('kameti_need_one_member') }); return; }

    const members: NewCommitteeMember[] = [
      { name: organizerName.trim() || t('kameti_you_organizer'), isOrganizer: true },
      ...named.map((r) => ({ name: r.name.trim(), phone: r.phone.trim() || null })),
    ];

    setSaving(true);
    try {
      const c = await createCommittee({
        name: name.trim(), currency, contributionAmount: amt, cadence, startDate,
        payoutMethod: method, members,
      });
      // Catalog #21. Kameti is the differentiator; report 10 funnel 4 asks
      // whether created kametis reach round 1 or die as empty shells, and this
      // is its first step. `rounds` == member count (one payout per member);
      // the contribution amount and every member name stay on the device.
      track('kameti_created', {
        member_count_bucket: bucketCount(members.length),
        rounds: members.length,
        frequency: cadence,
        payout_method: method,
        currency,
      });
      reset();
      onClose();
      onCreated?.(c.id);
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  // Turn numbers only mean something for a fixed kameti (slot = order added);
  // a ballot's order is drawn later, so its list shows no numbers.
  const showTurns = method === 'fixed';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('kameti_new')}
      confirmClose={() => guardClose(isDirty)}
      footer={
        <div className="space-y-2.5">
          {/* Live summary — members × amount = the pool each round. Pinned
              with the Create button so the result is in view at the tap. */}
          <div className="m-inset flex items-center justify-between gap-3 px-3.5 py-2">
            <div className="min-w-0">
              <p className="m-label">{t('kameti_pool')}</p>
              <p className="text-[12px] text-ink-600 mt-0.5 tabular-nums truncate">
                <span className="font-semibold text-ink-900">{memberCount}</span> {t('kameti_members').toLowerCase()}
                {' × '}
                <span className="font-semibold text-ink-900">{amt > 0 ? formatMoney(amt, currency) : '—'}</span>
              </p>
            </div>
            <p className="shrink-0 flex items-baseline gap-1.5 tabular-nums">
              <span className="text-[13px] text-ink-400" aria-hidden="true">=</span>
              <span className="text-[18px] font-semibold tracking-[-0.02em] text-warn-700">
                {amt > 0 ? formatMoney(poolAmount(amt, memberCount), currency) : '—'}
              </span>
            </p>
          </div>
          <button onClick={handleCreate} disabled={saving || !canCreate} className="cta-primary">
            {saving ? t('kameti_creating') : t('kameti_create')}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* No-custody reassurance up front */}
        <div className="m-card m-mint flex items-start gap-2.5 p-3.5">
          <Glyph name="shield" size={16} tone="green" className="mt-0.5" />
          <p className="text-[11.5px] text-receive-text leading-relaxed">{t('kameti_no_custody_desc')}</p>
        </div>

        {/* Labelled field cards: the whole card is the tap target. */}
        <label className="m-field">
          <span className="m-label block">{t('kameti_name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('kameti_name_ph')}
            className="mt-1.5 block w-full bg-transparent border-0 outline-none font-medium text-ink-900"
          />
        </label>

        <label className="m-field">
          <span className="m-label block">{t('kameti_amount')}</span>
          <span className="mt-1 flex items-baseline gap-2">
            <span className="text-[12px] font-semibold text-ink-400 shrink-0">{currency}</span>
            <input
              type="number" step="0.01" inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="flex-1 min-w-0 bg-transparent border-0 outline-none font-semibold text-ink-900 tabular-nums"
              // Inline on purpose: index.css pins every <input> to 16px (iOS
              // focus-zoom guard), which beats any font-size utility.
              style={{ fontSize: 22, letterSpacing: '-0.02em' }}
            />
          </span>
        </label>

        <div>
          <label className="form-label">{t('common_currency')}</label>
          <CurrencyPicker
            value={currency}
            onChange={setCurrency}
            primary={getPrimaryCurrency()}
            used={usedCurrencies}
          />
        </div>

        <div>
          <label className="form-label">{t('kameti_cadence')}</label>
          <div className="grid grid-cols-3 gap-2">
            {([['daily', 'kameti_cadence_daily'], ['weekly', 'kameti_cadence_weekly'], ['monthly', 'kameti_cadence_monthly']] as const).map(([c, key]) => (
              <button key={c} type="button" onClick={() => setCadence(c)}
                aria-pressed={cadence === c}
                className="m-pill m-pill-gold min-h-[44px] w-full text-[12.5px]">
                {t(key)}
              </button>
            ))}
          </div>
        </div>

        <label className="m-field">
          <span className="m-label block">{t('kameti_start_date')}</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="mt-1.5 block w-full bg-transparent border-0 outline-none font-medium text-ink-900"
          />
        </label>

        <div>
          <label className="form-label">{t('kameti_method')}</label>
          <div className="space-y-2.5">
            {([['fixed', 'kameti_method_fixed', 'kameti_method_fixed_desc'], ['ballot', 'kameti_method_ballot', 'kameti_method_ballot_desc']] as const).map(([m, label, desc]) => (
              <button key={m} type="button" onClick={() => setMethod(m)}
                aria-pressed={method === m}
                className={`w-full text-left gap-3 ${method === m ? 'selector-base selector-selected' : 'selector-base'}`}>
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[13.5px] font-semibold text-ink-900">{t(label)}</span>
                  <span className="text-[11.5px] text-ink-600">{t(desc)}</span>
                </span>
                {method === m && <Glyph name="check" size={16} tone="gold" strokeWidth={3} />}
              </button>
            ))}
          </div>
        </div>

        {/* Members: composer → running list, with the live count. */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="form-label mb-0">{t('kameti_members')}</p>
            <span className="m-chip m-chip-gold tabular-nums">{memberCount}</span>
          </div>

          <div className="m-card p-3.5">
            {quickAdd.length > 0 && (
              <>
                <p className="text-[11px] text-ink-600 mb-2.5">{t('kameti_quick_add_hint')}</p>
                <div className="flex flex-wrap gap-2">
                  {quickAdd.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      // Keep focus (and the keyboard) where it is while adding.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addMember(p.name, p.phone ?? '')}
                      aria-label={`${t('kameti_add_member')}: ${p.name}`}
                      className="m-pill min-h-[44px] max-w-full pl-1.5 pr-3.5 gap-2 text-[12.5px] text-ink-800"
                    >
                      <UserAvatar name={p.name} size={28} />
                      <span className="truncate">{p.name}</span>
                      <Glyph name="plus" size={12} tone="gold" strokeWidth={2.8} />
                    </button>
                  ))}
                </div>
                <div className="border-t border-cream-hairline my-3.5" />
              </>
            )}

            {/* Name over number on the left, one tall gold + on the right that
                adds them both. DOM order is name → number → + so Tab walks it
                the way the eye does. */}
            <div className="grid grid-cols-[minmax(0,1fr)_56px] gap-2">
              <input
                ref={draftNameRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder={t('kameti_member_name_ph')}
                aria-label={t('kameti_member_name')}
                enterKeyHint="next"
                autoComplete="off"
                autoCapitalize="words"
                className="input-field col-start-1 row-start-1"
              />
              <input
                value={draftPhone}
                onChange={(e) => setDraftPhone(e.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder={t('kameti_member_phone_ph')}
                aria-label={t('kameti_member_phone')}
                inputMode="tel"
                enterKeyHint="next"
                autoComplete="off"
                className="input-field col-start-1 row-start-2 tabular-nums"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleAddClick}
                aria-label={t('kameti_add_member')}
                className="m-btn m-btn-primary col-start-2 row-start-1 row-span-2 h-full min-h-0 p-0"
              >
                <Glyph name="plus" size={24} strokeWidth={3} />
              </button>
            </div>
            <p className="text-[10.5px] text-ink-400 mt-3.5 leading-relaxed">{t('kameti_enter_to_add')}</p>
          </div>

          {/* The running list — you first, then everyone in the order added. */}
          <div className="m-card overflow-hidden divide-y divide-cream-hairline mt-3">
            <div className="flex items-center gap-2.5 px-3.5 py-2.5">
              {showTurns && <span className="w-6 shrink-0 text-[10.5px] font-semibold text-ink-400 tabular-nums">#1</span>}
              <UserAvatar name={organizerName} size={34} self />
              <input
                value={organizerName}
                onChange={(e) => setOrganizerName(e.target.value)}
                placeholder={t('kameti_member_name_ph')}
                aria-label={t('kameti_you_organizer')}
                autoCapitalize="words"
                className="input-field flex-1 min-w-0 px-2.5 py-1.5 rounded-[10px]"
              />
              <span className="m-chip m-chip-violet shrink-0">{t('kameti_you_organizer')}</span>
            </div>
            {rows.map((r, i) => (
              <div key={r.id} className="flex items-center gap-2.5 px-3.5 py-2.5 motion-safe:animate-fade-in">
                {showTurns && <span className="w-6 shrink-0 text-[10.5px] font-semibold text-ink-400 tabular-nums">#{i + 2}</span>}
                <UserAvatar name={r.name} size={34} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-medium text-ink-900 truncate">{r.name}</p>
                  {r.phone && <p className="text-[10.5px] text-ink-400 tabular-nums truncate mt-0.5">{r.phone}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => removeRow(r.id)}
                  aria-label={t('kameti_remove_member')}
                  className="m-key m-coral relative w-[30px] h-[30px] rounded-[10px] flex items-center justify-center shrink-0 before:absolute before:-inset-[7px] before:content-['']"
                >
                  <Glyph name="close" size={13} strokeWidth={2.8} />
                </button>
              </div>
            ))}
            {entered.length === 0 && (
              <p className="px-3.5 py-3 text-[11px] text-ink-400 leading-relaxed">{t('kameti_need_one_member')}</p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
