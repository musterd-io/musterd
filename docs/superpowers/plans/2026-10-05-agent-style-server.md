# Agent style, increment 2 — server: implementation plan

> **For agentic workers:** executed inline, in the owning seat, with `superpowers:executing-plans`.
> No subagent edits, builds or commits (AGENTS.md hard rule 8). Steps use checkbox (`- [ ]`) syntax.

**Goal:** the daemon stores each human's style dials, resolves them against the team policy, serves
them back (self route + roster), and records the style epoch a seat attests — so increment 3 can
put the block in `team_join` and a stale seat is visible.

**Architecture:** one portable ladder entry (`members.style_prefs`, `presence.style_epoch`); a small
`store/style.ts` beside `store/doorbell.ts`; `style_epoch` threaded through the attach/heartbeat
path exactly as `guidance_epoch` is (ADR 417); a self-only `GET/PUT /members/me/style` route on the
doorbell-prefs template; `style` (resolved dials) on human roster rows. Protocol gains the four
additive wire fields ADR 514 Decision 4 and Consequences already name.

**Tech Stack:** TypeScript, zod, vitest (`withDrivers` runs each HTTP test on SQLite and PGlite),
better-sqlite3 / pg.

**Spec:** `docs/superpowers/specs/2026-10-05-agent-style-design.md` §4.1 (data), §4.4
(attestation), §4.5 (write paths), §4.6 (failure modes), §6 (tests). ADR 514.

## Global Constraints

- Protocol schema changes are ADR-gated (hard rule 1): the four additive optional fields here are
  the ones ADR 514 Decision 4 / Consequences announce for increments 2–3; record them as a dated
  `## Consequences` note, never by editing `## Decision`.
- Docs and code agree at the end of the PR (hard rule 3): `SPEC.md` A.7 row, `02-protocol.md` HTTP
  rows, `03-server.md` file tree (drift-checked: `arch-trees:check`), ADR 514 note, spec §4.5.
- Parse every HTTP body through protocol zod at the boundary (hard rule 4): `StylePrefsSchema`.
- Prose cap refusal is **422 `validation`** naming the count (spec §4.5), as the doorbell route's
  `doorbellPrefsProblem` is — `parseOrBadRequest` alone would answer 400 without it.
- No new runtime dependency. No local full-suite runs on this laptop; per-file vitest only.
- Every commit ends with `Co-authored-by: stanley <stanley@revive.musterd>`, then
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8`.
- Fast gates before push: `pnpm -r build` (stale dist makes typecheck lie) then
  `pnpm typecheck && pnpm lint && pnpm format:check`.

## Review Focus

1. **An agent calling `PUT /members/me/style` gets 403**, never a write — agents have no
   preferences (spec §2). Test in Task 5.
2. **Six-line prose answers 422 with `prose is 6 lines; the cap is 5`**, not a bare 400 — the human
   can fix it from the message. Task 5.
3. **An admin changing `policy.style.defaults.length` changes what `GET /members/me/style` resolves
   for a human who never set `length`, and leaves one who did alone.** Task 5.
4. **`style_epoch` on attach is stored and read back; a heartbeat with a different epoch moves it; a
   heartbeat without one leaves it** (never a clear — ADR 236/417 rule). Task 4.
5. **`style` appears on human roster rows only**; agent rows carry `null`. Task 5.

## Increments

| # | Lane | This plan? |
| --- | --- | --- |
| 2 — server | `01M46MQPQ3JC6EWMY7WV6SY8AA` | yes, below |
| 3 — MCP | `01M46MQQFS3W2W4N37S7BB9RX5` | at its turn |
| 4 — CLI | `01M46MQR8F6E6G9BRX0JMY8CMH` | at its turn |
| 5 — web | `01M46MQSMJFBNGS0QE4PHVTXWT` | at its turn (miley) |
| 6 — readout | `01M46MQW7GV4BD3SV9HDKDRETV` | at its turn |

**One deviation from spec §4.5, decided here.** The spec says a dial write forwards to the hub and
shows `pending sync` on failure. No per-member preference does that today: `members.doorbell_prefs`
(ADR 443) is daemon-local, and the only joiner→hub forwards are lanes, claims, trust and policy via
dedicated `/sync/*` routes. A `/sync/style` route is a new sync surface; it is not this increment.
`style_prefs` follows the doorbell precedent (daemon-local), Task 7 opens a lane for the forward and
records it in the spec and ADR 514's Consequences with its trigger: a human on a second machine sets
a dial and a seat elsewhere does not see it.

---

## Tasks

### Task 1: Branch, lane, ledger

- [ ] **Step 1**

```bash
cd /Users/nick/musterd/revive/agents/stanley
git fetch origin main && git checkout -b feat/agent-style-server origin/main
```

`lane_update {id: "01M46MQPQ3JC6EWMY7WV6SY8AA", state: "active", branch: "feat/agent-style-server"}`.
Push the branch and open a draft PR after Task 2's first commit.

---

### Task 2: Ladder v86 — `members.style_prefs`, `presence.style_epoch`

**Files:**
- Modify: `packages/server/src/db/ladder.ts` (append after v85)
- Modify: `packages/server/src/db/ladder.test.ts:64`, `packages/server/src/db/db.test.ts:132,261,449,513` (`toBe(85)` → `toBe(86)`)
- Modify: `packages/server/src/store/rows.ts` — `MemberRow.style_prefs?: string | null` beside `doorbell_prefs`; `PresenceRow.style_epoch: string | null` beside `guidance_epoch`.

**Interfaces:** Produces the two columns every later task reads. `drift.test.ts` holds Postgres to
the SQLite ladder automatically (`expectedSchema` is derived), so no pg file changes.

- [ ] **Step 1: Write the failing test** — append to `ladder.test.ts` inside the existing `describe`:

```ts
  it('v86: members.style_prefs and presence.style_epoch exist on both engines (ADR 514)', async () => {
    const s = new Database(':memory:');
    runMigrations(s);
    const memberCols = s.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
    const presenceCols = s.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
    expect(memberCols).toContain('style_prefs');
    expect(presenceCols).toContain('style_epoch');
  });
```

(Postgres parity is `drift.test.ts`, which already compares both engines' column sets.)

- [ ] **Step 2: Run** `pnpm --filter @musterd/server exec vitest run src/db/ladder.test.ts` — Expected: FAIL, `style_prefs` missing; also the `toBe(85)` line stays green until Step 3.

- [ ] **Step 3: Implement** — append to `LADDER` after the v85 entry:

```ts
  {
    // v86 — ADR 514 (agent style): a human's own style dials and prose (`members.style_prefs`,
    // `StylePrefs` JSON; agents never carry one) and the style epoch a seat attests on attach and
    // heartbeat (`presence.style_epoch`, 8 hex chars; null = never attested, never read as stale).
    // Nullable, no backfill. Portable: both engines take ADD COLUMN IF NOT EXISTS.
    version: 86,
    sqlite: (db) => {
      const m = db.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
      if (!m.includes('style_prefs')) db.exec('ALTER TABLE members ADD COLUMN style_prefs TEXT');
      const p = db.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
      if (!p.includes('style_epoch')) db.exec('ALTER TABLE presence ADD COLUMN style_epoch TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE members ADD COLUMN IF NOT EXISTS style_prefs TEXT');
      await d.exec('ALTER TABLE presence ADD COLUMN IF NOT EXISTS style_epoch TEXT');
    },
  },
```

Bump the five `toBe(85)` assertions to `86` and append `, style prefs + style epoch` to the comment
on `db.test.ts:449`. In `rows.ts` add:

```ts
  /** The human's own style dials and prose (ADR 514), `StylePrefs` JSON; null/absent = team defaults. */
  style_prefs?: string | null;
```

beside `doorbell_prefs`, and on `PresenceRow`:

```ts
  /** The style epoch this occupancy attested (ADR 514): 8 hex chars over the resolved block it is
   *  running. Moves inside an occupancy on heartbeat, COALESCEd forward like `guidance_epoch`. Null
   *  for older clients and never defaulted: absence is not an assertion. */
  style_epoch: string | null;
```

- [ ] **Step 4: Run** `pnpm --filter @musterd/server exec vitest run src/db/ladder.test.ts src/db/db.test.ts src/db/pg/drift.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(server): ladder v86 — members.style_prefs + presence.style_epoch (ADR 514, lane 01M46MQPQ3)` with the trailers; push; `gh pr create --draft`.

---

### Task 3: Protocol wire fields (additive, ADR 514)

**Files:**
- Modify: `packages/protocol/src/frames.ts` (HeartbeatFrame, after `guidance_epoch`)
- Modify: `packages/protocol/src/claim-handshake.ts` (ClaimFrame, after `guidance_epoch`)
- Modify: `packages/protocol/src/member.ts` (PresenceSchema after `guidance_epoch`; MemberSummarySchema gains `style`)
- Modify: `packages/protocol/src/style.ts` — export `StyleEpochSchema`
- Test: `packages/protocol/src/style.test.ts` (append)

**Interfaces:** Produces `StyleEpochSchema = z.string().regex(/^[0-9a-f]{8}$/)`; wire fields
`style_epoch` (optional on frames, nullish on Presence) and `MemberSummary.style?: StyleDials | null`.

- [ ] **Step 1: Failing test** — append to `style.test.ts`:

```ts
describe('StyleEpochSchema (wire)', () => {
  it('accepts what styleEpoch produces and refuses anything else', () => {
    expect(StyleEpochSchema.parse(resolveStyle(shipped).epoch)).toBe(resolveStyle(shipped).epoch);
    expect(() => StyleEpochSchema.parse('xyz')).toThrow();
    expect(() => StyleEpochSchema.parse('a1b2c3d4e')).toThrow();
  });
});
```

and add `StyleEpochSchema` to the import list.

- [ ] **Step 2: Run** `pnpm --filter @musterd/protocol exec vitest run src/style.test.ts` — Expected: FAIL, not exported.

- [ ] **Step 3: Implement** — in `style.ts` after `STYLE_PROSE_MAX_CHARS`:

```ts
/** The wire form of a style epoch: exactly what {@link styleEpoch} produces. */
export const StyleEpochSchema = z.string().regex(/^[0-9a-f]{8}$/);
```

`frames.ts` HeartbeatFrame, after `guidance_epoch`:

```ts
  // Style re-attestation (ADR 514, additive): the epoch of the style block this seat is running.
  // Absent ⇒ no change, never a clear — the guidance_epoch rule, for the same reason.
  style_epoch: StyleEpochSchema.optional(),
```

`claim-handshake.ts` ClaimFrame, after `guidance_epoch`:

```ts
  /** The style epoch this seat is running (ADR 514) — the block it last read from `team_join`.
   *  Omitted by older clients and before the first block; absent reads as unknown. */
  style_epoch: StyleEpochSchema.optional(),
```

`member.ts` PresenceSchema, after `guidance_epoch`:

```ts
  /** The style epoch this occupancy attested (ADR 514). Null/absent = unknown, never stale. */
  style_epoch: StyleEpochSchema.nullish(),
```

`member.ts` MemberSummarySchema (inside the `.extend({...})`):

```ts
  /** ADR 514: how seats talk to this human — the resolved dials, no prose. Null on agent rows and
   *  from an older daemon. A seat composing an act to this human reads these. */
  style: StyleDialsSchema.nullish(),
```

Imports: `import { StyleDialsSchema, StyleEpochSchema } from './style.js';` in `member.ts`;
`import { StyleEpochSchema } from './style.js';` in `frames.ts` and `claim-handshake.ts`.

- [ ] **Step 4: Run** `pnpm --filter @musterd/protocol exec vitest run src/style.test.ts src/frames.test.ts src/member.test.ts` (whichever of the latter two exist) — Expected: PASS. Then `pnpm --filter @musterd/protocol build`.

- [ ] **Step 5: Commit** `feat(protocol): style_epoch on claim/heartbeat/presence, style on roster rows (ADR 514 inc 2, lane 01M46MQPQ3)`.

---

### Task 4: `style_epoch` through attach, heartbeat and the presence read

**Files:**
- Modify: `packages/server/src/store/presence.ts` — `AttachContext.style_epoch`, the `listPresence` row type, attach INSERT, heartbeat UPDATE, `emitReattested` detail, the wire projection, new `reattestStyleEpoch`.
- Modify: `packages/server/src/transport/ws.ts:853` (attach ctx) and `:1083` (heartbeat).
- Modify: `packages/server/src/transport/http.ts:4284` (claim body schema) and `:4567` (ctx).
- Test: `packages/server/src/store/store.test.ts` (append, next to the existing guidance_epoch cases — search `guidance_epoch`).

**Interfaces:** Produces `reattestStyleEpoch(db, presenceId, epoch: string | null | undefined)`.

- [ ] **Step 1: Failing tests** — append to the store test's presence block, mirroring the
  `guidance_epoch` cases there (same attach helper, same `listPresence` read):

```ts
  it('style_epoch is stored on attach and read back on the presence (ADR 514)', async () => {
    const p = await attach(db, member.id, 'cli', { style_epoch: 'a1b2c3d4' });
    const rows = await listPresence(db, team.id, 60_000);
    expect(rows.find((r) => r.member.id === member.id)!.presences[0]!.style_epoch).toBe('a1b2c3d4');
    void p;
  });
  it('a heartbeat with a new style_epoch moves it; without one it stays (never a clear)', async () => {
    const p = await attach(db, member.id, 'cli', { style_epoch: 'a1b2c3d4' });
    expect(await reattestStyleEpoch(db, p.id, 'ffffffff')).toEqual({ previous: 'a1b2c3d4' });
    expect(await reattestStyleEpoch(db, p.id, undefined)).toBeUndefined();
    expect(await reattestStyleEpoch(db, p.id, null)).toBeUndefined();
    expect(await reattestStyleEpoch(db, p.id, 'ffffffff')).toBeUndefined();
    const rows = await listPresence(db, team.id, 60_000);
    expect(rows.find((r) => r.member.id === member.id)!.presences[0]!.style_epoch).toBe('ffffffff');
  });
```

Adapt the attach helper's name and signature to what the file already uses for `guidance_epoch`.

- [ ] **Step 2: Run** `pnpm --filter @musterd/server exec vitest run src/store/store.test.ts -t style_epoch` — Expected: FAIL.

- [ ] **Step 3: Implement** in `presence.ts`:
  - `AttachContext`: `style_epoch?: string | null;` with a comment mirroring `guidance_epoch`'s.
  - the `listPresence` row type (`presences: {...}[]`): `style_epoch: string | null;`.
  - attach INSERT: add `style_epoch` to the column list and `row.style_epoch` to the values; the
    row object gets `style_epoch: ctx.style_epoch ?? null`.
  - heartbeat UPDATE (`:471`): append `, style_epoch = COALESCE(?, style_epoch)` and bind
    `ctx.style_epoch ?? null` after `guidance_epoch`'s bind.
  - `emitReattested` detail: `style_epoch: after.style_epoch`.
  - wire projection (`:600`): `style_epoch: p.style_epoch ?? null`.
  - after `reattestGuidanceEpoch`:

```ts
/** Re-attest the style epoch on a live presence (ADR 514) — the `reattestGuidanceEpoch` rule:
 *  undefined/null is no change, equal is no write, a change emits `presence.reattested`. */
export async function reattestStyleEpoch(
  db: Driver,
  presenceId: string,
  styleEpoch: string | null | undefined,
): Promise<{ previous: string | null } | undefined> {
  if (styleEpoch === undefined || styleEpoch === null) return undefined;
  const row = await presenceById(db, presenceId);
  if (!row) return undefined;
  if ((row.style_epoch ?? null) === styleEpoch) return undefined;
  await db.run('UPDATE presence SET style_epoch = ? WHERE id = ?', [styleEpoch, presenceId]);
  await emitReattested(db, presenceId);
  return { previous: row.style_epoch ?? null };
}
```

  `ws.ts` attach ctx: `style_epoch: frame.style_epoch ?? null,`; heartbeat, after the guidance
  line: `await reattestStyleEpoch(ctx.db, conn.presenceId, frame.style_epoch);`. `http.ts` claim
  body: `style_epoch: StyleEpochSchema.optional(),` and ctx `style_epoch: body.style_epoch ?? null`.
  Any other `INSERT INTO presence` (grep) gets the column too, or the fold's insert must list it —
  check `sync/fold.ts` for a presence insert and add `style_epoch` there with `null`.

- [ ] **Step 4: Run** `pnpm --filter @musterd/server exec vitest run src/store/store.test.ts src/sync/fold.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(server): style_epoch attested on attach and heartbeat, read on the presence (ADR 514, lane 01M46MQPQ3)`.

---

### Task 5: `store/style.ts`, the self route, `style` on roster rows

**Files:**
- Create: `packages/server/src/store/style.ts`
- Modify: `packages/server/src/transport/http.ts` — new route beside `/members/me/doorbell`; `summarize` adds `style`.
- Create: `packages/server/src/transport/style-http.test.ts`

**Interfaces:** Produces `memberStylePrefs(row): StylePrefs | undefined`,
`setStylePrefs(db, memberId, prefs)`, `teamStyle(db, teamId): Promise<StylePolicy>`,
`resolveMemberStyle(db, teamId, row): Promise<ResolvedStyle>`.

- [ ] **Step 1: Failing tests** — `style-http.test.ts`, on the `policy-http.test.ts` harness
  (`withDrivers`, `createServer`, `post`/`get` helpers, plus a `put`). Setup: `POST /teams` as nick;
  `POST /members {name:'dee', kind:'human'}` → `deeCred = json.human_credential`; `POST /members
  {name:'Ada', kind:'agent'}`; agent requests send `authorization: Bearer <agent_key>` and
  `x-musterd-seat: Ada` (copy the exact header the `integration.asks.test.ts` `ada` helper uses).

```ts
  it('a human reads team defaults before setting anything, and the block names them', async () => {
    const got = await get('/teams/dawn/members/me/style', bearer(deeCred));
    expect(got.status).toBe(200);
    expect(got.json.prefs).toEqual({});
    expect(got.json.resolved.dials).toEqual({ pushback: 'when-it-matters', bluntness: 'plain', length: 'normal', format: 'prose' });
    expect(got.json.block).toContain('For dee (in chat, and in any act addressed to dee)');
  });
  it('a human sets dials and prose and reads them back', async () => {
    const set = await put('/teams/dawn/members/me/style', { length: 'concise', prose: 'Lead with the result.' }, bearer(deeCred));
    expect(set.status).toBe(200);
    expect(set.json.resolved.dials.length).toBe('concise');
    expect(set.json.block).toContain('dee adds: "Lead with the result."');
    const got = await get('/teams/dawn/members/me/style', bearer(deeCred));
    expect(got.json.prefs).toEqual({ length: 'concise', prose: 'Lead with the result.' });
  });
  it('six-line prose is refused 422 with the count (Focus 2)', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    const set = await put('/teams/dawn/members/me/style', { prose: six }, bearer(deeCred));
    expect(set.status).toBe(422);
    expect(set.json.error.message).toBe('prose is 6 lines; the cap is 5');
  });
  it('a floor key in prefs is refused: the floor is not a preference', async () => {
    const set = await put('/teams/dawn/members/me/style', { assess_before_agreeing: false }, bearer(deeCred));
    expect(set.status).toBe(400);
  });
  it('an agent has no style preferences (Focus 1)', async () => {
    const got = await get('/teams/dawn/members/me/style', agentHeaders);
    expect(got.status).toBe(403);
    const set = await put('/teams/dawn/members/me/style', { length: 'concise' }, agentHeaders);
    expect(set.status).toBe(403);
  });
  it("an admin's default moves a human who never set that dial and not one who did (Focus 3)", async () => {
    await put('/teams/dawn/members/me/style', { length: 'concise' }, bearer(deeCred));
    await post('/teams/dawn/policy', { style: { defaults: { length: 'thorough', bluntness: 'direct' } } }, bearer(nickCred));
    const dee = await get('/teams/dawn/members/me/style', bearer(deeCred));
    expect(dee.json.resolved.dials).toMatchObject({ length: 'concise', bluntness: 'direct' });
    const nick = await get('/teams/dawn/members/me/style', bearer(nickCred));
    expect(nick.json.resolved.dials).toMatchObject({ length: 'thorough', bluntness: 'direct' });
  });
  it('the roster carries style on human rows only (Focus 5)', async () => {
    await put('/teams/dawn/members/me/style', { length: 'concise' }, bearer(deeCred));
    const roster = await get('/teams/dawn/members', bearer(nickCred));
    const byName = Object.fromEntries(roster.json.members.map((m: any) => [m.name, m]));
    expect(byName.dee.style).toMatchObject({ length: 'concise' });
    expect(byName.nick.style).toMatchObject({ length: 'normal' });
    expect(byName.Ada.style).toBeNull();
  });
  it('a set writes an audit row naming the dials, never the prose', async () => {
    await put('/teams/dawn/members/me/style', { length: 'concise', prose: 'secretish' }, bearer(deeCred));
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    const rows = await listAudit(server.store, team.id);
    const row = rows.find((r) => r.action === 'style.prefs_set')!;
    expect(row.actor).toBe('dee');
    expect(row.detail).toEqual({ dials: ['length'], prose_lines: 1 });
    expect(JSON.stringify(row)).not.toContain('secretish');
  });
```

- [ ] **Step 2: Run** `pnpm --filter @musterd/server exec vitest run src/transport/style-http.test.ts` — Expected: FAIL, 404 on the route.

- [ ] **Step 3: Implement** — `store/style.ts`:

```ts
import {
  type ResolvedStyle,
  type StylePolicy,
  type StylePrefs,
  StylePrefsSchema,
  resolveStyle,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import type { MemberRow } from './rows.js';
import { getPolicy } from './teams.js';

/**
 * Agent style, server half (ADR 514): a human's own dials live on `members.style_prefs`, daemon-local
 * like `doorbell_prefs` (ADR 443); the floor and team defaults are `policy.style`. Resolution is
 * protocol's `resolveStyle`; this file only reads and writes the row.
 */

/** A member's own style prefs; a malformed blob reads as none (team defaults). Agents have none. */
export function memberStylePrefs(m: MemberRow): StylePrefs | undefined {
  if (m.kind !== 'human' || !m.style_prefs) return undefined;
  try {
    return StylePrefsSchema.safeParse(JSON.parse(m.style_prefs)).data;
  } catch {
    return undefined;
  }
}

export async function setStylePrefs(db: Driver, memberId: string, prefs: StylePrefs): Promise<void> {
  await db.run('UPDATE members SET style_prefs = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(prefs),
    Date.now(),
    memberId,
  ]);
}

/** The team's effective style policy — floor, default dials, team prose (dense, ADR 185 read side). */
export async function teamStyle(db: Driver, teamId: string): Promise<StylePolicy> {
  return (await getPolicy(db, teamId)).style;
}

/** How seats talk to this member: team style resolved against their prefs (agents: team style). */
export async function resolveMemberStyle(db: Driver, teamId: string, m: MemberRow): Promise<ResolvedStyle> {
  return resolveStyle(await teamStyle(db, teamId), memberStylePrefs(m));
}
```

  Route in `http.ts`, directly before the `/members/me/doorbell` block:

```ts
      // Agent style (ADR 514): a human's own dials and prose, self only — no URL member name, no
      // cross-member read (`team_members.style` carries the dials). Agents have no preferences.
      if ((method === 'GET' || method === 'PUT') && rest === '/members/me/style') {
        const { team, member } = await authMember(ctx.db, slug, bearer(req), actingSeat(req), agentSessionLease(req));
        if (member.kind !== 'human')
          throw new MusterdError('forbidden', 'style preferences are for human members');
        if (method === 'PUT') {
          const body: unknown = await readJson(req);
          // The cap answers 422 with the count (spec §4.5); a bare schema parse would say 400.
          const prose = (body as { prose?: unknown } | null)?.prose;
          if (typeof prose === 'string') {
            const problem = styleProseProblem(prose);
            if (problem) throw new MusterdError('validation', problem);
          }
          const prefs = parseOrBadRequest(StylePrefsSchema, body);
          await setStylePrefs(ctx.db, member.id, prefs);
          await appendAudit(ctx.db, team.id, {
            actor: member.name,
            action: 'style.prefs_set',
            target: null,
            result: 'allow',
            detail: {
              dials: (['pushback', 'bluntness', 'length', 'format'] as const).filter((k) => prefs[k] !== undefined),
              prose_lines: styleProseLineCount(prefs.prose ?? ''),
            },
          });
        }
        const fresh = (await getMemberById(ctx.db, member.id)) ?? member;
        const policy = await teamStyle(ctx.db, team.id);
        const prefs = memberStylePrefs(fresh) ?? {};
        const resolved = resolveStyle(policy, prefs);
        return sendJson(res, 200, {
          member: member.name,
          prefs,
          resolved,
          block: renderStyleBlock({ team: resolveStyle(policy), driver: { name: member.name, style: resolved } }),
        });
      }
```

  Imports in `http.ts`: `StylePrefsSchema, renderStyleBlock, resolveStyle, styleProseLineCount,
  styleProseProblem` from `@musterd/protocol`; `memberStylePrefs, setStylePrefs, teamStyle` from
  `../store/style.js`.

  `summarize`: read `const style = await teamStyle(ctx.db, teamId);` once beside `statuses`, and in
  the returned object add
  `style: s.member.kind === 'human' ? resolveStyle(style, memberStylePrefs(s.member)).dials : null,`.

- [ ] **Step 4: Run** `pnpm --filter @musterd/server exec vitest run src/transport/style-http.test.ts src/transport/policy-http.test.ts` — Expected: PASS on both drivers.

- [ ] **Step 5: Commit** `feat(server): GET/PUT /members/me/style + style dials on human roster rows (ADR 514, lane 01M46MQPQ3)`.

---

### Task 6: Docs

- `docs/architecture/02-protocol.md` HTTP table, after the `/members/me/doorbell` rows:

```
| `GET`  | `/teams/:slug/members/me/style`              | —                                                                   | `{ member, prefs, resolved, block }`                              | a human's own style dials and prose, resolved against the team floor and defaults, with the block a seat would read; agents 403 (ADR 514) |
| `PUT`  | `/teams/:slug/members/me/style`              | `{ pushback?, bluntness?, length?, format?, prose? }`              | same as `GET`                                                     | set your own dials; 422 for prose over five lines or 800 characters, naming the count; a floor key is 400 — the floor is not a preference (ADR 514) |
```

- `SPEC.md` A.7, after the `/members/me/doorbell` row: `| `GET`/`PUT` | `/teams/:slug/members/me/style` | a human's own style dials and prose (ADR 514) |` — match the existing row's padding style.
- `docs/architecture/03-server.md` store tree, after `doorbell.ts`:
  `    style.ts          // agent style, server half (ADR 514): members.style_prefs (human-only, daemon-local like doorbell_prefs) + teamStyle (policy.style, dense) + resolveMemberStyle; the self route and the roster's \`style\` read through it`
- ADR 514 `## Consequences`, a dated note: *2026-10-05 — increment 2 landed … `style_epoch` on
  claim/heartbeat/presence, `style` on roster rows, `GET/PUT /members/me/style`, ladder v86. The
  spec's hub forward for prefs is not built: prefs are daemon-local like `doorbell_prefs`; lane
  `<id from Task 7>` carries the forward, trigger: a human on a second machine sets a dial a seat
  elsewhere does not see.*
- Spec §4.5 write-path paragraph: replace "it writes locally, then forwards to the hub; a failed
  forward leaves the local block in force and the roster shows `pending sync`" with "it writes
  locally; the hub forward is lane `<id>` (see ADR 514 Consequences, 2026-10-05)".

### Task 7: Lane for the deferred forward; gates; land

- `lane_open {title: "Agent style — a human's style prefs replicate joiner → hub (/sync/style), so a dial set on one machine reaches seats on another", goal_id: "agent-style", project: "runtime", scope: ["packages/server/src/sync/**", "packages/server/src/transport/http.ts"], detail: "Deferred from inc 2 (plan 2026-10-05-agent-style-server). Trigger: a human on a second machine sets a dial and a seat elsewhere keeps the old block. Precedent to decide against: doorbell_prefs is daemon-local too."}` — paste the id into Task 6's two docs.
- `pnpm -s vocab:check && pnpm -s intents:check && pnpm -s change-adr:check`; `pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check` (expect the drift check `arch-trees:check` to pass on the new tree line).
- Commit `docs: 02-protocol + SPEC rows, 03-server tree, ADR 514 note, spec §4.5 (lane 01M46MQPQ3)`; push; `gh pr ready`; `gh pr merge --squash --auto --delete-branch`.
- After merge: `lane_submit {id, pr, sha, authorized_by: "nick", follows_up: "01M46MQQFS3W2W4N37S7BB9RX5"}`; follow the reply (ADR 235); detach to `origin/main`, `git branch -D feat/agent-style-server`.
