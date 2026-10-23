import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { nextStatusExpiry, replaceMember, statusLineDraft, visibleStatusLine } from './statusLine';

const m = (over: Partial<MemberSummary>): MemberSummary =>
  ({ id: '1', team: 'revive', name: 'nick', kind: 'human', created_at: 1, presence: 'online', presences: [], ...over }) as MemberSummary;

describe('status line on /live (ADR 721)', () => {
  const line = { text: 'assembling a new dresser for the nursery', set_at: 1_000, expires_at: 3_601_000 };

  it("shows a human's status while it lasts, and drops it the moment it lapses", () => {
    expect(visibleStatusLine(m({ status_line: line }), 2_000)).toEqual({ text: line.text, expiresAt: line.expires_at });
    expect(visibleStatusLine(m({ status_line: line }), 3_601_000)).toBeNull();
  });

  it('never shows one on an agent or a service, whatever the wire says', () => {
    expect(visibleStatusLine(m({ kind: 'agent', status_line: line }), 2_000)).toBeNull();
    expect(visibleStatusLine(m({ kind: 'service', status_line: line }), 2_000)).toBeNull();
  });

  it('names the next moment a status lapses, so the room redraws then and not before', () => {
    const roster = [
      m({ name: 'nick', status_line: line }),
      m({ name: 'ola', status_line: { text: 'lunch', set_at: 0, expires_at: 9_000 } }),
      m({ name: 'bo' }),
    ];
    expect(nextStatusExpiry(roster, 2_000)).toBe(9_000);
    expect(nextStatusExpiry(roster, 10_000)).toBe(3_601_000);
    expect(nextStatusExpiry([m({ name: 'bo' })], 0)).toBeNull();
  });

  it('a member_updated push replaces that member and leaves the rest of the roster alone', () => {
    const roster = [m({ name: 'nick' }), m({ name: 'ada', kind: 'agent' })];
    const next = replaceMember(roster, m({ name: 'nick', status_line: line }));
    expect(next[0]!.status_line).toEqual(line);
    expect(next[1]).toBe(roster[1]);
    expect(replaceMember(roster, m({ name: 'zed' }))).toBe(roster);
  });
});

describe('the status line field (ADR 721)', () => {
  it('counts characters as you type, an emoji as one, and is ready only between 1 and 48', () => {
    expect(statusLineDraft('at the vet')).toEqual({ count: 10, ready: true, over: false });
    expect(statusLineDraft('🛠'.repeat(48))).toMatchObject({ count: 48, ready: true });
    expect(statusLineDraft('x'.repeat(49))).toEqual({ count: 49, ready: false, over: true });
    expect(statusLineDraft('   ')).toEqual({ count: 0, ready: false, over: false });
  });
});
