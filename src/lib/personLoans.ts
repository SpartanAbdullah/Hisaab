// The loans that belong to ONE contact — the single rule every per-person
// surface (contact sheet, loans group sheet, person ledger, statement) uses,
// so the balance card, the ledger and the PDF can never disagree about which
// loans count. Match on personId; a loan with NO personId (pre-persons
// history) falls back to the lowercased trimmed name — the repo-wide person
// key rule (`personId ?? lowercased trimmed name`). A loan that HAS a
// personId never matches by name, so two contacts called "Ali" stay apart.

import type { Loan, Person } from '../db';

export function loansForPerson<L extends Pick<Loan, 'personId' | 'personName' | 'deletedAt'>>(
  loans: readonly L[],
  person: Pick<Person, 'id' | 'name'>,
): L[] {
  const name = person.name.trim().toLowerCase();
  return loans.filter((l) => {
    if (l.deletedAt) return false;
    if (l.personId) return l.personId === person.id;
    return !!name && l.personName.trim().toLowerCase() === name;
  });
}
