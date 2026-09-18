// Shared wrapper that renders any account list as Wallets & Cash / Banks /
// Credit Cards sections. Each surface keeps its own row JSX via renderAccount
// — this component only contributes the consistent grouping + labels. Labels
// are shown only when the list actually spans more than one group, so a user
// with only bank accounts sees no header noise.

import type { ReactNode } from 'react';
import { groupAccountsByType } from '../lib/accountGroups';
import { useT } from '../lib/i18n';
import type { Account } from '../db';

interface Props {
  accounts: Account[];
  renderAccount: (account: Account) => ReactNode;
  /** Class for the row container inside each section (default: vertical stack). */
  sectionClassName?: string;
}

// Default stack gap is 10px: the rows are raised selectors, and their 2px
// wall must never touch the row below.
export function AccountGroupSections({ accounts, renderAccount, sectionClassName = 'space-y-2.5' }: Props) {
  const t = useT();
  const groups = groupAccountsByType(accounts);
  const showLabels = groups.length > 1;

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.id}>
          {showLabels && (
            <p className="m-label mb-1.5 px-0.5">
              {t(group.labelKey)}
            </p>
          )}
          <div className={sectionClassName}>{group.accounts.map(renderAccount)}</div>
        </div>
      ))}
    </div>
  );
}
