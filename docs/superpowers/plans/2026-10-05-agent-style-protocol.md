# Agent style, increment 1 — ADR + protocol: implementation plan

> **For agentic workers:** this plan is executed inline, in the owning seat, with
> `superpowers:executing-plans`. No subagent edits, builds or commits (AGENTS.md hard rule 8; the
> lane gate, git attribution and model attestation all see the seat, never a subagent). Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@musterd/protocol` can say, for any team and any human, how a seat should talk — the
admin-owned floor, the team defaults, the human's dials and prose — as typed schemas, one pure
resolver, one pure renderer and a stable epoch, with the ADR that admits the schema change.

**Architecture:** a new `style.ts` beside `doorbell.ts` holds the schemas, the shipped defaults,
`resolveStyle`, `styleEpoch` and `renderStyleBlock`; `credentials.ts` gains a `style` key on the
team policy (dense on read, sparse on write, ADR 185); nothing in server, MCP or CLI changes in this
increment — they consume these names in increments 2–4.

**Tech Stack:** TypeScript, zod, vitest, `node:crypto` (already used in protocol).

**Spec:** `docs/superpowers/specs/2026-10-05-agent-style-design.md` — §4.1 (data model), §4.2 (the
block), §4.3 (which human), §4.6 (failure modes), §6 (tests), §7 increment 1.

## Global Constraints

- Protocol schema changes need an ADR (AGENTS.md hard rule 1). Take the number with
  `pnpm adr:next` and push the branch as a draft PR **before** writing the ADR (ADR 220/223).
- Docs and code never disagree at the end of a commit (hard rule 3): the ADR, `SPEC.md` and
  `docs/architecture/02-protocol.md` land in the same PR as the code.
- Prose cap: **5 lines** (spec §4.1), team and human alike; a longer prose is refused with the count.
- Shipped defaults (spec §4.1): every floor boolean `true`; dials `when-it-matters · plain · normal ·
  prose`; empty prose.
- A preference can never lower the floor (spec §2): `resolveStyle` reads the floor from policy only.
- Vocabulary (ADR 098): Goal / Lane / increment; `pnpm vocab:check` gates new docs.
- Every commit ends with the seat trailer `Co-authored-by: stanley <stanley@revive.musterd>`, then
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8`.
- Fast gates before every push: `pnpm typecheck && pnpm lint && pnpm format:check`. CI is the authority;
  do not run the full suite locally (shared laptop).
- No new runtime dependency (hard rule 6). None is needed.

## Review Focus

Inputs the spec implies and no test exercised until this list was written; each has its test in
the task that owns the code.

1. **Prose of exactly 5 lines passes; 6 is refused with the count** — the cap is inclusive and the
   message says how many lines were sent, so a human can fix it (Task 2).
2. **A trailing newline is not a sixth line** — `"a\nb\n"` is two lines (Task 2).
3. **Every floor boolean off ⇒ no `Floor (team):` line at all**, rather than an empty one that reads
   as a floor with nothing in it (Task 4).
4. **A driver with no prefs row still gets a `For <name>` line** in team defaults — the human is
   named, the dials are the team's, and the epoch equals the team epoch (Task 3, Task 4).
5. **A sparse override `{ style: { floor: { assess_before_agreeing: false } } }` round-trips** through
   `PolicyOverrideSchema` and `sparsifyPolicy` without densifying the other three floor booleans
   (Task 5).

## Increments

| # | Lane | This plan? |
| --- | --- | --- |
| 1 — ADR + protocol | `01M46MQD2FXXJ1RVTDCN6XW7WK` | yes, below |
| 2 — server | `01M46MQPQ3JC6EWMY7WV6SY8AA` | its own plan, at its turn |
| 3 — MCP | `01M46MQQFS3W2W4N37S7BB9RX5` | its own plan, at its turn |
| 4 — CLI | `01M46MQR8F6E6G9BRX0JMY8CMH` | its own plan, at its turn |
| 5 — web | `01M46MQSMJFBNGS0QE4PHVTXWT` | its own plan, at its turn (miley) |
| 6 — readout | `01M46MQW7GV4BD3SV9HDKDRETV` | its own plan, at its turn |

**One timing change from the spec's §7 line for increment 1.** The spec says dolly's "push back on
the human" bullet moves out of `guidance.ts` here. Until increment 3 ships the block on `team_join`,
nothing else would carry that rule, so the bullet **stays** in this increment and leaves in
increment 3's first task. Task 7 records that in the spec.

---

### Task 1: Reserve the ADR number and publish the branch

**Files:**
- Create: `docs/decisions/NNN-agent-style-floor-and-dials.md` (skeleton; `NNN` from `pnpm adr:next`)

**Interfaces:**
- Produces: the ADR number every later task cites as `ADR NNN`.

- [ ] **Step 1: Branch from fresh main and claim the lane**

```bash
cd /Users/nick/musterd/revive/agents/stanley
git fetch origin main
git checkout -b feat/agent-style-protocol origin/main
```

Then `lane_claim {id: "01M46MQD2FXXJ1RVTDCN6XW7WK"}` and `lane_update {id, state: "active", branch: "feat/agent-style-protocol"}`.

- [ ] **Step 2: Take the number**

Run: `pnpm -s adr:next`
Expected: a line naming the next free number and the reserve commit to run. Call it `NNN` below.

- [ ] **Step 3: Write the skeleton**

```markdown
# NNN — Agent style: an admin-owned floor and per-human dials, resolved by the daemon

- Status: proposed — 2026-10-05
- Date: 2026-10-05
- Lane: `01M46MQD2FXXJ1RVTDCN6XW7WK`
- Spec: `docs/superpowers/specs/2026-10-05-agent-style-design.md`

## Context

(filled in Task 7)

## Problem

## Decision

## Consequences

## Observability & Evaluation
```

- [ ] **Step 4: Commit and push as a draft PR (ADR 223: the number is contested from now)**

```bash
git add docs/decisions/NNN-agent-style-floor-and-dials.md
git commit -F - <<'EOF'
reserve ADR NNN: agent style floor and dials (lane 01M46MQD2F)

Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8
EOF
git push -u origin feat/agent-style-protocol
gh pr create --draft --title "ADR NNN: agent style — admin-owned floor + per-human dials (protocol, inc 1)" --body "Increment 1 of the agent-style spec (lane 01M46MQD2FXXJ1RVTDCN6XW7WK): schemas, resolveStyle, renderStyleBlock, style epoch, policy.style. Draft while the ADR is written."
```

---

### Task 2: Schemas and shipped defaults (`style.ts`)

**Files:**
- Create: `packages/protocol/src/style.ts`
- Create: `packages/protocol/src/style.test.ts`
- Modify: `packages/protocol/src/index.ts` (one export line, after `export * from './doorbell.js';`)

**Interfaces:**
- Produces:
  - `STYLE_PUSHBACK`, `STYLE_BLUNTNESS`, `STYLE_LENGTH`, `STYLE_FORMAT` — `readonly` tuples of the dial values.
  - `STYLE_PROSE_MAX_LINES = 5`.
  - `StyleFloorSchema`, `StyleDialsSchema`, `StylePolicySchema` (`{ floor, defaults, prose }`, dense on `parse({})`), `StylePolicyOverrideSchema` (sparse: every level optional), `StylePrefsSchema` (`.strict()`, every key optional).
  - Types `StyleFloor`, `StyleDials`, `StylePolicy`, `StylePolicyOverride`, `StylePrefs`.
  - `styleProseLineCount(text: string): number` and `styleProseProblem(text: string): string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/protocol/src/style.test.ts
import { describe, expect, it } from 'vitest';
import {
  STYLE_PROSE_MAX_LINES,
  StylePolicyOverrideSchema,
  StylePolicySchema,
  StylePrefsSchema,
  styleProseLineCount,
  styleProseProblem,
} from './style.js';

describe('StylePolicySchema — shipped defaults (spec §4.1)', () => {
  it('parse({}) is the shipped floor, defaults and empty prose', () => {
    expect(StylePolicySchema.parse({})).toEqual({
      floor: {
        assess_before_agreeing: true,
        disagree_once_then_commit: true,
        concession_names_check: true,
        human_critique_weighed_as_peer: true,
      },
      defaults: { pushback: 'when-it-matters', bluntness: 'plain', length: 'normal', format: 'prose' },
      prose: '',
    });
  });
  it('an admin may turn one floor boolean off and the other three stay on', () => {
    const p = StylePolicySchema.parse({ floor: { assess_before_agreeing: false } });
    expect(p.floor.assess_before_agreeing).toBe(false);
    expect(p.floor.disagree_once_then_commit).toBe(true);
  });
  it('an unknown dial value is refused', () => {
    expect(() => StylePolicySchema.parse({ defaults: { length: 'terse' } })).toThrow();
  });
});

describe('StylePolicyOverrideSchema — sparse (ADR 185)', () => {
  it('keeps only what was written, at every level', () => {
    expect(StylePolicyOverrideSchema.parse({ floor: { concession_names_check: false } })).toEqual({
      floor: { concession_names_check: false },
    });
  });
});

describe('StylePrefsSchema — a human\'s own dials', () => {
  it('parse({}) is empty: every dial falls to the team default', () => {
    expect(StylePrefsSchema.parse({})).toEqual({});
  });
  it('refuses a key that is not a dial (the floor is not a preference)', () => {
    expect(() => StylePrefsSchema.parse({ assess_before_agreeing: false })).toThrow();
  });
  it('accepts prose of exactly the cap', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(StylePrefsSchema.parse({ prose: five }).prose).toBe(five);
  });
  it('refuses prose over the cap', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    expect(() => StylePrefsSchema.parse({ prose: six })).toThrow();
  });
});

describe('styleProseLineCount / styleProseProblem', () => {
  it('a trailing newline is not a line', () => {
    expect(styleProseLineCount('a\nb\n')).toBe(2);
  });
  it('CRLF counts like LF', () => {
    expect(styleProseLineCount('a\r\nb\r\nc')).toBe(3);
  });
  it('empty prose is zero lines and no problem', () => {
    expect(styleProseLineCount('')).toBe(0);
    expect(styleProseProblem('')).toBeNull();
  });
  it('the problem names the count and the cap', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    expect(styleProseProblem(six)).toBe(`prose is 6 lines; the cap is ${STYLE_PROSE_MAX_LINES}`);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @musterd/protocol test -- style.test.ts`
Expected: FAIL — `Cannot find module './style.js'`.

- [ ] **Step 3: Write `style.ts` — schemas only (resolver and renderer come in Tasks 3–4)**

```ts
// packages/protocol/src/style.ts
import { z } from 'zod';

/**
 * Agent style (ADR NNN; spec docs/superpowers/specs/2026-10-05-agent-style-design.md) — how a seat
 * talks to humans. Two layers: the **floor** and **team defaults** are team policy human admins own
 * (`PolicySchema.style`, sparse on write per ADR 185); a human's own **dials** and **prose**
 * (`members.style_prefs`) sit on top and can never lower the floor. Everything here is pure: the
 * daemon passes policy and prefs in, {@link resolveStyle} answers, {@link renderStyleBlock} prints
 * the block a seat reads on `team_join`.
 */

export const STYLE_PUSHBACK = ['every-time', 'when-it-matters', 'only-on-risk'] as const;
export const STYLE_BLUNTNESS = ['direct', 'plain', 'soft'] as const;
export const STYLE_LENGTH = ['concise', 'normal', 'thorough'] as const;
export const STYLE_FORMAT = ['prose', 'structured'] as const;

/** The prose cap, team and human alike (spec §4.1). Inclusive: five lines pass, six are refused. */
export const STYLE_PROSE_MAX_LINES = 5;

/** Lines in a prose addendum. A trailing newline is not a line; CRLF counts like LF. */
export function styleProseLineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}

/** Null when the prose fits; otherwise the refusal a surface prints, naming the count and the cap. */
export function styleProseProblem(text: string): string | null {
  const n = styleProseLineCount(text);
  return n > STYLE_PROSE_MAX_LINES ? `prose is ${n} lines; the cap is ${STYLE_PROSE_MAX_LINES}` : null;
}

const ProseSchema = z
  .string()
  .max(2000)
  .refine((s) => styleProseProblem(s) === null, {
    message: `prose is at most ${STYLE_PROSE_MAX_LINES} lines`,
  });

/** The team floor: stance rules a preference cannot lower. An admin may turn one off (audited). */
export const StyleFloorSchema = z.object({
  assess_before_agreeing: z.boolean().default(true),
  disagree_once_then_commit: z.boolean().default(true),
  concession_names_check: z.boolean().default(true),
  human_critique_weighed_as_peer: z.boolean().default(true),
});
export type StyleFloor = z.infer<typeof StyleFloorSchema>;

/** The four dials. Team defaults carry every one; a human's prefs name only the ones they set. */
export const StyleDialsSchema = z.object({
  pushback: z.enum(STYLE_PUSHBACK).default('when-it-matters'),
  bluntness: z.enum(STYLE_BLUNTNESS).default('plain'),
  length: z.enum(STYLE_LENGTH).default('normal'),
  format: z.enum(STYLE_FORMAT).default('prose'),
});
export type StyleDials = z.infer<typeof StyleDialsSchema>;

/** `PolicySchema.style`, dense on read: `parse({})` is the shipped default. */
export const StylePolicySchema = z.object({
  floor: StyleFloorSchema.default({}),
  defaults: StyleDialsSchema.default({}),
  prose: ProseSchema.default(''),
});
export type StylePolicy = z.infer<typeof StylePolicySchema>;

/** What an admin wrote (ADR 185): optional at every level, so a present `floor` stays sparse. */
export const StylePolicyOverrideSchema = z.object({
  floor: StyleFloorSchema.partial().optional(),
  defaults: StyleDialsSchema.partial().optional(),
  prose: ProseSchema.optional(),
});
export type StylePolicyOverride = z.infer<typeof StylePolicyOverrideSchema>;

/** A human's own dials (`members.style_prefs`). Strict: the floor is not a preference. */
export const StylePrefsSchema = z
  .object({
    pushback: z.enum(STYLE_PUSHBACK).optional(),
    bluntness: z.enum(STYLE_BLUNTNESS).optional(),
    length: z.enum(STYLE_LENGTH).optional(),
    format: z.enum(STYLE_FORMAT).optional(),
    prose: ProseSchema.optional(),
  })
  .strict();
export type StylePrefs = z.infer<typeof StylePrefsSchema>;
```

Add to `packages/protocol/src/index.ts`, directly after `export * from './doorbell.js';`:

```ts
export * from './style.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @musterd/protocol test -- style.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/style.ts packages/protocol/src/style.test.ts packages/protocol/src/index.ts
git commit -F - <<'EOF'
feat(protocol): agent style schemas — floor, dials, prefs, prose cap (ADR NNN, lane 01M46MQD2F)

Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8
EOF
```

---

### Task 3: `resolveStyle` and `styleEpoch`

**Files:**
- Modify: `packages/protocol/src/style.ts` (append)
- Modify: `packages/protocol/src/style.test.ts` (append)

**Interfaces:**
- Consumes: `StylePolicy`, `StylePrefs`, `StyleFloor`, `StyleDials` (Task 2).
- Produces:
  - `interface ResolvedStyle { floor: StyleFloor; dials: StyleDials; team_prose: string; human_prose: string; epoch: string }`
  - `resolveStyle(policy: StylePolicy, prefs?: StylePrefs): ResolvedStyle`
  - `styleEpoch(parts: Omit<ResolvedStyle, 'epoch'>): string` — 8 hex chars of sha256.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/protocol/src/style.test.ts
import { resolveStyle, styleEpoch } from './style.js';

const shipped = StylePolicySchema.parse({});

describe('resolveStyle (spec §4.1)', () => {
  it('with no prefs, every dial is the team default and both proses are empty', () => {
    const r = resolveStyle(shipped);
    expect(r.dials).toEqual(shipped.defaults);
    expect(r.team_prose).toBe('');
    expect(r.human_prose).toBe('');
  });
  it.each([
    ['pushback', 'every-time'],
    ['bluntness', 'direct'],
    ['length', 'concise'],
    ['format', 'structured'],
  ] as const)('a human\'s %s overrides the team default', (dial, value) => {
    const r = resolveStyle(shipped, { [dial]: value });
    expect(r.dials[dial]).toBe(value);
    for (const other of ['pushback', 'bluntness', 'length', 'format'] as const)
      if (other !== dial) expect(r.dials[other]).toBe(shipped.defaults[other]);
  });
  it('the floor comes from policy only — prefs cannot reach it', () => {
    const policy = StylePolicySchema.parse({ floor: { concession_names_check: false } });
    const r = resolveStyle(policy, { pushback: 'only-on-risk' });
    expect(r.floor).toEqual(policy.floor);
  });
  it('team prose and human prose are kept apart, in that order', () => {
    const policy = StylePolicySchema.parse({ prose: 'Say numbers with units.' });
    const r = resolveStyle(policy, { prose: 'Lead with the result.' });
    expect(r.team_prose).toBe('Say numbers with units.');
    expect(r.human_prose).toBe('Lead with the result.');
  });
  it('empty prefs resolve identically to no prefs — same epoch', () => {
    expect(resolveStyle(shipped, {}).epoch).toBe(resolveStyle(shipped).epoch);
  });
});

describe('styleEpoch', () => {
  it('is 8 hex chars and stable for equal inputs', () => {
    const a = resolveStyle(shipped);
    const b = resolveStyle(StylePolicySchema.parse({}));
    expect(a.epoch).toMatch(/^[0-9a-f]{8}$/);
    expect(a.epoch).toBe(b.epoch);
  });
  it('moves when a dial moves, and when a floor boolean moves', () => {
    const base = resolveStyle(shipped).epoch;
    expect(resolveStyle(shipped, { length: 'concise' }).epoch).not.toBe(base);
    expect(
      resolveStyle(StylePolicySchema.parse({ floor: { assess_before_agreeing: false } })).epoch,
    ).not.toBe(base);
  });
  it('moves when prose moves', () => {
    const base = resolveStyle(shipped).epoch;
    expect(resolveStyle(shipped, { prose: 'x' }).epoch).not.toBe(base);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @musterd/protocol test -- style.test.ts`
Expected: FAIL — `resolveStyle` is not exported.

- [ ] **Step 3: Implement**

```ts
// append to packages/protocol/src/style.ts
import { createHash } from 'node:crypto';   // move to the top of the file with the zod import

/** One human's resolved style: the floor (team's), each dial (theirs, else the team's), both proses. */
export interface ResolvedStyle {
  floor: StyleFloor;
  dials: StyleDials;
  team_prose: string;
  human_prose: string;
  /** 8 hex chars of sha256 over the other four fields — the seat attests this (ADR 417 shape). */
  epoch: string;
}

/** The epoch of a resolved style: stable while nothing in it changes, different when anything does. */
export function styleEpoch(parts: Omit<ResolvedStyle, 'epoch'>): string {
  const canonical = JSON.stringify([
    parts.floor.assess_before_agreeing,
    parts.floor.disagree_once_then_commit,
    parts.floor.concession_names_check,
    parts.floor.human_critique_weighed_as_peer,
    parts.dials.pushback,
    parts.dials.bluntness,
    parts.dials.length,
    parts.dials.format,
    parts.team_prose,
    parts.human_prose,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

/**
 * Resolve how seats talk to one human (spec §4.1): the floor from policy — prefs cannot touch it —
 * each dial from prefs, else the team default; team prose then human prose. With no prefs this is
 * the team's own style, which is what `@team` and the record get.
 */
export function resolveStyle(policy: StylePolicy, prefs?: StylePrefs): ResolvedStyle {
  const parts = {
    floor: policy.floor,
    dials: {
      pushback: prefs?.pushback ?? policy.defaults.pushback,
      bluntness: prefs?.bluntness ?? policy.defaults.bluntness,
      length: prefs?.length ?? policy.defaults.length,
      format: prefs?.format ?? policy.defaults.format,
    },
    team_prose: policy.prose,
    human_prose: prefs?.prose ?? '',
  };
  return { ...parts, epoch: styleEpoch(parts) };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @musterd/protocol test -- style.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/style.ts packages/protocol/src/style.test.ts
git commit -F - <<'EOF'
feat(protocol): resolveStyle + styleEpoch — floor from policy, dials from prefs (ADR NNN, lane 01M46MQD2F)

Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8
EOF
```

---

### Task 4: `renderStyleBlock`

**Files:**
- Modify: `packages/protocol/src/style.ts` (append)
- Modify: `packages/protocol/src/style.test.ts` (append)

**Interfaces:**
- Consumes: `ResolvedStyle`, `resolveStyle` (Task 3).
- Produces:
  - `interface StyleBlockInput { team: ResolvedStyle; driver?: { name: string; style: ResolvedStyle }; no_driver?: 'unbound' | 'several_humans' }`
  - `renderStyleBlock(input: StyleBlockInput): string` — the lines a seat reads, `\n`-joined, no trailing newline.
  - `describeDials(dials: StyleDials): string` — `pushback when it matters · plain · normal · prose`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/protocol/src/style.test.ts
import { describeDials, renderStyleBlock } from './style.js';

describe('describeDials', () => {
  it('spells the pushback dial as words and keeps the others verbatim', () => {
    expect(describeDials(shipped.defaults)).toBe('pushback when it matters · plain · normal · prose');
    expect(describeDials({ pushback: 'every-time', bluntness: 'direct', length: 'concise', format: 'structured' }))
      .toBe('pushback every time · direct · concise · structured');
    expect(describeDials({ ...shipped.defaults, pushback: 'only-on-risk' })).toContain('pushback only on risk');
  });
});

describe('renderStyleBlock (spec §4.2–4.3)', () => {
  const team = resolveStyle(shipped);

  it('with a driver who set dials and prose, prints every line in order', () => {
    const nick = resolveStyle(shipped, {
      bluntness: 'direct',
      length: 'concise',
      prose: 'Lead with the result. Tell me when I am wrong, once, then do it my way.',
    });
    const out = renderStyleBlock({ team, driver: { name: 'nick', style: nick } });
    expect(out.split('\n')).toEqual([
      `Style (epoch ${nick.epoch}) — how you talk here.`,
      "Floor (team): assess before you agree; no praise before a check; disagree once, with the reason, then follow the decision; a concession names what you checked; a human's critique weighs what its evidence weighs.",
      'For nick (in chat, and in any act addressed to nick): pushback when it matters · direct · concise · prose.',
      'nick adds: "Lead with the result. Tell me when I am wrong, once, then do it my way."',
      'Everyone else, @team and the record: team defaults (pushback when it matters · plain · normal · prose).',
    ]);
  });

  it('a driver with no prefs is still named, in team defaults, at the team epoch', () => {
    const out = renderStyleBlock({ team, driver: { name: 'ana', style: resolveStyle(shipped) } });
    expect(out).toContain(`Style (epoch ${team.epoch})`);
    expect(out).toContain('For ana (in chat, and in any act addressed to ana): pushback when it matters · plain · normal · prose.');
    expect(out).not.toContain('ana adds:');
  });

  it('team prose prints after the floor as "The team adds"', () => {
    const policy = StylePolicySchema.parse({ prose: 'Say numbers with units.' });
    const out = renderStyleBlock({ team: resolveStyle(policy) });
    const lines = out.split('\n');
    expect(lines[1]).toMatch(/^Floor \(team\):/);
    expect(lines[2]).toBe('The team adds: "Say numbers with units."');
  });

  it('a floor boolean an admin turned off leaves the Floor line', () => {
    const policy = StylePolicySchema.parse({ floor: { human_critique_weighed_as_peer: false } });
    const out = renderStyleBlock({ team: resolveStyle(policy) });
    expect(out).toContain('Floor (team): assess before you agree; no praise before a check; disagree once, with the reason, then follow the decision; a concession names what you checked.');
    expect(out).not.toContain("a human's critique");
  });

  it('every floor boolean off ⇒ no Floor line at all', () => {
    const policy = StylePolicySchema.parse({
      floor: {
        assess_before_agreeing: false,
        disagree_once_then_commit: false,
        concession_names_check: false,
        human_critique_weighed_as_peer: false,
      },
    });
    const out = renderStyleBlock({ team: resolveStyle(policy) });
    expect(out).not.toMatch(/Floor \(team\)/);
  });

  it('no driver bound: says so, names the fix, and the record line covers chat too', () => {
    const out = renderStyleBlock({ team, no_driver: 'unbound' });
    expect(out.split('\n')).toEqual([
      `Style (epoch ${team.epoch}) — how you talk here.`,
      "Floor (team): assess before you agree; no praise before a check; disagree once, with the reason, then follow the decision; a concession names what you checked; a human's critique weighs what its evidence weighs.",
      'No driver bound — team defaults in chat (`musterd agent --driver <you>` binds one).',
      'In chat, @team and the record: team defaults (pushback when it matters · plain · normal · prose).',
    ]);
  });

  it('several humans and no driver: the reason is named', () => {
    const out = renderStyleBlock({ team, no_driver: 'several_humans' });
    expect(out).toContain('No driver bound and this team has several humans — team defaults in chat (`musterd agent --driver <you>` binds one).');
  });

  it('never ends with a newline', () => {
    expect(renderStyleBlock({ team })).not.toMatch(/\n$/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @musterd/protocol test -- style.test.ts`
Expected: FAIL — `renderStyleBlock` is not exported.

- [ ] **Step 3: Implement**

```ts
// append to packages/protocol/src/style.ts

const PUSHBACK_WORDS: Record<StyleDials['pushback'], string> = {
  'every-time': 'pushback every time',
  'when-it-matters': 'pushback when it matters',
  'only-on-risk': 'pushback only on risk',
};

/** The four dials as one line: `pushback when it matters · plain · normal · prose`. */
export function describeDials(dials: StyleDials): string {
  return [PUSHBACK_WORDS[dials.pushback], dials.bluntness, dials.length, dials.format].join(' · ');
}

/** One phrase per floor boolean, in the order the spec lists them (§4.2). */
const FLOOR_PHRASES: ReadonlyArray<[keyof StyleFloor, string]> = [
  ['assess_before_agreeing', 'assess before you agree; no praise before a check'],
  ['disagree_once_then_commit', 'disagree once, with the reason, then follow the decision'],
  ['concession_names_check', 'a concession names what you checked'],
  ['human_critique_weighed_as_peer', "a human's critique weighs what its evidence weighs"],
];

function floorLine(floor: StyleFloor): string | null {
  const on = FLOOR_PHRASES.filter(([key]) => floor[key]).map(([, phrase]) => phrase);
  return on.length === 0 ? null : `Floor (team): ${on.join('; ')}.`;
}

export interface StyleBlockInput {
  /** `resolveStyle(policy)` with no prefs — what `@team` and the record get. */
  team: ResolvedStyle;
  /** The human steering this Workspace (presence driver, else the team's only human), resolved. */
  driver?: { name: string; style: ResolvedStyle };
  /** Why there is no driver line, when there is none (spec §4.3). Ignored when `driver` is set. */
  no_driver?: 'unbound' | 'several_humans';
}

/**
 * The style block a seat reads on `team_join` (spec §4.2): an instruction in prose, floor first, the
 * driver's dials and prose labelled as theirs, then what everyone else gets. No trailing newline.
 */
export function renderStyleBlock(input: StyleBlockInput): string {
  const { team, driver } = input;
  const epoch = driver?.style.epoch ?? team.epoch;
  const lines: string[] = [`Style (epoch ${epoch}) — how you talk here.`];
  const floor = floorLine(team.floor);
  if (floor) lines.push(floor);
  if (team.team_prose) lines.push(`The team adds: "${team.team_prose}"`);
  const teamDials = describeDials(team.dials);
  if (driver) {
    lines.push(
      `For ${driver.name} (in chat, and in any act addressed to ${driver.name}): ${describeDials(driver.style.dials)}.`,
    );
    if (driver.style.human_prose) lines.push(`${driver.name} adds: "${driver.style.human_prose}"`);
    lines.push(`Everyone else, @team and the record: team defaults (${teamDials}).`);
  } else {
    const why =
      input.no_driver === 'several_humans'
        ? 'No driver bound and this team has several humans'
        : 'No driver bound';
    lines.push(`${why} — team defaults in chat (\`musterd agent --driver <you>\` binds one).`);
    lines.push(`In chat, @team and the record: team defaults (${teamDials}).`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @musterd/protocol test -- style.test.ts`
Expected: PASS, 32 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/style.ts packages/protocol/src/style.test.ts
git commit -F - <<'EOF'
feat(protocol): renderStyleBlock — the block a seat reads on team_join (ADR NNN, lane 01M46MQD2F)

Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8
EOF
```

---

### Task 5: `style` on the team policy

**Files:**
- Modify: `packages/protocol/src/credentials.ts` — `PolicySchema` (add a key after `acceptance_review_window_ms`), `PolicyOverrideSchema` (add to the `.extend({...})`), `POLICY_SUB_SCHEMAS` (add an entry), plus the import.
- Modify: `packages/protocol/src/credentials.test.ts` (append; create the `describe` if the file has no policy block — it does: search for `sparsifyPolicy`).

**Interfaces:**
- Consumes: `StylePolicySchema`, `StylePolicyOverrideSchema` (Task 2).
- Produces: `Policy['style']: StylePolicy` (dense on read); `PolicyOverride['style']?: StylePolicyOverride`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/protocol/src/credentials.test.ts
import { PolicyOverrideSchema, PolicySchema, sparsifyPolicy } from './credentials.js';
import { StylePolicySchema } from './style.js';

describe('PolicySchema.style (ADR NNN)', () => {
  it('a team that never set style reads the shipped default', () => {
    expect(PolicySchema.parse({}).style).toEqual(StylePolicySchema.parse({}));
  });
  it('a sparse floor override stays sparse on the wire and dense on read', () => {
    const wire = PolicyOverrideSchema.parse({ style: { floor: { assess_before_agreeing: false } } });
    expect(wire.style).toEqual({ floor: { assess_before_agreeing: false } });
    const read = PolicySchema.parse(wire);
    expect(read.style.floor).toEqual({
      assess_before_agreeing: false,
      disagree_once_then_commit: true,
      concession_names_check: true,
      human_critique_weighed_as_peer: true,
    });
  });
  it('sparsifyPolicy drops a style block that equals the default and keeps one that differs', () => {
    expect(sparsifyPolicy({ style: StylePolicySchema.parse({}) })).toEqual({});
    expect(sparsifyPolicy({ style: { ...StylePolicySchema.parse({}), prose: 'Units on numbers.' } }))
      .toEqual({ style: { prose: 'Units on numbers.' } });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @musterd/protocol test -- credentials.test.ts`
Expected: FAIL — `style` is undefined on the parsed policy.

- [ ] **Step 3: Implement**

In `credentials.ts`, with the other schema imports at the top:

```ts
import { StylePolicyOverrideSchema, StylePolicySchema } from './style.js';
```

In `PolicySchema`, after the `acceptance_review_window_ms` entry:

```ts
  /**
   * ADR NNN: agent style — the stance floor human admins own, the team's default dials, and a team
   * prose addendum. A human's own dials (`members.style_prefs`) sit on top and can never lower the
   * floor. Dense here (read); sparse on the wire and in the row (`PolicyOverrideSchema`, ADR 185).
   */
  style: StylePolicySchema.default({}),
```

In `PolicyOverrideSchema`'s `.extend({...})`, after `agent_host`:

```ts
  style: StylePolicyOverrideSchema.optional(),
```

In `POLICY_SUB_SCHEMAS`, after `agent_host`:

```ts
  style: StylePolicySchema,
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @musterd/protocol test -- credentials.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean. If a server test fixture asserts the full dense policy shape,
`pnpm --filter @musterd/server test -- policy` will say so in CI — the fix is to add
`style: StylePolicySchema.parse({})` to that fixture, and nothing else.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/credentials.ts packages/protocol/src/credentials.test.ts
git commit -F - <<'EOF'
feat(protocol): team policy carries `style` — dense on read, sparse on write (ADR NNN, lane 01M46MQD2F)

Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8
EOF
```

---

### Task 6: Guidance: the bullet stays; the skill names the block that is coming

**Files:**
- Modify: `packages/protocol/src/guidance.ts` — `GUIDANCE_CONTENT_VERSION` 43 → 44; one sentence appended to the "Push back on the human too, in chat" bullet.
- Modify: `packages/protocol/src/guidance.test.ts` — add the `44:` snapshot line.

Why this task exists: a seat reading the skill today should know that the per-human form of this
rule arrives on `team_join` once increment 3 lands, so the two do not read as competing rules. The
bullet itself leaves in increment 3 (see **Increments** above).

- [ ] **Step 1: Edit the bullet**

In `guidance.ts`, the line that reads

```ts
    "  A human's critique carries the weight of its evidence, no more, and is answered like a peer's.",
```

becomes

```ts
    "  A human's critique carries the weight of its evidence, no more, and is answered like a peer's.",
    '  This is the team floor; how each human wants it delivered (how readily, how bluntly, how long)',
    '  arrives as a style block on `team_join` once the daemon serves it (ADR NNN).',
```

and `export const GUIDANCE_CONTENT_VERSION = 43;` becomes `44`.

- [ ] **Step 2: Run the snapshot test to get the new hash**

Run: `pnpm --filter @musterd/protocol test -- guidance.test.ts`
Expected: FAIL in `version-bump discipline` with a message naming the computed 16-hex hash for
version 44.

- [ ] **Step 3: Record the hash**

In `guidance.test.ts`, after the `43:` line in `SNAPSHOTS`:

```ts
    44: '<the 16 hex chars from step 2>', // ADR NNN (lane 01M46MQD2F): the push-back bullet names the style block that will carry each human's dials from team_join; the bullet itself leaves in agent-style inc 3
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @musterd/protocol test -- guidance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/guidance.ts packages/protocol/src/guidance.test.ts
git commit -F - <<'EOF'
docs(guidance): v44 — the push-back bullet points at the coming style block (ADR NNN, lane 01M46MQD2F)

Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8
EOF
```

---

### Task 7: The ADR, SPEC and architecture doc

**Files:**
- Modify: `docs/decisions/NNN-agent-style-floor-and-dials.md` (fill the skeleton)
- Modify: `SPEC.md` — the `POST /teams/:slug/policy` row in A.7 (line ≈314)
- Modify: `docs/architecture/02-protocol.md` — new subsection "Agent style"
- Modify: `docs/superpowers/specs/2026-10-05-agent-style-design.md` — §7 increment 1 and 3 lines

- [ ] **Step 1: Fill the ADR**

```markdown
# NNN — Agent style: an admin-owned floor and per-human dials, resolved by the daemon

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (brainstorm 2026-10-05: preferences travel with the human; the stance floor is
  team policy admins configure; dials are every human's), stanley
- Lane: `01M46MQD2FXXJ1RVTDCN6XW7WK` (increment 1 of 6, Goal `agent-style`)
- Spec: `docs/superpowers/specs/2026-10-05-agent-style-design.md`
- Relates to: ADR 476 (verify before conceding — the stance this makes a floor), ADR 085 (one fact
  per guidance layer), ADR 185 (sparse team policy), ADR 417 (a seat attests the guidance it runs),
  ADR 443 (`members.doorbell_prefs`, the per-human prefs precedent), ADR 021/155 (the driver)

## Context

Stance guidance exists as one bullet in the skill (`guidance.ts` v41, agent-style lane
`01M44BNJRF`): assess before you agree, push back once with the reason, then commit, no opening
praise. It is one rule, in one static file, for everyone. Format is the harness's: nick's Claude
Code output style is `Concise`, and it covers one harness on one machine. Nothing lets a human say
how seats should talk to *them*, and nothing lets the team's admins change the stance rule without
a rebuild and a guidance refresh that reaches a Workspace only on `musterd init`
([guidance distribution](../wiki/guidance-distribution.md)).

The daemon already speaks to every seat at session start: the `team_join` reply carries live text
(the seat-memory headline), on every harness, current as of that call. The presence row already
knows the Workspace's driver.

## Problem

Make "how a seat talks" a thing the team owns and a human tunes — harness-independent, current
without a reprovision, with the stance rules of ADR 476 kept as a floor no preference can lower —
without adding a second home for a fact the skill already states.

## Decision

1. **Style has two layers.** The **floor** (four stance booleans) and the **team defaults** (four
   dials: `pushback`, `bluntness`, `length`, `format`) plus a team prose addendum are **team
   policy**: `PolicySchema.style`, dense on read and sparse on the wire and in the row (ADR 185),
   written by admins through `POST /policy`, audited as `policy.change`. A human's own **dials and
   prose** are `members.style_prefs`, written only by that human for themselves. Agents have no
   preferences.
2. **A preference never lowers the floor.** `resolveStyle(policy, prefs)` reads the floor from
   policy alone; prefs supply dials and prose. The shipped defaults are every floor boolean on and
   `when-it-matters · plain · normal · prose`. An admin may turn a floor boolean off; the audit row
   says who.
3. **Prose is capped at five lines**, team and human alike, inclusive; a longer prose is refused
   with the count (`styleProseProblem`).
4. **The resolved style has an epoch**: eight hex characters of sha256 over the floor, the dials and
   both proses. A seat attests the epoch it is running (increments 2–3), the ADR 417 shape.
5. **One renderer, in protocol.** `renderStyleBlock` prints the block a seat reads: floor first,
   team prose, the driver's dials and prose labelled with their name, then what `@team` and the
   record get. With no driver it says so and names the fix. Where the block is delivered is
   increment 3's ADR-free work; this ADR fixes what it says.
6. **Scope of a preference** (spec §2): the chat with that human and any act addressed to them.
   Team-addressed and peer-addressed output stays the team default.

## Consequences

- Protocol gains `style.ts` (schemas, `resolveStyle`, `styleEpoch`, `renderStyleBlock`,
  `describeDials`, `styleProseProblem`) and `PolicySchema.style`. Additive optional policy key: no
  protocol-version bump (the ADR 044 precedent for additive optional fields).
- The skill's push-back bullet (`guidance.ts` v44) now names the coming block and leaves in
  increment 3, when the block ships — the only window in which the fact would otherwise have two
  homes.
- Server (`members.style_prefs`, the self route, `presence.style_epoch`), MCP (the block on
  `team_join` and on epoch change, `team_members.style`, `team_style`/`team_style_set`), CLI
  (`musterd style`, `musterd policy style`), web and the readout are increments 2–6, each a lane
  under `agent-style`.
- Harness-native renderers (writing a harness's own format knob from the dials) are deferred with a
  dated trigger: the first readout, thirty days after increment 3, showing the `length` dial not
  moving what reaches the human.

## Observability & Evaluation

- The block is text in a tool reply; chat stays off the record (ADR 476). What is measured, in
  increment 6 under ADR 294: body length of acts addressed to a human by that human's `length` dial
  and the sender's `style_epoch`; ADR 476's concession eval split by `style_epoch`; adoption
  (humans with any dial set; seats attesting the current epoch).
- Falsifier: thirty days after increment 3, no human has set a dial, or the `length` split shows no
  difference. Then the block has no standing with the models and the deferred alternative is next.
```

- [ ] **Step 2: SPEC.md — the `/policy` row**

In the A.7 table, the `POST | /teams/:slug/policy` row's Notes cell currently ends with
`(ADR 456)`. Append:

```
; `{ style: { floor, defaults, prose } }` — the agent-style floor, default dials and team prose, sparse (ADR NNN; additive optional key, no version bump)
```

- [ ] **Step 3: `02-protocol.md` — a subsection**

Find the section that documents the doorbell schemas (search `DoorbellPrefsSchema`). Directly after
that section add:

```markdown
### Agent style (ADR NNN)

`style.ts` says how a seat talks to humans. `PolicySchema.style` is the team's: a **floor** of four
stance booleans (every one on by default; an admin may turn one off), four **default dials**
(`pushback` every-time | when-it-matters | only-on-risk, `bluntness` direct | plain | soft, `length`
concise | normal | thorough, `format` prose | structured) and a team **prose** addendum. A human's
own `StylePrefs` (`members.style_prefs`, increment 2) name the dials they set and their own prose;
both proses are capped at five lines (`STYLE_PROSE_MAX_LINES`, `styleProseProblem`).

`resolveStyle(policy, prefs?)` is pure: the floor from policy only, each dial from prefs else the
team default, team prose then human prose, and an `epoch` (8 hex of sha256) the seat attests.
`renderStyleBlock({ team, driver?, no_driver? })` prints the block a seat reads on `team_join`
(increment 3): floor first, team prose, the driver's line and prose labelled with their name, then
what `@team` and the record get; with no driver it says so and names `musterd agent --driver`.
```

- [ ] **Step 4: The spec's §7 timing lines**

In `docs/superpowers/specs/2026-10-05-agent-style-design.md` §7, the increment 1 line

```
1. **ADR + protocol** — schemas, shipped defaults, `resolveStyle`, `renderStyleBlock`, epoch; dolly's
   bullet moves into the floor renderer; guidance version bump. Lane `01M46MQD2FXXJ1RVTDCN6XW7WK`.
```

becomes

```
1. **ADR + protocol** — schemas, shipped defaults, `resolveStyle`, `renderStyleBlock`, epoch; the
   floor renderer carries dolly's rule; the skill bullet names the coming block (v44). Lane
   `01M46MQD2FXXJ1RVTDCN6XW7WK`.
```

and the increment 3 line gains, before its lane id:

```
   dolly's bullet leaves `guidance.ts` here, when the block ships (plan 2026-10-05, Task 6).
```

- [ ] **Step 5: Run the doc gates**

Run: `pnpm -s vocab:check && pnpm -s intents:check && pnpm -s change-adr:check`
Expected: all three exit 0. `intents:check` must see a lane id on every §7 line it reads.

- [ ] **Step 6: Commit**

```bash
git add docs/decisions/NNN-agent-style-floor-and-dials.md SPEC.md docs/architecture/02-protocol.md docs/superpowers/specs/2026-10-05-agent-style-design.md
git commit -F - <<'EOF'
docs: ADR NNN — agent style floor and dials; SPEC /policy row; 02-protocol style section (lane 01M46MQD2F)

Refs ADR-NNN

Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8
EOF
```

---

### Task 8: Gates, PR, land, submit

- [ ] **Step 1: Fast gates**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all green. An `import/order` error from `lint` is the usual trip: `node:crypto` goes in
the builtin group above `zod`.

- [ ] **Step 2: Protocol suite once, for the coverage floor**

Run: `pnpm --filter @musterd/protocol test`
Expected: PASS; coverage ≥ 95% lines on the package (the AGENTS.md floor). `style.ts` is fully
exercised by Tasks 2–4; if a line is not, the missing case is a test, never an ignore comment.

- [ ] **Step 3: Push, mark ready, arm auto-merge**

```bash
git push
gh pr ready
gh pr merge --squash --auto --delete-branch
```

Do not poll. The `gates` check lands it; a red `gates` leaves the PR open and the fix is a new
commit.

- [ ] **Step 4: After merge — submit the lane, then follow the reply**

`lane_submit {id: "01M46MQD2FXXJ1RVTDCN6XW7WK", pr: <n>, sha: "<squash sha>", authorized_by: "nick"}`
with `follows_up: "01M46MQPQ3JC6EWMY7WV6SY8AA"` (increment 2). Then do what the reply says (ADR
235): acceptor asked with a backstop armed ⇒ done; acceptor asked, no backstop ⇒ wait the window it
names, then self-close on silence; nobody asked ⇒ self-close now.

- [ ] **Step 5: Clear the local branch**

```bash
git fetch origin main --prune && git switch --detach origin/main && git branch -D feat/agent-style-protocol
```

Then `team_send {act:'status_update'}` one line, and `team_inbox_check`.
