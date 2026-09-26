import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember, getMemberByName, leaveMember, sweepExpiredMembers } from './members.js';
import { createTeam } from './teams.js';

/**
 * Cosmetic expiry sweep (ADR 459 §4): members past `lifecycle_until` read as departed on the
 * roster. Auth already refused them — the sweep changes no decision, only `left_at`.
 */
describe('sweepExpiredMembers (ADR 459 §4)', () => {
  function freshTeam() {
    const db = openDb(':memory:');
    return { db, team: createTeam(db, { slug: 'sweep-t' }) };
  }

  it('marks expired members left_at and returns them, leaving everyone else alone', () => {
    const { db, team } = freshTeam();
    const past = Date.now() - 1000;
    const { row: gone } = addMember(db, team, {
      name: 'gone',
      kind: 'human',
      lifecycle: 'until' as const,
      lifecycleUntil: past,
    });
    const { row: staying } = addMember(db, team, { name: 'staying', kind: 'human' });
    const { row: future } = addMember(db, team, {
      name: 'future',
      kind: 'human',
      lifecycle: 'until' as const,
      lifecycleUntil: Date.now() + 3600_000,
    });
    const swept = sweepExpiredMembers(db);
    expect(swept.map((m) => m.name)).toEqual(['gone']);
    expect(getMemberByName(db, team.id, 'gone')!.left_at).not.toBeNull();
    expect(getMemberByName(db, team.id, 'staying')!.left_at).toBeNull();
    expect(getMemberByName(db, team.id, 'future')!.left_at).toBeNull();
    expect(gone.id).toBe(swept[0]!.id);
    expect(staying.id).toBeDefined();
    expect(future.id).toBeDefined();
  });

  it('never touches unexpiring members, and skips the already-departed', () => {
    const { db, team } = freshTeam();
    const { row: old } = addMember(db, team, {
      name: 'old',
      kind: 'agent',
      lifecycle: 'until' as const,
      lifecycleUntil: Date.now() - 1000,
    });
    leaveMember(db, old.id);
    expect(sweepExpiredMembers(db)).toEqual([]);
    // An empty sweep is a no-op, not an error.
    expect(sweepExpiredMembers(db)).toEqual([]);
  });
});
