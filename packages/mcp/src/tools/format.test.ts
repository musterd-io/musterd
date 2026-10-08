import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildSkewOf,
  formatMember,
  formatRoster,
  notReadyMessage,
  syncWedgeWarning,
} from './format.js';

const base = { team: 'dawn', lifecycle: 'forever' as const, created_at: 0, role: '' };

const working: MemberSummary = {
  ...base,
  id: '1',
  name: 'izzo',
  kind: 'agent',
  presence: 'online',
  activity: 'working',
  state: 'Shipping ADR 131 inc 3 — the wake actuator',
  presences: [
    {
      surface: 'claude-code',
      status: 'online',
      last_seen_at: 0,
      model: 'claude-fable-5',
      workspace: 'agents-izzo@main',
    },
  ],
};
const out: MemberSummary = {
  ...base,
  id: '2',
  name: 'ryder',
  kind: 'agent',
  presence: 'offline',
  activity: 'offline',
  presences: [],
  wakeable: true,
};

describe('formatRoster (the agent-facing roster)', () => {
  it('says what each teammate is working on — the fact the old tool left out', () => {
    const text = formatRoster([working, out]);
    expect(text).toContain('Shipping ADR 131 inc 3');
    expect(text).toContain('claude-fable-5'); // attested model (ADR 101)
    expect(text).toContain('agents-izzo@main'); // where
  });

  it('groups by working / here / out and leads with the roll call', () => {
    const text = formatRoster([working, out]);
    expect(text).toContain('2 members · 1 present · 1 working');
    expect(text).toContain('working:');
    expect(text).toContain('out:');
    expect(text).not.toContain('here:'); // an empty group is not a fact
  });

  it('names the reader — an agent needs to know which seat it is', () => {
    expect(formatRoster([working], 'izzo')).toContain('you are izzo');
  });

  it('stays silent on absent facets — no `role=—`, no `lifecycle=forever`', () => {
    const text = formatRoster([working, out]);
    expect(text).not.toContain('role=');
    expect(text).not.toContain('lifecycle=');
    expect(text).not.toContain('—\n');
    expect(text).not.toContain('forever');
  });

  it('marks a residency-enrolled seat wakeable — offline is not unreachable (ADR 131)', () => {
    expect(formatRoster([out])).toContain('ryder (agent · wakeable)');
  });

  it('clips a long status in the overview, but never in the detail view', () => {
    const long = { ...working, state: 'x'.repeat(400) };
    // the roster is an overview — twenty working members must not bury the reader
    expect(formatRoster([long])).toContain('…');
    // `team_members` is the detail tool: a truncated status is useless to someone deciding to hand off
    expect(formatMember(long)).toContain('x'.repeat(400));
    expect(formatMember(long)).not.toContain('…');
  });

  it('collapses a multi-line status to one line', () => {
    const multi = { ...working, state: 'line one\n\nline two' };
    expect(formatMember(multi)).toContain('line one line two');
  });

  it('handles an empty team', () => {
    expect(formatRoster([])).toBe('no members yet — team_join claims your seat');
  });
});

describe('notReadyMessage — seat-drop B (ADR 193)', () => {
  // A restarted adapter has no member yet (`claimed === false`) even when a claim already failed.
  // The pending-presence arm used to ignore lastJoinError, so an expired grant read as "claim a
  // seat first" — the wrong repair (lane 01KYQCF678).
  it('surfaces a failed claim while still a pending presence', () => {
    const msg = notReadyMessage(
      {
        claimed: false,
        lastJoinError: 'expired_grant: grant expired',
        claimCode: 'GXJ0',
      },
      'send',
    );
    expect(msg).toContain('expired_grant');
    expect(msg).toMatch(/last join attempt failed/i);
    expect(msg).toMatch(/repair:/i);
  });

  it('keeps the plain pending-presence copy when no join has failed yet', () => {
    const msg = notReadyMessage({ claimed: false, lastJoinError: null, claimCode: 'AB12' }, 'send');
    expect(msg).toContain('pending presence');
    expect(msg).not.toMatch(/last join attempt failed/i);
  });
});

describe('notReadyMessage — evicted session (ADR 237)', () => {
  // An evicted session DID join; "call team_join first" was the opposite of what happened, and
  // following it reflexively re-fights the ADR 131 ping-pong war (the 2026-08-05 ryder incident).
  it('names the eviction instead of claiming the session never joined', () => {
    const msg = notReadyMessage(
      {
        claimed: true,
        lastJoinError: 'superseded: your session as "ryder" was taken over by a newer one',
        claimCode: 'GXJ0',
      },
      'send',
    );
    expect(msg).toMatch(/evicted/i);
    expect(msg).toMatch(/would displace/i);
    expect(msg).toContain('taken over by a newer one');
    expect(msg).not.toMatch(/haven't joined the team yet/i);
  });

  it('keeps the never-joined copy for a non-eviction join failure', () => {
    const msg = notReadyMessage(
      { claimed: true, lastJoinError: 'timed out waiting for admin approval', claimCode: 'GXJ0' },
      'send',
    );
    expect(msg).toMatch(/haven't joined the team yet/i);
    expect(msg).not.toMatch(/evicted/i);
  });
});

// Lane 01M3TWWQST: the adapter runs from whatever checkout its dist lives in — on a dogfood machine
// `~/.musterd/runtime`, which the auto-refresher has ALREADY rebuilt by the time the daemon differs.
// "Rebuild this worktree" sent every seat to build the wrong checkout after every refresh.
describe('buildSkewOf — the remedy matches what is on disk', () => {
  const sha = (c: string) => c.repeat(40);
  const client = { build: sha('a'), daemonBuild: async () => sha('b') };

  it('dist on disk already matches the daemon → only /mcp reload, no rebuild', async () => {
    const w = await buildSkewOf(client, () => ({ build: sha('b'), checkout: '/x/runtime' }));
    expect(w?.text).toContain('/mcp reload');
    expect(w?.text).not.toMatch(/pnpm build|rebuild/i);
  });

  it('dist on disk is stale too → names the checkout to rebuild, then reload', async () => {
    const w = await buildSkewOf(client, () => ({ build: sha('a'), checkout: '/x/runtime' }));
    expect(w?.text).toContain('pnpm -C /x/runtime build');
    expect(w?.text).toContain('/mcp reload');
    expect(w?.text).not.toContain('this worktree');
  });
});

describe('syncWedgeWarning — a stopped pull reads where a wedged push does (ADR 547)', () => {
  const stop = { kind: 'unresolved_seat', subject: 'alfie', hub_seq: 191206, since: 1_000 };

  it('says the sync is stopped, naming the seat and the event', () => {
    const text = syncWedgeWarning(
      { sync: { wedged: null, pull_stopped: stop } },
      1_000 + 3_600_000,
    );
    expect(text).toContain('sync is stopped');
    expect(text).toContain('seat "alfie"');
    expect(text).toContain('191206');
  });

  it('is silent when the fold is moving, and on a daemon that predates the field', () => {
    expect(syncWedgeWarning({ sync: { wedged: null, pull_stopped: null } })).toBe('');
    expect(syncWedgeWarning({ sync: { wedged: null } })).toBe('');
    expect(syncWedgeWarning(undefined)).toBe('');
  });
});
