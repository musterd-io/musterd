import { describe, expect, it } from 'vitest';
import {
  HOLD_MAX_MS,
  HoldSchema,
  SetHoldBodySchema,
  SyncHoldRequestSchema,
  activeHoldFor,
  describeHoldLine,
  holdRefusal,
  isHoldActive,
  isHoldEnforced,
  isMergeShapedCommand,
  pushedRemote,
  pushSpec,
  type Hold,
} from './holds.js';
import { NextBriefSchema, NextSummarySchema } from './lanes.js';

const T0 = new Date(2026, 9, 5, 14, 0).getTime();
const hold = (over: Partial<Hold> = {}): Hold =>
  HoldSchema.parse({
    id: '01M46S3Q4APZYRZMZ3HYNT522E',
    effect: 'autorefresh_paused',
    reason: 'demo 14:00',
    created_by: 'nick',
    created_at: T0,
    expires_at: T0 + 90 * 60_000,
    lifted_at: null,
    lifted_by: null,
    ...over,
  });

describe('holds (ADR 516)', () => {
  it('the cap is the autorefresh hold it replaces: 12 hours', () => {
    expect(HOLD_MAX_MS).toBe(12 * 3600_000);
  });

  it('a set body takes exactly one of until or for_ms', () => {
    expect(SetHoldBodySchema.safeParse({ effect: 'notice', reason: 'x', for_ms: 1 }).success).toBe(
      true,
    );
    expect(SetHoldBodySchema.safeParse({ effect: 'notice', reason: 'x', until: 1 }).success).toBe(
      true,
    );
    expect(SetHoldBodySchema.safeParse({ effect: 'notice', reason: 'x' }).success).toBe(false);
    expect(
      SetHoldBodySchema.safeParse({ effect: 'notice', reason: 'x', until: 1, for_ms: 1 }).success,
    ).toBe(false);
  });

  it('refuses an effect outside the closed set and an empty reason', () => {
    expect(
      SetHoldBodySchema.safeParse({ effect: 'nobody_merges', reason: 'x', for_ms: 1 }).success,
    ).toBe(false);
    expect(SetHoldBodySchema.safeParse({ effect: 'notice', reason: '  ', for_ms: 1 }).success).toBe(
      false,
    );
  });

  it('active is derived: not lifted and before expiry', () => {
    const h = hold();
    expect(isHoldActive(h, T0)).toBe(true);
    expect(isHoldActive(h, h.expires_at)).toBe(false);
    expect(isHoldActive(hold({ lifted_at: T0 + 1, lifted_by: 'nick' }), T0 + 2)).toBe(false);
  });

  it('activeHoldFor matches the effect, never a different one', () => {
    const holds = [hold({ effect: 'notice' }), hold()];
    expect(activeHoldFor(holds, 'autorefresh_paused', T0)?.effect).toBe('autorefresh_paused');
    expect(activeHoldFor(holds, 'merges_paused', T0)).toBeNull();
    expect(activeHoldFor(holds, 'autorefresh_paused', T0 + HOLD_MAX_MS)).toBeNull();
  });

  it('a notice is never enforced and says so', () => {
    expect(isHoldEnforced('notice')).toBe(false);
    expect(isHoldEnforced('merges_paused')).toBe(true);
    expect(describeHoldLine(hold({ effect: 'notice', reason: 'leave the deck' }), T0)).toContain(
      'notice — not enforced',
    );
  });

  it('names the effect, the human, the end and the time left', () => {
    expect(describeHoldLine(hold(), T0)).toBe(
      'autorefresh paused by nick until 15:30 (1h30m left): demo 14:00',
    );
    expect(describeHoldLine(hold(), T0 + 60 * 60_000)).toContain('(30m left)');
    expect(describeHoldLine(hold({ expires_at: T0 + 120 * 60_000 }), T0)).toContain('(2h left)');
    expect(holdRefusal(hold())).toBe('held by nick until 15:30: demo 14:00');
  });

  it('the hub forward carries a set or a lift', () => {
    expect(
      SyncHoldRequestSchema.parse({
        op: 'set',
        actor: 'nick',
        hold: { effect: 'notice', reason: 'x', for_ms: 60_000 },
      }).op,
    ).toBe('set');
    expect(SyncHoldRequestSchema.parse({ op: 'lift', actor: 'nick', id: 'h1' }).op).toBe('lift');
  });

  it('the brief and summary report holds optionally — omission means not reported', () => {
    const summary = { member: 'ryder', carrying: 0, incidents: [], owed: [] };
    expect(NextSummarySchema.parse(summary).holds).toBeUndefined();
    expect(NextSummarySchema.parse({ ...summary, holds: [hold()] }).holds).toHaveLength(1);
    const briefHolds = NextBriefSchema.shape.holds;
    expect(briefHolds.parse(undefined)).toBeUndefined();
    expect(briefHolds.parse([hold()])).toHaveLength(1);
  });
});

describe('isMergeShapedCommand (ADR 516 increment 2)', () => {
  it.each([
    'gh pr merge 2099 --squash --auto --delete-branch',
    'gh pr merge',
    'cd repo && gh pr merge 12 --squash',
    'GH_TOKEN=x gh pr merge 3',
    'git push origin main',
    'git push origin HEAD:main',
    'git -C /tmp/r push origin master',
    'git push --force-with-lease origin refs/heads/main',
    'pnpm lint; git push origin main',
    // stanley's gaps from probing the built matcher (holds inc 2 acceptance, 2026-10-06)
    'git push origin +main',
    'git push origin "main"',
    "git push origin 'HEAD:main'",
    'git push origin main&',
    'bash -c "gh pr merge 3 --squash"',
    "sh -c 'cd repo && git push origin main'",
    'command gh pr merge 3',
    'exec gh pr merge 3',
    'env GH_TOKEN=x gh pr merge 3',
  ])('matches %s', (cmd) => {
    expect(isMergeShapedCommand(cmd)).toBe(true);
  });

  it.each([
    'git push --force-with-lease origin feat/holds',
    'git push',
    'git push -u origin docs/main-notes',
    'gh pr view 2099',
    'gh pr create --title "merge main into nothing"',
    'git fetch origin main && git rebase origin/main',
    'echo gh pr merge',
    'git log main',
    'git push origin +feat/holds',
    'bash -c "pnpm test"',
    'bash -c "echo gh pr merge"',
    'git push origin "feat/main-notes"',
  ])('does not match %s', (cmd) => {
    expect(isMergeShapedCommand(cmd)).toBe(false);
  });
});

describe('pushedRemote (ADR 730 §1)', () => {
  it.each([
    ['git push origin feat/x', 'origin'],
    ['git push', 'origin'],
    ['git push -u origin feat/x', 'origin'],
    ['cd /w && git -C /repo push team HEAD:agent1', 'team'],
    ['git add -A && git commit -m x && git push --force-with-lease origin b', 'origin'],
    ['bash -c "git push team agent1"', 'team'],
  ])('%s → %s', (cmd, remote) => {
    expect(pushedRemote(cmd)).toBe(remote);
  });

  it.each([
    'git fetch origin',
    'git pull',
    'git push --dry-run origin b',
    'git push -n',
    'echo git push',
    'git push HEAD:refs/heads/x',
  ])('%s → null', (cmd) => {
    expect(pushedRemote(cmd)).toBeNull();
  });

  it('returns the refspecs too, so a push of another branch is not the lane branch (big-body, 2026-10-25)', () => {
    expect(pushSpec('git push team other')).toEqual({
      remote: 'team',
      refspecs: ['other'],
      all: false,
      del: false,
    });
    expect(pushSpec('git push -u origin +HEAD:refs/heads/agent1')).toEqual({
      remote: 'origin',
      refspecs: ['HEAD:refs/heads/agent1'],
      all: false,
      del: false,
    });
    expect(pushSpec('git push')).toEqual({
      remote: 'origin',
      refspecs: [],
      all: false,
      del: false,
    });
    expect(pushSpec('git push --all team')).toMatchObject({ remote: 'team', all: true });
    expect(pushSpec('git push -d team old')).toMatchObject({ refspecs: ['old'], del: true });
    // An option's value is neither the remote nor a refspec.
    expect(pushSpec('git push -o ci.skip team agent1')).toMatchObject({
      remote: 'team',
      refspecs: ['agent1'],
    });
  });
});
