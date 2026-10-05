# Agent style — design

- Date: 2026-10-05
- Author: stanley (lane `01M44BNKM2N826210MWHY2NP0V`), from the design conversation with nick on
  2026-10-05
- Goal: `agent-style`
- Status: approved by nick 2026-10-05; the protocol change is recorded as one ADR when increment 1
  starts (number from `pnpm adr:next`)
- Builds on: ADR 476 (verify before conceding; the "push back on the human" line dolly shipped in
  lane `01M44BNJRF4C67HQNGM26Z74P5`), ADR 085 (one fact per guidance layer), ADR 185 (team policy
  is stored sparsely), ADR 307 (the primer is local to the Workspace), ADR 417 (a seat attests the
  guidance it runs), ADR 443 (`members.doorbell_prefs`, the per-human prefs precedent), ADR 021/155
  (`binding.driver`, the human steering a Workspace), ADR 294 (no bare rates), ADR 487 (increments
  are lanes under the Goal), `docs/design/brand.md` §4 (voice for product copy, which this does
  not change)

## 1. Outcome

Every seat on the team talks the same way — assesses before it agrees, disagrees once with the
reason and then commits, never opens with praise — whatever harness or model it runs on. That is
the **team floor**, and the team's human admins own it. On top of the floor, **each human sets how
seats talk to them**: how readily a seat pushes back, how bluntly, how long, in prose or structured,
plus a few lines of their own. Those preferences follow the human onto every seat, harness and
machine, in the chat and in every act addressed to them. The shared record — `@team`, peer-to-peer
acts, `/live` — stays in one voice, the team default.

A seat learns all of this from musterd at session start, in the reply it already reads, and is told
when it changes. Nothing is written into a harness's own settings.

## 2. Boundaries

**In:** the style data model (floor, team defaults, per-human dials, prose); the resolved **style
block** a seat receives on `team_join` and when it changes; the roster exposure so a seat addressing
another human uses theirs; `style_epoch` attestation on presence; CLI, MCP and web surfaces to set
and read it; a readout.

**Out, with the reopen trigger named:** rendering dials into harness-native format settings
(Claude Code output styles, Cursor rules) — reopened if the first readout (§6) shows the `length`
dial not moving what reaches the human in chat. Any instruction to disagree *more*, or a target
concession rate (ADR 476 forbids it). Measuring chat itself: chat is off the record, so the floor's
effect in chat stays unmeasured, as ADR 476 says. Product-copy voice (`brand.md` §4) is a different
thing and is untouched.

**Who may do what.** The floor and team defaults: human admins only. A human's own dials and
prose: that human only — never a seat, never an admin on another human's behalf. Agents have no
style preferences. A preference can never lower the floor.

## 3. What already exists, from the code

- **The primer is static.** `primerInstructions` (`packages/mcp/src/index.ts`) renders MCP
  `instructions` from the local config; the skill files are static renders of the CLI build and move
  only on `musterd init` / the doctor's repair ([guidance distribution](../../wiki/guidance-distribution.md)).
  Nothing per-human or admin-editable can live there.
- **The daemon already speaks in the join reply.** `team_join` returns live text — the seat-memory
  headline (`packages/mcp/src/tools/memory.ts`) — and every harness receives it on every session.
- **The driver rides to the daemon.** `config.driver` (`MUSTERD_DRIVER` env, else `binding.driver`;
  `packages/mcp/src/config.ts`) is sent on join and stored on the presence row (`presence.driver`).
  The daemon knows which human steers a Workspace at the moment it composes the reply.
- **Per-human prefs have a column.** `members.doorbell_prefs` with `DoorbellPrefsSchema` and a pure
  `resolveRoute(policy, prefs)` in protocol — the exact shape style needs.
- **Team policy is sparse and admin-only.** `POST /policy` (`authAdmin`) stores the override doc
  verbatim (ADR 185), forwards to the hub on an enrolled joiner, refuses when the hub is unreachable,
  and audits `policy.change`.
- **Admin is a real fact.** `resolveCapabilities(row).is_admin`; agents are never admins.
- **Attestation has a slot.** `presence.guidance_epoch` (ADR 417) is sent by the adapter on
  heartbeats; `style_epoch` sits beside it.
- **Stance guidance exists once already.** The "push back on the human too, in chat" bullet in
  `packages/protocol/src/guidance.ts` (content v43). It moves into the floor renderer so the fact
  has one home.

## 4. Design

### 4.1 Data model

**Team floor and defaults** — a `style` key on the team policy override (`PolicyOverrideSchema`,
`packages/protocol/src/credentials.ts`), sparse like every other key:

```ts
style: {
  floor: {
    assess_before_agreeing: boolean,        // no praise before a check
    disagree_once_then_commit: boolean,     // say it once, with the reason, then follow the decision
    concession_names_check: boolean,        // a concession says what was checked; a wrong one → ledger
    human_critique_weighed_as_peer: boolean // a human's critique carries its evidence, no more
  },
  defaults: {
    pushback:  'every-time' | 'when-it-matters' | 'only-on-risk',
    bluntness: 'direct' | 'plain' | 'soft',
    length:    'concise' | 'normal' | 'thorough',
    format:    'prose' | 'structured'
  },
  prose: string   // team-wide addendum, ≤ 5 lines and ≤ 800 characters, optional
}
```

Shipped defaults are constants in `@musterd/protocol`: every floor boolean `true`;
`when-it-matters · plain · normal · prose`; empty prose. An admin's override names only what they
changed, so a read can label each knob `default` or `set by <admin> <date>` from the audit row.
Turning a floor boolean off is how an admin configures the floor; the audit records who did.

**Per-human dials** — a new `members.style_prefs` column (SQLite migration + pg baseline), nullable:

```ts
StylePrefsSchema = {
  pushback?, bluntness?, length?, format?,   // same enums as defaults
  prose?: string                             // ≤ 5 lines
}
```

Unset means "team default". Written only by that human for themselves. Agents' rows never carry it.

**Resolution** — one pure function in protocol:

```ts
resolveStyle(policy: Policy, prefs?: StylePrefs): ResolvedStyle
// floor: from policy (prefs cannot touch it)
// dials: each from prefs, else policy.defaults
// prose: [policy.prose, prefs.prose] in that order, each labelled
// epoch: short hash of (policy.style, prefs) — stable while neither changes
```

Tested like `resolveRoute` in `doorbell.ts`: one case per dial, each floor boolean off, prose cap,
epoch stability and change.

### 4.2 The style block

`renderStyleBlock(resolved, { driver, record })` returns 8–12 lines of prose — an instruction, not
JSON. Shape:

```
Style (epoch a1b2c3) — how you talk here.
Floor (team): assess before you agree; no praise before a check; disagree once, with the reason,
  then follow the decision; a concession names what you checked; a human's critique weighs what
  its evidence weighs.
For nick (in chat, and in any act addressed to nick): pushback when it matters · direct · concise · prose.
nick adds: "Lead with the result. Tell me when I'm wrong, once, then do it my way."
Everyone else, @team and the record: team defaults (pushback when it matters · plain · normal · prose).
```

A floor boolean an admin turned off is omitted from the Floor line. Prose prints as one
JSON-quoted line (line breaks and quotes escaped), so a multi-line prose can never shed its label. Team prose, when set, prints
after the Floor line as `The team adds: …`. The renderer prints the floor first and labels the
human's prose as theirs, so a seat reading "just agree with me" in prose also reads the floor above
it and knows which wins. No prose filter.

### 4.3 Which human

The chat human is the presence's `driver`. If none is bound and the team has exactly one human
member, it is that human. Otherwise the block carries only the floor and team defaults and says so
— `no driver bound — team defaults in chat` — and `musterd style` tells the human how to bind
(`musterd agent --driver <you>`). A seat never guesses.

### 4.4 Delivery

- **Join.** `team_join`, and the auto-claim on a first `team_inbox_check`, append the style block to
  the reply after the memory headline. Composed server-side from the team policy, the driver's
  `style_prefs` and the presence's driver.
- **Other humans.** `team_members` gains `style` on human rows: the resolved dials, no prose. The
  `team_send` reply to an act addressed to a human echoes that human's dials in one line.
- **Change mid-session.** The adapter sends `style_epoch` beside `guidance_epoch` on heartbeats.
  When the daemon's current epoch for that seat differs, the next `team_inbox_check` reply leads
  with the new block and one line: `style changed by nick: length concise → thorough`. No restart.
- **Standing.** The static primer keeps one pointer line (the duplication ADR 085 allows): *the style
  block in your join reply governs how you talk; a later inbox reply may replace it.* Dolly's bullet
  leaves `guidance.ts`; `GUIDANCE_CONTENT_VERSION` bumps.
- **Attestation.** `presence.style_epoch` is recorded on attach and heartbeat. Roster rows show
  `style <epoch>`; a seat whose attested epoch differs from the current one shows `style stale`,
  the guidance-drift treatment. Absent is unknown, never current (ADR 135).

### 4.5 Surfaces

| Who | CLI | MCP | Web (`/board`) |
| --- | --- | --- | --- |
| Any human, self only | `musterd style` (the block as a seat receives it) · `musterd style set length=concise pushback=every-time` · `musterd style set --prose "…"` · `musterd style clear` | `team_style` (read) · `team_style_set` from a human-interactive chat folder; refused for a seat | "how agents talk to me" card on the human's own row |
| Admins | `musterd policy style` (each knob labelled default / set by whom) · `musterd policy style set assess_before_agreeing=false` · `--prose` | none — admins are humans | team policy card, admin-only |

Writes go through `StylePrefsSchema` / `PolicyOverrideSchema` at the boundary. Prose over five
lines is refused with the count. The admin path rides `POST /policy`, so hub forwarding and the
`policy.change` audit row come with it. The self path is a new self-only route on the member
(`authMember`, target must equal the caller), the doorbell-prefs precedent; it writes locally. The
hub forward — so a dial set on one machine reaches seats on another — is lane
`01M46RWP23N253H9M0HDWPYJNB` (deferred at increment 2; ADR 514 Consequences, 2026-10-05).

### 4.6 Failure modes

- Hub unreachable on a floor change → refused (policy may not fork), as every policy write.
- Prefs that contradict the floor → cannot, by construction (§4.2).
- No driver, several humans → floor + team defaults, stated (§4.3).
- Old daemon, new adapter (or the reverse) → a join reply with no block means the seat follows the
  primer and skill as today; `style_epoch` absent is unknown.
- A seat calls `team_style_set` → refused: agents have no preferences.

## 5. Alternatives considered

- **Static guidance (skill + primer renderers, a per-Workspace prefs file).** Cheapest, and the floor
  stops being admin-editable without a rebuild, a human's dials reach only re-provisioned
  Workspaces, and it inherits the five-day stale-distribution outage. Rejected.
- **Daemon-served block plus harness-native renderers.** Everything here, and musterd also writes
  each harness's format knob from the dials (musterd configures, the harness enforces). Strongest
  effect on chat format; per-harness work; the same fact in two places. Deferred with the §2 trigger.
- **Free prose only, no dials.** Expressive and unmeasurable; two humans' paragraphs can contradict
  and nothing can say so. The dials are what the eval keys on; prose stays as the capped addendum.

## 6. Limits and verification shape

Chat is off the record. What this can measure, as `pnpm style:readout` under ADR 294's rules
(detection channel and denominator on every number; no leaderboard by seat):

- **Dials on acts addressed to a human:** body length of `ask` / `message` / `handoff` to each human,
  by that human's `length` dial and the sender's `style_epoch`. Pass: `concise` is shorter than
  `normal` for the same human after the epoch that set it.
- **Stance:** ADR 476's own eval (unverified-concession share, `challenge` decline rate) split by
  `style_epoch`, so an admin's floor change reads as a before/after.
- **Adoption:** humans with any dial set / humans; seats attesting the current epoch / live seats.

Falsifier for the design: thirty days after increment 3 lands, no human has set a dial, or the
`length` split shows no difference — then the block has no standing with the models and §2's
deferred alternative is the next increment.

Tests: protocol — `resolveStyle` and `renderStyleBlock` unit cases above. Server — `POST /policy`
with `style`, the self route, admin / self-only auth, migration round-trip on SQLite and pg, epoch
on presence. MCP — join reply carries the block; inbox reply carries the change line on epoch
mismatch; `team_members.style` on human rows; `team_style_set` refused for a seat. CLI — snapshot
tests for `musterd style` and `musterd policy style` against terminal frames. Package coverage
floors as usual.

## 7. Increments (each a lane under `agent-style`)

Each increment has its lane (ADR 487), opened 2026-10-05, unowned until its turn.

1. **ADR + protocol** — schemas, shipped defaults, `resolveStyle`, `renderStyleBlock`, epoch; the
   floor renderer carries dolly's rule; the skill bullet names the coming block (v44). Lane
   `01M46MQD2FXXJ1RVTDCN6XW7WK`.
2. **Server** — policy `style`, `members.style_prefs` + migrations, the self route, presence
   `style_epoch`. Lane `01M46MQPQ3JC6EWMY7WV6SY8AA`. The hub forward for prefs is its own lane,
   `01M46RWP23N253H9M0HDWPYJNB` (§4.5).
3. **MCP** — block on join and on epoch change, `team_members.style`, `team_style` /
   `team_style_set`, epoch on heartbeat, primer pointer line; dolly's bullet leaves `guidance.ts`
   here, when the block ships (plan 2026-10-05, Task 6). Lane `01M46MQQFS3W2W4N37S7BB9RX5`.
4. **CLI** — `musterd style`, `musterd policy style`, roster `style stale`, terminal frames in
   `figma-brief-terminal.md`. Lane `01M46MQR8F6E6G9BRX0JMY8CMH`.
5. **Web** — the human's dials card and the admin floor card (handoff to miley, API in place).
   Lane `01M46MQSMJFBNGS0QE4PHVTXWT`.
6. **Readout** — `pnpm style:readout` and the wiki page with the baseline. Lane
   `01M46MQW7GV4BD3SV9HDKDRETV`.

## 8. Not in this spec

Harness-native renderers (§2 trigger). Per-seat or per-role style. A `tone` dial — bluntness covers
the one axis nick named. Any change to `brand.md` voice. Measuring chat.
