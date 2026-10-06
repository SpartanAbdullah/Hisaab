import { describe, it, expect } from 'vitest';
import { loansForPerson } from './personLoans';

const L = (id: string, personId: string | null, personName: string, deletedAt: string | null = null) =>
  ({ id, personId, personName, deletedAt });

describe('loansForPerson', () => {
  it('matches by personId, falls back to the name only for loans without one', () => {
    const loans = [
      L('a', 'p1', 'Ali'),
      L('b', null, '  ali '), // legacy, pre-persons — same name
      L('c', 'p2', 'Ali'), // a DIFFERENT contact also called Ali — never by name
      L('d', 'p1', 'Ali', '2026-01-01T00:00:00.000Z'), // deleted
      L('e', null, 'Bilal'),
    ];
    expect(loansForPerson(loans, { id: 'p1', name: 'Ali' }).map((l) => l.id)).toEqual(['a', 'b']);
  });
});
