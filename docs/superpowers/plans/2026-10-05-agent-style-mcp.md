# Agent style, increment 3 — MCP: implementation plan

> **For agentic workers:** executed inline, in the owning seat, with `superpowers:executing-plans`.
> No subagent edits, builds or commits (AGENTS.md hard rule 8). Steps use checkbox (`- [ ]`) syntax.

**Goal:** a seat reads its style block in the `team_join` reply, is told when it changes, attests
the epoch it runs, sees each human's dials on the roster, and a human in a chat folder can read and
set their own dials — so the stance floor and per-human preferences reach every harness through the
one channel they all share.

**Architecture:** the daemon composes a **style envelope** `{ block, epoch, dials, driver }` with
the same `resolveStyle`/`renderStyleBlock` increment 1 shipped and hands it to the seat where it
already hands the memory envelope — the `occupied` frame (WS and HTTP claim). The adapter keeps it
like `memoryEnvelope`, renders the block in `team_join`, attests `epoch` on claim and heartbeat,
and on `team_inbox_check` compares the daemon's current epoch (new field on `GET /inbox`) with
its own, fetching the new block from `GET /style-block` when they differ. The skill bullet leaves
`guidance.ts`; the primer gains its one pointer line (ADR 085).

**Tech Stack:** TypeScript, zod, vitest; `@modelcontextprotocol/server` tool registration as in
`tools/memory.ts`.

**Spec:** `docs/superpowers/specs/2026-10-05-agent-style-design.md` §4.2–4.4 (block, which human,
delivery, standing, attestation), §4.5 (MCP row), §4.6. ADR 514 Decision 5 ("where the block is
delivered is increment 3's work") and 6.

## Global Constraints

- Protocol change is additive and ADR 514 names it: `OccupiedFrame.style` (nullish, so an older
  daemon that omits it still parses), `StyleEnvelopeSchema`. Record as a dated ADR 514 Consequences
  note; `## Decision` stays untouched.
- One fact, one home (ADR 085): the push-back bullet leaves `guidance.ts` **in this increment**,
  since the block now carries it; `GUIDANCE_CONTENT_VERSION` 44 → 45 with a new snapshot line; the
  primer keeps exactly one pointer line.
- Absent is unknown, never a clear (ADR 236/417): the adapter sends `style_epoch` only when it holds
  an envelope; an inbox reply without `style_epoch` (older daemon) changes nothing.
- Agents have no preferences: `team_style_set` from an agent seat surfaces the daemon's 403 text.
- Prose cap: 5 lines / 800 chars; the daemon's 422 message is what the tool shows.
- Trailers on every commit: `Co-authored-by: stanley <stanley@revive.musterd>`,
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`,
  `Claude-Session: https://claude.ai/code/session_01SFEcztwcWpafWmg2uS2DW8`.
- Fast gates before push: `pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check`.

## Review Focus

1. **An older daemon (no `style` on `occupied`, no `style_epoch` on `/inbox`)**: `team_join` renders
   as today, nothing is attested, `team_inbox_check` adds no line. Task 4/5 tests with a fake client
   whose `style` is null.
2. **A driver who has no prefs row** still gets a `For <name>` line in team defaults; **no driver and
   two humans** gets the `several humans` line. Task 3 tests.
3. **Epoch change mid-session**: `/inbox` reports a different epoch → one `Style changed` line naming
   the dial that moved, the new block, and the next heartbeat attests the new epoch. Task 5 test.
4. **`team_style_set` with one dial** does not wipe the others — read-merge-write, and `clear: true`
   is the only way to empty. Task 5 test.
5. **The skill no longer states the push-back rule and the primer points at the block**: a seat whose
   `team_join` carried the block has the rule once; a seat on an old daemon has it in neither, which
   the primer's pointer line names ("if no block arrived, the floor is ADR 514's"). Task 2.

## Increments

| # | Lane | This plan? |
| --- | --- | --- |
| 3 — MCP | `01M46MQQFS3W2W4N37S7BB9RX5` | yes, below |
| 4 — CLI | `01M46MQR8F6E6G9BRX0JMY8CMH` | at its turn |
| 5 — web | `01M46MQSMJFBNGS0QE4PHVTXWT` | at its turn (miley) |
| 6 — readout | `01M46MQW7GV4BD3SV9HDKDRETV` | at its turn |

**Two rulings taken in the plan.** (a) The spec's `style changed by nick: length concise → thorough`
line: the adapter knows the old and new dials (both envelopes), not who changed them — the audit
row does; the line names the dial change and omits the actor. (b) `team_send` echoing the
addressee's dials: only when the send path already holds the roster (it does for eligible-set
checks); otherwise no extra round trip per send — decided at Task 5 against the code.

---

## Tasks

### Task 1: Branch, lane, ledger

```bash
cd /Users/nick/musterd/revive/agents/stanley
git fetch origin main && git checkout -b feat/agent-style-mcp origin/main
```

`lane_update {id: "01M46MQQFS3W2W4N37S7BB9RX5", state: "active", branch: "feat/agent-style-mcp"}`.
Push + draft PR after Task 2's first commit.

---

### Task 2: Protocol — envelope, occupied frame, floor phrase, guidance v45, primer line

**Files:**
- Modify: `packages/protocol/src/style.ts` (+ `StyleEnvelopeSchema`, `describeDialChange`, phrase)
- Modify: `packages/protocol/src/claim-handshake.ts` (OccupiedFrame `style`)
- Modify: `packages/protocol/src/guidance.ts` (bullet out, v45), `guidance.test.ts` (snapshot 45)
- Modify: `packages/protocol/src/primer.ts` (pointer line), `primer.test.ts`
- Test: `packages/protocol/src/style.test.ts`, `claim-handshake.test.ts`

**Interfaces — Produces:**
- `StyleEnvelopeSchema = z.object({ block: z.string(), epoch: StyleEpochSchema, dials: StyleDialsSchema, driver: z.string().nullable() })`, type `StyleEnvelope`.
- `describeDialChange(from: StyleDials, to: StyleDials): string` — `length concise → thorough` joined by `, `; `''` when equal.
- `OccupiedFrame.style: StyleEnvelopeSchema.nullish()`.
- Floor phrase 4 becomes `weigh a human's critique by its evidence, like anyone's` (sloane's acceptance note).

- [ ] **Step 1: Failing tests** (append to `style.test.ts`; adjust the two renderer expectations that quote the old phrase):

```ts
describe('StyleEnvelopeSchema + describeDialChange (inc 3)', () => {
  it('an envelope carries block, epoch, dials and the driver (or null)', () => {
    const r = resolveStyle(shipped);
    const env = StyleEnvelopeSchema.parse({ block: renderStyleBlock({ team: r }), epoch: r.epoch, dials: r.dials, driver: null });
    expect(env.driver).toBeNull();
    expect(() => StyleEnvelopeSchema.parse({ block: 'x', epoch: 'nope', dials: r.dials, driver: null })).toThrow();
  });
  it('describeDialChange names only the dials that moved', () => {
    const a = shipped.defaults;
    expect(describeDialChange(a, { ...a, length: 'thorough' })).toBe('length normal → thorough');
    expect(describeDialChange(a, { ...a, length: 'concise', bluntness: 'direct' })).toBe('bluntness plain → direct, length normal → concise');
    expect(describeDialChange(a, a)).toBe('');
  });
});
```

In `claim-handshake.test.ts`, beside the existing occupied-frame case: an occupied frame **with**
`style: { block, epoch: 'a1b2c3d4', dials, driver: 'nick' }` parses, one **without** `style`
parses (older daemon), one with `style: null` parses.

In `primer.test.ts` `wraps the shared working loop`: `expect(primer).toContain('style block')`.

- [ ] **Step 2: Run** `pnpm --filter @musterd/protocol exec vitest run src/style.test.ts src/claim-handshake.test.ts src/primer.test.ts` — Expected: FAIL (not exported / phrase / primer).

- [ ] **Step 3: Implement.** `style.ts`: after `StyleEpochSchema`:

```ts
/** What the daemon hands a seat on `occupied` and on `GET /style-block` (ADR 514 inc 3): the block
 *  to read, the epoch to attest, the dials it resolved (so a later change can be named) and whose
 *  dials they are. `driver` is null when the block carries only the team defaults. */
export const StyleEnvelopeSchema = z.object({
  block: z.string(),
  epoch: StyleEpochSchema,
  dials: StyleDialsSchema,
  driver: z.string().nullable(),
});
export type StyleEnvelope = z.infer<typeof StyleEnvelopeSchema>;

/** `length normal → thorough`, one entry per dial that moved, in dial order; '' when none did. */
export function describeDialChange(from: StyleDials, to: StyleDials): string {
  return (['pushback', 'bluntness', 'length', 'format'] as const)
    .filter((k) => from[k] !== to[k])
    .map((k) => `${k} ${from[k]} → ${to[k]}`)
    .join(', ');
}
```

Phrase: `['human_critique_weighed_as_peer', "weigh a human's critique by its evidence, like anyone's"]`
— and the matching expectations in `style.test.ts` (two places quote the full floor line).

`claim-handshake.ts` OccupiedFrame, after `memory`:

```ts
  /** The style envelope (ADR 514 inc 3): the block this seat reads, its epoch, dials, driver.
   *  Absent from an older daemon, null when the team has no style to say (never today: the shipped
   *  floor always renders) — both read as "nothing to attest". */
  style: StyleEnvelopeSchema.nullish(),
```

`guidance.ts`: delete the eight bullet lines (`- **Push back on the human too, in chat.**` through
`arrives as a style block on \`team_join\` once the daemon serves it (ADR 514).`); bump to 45; run
the snapshot test, record the hash on a new `45:` line with the note
`ADR 514 inc 3 (lane 01M46MQQFS): the push-back bullet leaves — the style block on team_join carries the floor; the primer points at it`.

`primer.ts`, after the "Ask a human" bullet and before the blank line that precedes "Invoke the tools":

```ts
    '- **How you talk is in your `team_join` reply.** The style block there (ADR 514) is the team floor plus',
    '  your human\'s dials; a later `team_inbox_check` may replace it. No block arrived? Assess before you',
    '  agree, push back once with the reason, then commit — that is the floor.',
```

- [ ] **Step 4: Run** the three test files + `pnpm --filter @musterd/protocol exec vitest run` (whole package: snapshot + exports) — Expected: PASS. `pnpm --filter @musterd/protocol build`.

- [ ] **Step 5: Commit** `feat(protocol): style envelope on occupied, describeDialChange, floor phrase; guidance v45 drops the push-back bullet; primer points at the block (ADR 514 inc 3, lane 01M46MQQFS)`. Push; `gh pr create --draft`.

---

### Task 3: Server — envelope on `occupied`, `GET /style-block`, `style_epoch` on `/inbox`

**Files:**
- Modify: `packages/server/src/store/style.ts` (+ `styleEnvelopeFor`, `driverForSeat`)
- Modify: `packages/server/src/transport/ws.ts` (occupied), `http.ts` (HTTP claim occupied, `/style-block`, `/inbox`)
- Test: `packages/server/src/transport/style-http.test.ts` (append), `integration.attestation-lanes.test.ts` (occupied carries style)

**Interfaces — Produces:**
- `styleEnvelopeFor(db, teamId, driver: string | null): Promise<StyleEnvelope>` — §4.3: a named driver who is a human member → their dials; no driver and exactly one human → that human; else team defaults with `no_driver: 'unbound' | 'several_humans'`.
- `driverForSeat(db, teamId, memberId): Promise<string | null>` — the newest live presence's `driver` for that member, else null.
- `GET /teams/:slug/style-block?driver=<name>` → `StyleEnvelope` (any seat; `driver` overrides the presence's).
- `GET /teams/:slug/inbox` gains `style_epoch: string` (envelope epoch for the caller's driver).

- [ ] **Step 1: Failing tests** (`style-http.test.ts`):

```ts
  describe('the style envelope a seat receives (inc 3)', () => {
    it('GET /style-block names the driver passed, their dials, and the team line', async () => {
      const t = await team();
      await put('/teams/dawn/members/me/style', { length: 'concise' }, t.dee);
      const got = await get('/teams/dawn/style-block?driver=dee', t.ada);
      expect(got.status).toBe(200);
      expect(got.json.driver).toBe('dee');
      expect(got.json.dials.length).toBe('concise');
      expect(got.json.block).toContain('For dee (in chat, and in any act addressed to dee): pushback when it matters · plain · concise · prose.');
      expect(got.json.epoch).toMatch(/^[0-9a-f]{8}$/);
    });
    it('no driver and two humans ⇒ team defaults, says so (Focus 2)', async () => {
      const t = await team();
      const got = await get('/teams/dawn/style-block', t.ada);
      expect(got.json.driver).toBeNull();
      expect(got.json.block).toContain('No driver bound and this team has several humans');
    });
    it('no driver and ONE human ⇒ that human is the driver', async () => {
      const created = await post('/teams', { slug: 'solo', creator: { name: 'nick', kind: 'human' } });
      const nick = created.json.human_credential;
      await post('/teams/solo/members', { name: 'Ada', kind: 'agent' }, nick);
      const got = await get('/teams/solo/style-block', { key: created.json.agent_key, seat: 'Ada' });
      expect(got.json.driver).toBe('nick');
      expect(got.json.block).toContain('For nick');
    });
    it('GET /inbox carries the current style_epoch for the seat (Focus 3, daemon half)', async () => {
      const t = await team();
      const before = (await get('/teams/dawn/inbox?unread=1', t.ada)).json.style_epoch;
      expect(before).toMatch(/^[0-9a-f]{8}$/);
      await post('/teams/dawn/policy', { style: { defaults: { length: 'thorough' } } }, t.nick);
      const after = (await get('/teams/dawn/inbox?unread=1', t.ada)).json.style_epoch;
      expect(after).not.toBe(before);
    });
  });
```

`integration.attestation-lanes.test.ts`: in the style-epoch test, assert
`occupied.style.block` contains `Style (epoch` and `occupied.style.epoch` matches `/^[0-9a-f]{8}$/`
(the claim there sends no `driver`, two humans exist → driver null).

- [ ] **Step 2: Run** both files — Expected: FAIL (404 / undefined).

- [ ] **Step 3: Implement.** `store/style.ts`:

```ts
/** The driver of a seat's newest live presence, if any (ADR 021/155 driver co-presence). */
export async function driverForSeat(db: Driver, teamId: string, memberId: string): Promise<string | null> {
  const row = await db.get<{ driver: string | null }>(
    'SELECT driver FROM presence WHERE team_id = ? AND member_id = ? AND held_until IS NULL ORDER BY last_seen_at DESC LIMIT 1',
    [teamId, memberId],
  );
  return row?.driver ?? null;
}

/** The envelope a seat reads (spec §4.3): the named driver's dials when they are a human member;
 *  with no driver, the team's only human; otherwise team defaults, and the block says why. */
export async function styleEnvelopeFor(db: Driver, teamId: string, driver: string | null): Promise<StyleEnvelope> {
  const policy = await teamStyle(db, teamId);
  const team = resolveStyle(policy);
  const members = (await listMembers(db, teamId)).filter((m) => m.left_at === null);
  const humans = members.filter((m) => m.kind === 'human');
  const named = driver ? humans.find((m) => m.name === driver) : undefined;
  const chosen = named ?? (!driver && humans.length === 1 ? humans[0] : undefined);
  if (chosen) {
    const style = resolveStyle(policy, memberStylePrefs(chosen));
    return {
      block: renderStyleBlock({ team, driver: { name: chosen.name, style } }),
      epoch: style.epoch,
      dials: style.dials,
      driver: chosen.name,
    };
  }
  const no_driver = humans.length > 1 ? 'several_humans' : 'unbound';
  return { block: renderStyleBlock({ team, no_driver }), epoch: team.epoch, dials: team.dials, driver: null };
}
```

(`listMembers` from `./members.js` — check the exact export; `resolveStyle`, `renderStyleBlock`,
`StyleEnvelope` from protocol.) `ws.ts` occupied: `style: await styleEnvelopeFor(ctx.db, team.id, frame.driver ?? null),`; `http.ts` HTTP claim occupied JSON: `style: await styleEnvelopeFor(ctx.db, team.id, null)` (the HTTP claim carries no driver today). Route, beside `/members/me/style`:

```ts
      // ADR 514 inc 3: the block a seat reads, for its driver (query) or its presence's driver.
      if (method === 'GET' && rest === '/style-block') {
        const { team, member } = await authMember(ctx.db, slug, bearer(req), actingSeat(req), agentSessionLease(req));
        const driver = url.searchParams.get('driver') ?? (await driverForSeat(ctx.db, team.id, member.id));
        return sendJson(res, 200, await styleEnvelopeFor(ctx.db, team.id, driver));
      }
```

`/inbox` (the non-`ids` branch's `sendJson`): add
`style_epoch: (await styleEnvelopeFor(ctx.db, team.id, await driverForSeat(ctx.db, team.id, member.id))).epoch`.

- [ ] **Step 4: Run** the two files + `policy-http.test.ts` — Expected: PASS on both drivers.
- [ ] **Step 5: Commit** `feat(server): style envelope on occupied, GET /style-block, style_epoch on /inbox (ADR 514 inc 3, lane 01M46MQQFS)`.

---

### Task 4: MCP client — keep the envelope, attest the epoch, notice a change

**Files:** `packages/mcp/src/client.ts`; test `packages/mcp/src/client.test.ts` (or the nearest existing client test that fakes an occupied frame — search `memoryEnvelope` / `frame.memory` in `*.test.ts`).

**Interfaces — Produces:**
- `get style(): StyleEnvelope | null`; set from `frame.style ?? null` on occupied; cleared where `memoryEnvelope` is.
- Claim frame and heartbeat carry `style_epoch: this.styleEnvelope.epoch` when an envelope is held.
- `fetchInbox` result gains `style_epoch?: string` (pass-through of the daemon field).
- `refreshStyle(): Promise<StyleEnvelope | null>` → `GET /teams/<team>/style-block` + `?driver=` when `config.driver`; stores and returns it.

- [ ] **Step 1: Failing tests** — mirror the existing occupied/heartbeat test shape: an occupied frame carrying `style` populates `client.style`; the next heartbeat frame includes `style_epoch`; an occupied frame without `style` leaves `client.style` null and the heartbeat omits `style_epoch` (Focus 1).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** as listed; the heartbeat/claim spread follows the `guidance_epoch` spread exactly.
- [ ] **Step 4: Run** `pnpm --filter @musterd/mcp exec vitest run src/client.test.ts` (and whichever file holds the occupied tests) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): client keeps the style envelope, attests style_epoch, reads it off /inbox (ADR 514 inc 3, lane 01M46MQQFS)`.

---

### Task 5: MCP tools — join block, inbox change line, members dials, `team_style` / `team_style_set`

**Files:**
- Modify: `tools/join.ts`, `tools/inboxCheck.ts`, `tools/members.ts`, `tools/send.ts` (only if the roster is already in hand), `toolNames.ts`, `index.ts` (register)
- Create: `tools/style.ts`
- Test: `tools/tools.test.ts` (append), `tools/inboxCheck.*.test.ts` nearest

**Interfaces — Produces:** tools `team_style` (no args) and `team_style_set {pushback?, bluntness?, length?, format?, prose?, clear?}`; `MusterdClient.styleRead(): Promise<StyleSelfRead>` and `styleWrite(prefs): Promise<StyleSelfRead>` over `GET/PUT /members/me/style`.

- [ ] **Step 1: Failing tests** (`tools.test.ts`, `captureAll` with a fake client):
  - `team_join` reply contains the block when `client.style` is set; not when null (Focus 1).
  - `team_inbox_check`: fake `fetchInbox` returning `style_epoch: 'ffffffff'` while `client.style.epoch` is `'a1b2c3d4'` and `refreshStyle` returning the new envelope with `length: 'thorough'` → text starts with `Style changed (length normal → thorough)` followed by the new block; with equal epochs no line; with no `style_epoch` in the reply no line (Focus 3, Focus 1).
  - `team_members`: a human row with `style` renders ` · style: pushback when it matters · plain · concise · prose`; an agent row has no style facet.
  - `team_style_set { length: 'concise' }` calls `styleWrite` with `{ ...existingPrefs, length: 'concise' }` (read-merge-write, Focus 4); `{ clear: true }` writes `{}`; a daemon 403 surfaces as text containing `for human members`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `join.ts`: after `memory`, `const style = client.style ? `\n\n${client.style.block}` : '';` appended before the IMPORTANT paragraph. `inboxCheck.ts`: after the fetch, `if (reply.style_epoch && client.style && reply.style_epoch !== client.style.epoch) { const prev = client.style; const next = await client.refreshStyle(); if (next) styleNotice = `Style changed${change ? ` (${change})` : ''} — read the block below; it replaces the one from team_join.\n${next.block}\n\n`; }` where `change = describeDialChange(prev.dials, next.dials)`; prepend to `text` and add `style_changed: {from, to}` to `structuredContent`. `members.ts`: `if (m.kind === 'human' && m.style) line += ` · style: ${describeDials(m.style)}`;`. `tools/style.ts`: the two tools on the `memory.ts` template; descriptions say self-only and that agents have none. Register in `index.ts` where `registerMemory` is; add both names to `TOOL_NAMES`.
- [ ] **Step 4: Run** `pnpm --filter @musterd/mcp exec vitest run` (whole package: `tools.test` counts tools; `scopeSurface`/`resultAudit` enumerate registered tools and may need the two names added to their expectations) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): style block on team_join, change line on team_inbox_check, dials on team_members, team_style/team_style_set (ADR 514 inc 3, lane 01M46MQQFS)`.

---

### Task 6: Docs

- `docs/architecture/02-protocol.md`: HTTP rows for `GET /teams/:slug/style-block` and the `style_epoch` field on `GET /inbox`; the `occupied` frame mention gains `style`.
- `SPEC.md` A.7: `GET /teams/:slug/style-block` row; A.3 occupied frame: `style` envelope, additive.
- `docs/architecture/05-mcp.md` tools tree: `style.ts` line; `join.ts`/`inboxCheck.ts`/`members.ts` lines mention the block / change line / dials.
- ADR 514 `## Consequences`: dated increment-3 note (envelope on occupied, `/style-block`, `/inbox.style_epoch`, tools, bullet removed at v45, primer line, floor phrase change).
- Spec §4.2 example: the new floor phrase; §4.4 "Change mid-session" names the dial-change line without the actor (ruling a); §7 inc 3 line stays (bullet left here as it says).

### Task 7: Gates, land, submit

`pnpm -s format`, `pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check` (the 05-mcp
tree is drift-checked). Commit docs; push; `gh pr ready`; `gh pr merge --squash --auto
--delete-branch`. After merge: `lane_submit {id, pr, sha, authorized_by: "nick", follows_up:
"01M46MQR8F6E6G9BRX0JMY8CMH"}`; follow the reply; detach to `origin/main` and `git branch -D`.
