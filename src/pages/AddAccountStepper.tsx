import { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { Glyph } from '../components/Glyph';
import { Tile3D } from '../components/Tile3D';
import type { Tint } from '../lib/material';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from '../components/Toast';
import { StepIndicator } from '../components/StepIndicator';
import { type AccountType, type Currency } from '../db';
import { CurrencyPicker } from '../components/CurrencyPicker';
import { currencyMeta } from '../lib/design-tokens';
import { StatementCycleField } from '../components/StatementCycleField';
import { useT } from '../lib/i18n';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { track } from '../lib/telemetry';

interface Props { open: boolean; onClose: () => void; onComplete?: () => void; inline?: boolean; }

// One tinted tile per account type, each with its 3c glyph — the same
// type→accent mapping the Accounts list uses (cash green, bank blue, wallet
// violet, savings gold, card coral).
const ACCOUNT_TYPES: { value: AccountType; label_key: 'type_cash' | 'type_bank' | 'type_wallet' | 'type_savings' | 'type_credit_card'; tint: Tint; glyph: string }[] = [
  { value: 'cash', label_key: 'type_cash', tint: 'mint', glyph: 'banknote' },
  { value: 'bank', label_key: 'type_bank', tint: 'sky', glyph: 'bank' },
  { value: 'digital_wallet', label_key: 'type_wallet', tint: 'accent', glyph: 'wallet' },
  { value: 'savings', label_key: 'type_savings', tint: 'gold', glyph: 'savings' },
  { value: 'credit_card', label_key: 'type_credit_card', tint: 'coral', glyph: 'card' },
];

const BANK_PRESETS = [
  { name: 'Mashreq Bank', currency: 'AED' as Currency },
  { name: 'Emirates NBD', currency: 'AED' as Currency },
  { name: 'ADCB', currency: 'AED' as Currency },
  { name: 'Emirates Islamic', currency: 'AED' as Currency },
  { name: 'HBL', currency: 'PKR' as Currency },
  { name: 'Meezan Bank', currency: 'PKR' as Currency },
  { name: 'UBL', currency: 'PKR' as Currency },
];

const WALLET_PRESETS = [
  { name: 'EasyPaisa', walletType: 'easypaisa', currency: 'PKR' as Currency },
  { name: 'JazzCash', walletType: 'jazzcash', currency: 'PKR' as Currency },
  { name: 'NayaPay', walletType: 'nayapay', currency: 'PKR' as Currency },
  { name: 'SadaPay', walletType: 'sadapay', currency: 'PKR' as Currency },
];

const CC_ISSUER_PRESETS = [
  { name: 'Mashreq', currency: 'AED' as Currency },
  { name: 'Emirates NBD', currency: 'AED' as Currency },
  { name: 'Emirates Islamic', currency: 'AED' as Currency },
  { name: 'ADCB', currency: 'AED' as Currency },
  { name: 'HBL', currency: 'PKR' as Currency },
  { name: 'Meezan Bank', currency: 'PKR' as Currency },
];

export function AddAccountStepper({ open, onClose, onComplete, inline }: Props) {
  const { accounts, createAccount, loadAccounts } = useAccountStore();
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  const primaryCurrency = getPrimaryCurrency();

  const [step, setStep] = useState(0);
  const [accountType, setAccountType] = useState<AccountType>('cash');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>(primaryCurrency);
  // Ranks the CurrencyPicker chips from the currencies this user's existing
  // accounts are already in — accountStore is subscribed above, so no fetch.
  const usedCurrencies = useMemo(() => [...new Set(accounts.map(a => a.currency))], [accounts]);
  const [balance, setBalance] = useState('');
  const [bankName, setBankName] = useState('');
  const [walletType, setWalletType] = useState('');
  // Credit card fields
  const [ccIssuer, setCcIssuer] = useState('');
  const [ccLast4, setCcLast4] = useState('');
  const [ccLimit, setCcLimit] = useState('');
  const [ccDueDay, setCcDueDay] = useState('');
  // Statement CLOSING day — optional (falls back to the due day). Real cards
  // close the cycle then give ~3 weeks to pay; capturing both makes reminders
  // land at the right time.
  const [ccStatementDay, setCcStatementDay] = useState('');
  // How much is already owed on the card today (optional). Without it we'd
  // assume a brand-new card with nothing spent and show wrong net worth.
  const [ccOwed, setCcOwed] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setStep(0); setAccountType('cash'); setName(''); setCurrency(primaryCurrency);
    setBalance(''); setBankName(''); setWalletType('');
    setCcIssuer(''); setCcLast4(''); setCcLimit(''); setCcDueDay(''); setCcStatementDay(''); setCcOwed('');
  };
  const handleClose = () => { reset(); onClose(); };

  const selectType = (type: AccountType) => {
    setAccountType(type);
    if (type === 'cash') { setName(''); setCurrency(primaryCurrency); }
    setStep(1);
  };

  const selectPreset = (preset: { name: string; currency: Currency; walletType?: string }) => {
    setName(preset.name); setCurrency(preset.currency);
    if ('walletType' in preset && preset.walletType) setWalletType(preset.walletType);
    if (accountType === 'bank') setBankName(preset.name);
    setStep(2);
  };

  const selectCcIssuer = (preset: { name: string; currency: Currency }) => {
    setCcIssuer(preset.name); setCurrency(preset.currency);
    setName(`${preset.name} Credit Card`);
  };

  const canProceedStep1 = () => {
    if (accountType === 'credit_card') {
      const dd = parseInt(ccDueDay, 10);
      // Statement day must be a real day of the month (1..31) — it anchors the
      // whole statement/instalment cycle downstream.
      return Boolean(ccIssuer.trim()) && ccLast4.length === 4 && parseFloat(ccLimit) > 0 && dd >= 1 && dd <= 31;
    }
    return name.trim().length > 0;
  };

  // Opening balance may be left blank (= 0) but never negative or non-numeric.
  const balanceValid = (() => {
    const tb = balance.trim();
    if (tb === '') return true;
    const n = parseFloat(tb);
    return Number.isFinite(n) && n >= 0;
  })();

  // Ref-backed entry re-check (audit F-8/D-1): the `saving` STATE flag is
  // updated asynchronously, so two taps in one frame both read it as false.
  // `saving` stays for the disabled/label UI; the ref is the real guard.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    if (!balanceValid) { toast.show({ type: 'error', title: t('val_balance_invalid') }); return; }
    setSaving(true);
    try {
      const metadata: Record<string, string> = {};
      if (accountType === 'bank' && bankName) metadata.bankName = bankName;
      if (accountType === 'digital_wallet' && walletType) metadata.walletType = walletType;
      if (accountType === 'credit_card') {
        metadata.issuer = ccIssuer;
        metadata.last4 = ccLast4;
        metadata.creditLimit = ccLimit;
        metadata.dueDay = ccDueDay;
        // Only store a distinct statement day (blank → the model falls back
        // to the due day, i.e. single-date behaviour).
        const sd = parseInt(ccStatementDay, 10);
        if (Number.isFinite(sd) && sd >= 1 && sd <= 31) metadata.statementDay = ccStatementDay;
        if (ccOwed.trim()) metadata.outstanding = ccOwed;
      }

      // Credit card: stored balance = available credit = limit − amount already
      // owed. Leaving "owed" blank assumes a fresh card with nothing spent.
      const initialBalance = accountType === 'credit_card'
        ? (parseFloat(ccLimit) || 0) - (parseFloat(ccOwed) || 0)
        : parseFloat(balance) || 0;

      const accountName = accountType === 'credit_card'
        ? `${ccIssuer} ••••${ccLast4}`
        : name.trim();

      const isFirstAccount = accounts.length === 0;
      await createAccount({
        name: accountName,
        type: accountType,
        currency,
        balance: initialBalance,
        metadata,
      });
      await loadAccounts();
      // Catalog #7. Onboarding's own create fires from OnboardingPage.tsx
      // directly — this stepper only ever runs post-onboarding, from the
      // Accounts page or embedded inline inside QuickEntry.
      track('account_created', {
        account_type: accountType,
        is_first: isFirstAccount,
        source: inline ? 'quick_entry' : 'accounts_page',
      });
      if (isFirstAccount) {
        toast.show({ type: 'success', title: t('first_acct_congrats'), subtitle: t('first_acct_msg') });
      } else {
        toast.show({ type: 'success', title: t('acct_created'), subtitle: `${accountName} — ${currency}` });
      }
      reset(); onComplete?.(); if (!inline) onClose();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : 'Account nahi bana' });
    } finally { setSaving(false); }
  };

  const isCreditCard = accountType === 'credit_card';
  const isDirty = step > 0 || !!name.trim() || !!balance.trim() || !!bankName || !!walletType || !!ccIssuer.trim() || !!ccLast4 || !!ccLimit || !!ccDueDay || !!ccOwed;
  const title = inline ? t('acct_create_first') : step === 0 ? t('acct_what_type') : step === 1 ? t('acct_details') : t('acct_opening');

  const footerContent = step === 1 ? (
    <div className="flex gap-2.5">
      <button onClick={() => setStep(0)} className="m-btn m-btn-plain px-4" aria-label={t('back')}>
        <Glyph name="arrow-left" size={17} />
      </button>
      {isCreditCard ? (
        <button onClick={handleSubmit} disabled={saving || !canProceedStep1()}
          className="m-btn m-btn-primary flex-1 py-3.5 text-[14px]"
        >{saving ? t('acct_creating') : <><Glyph name="check" size={16} strokeWidth={3} /> {t('acct_create')}</>}</button>
      ) : (
        <button onClick={() => setStep(2)} disabled={!canProceedStep1()} className="m-btn m-btn-primary flex-1 py-3.5 text-[14px]">
          {t('quick_next')}<Glyph name="arrow-right" size={16} strokeWidth={2.8} />
        </button>
      )}
    </div>
  ) : step === 2 ? (
    <div className="flex gap-2.5">
      <button onClick={() => setStep(1)} className="m-btn m-btn-plain px-4" aria-label={t('back')}>
        <Glyph name="arrow-left" size={17} />
      </button>
      <button onClick={handleSubmit} disabled={saving || !name.trim() || !balanceValid}
        className="m-btn m-btn-primary flex-1 py-3.5 text-[14px]"
      >{saving ? t('acct_creating') : <><Glyph name="check" size={16} strokeWidth={3} /> {t('acct_create')}</>}</button>
    </div>
  ) : undefined;

  const typeLabelKey = ACCOUNT_TYPES.find((at) => at.value === accountType)?.label_key ?? 'type_cash';

  return (
    <Modal open={open} onClose={handleClose} title={title} footer={footerContent} confirmClose={() => guardClose(isDirty)}>
      <div className="space-y-4">
        <StepIndicator
          steps={[t('onboard_acct_type'), t('acct_details'), ...(isCreditCard ? [] : [t('label_balance')])]}
          current={step}
        />

        {/* Step 0: Type — one tinted tile per kind; the violet ring marks the
            current pick. */}
        {step === 0 && (
          <div className="space-y-2.5 animate-fade-in">
            {inline && (
              <div className="m-card m-violet p-3.5 mb-3 flex items-start gap-2.5">
                <Glyph name="info" size={16} tone="violet" className="mt-0.5" />
                <p className="text-[12px] text-accent-text font-semibold tracking-tight leading-snug">{t('acct_need_for_tx')}</p>
              </div>
            )}
            {ACCOUNT_TYPES.map(at => (
              <Tile3D
                key={at.value}
                tint={at.tint}
                icon={at.glyph}
                title={t(at.label_key)}
                selected={accountType === at.value}
                onClick={() => selectType(at.value)}
              />
            ))}
          </div>
        )}

        {/* Step 1: Details */}
        {step === 1 && (
          <div className="space-y-4 animate-fade-in">
            {/* Credit card specific fields */}
            {isCreditCard ? (
              <>
                {/* Issuer presets */}
                <div>
                  <p className="form-label">{t('cc_issuer')}</p>
                  <div className="grid grid-cols-2 gap-2.5 mb-3">
                    {CC_ISSUER_PRESETS.map(p => {
                      const meta = currencyMeta[p.currency];
                      return (
                        <button key={p.name} type="button" onClick={() => selectCcIssuer(p)}
                          aria-pressed={ccIssuer === p.name}
                          className={`selector-base flex-col items-start justify-center gap-0.5 p-3 ${
                            ccIssuer === p.name ? 'selector-selected' : ''
                          }`}
                        >
                          <p className="font-semibold text-[12.5px] text-ink-900 tracking-tight">{p.name}</p>
                          <p className="text-[10.5px] text-ink-500 flex items-center gap-1">{meta?.flag} {p.currency}</p>
                        </button>
                      );
                    })}
                  </div>
                  <input value={ccIssuer} onChange={e => { setCcIssuer(e.target.value); setName(`${e.target.value} Credit Card`); }}
                    placeholder={t('aas_issuer_placeholder')} className="input-field" />
                </div>

                <div>
                  <label className="form-label">{t('cc_last4')}</label>
                  <input value={ccLast4} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); setCcLast4(v); }}
                    placeholder="e.g. 4521" maxLength={4} inputMode="numeric" className="input-field text-center text-lg font-bold tracking-[0.3em]" />
                </div>

                <div>
                  <label className="form-label">{t('cc_limit')}</label>
                  <input type="number" step="0.01" value={ccLimit} onChange={e => setCcLimit(e.target.value)}
                    placeholder="e.g. 10000" className="input-field text-center text-lg font-bold tabular-nums" />
                </div>

                <StatementCycleField
                  statementDay={ccStatementDay}
                  dueDay={ccDueDay}
                  onStatementDay={setCcStatementDay}
                  onDueDay={setCcDueDay}
                />

                <div>
                  <label className="form-label">{t('cc_owed')}</label>
                  <input type="number" step="0.01" min="0" value={ccOwed} onChange={e => setCcOwed(e.target.value)}
                    placeholder="0" className="input-field text-center text-lg font-bold tabular-nums" />
                  <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">{t('cc_owed_hint')}</p>
                </div>

                <div>
                  <label className="form-label">{t('common_currency')}</label>
                  <CurrencyPicker
                    value={currency}
                    onChange={setCurrency}
                    primary={primaryCurrency}
                    used={usedCurrencies}
                  />
                </div>
              </>
            ) : (
              <>
                {/* Bank/Wallet presets */}
                {(accountType === 'bank' || accountType === 'digital_wallet') && (
                  <div>
                    <p className="form-label">{t('acct_quick_select')}</p>
                    <div className="grid grid-cols-2 gap-2.5">
                      {(accountType === 'bank' ? BANK_PRESETS : WALLET_PRESETS).map(p => {
                        const meta = currencyMeta[p.currency];
                        return (
                          <button key={p.name} type="button" onClick={() => selectPreset(p)}
                            aria-pressed={name === p.name}
                            className={`selector-base flex-col items-start justify-center gap-0.5 p-3 ${
                              name === p.name ? 'selector-selected' : ''
                            }`}
                          >
                            <p className="font-semibold text-[12.5px] text-ink-900 tracking-tight">{p.name}</p>
                            <p className="text-[10.5px] text-ink-500 flex items-center gap-1">{meta?.flag} {p.currency}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className={accountType === 'bank' || accountType === 'digital_wallet' ? 'border-t border-cream-hairline pt-4' : ''}>
                  <p className="form-label">
                    {accountType === 'bank' || accountType === 'digital_wallet' ? t('acct_or_type') : t('acct_name')}
                  </p>
                  <input value={name} onChange={e => setName(e.target.value)}
                    placeholder={
                      accountType === 'cash'
                        ? t('mv_acct_name_ph_cash')
                        : accountType === 'bank'
                          ? t('mv_acct_name_ph_bank')
                          : t('mv_acct_name_ph_wallet')
                    }
                    className="input-field"
                  />
                </div>

                <div>
                  <label className="form-label">{t('common_currency')}</label>
                  <CurrencyPicker
                    value={currency}
                    onChange={setCurrency}
                    primary={primaryCurrency}
                    used={usedCurrencies}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 2: Balance (non-credit-card only) */}
        {step === 2 && !isCreditCard && (
          <div className="space-y-4 animate-fade-in">
            <div className="m-inset p-4 text-center">
              <p className="m-label">{t('acct_new')}</p>
              <p className="font-semibold text-[15px] mt-1 text-ink-900 tracking-tight">{name}</p>
              <p className="text-[11.5px] text-ink-600 mt-0.5 flex items-center gap-1 justify-center">
                <span>{currencyMeta[currency]?.flag}</span> {t(typeLabelKey)} — {currency}
              </p>
            </div>

            <div>
              <label className="form-label">{t('acct_how_much')}</label>
              <input type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)}
                placeholder="0.00"
                className="input-field text-center text-xl font-bold tabular-nums"
                autoFocus
              />
              <p className="text-[11px] text-ink-500 text-center mt-1.5">{t('acct_leave_empty')}</p>
              {!balanceValid && <p className="text-[11px] text-pay-text text-center mt-1 font-semibold">{t('val_balance_invalid')}</p>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
