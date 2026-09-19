import { describe, expect, it } from 'vitest';
import { decideLinkedBranch } from './linkedRequestBranch';
import type { Person } from '../db';

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'person-1',
    name: 'Bilal',
    phone: null,
    linkedProfileId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('decideLinkedBranch', () => {
  it('does not branch when person is null', () => {
    const result = decideLinkedBranch({
      type: 'loan_given',
      person: null,
      requestCurrency: 'AED',
    });
    expect(result.branch).toBe(false);
  });

  it('does not branch when person has no linkedProfileId', () => {
    const result = decideLinkedBranch({
      type: 'loan_given',
      person: makePerson({ linkedProfileId: null }),
      requestCurrency: 'AED',
    });
    expect(result.branch).toBe(false);
  });

  it('does not branch when currency is missing', () => {
    const result = decideLinkedBranch({
      type: 'loan_given',
      person: makePerson({ linkedProfileId: 'profile-2' }),
      requestCurrency: null,
    });
    expect(result.branch).toBe(false);
  });

  it('does not branch when a stale archived contact is supplied', () => {
    const result = decideLinkedBranch({
      type: 'loan_given',
      person: makePerson({ linkedProfileId: 'profile-2', archivedAt: '2026-05-01T00:00:00Z' }),
      requestCurrency: 'AED',
    });
    expect(result.branch).toBe(false);
  });

  it('branches loan_given → lent', () => {
    const result = decideLinkedBranch({
      type: 'loan_given',
      person: makePerson({ id: 'p1', linkedProfileId: 'profile-2' }),
      requestCurrency: 'AED',
    });
    expect(result).toEqual({
      branch: true,
      kind: 'lent',
      toUserId: 'profile-2',
      personId: 'p1',
      currency: 'AED',
    });
  });

  it('branches loan_taken → borrowed', () => {
    const result = decideLinkedBranch({
      type: 'loan_taken',
      person: makePerson({ id: 'p1', linkedProfileId: 'profile-2' }),
      requestCurrency: 'PKR',
    });
    expect(result).toEqual({
      branch: true,
      kind: 'borrowed',
      toUserId: 'profile-2',
      personId: 'p1',
      currency: 'PKR',
    });
  });

  it('never branches a cash advance — the card is the lender, nobody confirms it', () => {
    const result = decideLinkedBranch({
      type: 'loan_taken',
      person: makePerson({ linkedProfileId: 'profile-2' }),
      requestCurrency: 'AED',
      cashAdvance: true,
    });
    expect(result.branch).toBe(false);
  });

  it('branches a loan GIVEN from a card account — paying for someone with a card is not a cash advance', () => {
    // The founder's 2026-09 report: card lends to linked contacts were saved
    // locally and had to be pushed with "Sync past records" by hand.
    const result = decideLinkedBranch({
      type: 'loan_given',
      person: makePerson({ id: 'p1', linkedProfileId: 'profile-2' }),
      requestCurrency: 'AED',
      cashAdvance: false,
    });
    expect(result).toEqual({ branch: true, kind: 'lent', toUserId: 'profile-2', personId: 'p1', currency: 'AED' });
  });

  it('does not restrict by currency — Phase 2B is ledger-only', () => {
    // Comment in source explicitly notes "No cross-currency gate" — lock
    // that decision in with a test so a well-meaning future PR doesn't
    // silently reintroduce the gate.
    const result = decideLinkedBranch({
      type: 'loan_given',
      person: makePerson({ linkedProfileId: 'profile-2' }),
      requestCurrency: 'OMR', // GCC currency that earlier phases didn't support
    });
    expect(result.branch).toBe(true);
  });
});
