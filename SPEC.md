# musterd protocol — SPEC

The musterd wire protocol: the Envelope every message travels in, the acts Members exchange, and the rules any conforming server or client MUST follow.

**Version:** `musterd/0.3` (draft)
**Status:** v0.3 draft — designed in the open, versioned from the first commit. v0.3 adds the terminal **`resolve` act** (thread-close — the open-vs-done axis, ADR 025) over v0.2; it is a backward-compatible MINOR (one new act, no change to existing fields). v0.2 added the **minimal trust model** (single-active Members + reclaim grace) and **roster activity** over v0.1. The full shared-teams governance model is otherwise **designed but not yet specified** — it activates when the daemon stops being localhost-only. Its wire-level design lives in **Appendix A (Unreleased)** below; the rationale is in `docs/design/membership-model.md` + `docs/design/security.md`.
**License:** MIT (same as the implementation).

> This is the normative protocol. Implementations (this repo's `@musterd/server`, `@musterd/protocol`, and any third-party server or client) MUST conform to it. The implementation-facing distillation with file/function detail is `docs/architecture/02-protocol.md`; where that and this file disagree, **this file wins**. Changes to this spec are versioned and require an ADR (`docs/decisions/`).

The keywords MUST, SHOULD, MAY are used per RFC 2119.

---

## 1. Model

musterd coordinates **Teams** of **Members** with shared messaging.

- A **Team** is a named, persistent group — a **standing roster**, not a project. It outlives any task, session, or repository.
- A **Member** is a durable identity within exactly one Team. `kind` is `agent` or `human` — **humans are first-class Members, not approvers**. A Member has a name (unique within its Team), a free-text role, a **lifecycle** (`forever | session | until <ts>`), an optional **availability** schedule (stored, not enforced), and an optional recurring **working_hours** schedule. A Team may set the default schedule; a Member schedule replaces it for that Member (ADR 206).
- A **Presence** is where a Member is currently attached — a **Surface** such as `cli`, `claude-code`, `codex`, `opencode`, or `grok`. One Member MAY have multiple simultaneous Presences (like a person on desktop + phone). **A Member is not a session.**
- The server routes each message to wherever the recipient is present; an offline recipient's messages remain in the durable log and surface via their **Inbox** (cursor-based).

These five terms — Team, Member, Presence, Surface, Act — are the glossary; conforming implementations MUST use them with these meanings in any user-facing surface.

## 2. Envelope

Every message is an Envelope (JSON):

```jsonc
{
  "id": "<ULID>", // client-generated, globally unique
  "v": "musterd/0.3", // protocol version; MUST match server's supported version
  "team": "<team-slug>", // [a-z0-9-], 1..32
  "from": "<member-name>", // sender, a Member in `team`
  "to": { "kind": "member", "name": "<member-name>" }, // or {"kind":"team"} or {"kind":"broadcast"}
  "act": "<act>", // one of the 8 acts (§3)
  "body": "<string>", // human/agent-readable content; MAY be empty
  "thread": "<ULID|null>", // optional thread root id; null/absent starts a thread
  "meta": {}, // optional, act-specific (§3); unknown keys MUST be preserved
  "ts": 1733760000000, // sender clock, epoch ms; server records its own receive time too
}
```

Recipient (`to`) is one of:

- `{"kind":"member","name":"<name>"}` — delivered to that Member.
- `{"kind":"team"}` — delivered to every current Member of the Team except the sender.
- `{"kind":"broadcast"}` — in v0.1, delivered as `team`. The distinct kind is RESERVED for future cross-Team/announce semantics; implementations MUST keep it distinct on the wire even while delivering it as team.

An **eligible set** (ADR 254) narrows who OWES an answer without narrowing who can see the act: a `{"kind":"team"}` Envelope MAY carry `meta.eligible`, an array of 2–4 distinct Member names. It is delivered to the whole Team as above, but only the named Members owe a reply, and the FIRST `accept`/`decline` naming the act (via `meta.in_reply_to`) discharges it for all of them. Only `message`, `request_help`, and `challenge` may carry one; a server MUST reject an eligible set naming an unknown, departed, observer, or sending Member rather than silently dropping the name.

Validation: an Envelope with an unknown `act` MUST be rejected. Unknown `meta` keys MUST be accepted and preserved (forward-compatibility). A server MUST reject an Envelope whose `from`/`team` do not match the authenticated Member.

## 3. Collaboration acts

Acts are the typed intents of coordination, grounded in the **Co-Gym** collaboration-act taxonomy (Shao et al., _Collaborative Gym_, arXiv 2412.15701). v0.1 defined seven; **v0.3 adds `resolve`** (ADR 025), the **steering trio `steer`/`challenge`/`defer`** (ADR 103), **`ask`** (ADR 147), and **`insight`** (ADR 327) for thirteen:

| Act             | Meaning                                                                   | Required `meta`/fields                                                                              | Optional `meta`                                                                                                      |
| --------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `message`       | plain communication, no protocol semantics                                | —                                                                                                   | —                                                                                                                    |
| `status_update` | report what you are doing / have done                                     | —                                                                                                   | `progress` (0..1), `state` (string)                                                                                  |
| `request_help`  | ask a Member or the Team to assist / unblock you                          | —                                                                                                   | `blocking` (bool), `topic` (string)                                                                                  |
| `handoff`       | transfer a unit of work to someone                                        | —                                                                                                   | `artifact` (string), `summary` (string)                                                                              |
| `accept`        | accept a prior `request_help`/`handoff`/`challenge`                       | `meta.in_reply_to` (ULID)                                                                           | —                                                                                                                    |
| `decline`       | decline a prior `request_help`/`handoff`/`challenge`                      | `meta.in_reply_to` (ULID)                                                                           | `reason` (string)                                                                                                    |
| `wait`          | paused / blocked — bare, deciding (`ask_ref`), or deferring (`defer_ref`) | —                                                                                                   | `reason`; `ask_ref`+`until` (duration string); `defer_ref`+`until` (`{lane}`\|`{reply:true}`)                        |
| `resolve`       | close a thread — mark the work it tracks **done**                         | `thread` (ULID)                                                                                     | `reason` (string)                                                                                                    |
| `steer`         | change direction — a directive that supersedes prior direction            | —                                                                                                   | `urgent`+`urgent_reason`                                                                                             |
| `challenge`     | ask a Member to justify a task/assumption or reconsider                   | —                                                                                                   | `urgent`+`urgent_reason`                                                                                             |
| `defer`         | shelve a Goal on the plan                                                 | `meta.goal_id` (string)                                                                             | —                                                                                                                    |
| `ask`           | direct a question to a human, carrying an answerability contract          | `meta.species` (`consult`\|`escalate`\|`approve`), `meta.tier` (`advisory`\|`standard`\|`blocking`) | resolution rides `status_update` (`meta.ask_outcome`+`meta.ask_ref`); the deciding reply rides `wait` (`meta.until`) |
| `insight`       | save a reusable finding so the whole team can find it                     | `meta.headline` (1..120 chars)                                                                      | `meta.tags` (≤8 strings), `meta.repo` (slug)                                                                         |

Rules:

- `accept` and `decline` MUST carry `meta.in_reply_to` referencing the Envelope they answer, and SHOULD set `thread` to that Envelope's thread (or its `id` if it was a root).
- `resolve` is **thread-terminal**: it MUST carry a non-empty `thread` naming the thread it closes (a no-thread root is closed by passing its own `id`). It marks the thread — the proto-work-item — **done**, supplying the open-vs-done axis the other acts lack (`accept` ≠ finished). It MAY follow an `accept` or close a thread directly without one. **Authority:** any Member of the Team MAY `resolve` a thread; v0.3 does not enforce a closer (the norm is the opener or the assignee). Conforming UIs SHOULD treat a thread carrying a `resolve` as closed and stop surfacing its open `request_help`/directed asks as pending.
- **The steering acts (ADR 103)** give a "change of direction" first-class semantics on the interrupt line (ADR 088), and ride it for delivery — no new delivery machinery. `steer` is a directive that is **interrupt-class by definition** (it reaches a busy Member even when not flagged `urgent`); the **newest `steer` directed at a Member supersedes** all prior steers to it ([ADR 017](docs/decisions/017-newest-session-wins.md) newest-wins applied to direction), so a late-waking Member sees only the current direction, never a contradictory stack. `challenge` is epistemic (warn-never-block) and **tier-configurable** — it interrupts only when its sender flags it `urgent`; it is answered with evidence (an `accept` carrying justification, or a plan change). `defer` MUST carry `meta.goal_id` naming the Goal it **shelves** ([ADR 257](docs/decisions/257-retire-the-numeric-wave.md) retired the numeric position, so shelving is its whole meaning); it records/surfaces the plan mutation as a first-class act.
- **Disputes (ADR 505)** are one lifecycle for contesting a claim, whatever the source — the source is a **server-stamped** field, never an act of its own. The daemon stamps `meta.dispute { via: 'review' | 'challenge' | 'dependency', lane?, ask?, on? }` on the act that opens one (a client-supplied `dispute` is stripped, on the same grounds as `lane_review`): a reviewer's `decline` on the standing `lane_review` ask of a Lane still in acceptance is `via: 'review'`; a Member-directed `challenge` is `via: 'challenge'`, or `via: 'dependency'` when the sender owns a live Lane whose `depends_on` names one the recipient owns. A review dispute is an **obligation on the Lane's owner** (the one `decline` shape that is, ADR 429): a server MUST pin it in the owner's inbox until the owner replies `accept` (conceded — the body names what was re-checked; the Lane stays `active` for the fix) or `decline` (held — the body names the evidence), or the thread is resolved; the owner's `message` reply does not discharge it (ADR 614 — the general rule that any reply by the recipient discharges an obligation does not apply here). A hold moves the Lane back to `awaiting_acceptance` and re-routes the acceptance to a second reviewer with the first excluded (cross-family first), on the ADR 412 re-route rail: the new `lane_review` ask carries `tiebreak { rejection, hold, first_reviewer }` and joins the dispute's thread; that reviewer's verdict settles it as any acceptance verdict does. No candidate → the hold is recorded and the Lane stays `active`. The owner's answer is reported on the send ack as `dispute { lane, verdict, tiebreak? }`. Additive (v0.3): a client that ignores `meta.dispute` sees a `decline` it may still answer.
- **The ask act (ADR 147)** is directed-to-human traffic: `meta.species` picks the kind (`consult` | `escalate` | `approve`) and `meta.tier` derives the timeout + no-answer policy the _agent_ itself runs (top tier holds; below-top proceeds with a recorded risk-acceptance). The no-answer resolution rides `status_update` (`meta.ask_outcome` naming `meta.ask_ref`); the human "deciding — check back" reply rides `wait` (`meta.ask_ref` + `meta.until`). **`meta.action_class` (ADR 623):** every `ask` carries `privileged` or `advisory`, stamped by the server from the species and `meta.gate` (a gate, or an unknown or missing species, is `privileged`); it says what a channel answer to the ask is worth, and `advisory` does not mean low risk. It is server-controlled: an implementation strips a client-supplied copy. **`meta.channel_answer` (ADR 623):** an answer that arrived through a channel (ADR 618) carries it, server-controlled and stripped from any client envelope. A channel answer is advice, not authority: it is recorded as a `message`, never as an `accept` or `decline`, and a server MUST refuse an `accept` or `decline` that carries it. **The doorbell (ADR 443):** an `ask`, and a `request_help` or `handoff` directed to a human, rings that human (a non-directed `ask` rings the admin humans) through surfaces musterd owns — `/live`, an OS banner raised by the host, Slack, or a generic webhook — never through a harness session. The rung record carries structured fields only; a self-set `away`/`dnd` holds it and `blocking` pierces `dnd`. **What this does and does not protect (spec §7).** The doorbell removes a model's choice of where a human is reached. It is not a boundary against a hostile process under the same OS user: such a process can read any binding or config file, or call the daemon's HTTP API directly with a credential it read. Closing that is credential custody (ADR 200, ADR 341).
- **The insight act (ADR 327)** saves a reusable finding for the whole team. It is written **team-visible on intent** — there is no private variant, so seat memory's privacy boundary (ADR 093) is untouched. The finding text rides the envelope body (server-bounded to 1–2048 bytes, ADR 327); retrieval is pull-only through a derived index over the log (a rebuildable cache — never a source of truth, ADR 259); no digest or standing-context injection (ADR 212). Durable findings promote into `docs/wiki/` as a norm, not machinery.
- Acts are the stable contract; `meta` is the extension point. New acts are a versioned change to this spec.

## 4. Identity, Presence, Lifecycle

- **Authentication:** each Member has a secret token, issued once when the Member is added. A request/connection presents the token; the server authorizes it to act **as that Member in that Team** and no other. Servers MUST store only a hash of the token, never the plaintext.
- **Presence lifecycle:** a client attaches a Presence by connecting (declaring its Surface), keeps it alive with heartbeats, and detaches on disconnect. A Member is **online** while it has a fresh Presence, **offline** otherwise; **away** is set only explicitly by a client and MUST NOT be inferred by the server. Heartbeat cadence and timeout are implementation parameters (this repo: 15s heartbeat, 45s timeout).
- **Single-active is kind-scoped (v0.2 + ADR 042; ADR 017 supersedes ADR 010's refusal):** **agent** Members are single-active, newest-wins — an agent MAY hold at most **one** live Presence at a time, and on a new attach for an agent that already has a live Presence the server MUST keep only the **newest** session: it takes over, and the existing one is told it was **`superseded`** (this repo: WS `error`) and dropped. (This replaces the earlier "refuse the second with `member_busy`" rule — refusing locked a Member out of its _own_ seat after a reload/orphaned session.) **Human** Members instead **fan out**: a human MAY hold multiple simultaneous Presences (watch on a phone while acting on a laptop), so a new human attach adds a Presence alongside the existing ones — no displacement. Agent displacement is **workspace-scoped** (ADR 068), and the workspace is identified by `workspace_key` where both sides send one, by the `workspace` label otherwise (ADR 368): a same-workspace attach does not immediately supersede the incumbent (a transient health-check probe must not flap the seat); instead a same-workspace successor that proves durable (survives a short grace window still attached) reaps its predecessor, which is told `superseded` with `same_workspace:true` and — being a replaced reload orphan — SHOULD exit rather than linger dormant (ADR 092). Either way, on a clean detach the server SHOULD hold a seat for a short **reclaim grace** (this repo: 45s, tracked as `held_until`) so the same Member can rejoin without losing it; the grace is swept per-Presence by the reaper, and a Member goes offline only when its **last** Presence drops. _(Rationale: single-active exists to stop N concurrent autonomous minds wearing one agent identity — an agent hazard, not a human one; a person across devices is the original "one Member, many Presences" — §1, ADR 042. The v0.3 seat-claim model governs who may take a seat once the daemon leaves localhost; ADR 007/010/017/042.)_
- **Roster activity (v0.2; idle rename ADR 140):** a roster/status response carries, per Member, a coarse `activity` of `offline | idle | working`, derived server-side by a **two-clocks rule** — liveness (presence) decides `offline` vs present, and the latest `status_update` decides `idle` vs `working` (a self-reported task). The backing task summary rides in `state` with a `last_status_at` timestamp (for staleness display). These fields are **optional/additive** — a v0.1 client that ignores them still conforms. When offline, optional `offline_reason` (`reconnecting | disconnected | signed_off | off_hours | unknown`) explains why (ADR 141).
- **Attach context — provenance & workspace (v0.2, ADR 014):** on attach a client MAY declare two facts about _why_ and _where_ the Presence exists: a `provenance` of `session | asked | hook | scheduled | daemon | wake` (why this attachment exists — e.g. `session` means a human opened a harness session, `scheduled` means a timer started it), and a `workspace` string (a "where" label, e.g. `repo@branch`). The server records both on the Presence and surfaces them on the roster; it MUST NOT guess them (they are facts known only to the attaching client) — a client that declares neither leaves both NULL, and a reader MUST NOT read that absence as an assertion (ADR 236). This binds the _ambient_ touch as much as the claim: an authenticated read that carries no `x-musterd-provenance` records none, rather than a plausible default that would make an unstated provenance indistinguishable from a declared one. A client SHOULD additionally send a `workspace_key` — the workspace's stable **identity** (this repo: the git work tree root; `resolveWorkspaceKey`), as distinct from the `workspace` label above (ADR 368). The label is branch-qualified and therefore changes under the very session that holds it, so it MUST NOT be used as an identity key; where the protocol scopes behaviour by workspace (agent displacement, §4 below and ADR 068/092) the server MUST compare `workspace_key` when both the incumbent and the claimant carry one, and MUST fall back to exact `workspace` label equality when either does not. `workspace_key` is optional and additive: it carries no routing or authorization meaning either, and a client that omits it gets exactly the pre-ADR-368 comparison. All three are **optional/additive** and carry no routing or authorization meaning — they are read context, rendered as such. The roster additionally carries each Presence's `attached_at` — when the attachment was created, distinct from `last_seen_at`, which heartbeats advance (ADR 379); a wake actuator reads it, with `workspace`, to recognise a child of its own that could not attest its lease, and MUST NOT read its absence as a time. A Presence that attests a wake lease (ADR 241) also carries `wake_for` — `{ edge, lane_id, act_id, act, from }`, the lease's own record of why the wake happened (the board edge that derived it, the lane it was for, the act it delivered with that act's kind and sender), joined at read time (ADR 543). It is ids and names only — never a body or a lane title, because the roster answers anonymous reads. It is null when the lease has no row on the answering daemon, and a reader MUST NOT read its absence as "not a wake": `provenance: wake` stays the wake signal. _(Rationale: presence answers "is anyone there"; provenance answers "why are they there" — don't make one layer carry another's question. See `docs/design/human-agent-dynamics.md` §2.)_
- **Driver co-presence (v0.2, ADR 021):** on attach a client MAY also declare a `driver` string (≤80 chars) — the name of the human steering this session, when one is — so the roster can render `driven by <name>` instead of showing the driving human as offline. Like provenance/workspace it is a fact known only to the attaching client (the server MUST NOT guess it), is **optional/additive**, and carries no routing or authorization meaning — it names a co-present human but does not link to, authenticate, or stand in for that human's Member. _(An adapter authenticates only as the agent; it never holds the human's token. See `docs/design/human-agent-dynamics.md` §54.)_
- **Session reach and Workspace identity (v0.3, ADR 442 — the wall):** a seat reaches its teammates only through the acts of §3, and reaches a human only through the surfaces musterd owns (§3, the doorbell). A conforming client running in a seat Workspace MUST refuse tools that reach another harness session (`SESSION_REACH_TOOLS` in `@musterd/protocol`: the session-management tools, `ListAgents`, `SendMessage`) **locally, before any server round trip**, so a server outage cannot open the wall; the one permitted reach is `SendMessage` toward a subagent the calling session itself spawned. Each refusal SHOULD be reported to the server as the actor attestation kind `session-denied`, carrying `{tool, harness}` only — no body, no target, no session id — and the server records it as audit action `gate.session_denied` with `result: deny`; the row is the record of a decision the client already made, not the decision. A server MUST NOT issue a delivery hint that steers one seat's session toward another's, and the interrupt, wake and nudge lines it composes are **pointers** — team-named (`musterd [<team>]:`), body-free — on which a client MUST act only through its own authenticated read of the named act. A client's identity is this Workspace's binding or a `MUSTERD_*` environment seat, or nothing: a stored credential vault MUST NOT resolve identity for an unbound folder, and no client surface may offer an `--as`-style override. _(These rules stop model mistakes — cross-session and cross-identity. They are not a boundary against a hostile process under the same OS user, which can read any binding or call the HTTP API with a credential it read; that boundary is credential custody — ADR 200/341, `docs/design/security.md`.)_
- **Residence (v0.3, ADR 503 Decision 5):** a roster entry MAY carry `residence` — `{ node, node_label, kind: node | cloud }` — stating the machine an enrolled seat lives on (ADR 358's seat–node binding, named by the node's id and label, **never** a hostname string) whether or not the seat is present. `kind: cloud` marks a musterd Cloud server (ADR 475). `null` means enrolled with no node bound; absence means the daemon predates the field, and a reader MUST NOT read either as a location. It is read context for a launcher's `where` and carries no routing or authorization meaning.
- **Member lifecycle:** `forever` (default), `session` (intended to last one working session), or `until <ts>`. The server stores lifecycle, availability, and working hours but does NOT enforce schedules or auto-expiry at runtime (enforcement is on the roadmap). Schema/field support exists from day one so enforcement can be added without a breaking change.

## 5. Transport

A conforming server MUST expose the message-routing semantics of §2–§4. This repo's server offers two bindings (full detail in `docs/architecture/02-protocol.md`):

- **WebSocket** for live, present clients: handshake `hello → welcome → subscribe → subscribed`, then `send`/`deliver`/`heartbeat`/`presence`/`ack`/`error` frames, and `seat_pulse` to firehose subscribers (A.25).
- **HTTP/JSON** for stateless one-shot clients (team/member management, send, inbox fetch, presence ping).

Both bindings MUST funnel sends through one validate→persist→route path so semantics are identical.

**Delivery guarantee:** at-least-once. The message log is authoritative; each Member has a cursor (high-water mark). A client MAY receive a message both live and again on inbox fetch after reconnect; clients MUST dedupe by `Envelope.id`.

## 6. Versioning & compatibility

- The version string is `musterd/MAJOR.MINOR`. `v0.1` was the first; `v0.2` added single-active newest-wins + reclaim grace, roster activity, attach provenance/workspace, driver co-presence (new error codes `member_busy`/`superseded`); **`v0.3`** is current — it adds the terminal `resolve` act (ADR 025), the steering trio `steer`/`challenge`/`defer` (ADR 103), un-stubs the reserved `memory` seam on the `occupied` frame into a seat-scoped continuity envelope (A.3, ADR 093), and adds the optional harness-attested `model` field on the `claim` frame + heartbeat (A.3, ADR 101 — per-occupancy, `unknown` when omitted). ADR 275 adds optional `surface` on the heartbeat so occupancy can follow a mid-session capture (absent ⇒ no change, same never-clear rule as `model`). ADR 301 adds optional `model_source` (`observed` | `environment` | `binding`) beside `model` on claim, heartbeat, grant-less requests, and as server-stamped `meta.model_source` on every act; omitted by older clients and when there is no model (never defaulted to `binding`). ADR 147 had added the `ask` act (the species/tier answerability contract, with no-answer resolution riding `status_update`) and ADR 327 adds the `insight` act (team memory — headline + capped body, retrieved through a derived index). ADR 368 adds optional `workspace_key` on the `claim` frame — the work-tree identity displacement compares, beside the ADR 014 `workspace` label it does not replace; omitted by older clients, and its absence on either side means the server compares labels exactly as before. All MINOR additions are additive (new acts and new optional fields, no change to existing required fields): a client that ignores `memory`/`model`/`surface`/`model_source`/`workspace_key` or does not recognize a new act is unaffected.
- Within a MAJOR, MINOR additions MUST be backward-compatible (new optional `meta`, new optional fields, new endpoints, new error codes). New **acts** or any change to envelope-required fields are a MINOR-or-greater, spec-versioned change requiring an ADR.
- A server MUST reject a client whose declared `v` it does not support, with a `version_mismatch` error.

## 7. Roadmap (informative, not part of v0.1 conformance)

These are designed-around but **not** specified/required in v0.1; see `ROADMAP.md`:

- **Step-level streaming** transport option (StreamMA finding: step-level streaming beats wait-for-complete) as a v2 transport mode; v0.1 sends whole Envelopes.
- **Schedule enforcement** of `availability` and `lifecycle`.
- **Team-to-team federation** (the reserved `broadcast` kind anticipates this).
- **Additional Surfaces** (iOS, web, Slack).
- **Sandboxed runtime** for member execution.

Schema and wire formats in v0.1 already reserve the fields these need, so adding them does not break v0.1 clients.

---

### References

- Co-Gym (collaboration acts): _Collaborative Gym: A Framework for Enabling and Evaluating Human-Agent Collaboration_, arXiv 2412.15701.
- MAST (coordination-failure analysis motivating the layer): _Why Do Multi-Agent LLM Systems Fail?_, arXiv 2503.13657.

---

# Appendix A — v0.3 shared-teams governance (SHIPPED — the live auth model)

> **Status: SHIPPED.** v0.3 P0–P3 landed on `main` (2026-06-30) — the hard auth cutover (ADR 069 build plan; ADRs 075–078; banned-inert read-gate follow-up PR #37). This **shared-teams** governance model — seats, agent key + grants, capabilities, approval lane, audit — **is now the live identity/auth model**: the per-member-token path (§4) and the `hello` frame are **removed**, replaced by the `claim` handshake + team **agent key** + admin-issued **grants** + human **credentials** described below. The collaboration **Envelope/Acts (§2–§3) are unchanged** — governance layered on without touching them. Rationale + design review: `docs/design/membership-model.md`, `docs/design/security.md`; the _two universes_ capability split (what musterd enforces vs. provisions/declares for the harness) is ADR 026.
>
> _Spec-hygiene follow-up (tracked, not yet done): fold this appendix into the normative body (§1 identity, §4 auth) and retire the now-superseded `hello`/per-member-token prose in §1–§6, which describes the **pre-cutover (v0.2)** model. Until then: read §1–§6's join/auth text as **historical**, and this appendix as **current**._

## A.0 What the cutover changed (v0.2 → v0.3, shipped in P3)

| Area          | v0.2 (former, §1–§6)                   | v0.3 (shipped)                                                                               |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Identity      | flat Member (name, kind)               | **Seat** in a **Role** (Member = named Seat)                                                 |
| Auth unit     | per-member token = one member          | **agent key** (harness) **+ admin-issued Grant** (seat occupancy)                            |
| Join          | `hello {team, as, token}` → presence   | `claim {seat\|role}` → occupy, or → **request** to an admin                                  |
| Authorization | token == member                        | **grant required**; default **live admin approval**; team opt-in pre-issued                  |
| Concurrency   | N sessions = N presences of one member | **single-active** per _agent_ seat (2nd → `claim_conflict`); _human_ seats fan out (ADR 042) |
| State         | `presence.status` + `left_at`          | **three axes**: account · availability · activity (with `working` staleness)                 |
| Observers     | none                                   | **human-only** read-only watchers                                                            |
| Governance    | none                                   | **own lane**: roles, seats, grants, requests, status — all **audited**                       |

A new join/auth handshake is a MAJOR-of-MINOR change; it **landed as the isolated P3 cutover** (ADR 069 decision 2, 2026-06-30) — one coordinated breaking moment across every surface, with the acts (§2–§3) untouched. (Note: `musterd/0.3` also shipped the `resolve` act, ADR 025.)

## A.1 Roles, Seats & Capabilities

- A **Role** is admin-defined (`backend`, `frontend`, `reviewer`, `lead`…). It groups seats (capacity = its seats) **and carries default capabilities + an optional charter**.
- A **Seat** is the identity record: `{ id, team, role, name?, kind: agent|human, account_status, occupied_by?, availability?, activity?, capabilities, charter? }`. `name` is optional for agent seats (handle `<role>-<n>` if absent), conventional for humans. A seat's `capabilities` start from its role's defaults and may be **narrowed per seat, never widened**.
- **Capabilities (fixed set):** `can_message` (scope), `visibility_level`, `tool_allowlist`, `declared_resource_scopes`, `can_flag_urgent`, `can_observe`, `can_create_agents` (ADR 459), `can_coordinate` (ADR 621: `false` is talk-only — `message`, `status_update`, `request_help`, `ask`, and `accept`/`decline`/`wait`/`resolve` only on a thread addressed to the seat; every coordination route and act refused; the seat reads at `broadcast` grade), `is_admin`. A member may also carry a **ceiling** (`guest`) applied at read time, which no role or seat projection can widen; an invite stamps one on every member it admits (guest by default). Servers MUST enforce them on every in-band operation; external scopes (repo/dir/tool) are **declared** here and enforced by the harness/sandbox (Principle 4). ADR 026 frames this as the **two universes** — in-band acts musterd enforces vs harness tools it _provisions + declares_ — and makes the Role a harness-agnostic provisioning template. Custom RBAC is roadmap.
- **Charter** is identity metadata (what the seat is _for_ + instructions); musterd stores and serves it, never enforces behavior. A **memory/context blob** rides the claim response (A.3) as a seat-scoped continuity envelope (ADR 093): `memory` carries `{ headline, saved_at, size_bytes }` or `null`, with the body fetched on demand — an additive MINOR that un-stubs the seam once reserved here.
- An **agent** seat has **at most one** live occupant (single-active); a **human** seat may have multiple concurrent occupant Presences (kind-scoped, ADR 042). Humans claim their own named seat; agent seats may be claimed by name or by an open seat in a role.

## A.2 Credentials

- **Agent bootstrap credential** — an `mskey_` secret scoped by a server-held record to one seat claim, one declared role-pool claim, or one residency host label (ADR 344). It authenticates only that use, is independently expirable/revocable, and is **not** an identity or sufficient to occupy a seat. Existing Team-wide agent keys remain accepted only as marked legacy records until that Team completes ADR 350's readiness-gated cutover. A Workspace exchanges legacy authority for seat scope only by presenting the legacy key together with its independent `msac_` seat credential. Cutover readiness requires successful scoped authentication—not minting alone—for every held agent seat and active residency host; an administrator MAY force an incomplete cutover, with unmet targets recorded. Cutover atomically revokes legacy records, clears the Team key hash, records the cutover timestamp, and appends its audit evidence.
- **Grant** — admin-issued authorization to occupy a seat/role. Fields: `{ id, team, scope: seat|role, target, issued_by, lifetime: "once"|"ttl"|"standing", expires_at?, single_use?, revoked? }`. **At live approval the admin picks the lifetime** (once / N-hours TTL / until-revoke), so reconnects within the window don't re-prompt while keeping "no silent grant." Seat/role-scoped, expiring, revocable. Every issue/use/revoke is audited.
- **Human credential** — per-human-seat secret; acts as that human; observes if role permits.
- **OAuth access token** — per-human-seat bearer (`msat_`, 1h TTL) minted through the OAuth 2.1 authorization-code flow with PKCE S256 (A.13); authenticates exactly like a human credential (self-identifying, acting-seat must match-or-absent) with no session lease. Scoped to (team, member, client) at mint.
- **OAuth refresh token** — per-human-seat bearer (`msrt_`, 30d TTL, single-use rotation); reuse of a burned refresh revokes the whole chain.
- **Admin** — capability on a human seat (creator default).

Servers MUST store only hashes of keys/credentials/grants. A `banned` seat's credential MUST be rejected.

## A.3 Claim handshake (WS) — replaced the `hello` frame (removed in P3)

> **Note (local claim-on-first-use is already shipped _without_ this frame — ADRs 032/033).** The
> _local_ claim experience from `provisioning-recipe.md` §5–§6 — the overloaded `team_join`,
> `musterd claim`, the `MUSTERD_CLAIM` folder policy, and client-side pending presence — is built on
> the **existing** `hello`/members primitives, not this handshake: locally a seat is a member + its
> per-member token, auto-mint is the unauthenticated `POST /members`, occupy is `hello` (newest-wins
>
> - grace, §74), and `claim_conflict` is the unique-name `conflict` on mint. This appendix's
>   `claim`/grant frame is the **governed** path (agent key + admin grant + the request
>   lane); it **shipped in P3 (2026-06-30) and is now the sole claim path** — the local `hello`-based
>   occupy this note contrasts against is removed. (Server-side pending presence — a seatless session on
>   the roster — is the request lane's live-approval state, A.5.)

State machine: `connecting → authenticated(key) → claim → (occupied | refused | pending) → [subscribed] → live`.

```jsonc
// client → server
{ "type":"claim", "v":"musterd/0.x", "team":"dawn",
  "key":"<agent key | agent-seat credential | human credential>",
  "target": { "seat":"Ada" } | { "role":"backend" } | { "observe": true },
  "grant":"<grant token>"?,            // omitted → triggers a request (default path)
  "surface":"claude-code",
  "provenance":"session"?,              // ADR 014/131 §6 — what ANIMATES this session, not who it is;
                                       // `wake` is an actuator-spawned harness, which is how an
                                       // actuator recognises its own child rather than a stranger
  "workspace":"repo@branch"?,             // ADR 014 display label — where-on-attach seed, NOT an identity
  "workspace_key":"/abs/work/tree"?,     // ADR 368 — the workspace's stable identity (work tree root);
                                       // displacement compares this when both sides have it, else
                                       // falls back to `workspace` label equality (≤200 chars)
  "model":"claude-opus-4-8"?,           // harness-attested model id (ADR 101) — attested, never
                                       // verified; per-occupancy (the durable seat stays
                                       // model-agnostic, ADR 087); omitted → "unknown", never blocks
  "model_source":"observed"|"environment"|"binding"? }  // which tier produced `model` (ADR 301);
                                       // omitted with the id, or by older clients; never `unknown`
                                       // on the wire (absence is not an assertion)

// server → client
{ "type":"occupied", "seat": <Seat>, "presence_id":"01J…", "server_time": <ms>,
  "seat_credential":"<new msac_ credential>"?, // agent only; shown once on mint/rotation
  "session_lease":"<fresh msls_ lease>"?,       // agent only; Presence-bound and short-lived
  "charter": "<role/seat charter + instructions>"?,   // identity metadata, served not enforced
  "memory": { "headline":"<≤120 chars>", "saved_at": <ms>, "size_bytes": <int> } | null }
                                                       // seat-scoped continuity envelope (ADR 093);
                                                       // null when nothing saved. The body is NEVER
                                                       // here — fetch via GET /teams/:slug/memory.
{ "type":"refused", "code":"claim_conflict"|"forbidden"|"not_found"|"disabled"|"banned"|"halted"|"expired_grant",
  "message":"…", "claimable":["…"], "hint":"musterd team add <name> --kind agent --role backend" }
{ "type":"pending", "request_id":"01J…", "message":"asked admins to authorize this claim" }
```

Rules:

- Valid **grant** for the target + seat free → `occupied` (account `provisioned`→`active`).
- Valid grant + seat occupied → `refused {claim_conflict, claimable, hint}`.
- **No grant** → `pending`: the server opens a **claim request** (A.5) routed to admins. On approval the server emits `occupied` (or `refused` on deny/timeout). If an admin is co-present in the same session, approval MAY be immediate.
- `observe: true` requires a **human credential** whose seat role permits observing; agents MUST be refused (`forbidden`).
- An **agent** seat MUST have at most one live occupant; a **human** seat MAY have multiple concurrent occupant Presences (kind-scoped single-active, ADR 042).
- A claim carrying `provenance: "wake"` (or `"dream"`, ADR 494) MUST NOT displace a live occupant whose provenance is not `wake`/`dream`, EXCEPT inside ADR 609's lease window: a claim presenting its own daemon-minted lease displaces an occupant row that attached after that lease was minted (`presence.created_at > wake_leases.created_at`), with the `superseded` frame and a `claim.superseded` audit row as the notice. Outside the window it is refused `claim_conflict` with no side effects (ADR 444). An attended claim still displaces a wake.
- The Team agent key (`mskey_`) is bootstrap-only: it authenticates a claim handshake but is never
  routine Member HTTP authority. An agent's routine HTTP request MUST present its self-identifying
  `msac_` seat credential and the fresh `msls_` lease bound to its claimed Presence. Servers MUST
  reject a missing, expired, revoked, or displaced lease; ambient presence touches do not renew it.
- A standalone CLI invocation that needs routine agent HTTP authority re-claims its bound seat with
  its `msac_` credential, sends its resolved Workspace label **and `workspace_key`** (ADR 368), keeps
  that Presence live through the HTTP work, then closes it. The transient same-Workspace Presence follows ADR 068/092 and cannot
  supersede a live adapter; a later invocation re-claims again, and a lease from the prior closed
  Presence is not reusable (ADR 339/340).
- **`workspace_key`** (ADR 368) is the claimant's workspace **identity** — in this repo the git work
  tree root, capped at 200 chars — and `workspace` remains the ADR 014 display label. Where the
  server scopes displacement by workspace (ADR 068/092) it MUST compare `workspace_key` when the
  incumbent Presence and the claiming frame both carry one, and MUST fall back to exact `workspace`
  equality when either does not. A server MUST NOT treat the label as an identity key on its own
  where a key is available: the label is branch-qualified, so it changes under the session holding
  it and a seat's own re-attach would read as foreign. Optional and additive in both directions — an
  old client against a new server, or a new client against an old server, gets the previous
  label-only behaviour rather than an error.
- **`memory`** carries the seat's continuity envelope (ADR 093) — `{ headline (≤120 chars), saved_at, size_bytes }` — or `null` when the seat has saved nothing. It is the seat-scoped working note an occupant saved before wrapping up; the body is fetched **on demand** over `GET /teams/:slug/memory` (seat-authenticated), never delivered on this frame. Additive and back-compat: a client that ignores `memory` loses nothing.

## A.4 Release & grace

- On clean disconnect or `leave`, the occupancy is held for a **grace window = the presence timeout (45s)**. A re-`claim` of the same seat within the window re-occupies without a new grant or request. After it, the seat returns to `claimable` and a team `presence` offline event fires. During grace the seat shows `online` (held).

## A.5 Governance lane (own surface, audited)

Governance is **not** carried by the collaboration `Envelope`/Acts. It is a distinct set of operations and a **request** object.

**Request** `{ id, team, kind: "claim"|"teammate", from_session, target?, status: pending|approved|denied|expired, decided_by?, ts, model?, model_source? }`. Created on a no-grant claim (kind `claim`) or an explicit "I need a teammate" (kind `teammate`). Optional `model` (ADR 101) and `model_source` (ADR 301) carry the claimant's attestation across the approval gap so the approved occupancy is not born `unknown` / un-tiered. Routed to admins; surfaced via `GET /teams/:slug/requests` and a notification. An admin **approves** (issues a grant; for `teammate`, creates a seat then grants), **denies**, or it **expires**.

Governance operations (admin-only; A.7 HTTP): create/rename/disable/ban/archive seats; create/rename roles; issue/revoke grants; rotate the agent key; set team policy (e.g. `allow_pre_issued_grants`); decide requests.

Every governance operation and every grant issue/use/revoke writes an **audit record** (`security.md`): `{ ts, actor, action, target, result }`.

## A.6 State model (three axes)

**Account** (Axis 1): `provisioned → active → (disabled ⇄ active) → banned ; any → archived`. Non-active seats are not claimable.

**Availability** (Axis 2): `available | away | dnd | away_until(ts) | off_hours`. For **humans**, presence is implicit (connected → online; idle → away) while `away`/`dnd`/`away_until` are **explicitly set, never inferred**. For agents, availability is mostly `available` while occupied. Full schedule enforcement is roadmap.

**Activity** (Axis 3, only while occupied): `offline (unoccupied) | online (idle) | working | talking`.

- `working` carries `meta.state` from the seat's latest `status_update`; **self-reported, never inferred**.
- `working` **persists while occupied + alive**; after 5 min without a fresh `status_update` it is rendered **stale** (`working: x · Nm`), never reverting to `online`; it clears on release/timeout.
- Two clocks: heartbeat = alive; last `status_update` = fresh.

**Display resolution (first match wins):** archived/banned/disabled → `provisioned`(`created · waiting to join`) → away(`off until <ts>`) → unoccupied(`offline`) → occupied(`working: x · Nm` / `talking: y` / `online`).

## A.6a Notifications & urgency

Delivery is unchanged (at-least-once, cursor-based); **notification tiering** is a recipient-side policy the server supports:

- **Loud** (notify/page): acts _directed at the recipient_ (`request_help`/`handoff`/`accept`/`decline` to them, @mention) + governance approval requests.
- **Quiet** (stream only): ambient `status_update`, broadcasts, others' threads.
- **Held**: while the recipient is `away`/`dnd`, messages queue → digest on return.

**Breakthrough:** `away` holds all **except** an `urgent`-flagged ping; `dnd` holds quiet but passes directed pings and `urgent`.

**`urgent`** is an envelope `meta.urgent: true` with a **required** `meta.urgent_reason`. It MUST be gated by the sender seat's **`can_flag_urgent`** capability, is **audited**, and the recipient MAY mark it `wasnt_urgent` (recorded against the sender). Servers MUST reject `urgent` from a seat lacking the capability. (Acts themselves are unchanged; `urgent` is a meta flag, not a new act.)

> **Localhost down-payment (ADR 044).** v0.2 ships the _mechanism_ of this section without the governance, mirroring ADR 035's notify down-payment. **Shipped:** the availability axis is self-set + stored + on the roster (`POST /teams/:slug/availability`, reusing `members.availability` — no migration); `meta.urgent`+`meta.urgent_reason` is enforced by `actMetaRules` (additive optional meta → **no protocol-version bump**); and the Loud/Quiet/Held tiers + away/dnd breakthrough run **client-side** in `musterd notify`. **Deferred to the v0.3 governed superset (the named seams):** `can_flag_urgent` enforcement (urgent is **ungated** on localhost), `urgent` auditing, the recipient `wasnt_urgent` feedback, `off_hours` + schedule enforcement, and the A.7 admin endpoints / A.9 seats migration.

## A.7 HTTP deltas

| Method                | Path                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`                | `/teams`                                          | first-run bootstrap: creates a team and its first human admin together; Cloud requires a console token; returns `{ team, seat(creator+admin human), human_credential, agent_key, policy }`                                                                                                                                                                                                                 |
| `POST`                | `/teams/:slug/roles`                              | admin; create/rename a role; set its default `capabilities` + `charter`                                                                                                                                                                                                                                                                                                                                    |
| `POST`                | `/teams/:slug/seats`                              | admin; provision a seat (`role`, `name?`, `kind`) in `provisioned`; returns the seat (no token)                                                                                                                                                                                                                                                                                                            |
| `POST`                | `/teams/:slug/members`                            | human seats, observers, and any roster projection that adds/revives a human or makes a human admin require a human-admin credential; local trust may provision ordinary agent seats only; human credentials are returned only after human-admin authorization                                                                                                                                              |
| `POST`                | `/teams/:slug/seats/:id/capabilities`             | admin; per-seat capability **narrowing** (may not widen past the role) + seat `charter`                                                                                                                                                                                                                                                                                                                    |
| `POST`                | `/teams/:slug/seats/:id/status`                   | admin; `{ to: active\|disabled\|banned\|archived }`                                                                                                                                                                                                                                                                                                                                                        |
| `POST`                | `/teams/:slug/grants`                             | admin; issue a grant `{ scope, target, lifetime, expires_at?, single_use? }` → grant token                                                                                                                                                                                                                                                                                                                 |
| `GET`                 | `/teams/:slug/grants`                             | human admin; redacted grant inventory (no token or hash)                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE`              | `/teams/:slug/grants/:id`                         | admin; revoke                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST`                | `/teams/:slug/agent-key/rotate`                   | admin                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST`                | `/teams/:slug/agent-bootstrap-credentials`        | admin; mint one seat-, role-, or host-scoped bootstrap credential; plaintext returned once                                                                                                                                                                                                                                                                                                                 |
| `GET`                 | `/teams/:slug/agent-bootstrap-credentials`        | admin; redacted inventory (no plaintext or hashes)                                                                                                                                                                                                                                                                                                                                                         |
| `DELETE`              | `/teams/:slug/agent-bootstrap-credentials/:id`    | admin; revoke one active scoped credential                                                                                                                                                                                                                                                                                                                                                                 |
| `POST`                | `/agent-bootstrap-migrations`                     | exchange a legacy Team key plus independent agent-seat credential for one shown-once seat-scoped successor                                                                                                                                                                                                                                                                                                 |
| `GET`                 | `/teams/:slug/agent-bootstrap-cutover`            | admin; readiness from held seats, residency hosts, and observed scoped use                                                                                                                                                                                                                                                                                                                                 |
| `POST`                | `/teams/:slug/agent-bootstrap-cutover`            | admin; `{ force?: boolean }`; transactionally retire legacy bootstrap authority                                                                                                                                                                                                                                                                                                                            |
| `POST`                | `/teams/:slug/policy`                             | admin; e.g. `{ allow_pre_issued_grants: bool }`, `{ agent_connect: 'sponsor' \| 'any_member' }` (ADR 456); `{ style: { floor, defaults, prose } }` — the agent-style floor, default dials and team prose, sparse (ADR 514; additive optional key, no version bump)                                                                                                                                         |
| `GET`                 | `/teams/:slug/requests`                           | admin; pending claim/teammate requests                                                                                                                                                                                                                                                                                                                                                                     |
| `POST`                | `/teams/:slug/requests/:id/decide`                | admin; `{ decision:'approve', lifetime:'once'\|'ttl'\|'standing', ttl_hours? }` \| `{ decision:'deny' }` — approve issues a grant of the admin-chosen lifetime                                                                                                                                                                                                                                             |
| `POST`                | `/teams/:slug/claim`                              | stateless claim mirror of WS `claim` — carries `workspace` + `workspace_key` (ADR 014/368) and `provenance` (ADR 131 §6), so a stateless claim is scoped by workspace and reads its animation source exactly as a WS one does. The server records `provenance` on **agent** seats only (the ADR 121 gate the ambient-touch path applies): a human shell must not be able to label its own occupancy `wake` |
| `GET`                 | `/teams/:slug/members`                            | roster **projected by viewer**: seats with role, account/availability/activity + `watching` list; non-admins never see credentials/grants/audit/policy/other charters                                                                                                                                                                                                                                      |
| `POST`                | `/teams/:slug/availability`                       | set the caller's seat availability (`available\|away\|dnd\|away_until`)                                                                                                                                                                                                                                                                                                                                    |
| `GET`                 | `/teams/:slug/style-block`                        | the style envelope a seat reads — `{ block, epoch, dials, driver }` for the human steering it (its attested presence driver; a human caller gets their own), never a caller-named human; the same envelope rides the `occupied` frame, and `GET /inbox` carries its current `style_epoch` (ADR 514 inc 3)                                                                                                  |
| `GET`/`PUT`           | `/teams/:slug/members/me/style`                   | a human's own style dials and prose, resolved against the team floor and defaults (ADR 514)                                                                                                                                                                                                                                                                                                                |
| `GET`/`PUT`           | `/teams/:slug/members/me/doorbell`                | a human's own doorbell sinks (ADR 443); personal URLs are readable by their owner only; every sink URL must be `https` to a public host                                                                                                                                                                                                                                                                    |
| `GET`                 | `/teams/:slug/members/:name/doorbell`             | admin; a teammate's doorbell, masked — `{on, personal}` per sink, never a URL (ADR 443)                                                                                                                                                                                                                                                                                                                    |
| `GET`                 | `/teams/:slug/audit`                              | admin; audit records                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET`                 | `/.well-known/oauth-protected-resource/mcp/:team` | public; resource metadata naming this team's issuer (A.13)                                                                                                                                                                                                                                                                                                                                                 |
| `GET`                 | `/.well-known/oauth-authorization-server/:team`   | public; issuer, endpoints, `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true` (A.13); the global path 404s (multi-tenant honesty)                                                                                                                                                                                                                                 |
| `POST`                | `/oauth/:team/register`                           | public, rate-limited; RFC 7591 dynamic client registration — public clients only; redirect URIs validated (https, no wildcards, no private hosts)                                                                                                                                                                                                                                                          |
| `GET`                 | `/oauth/:team/authorize`                          | TLS-except-loopback; renders the consent page (app, team, seat); PKCE S256 required                                                                                                                                                                                                                                                                                                                        |
| `POST`                | `/oauth/:team/authorize`                          | TLS-except-loopback, rate-limited; one of three proofs: the seat's `mscr_` (ADR 446), a human-admin-issued team invite admitting a new human (ADR 450), or a sponsored agent's one-time connect nonce, which revokes the agent's prior chains and unexchanged codes (ADR 452); single-use 90s code rides one 302 to the exact registered redirect URI                                                      |
| `POST`                | `/oauth/:team/token`                              | TLS-except-loopback, rate-limited; `authorization_code` (PKCE verifier) → `msat_`+`msrt_`; `refresh_token` → rotated pair; OAuth-style errors (`invalid_grant`, …)                                                                                                                                                                                                                                         |
| `POST`                | `/oauth/:team/revoke`                             | TLS-except-loopback; RFC 7009 revocation of either token kind; unknown tokens still answer 200                                                                                                                                                                                                                                                                                                             |
| `POST`/`GET`/`DELETE` | `/mcp/:team`                                      | TLS-except-loopback, bearer (`msat_`); the adapter as Streamable HTTP — `team_join` (no-op when the bearer names the seat), `team_inbox_check`, `team_send`, `team_agent_create` (ADR 449 §3), `team_agent_connect` (ADR 456 §5)                                                                                                                                                                           |
| `POST`                | `/teams/:slug/members/agents`                     | a **human** member mints an agent they sponsor (ADR 449 §3): `{name, role?}` → `{member, connect_url, connect_expires_at}`; `sponsored_by` = caller, expiry inherited, ≤3 live per sponsor; no secret — a one-time `/join/:team#n=<nonce>` link (sha256 at rest, 15 min; ADR 450 shares the page)                                                                                                          |
| `POST`                | `/teams/:slug/members/agents/:name/connect`       | issues or re-issues that link. Who may is team policy `agent_connect` (ADR 456): `sponsor` (default) means the sponsor or an admin, `any_member` means any human member. The issuer bounds the session it starts; the prior unused link is burned                                                                                                                                                          |

### Human authority and local trust (ADR 580)

An **admin** is an authenticated `human` member whose resolved capabilities include `is_admin`.
Loopback proves that a request came from this machine; it MUST NOT substitute for a human-admin
credential.

- `POST /teams` is the bootstrap exception: it creates a new team and its first human admin in the
  same operation. It does not authorize later human-seat or credential changes.
- `POST /teams/:slug/members` may use local trust only for an ordinary agent-seat operation.
  Observers require a human-admin credential because they can read team traffic. It MUST also require
  a human-admin credential when a file-backed reconcile would add or revive a human seat, or change
  which human seats are admins. Its response MUST NOT return `human_credential` to a loopback-only
  caller.
- `POST /teams/:slug/members/:name/credential/rotate` requires a human-admin credential. The new
  credential is shown once; rotation revokes the prior credential's OAuth sessions.
- `POST /teams/:slug/members/:name/agent-seat-credential/rotate` may use local trust because it
  rotates only an agent-seat credential; off-machine callers require a human-admin credential.
- `GET /teams/:slug/local-identity` is local-peer-only and also requires an authenticated human
  bearer. It returns only the credential for that authenticated member, never the daemon's local
  credential inventory.
- `POST /teams/:slug/signin-handoff` requires an authenticated human bearer and may stage only that
  same member's credential. `GET /teams/:slug/signin-handoff/:nonce` is local-peer-only and consumes
  the short-lived, single-use nonce from that authenticated stage; it transfers an existing
  credential and does not mint one.
- An invite is a bounded delegation created by a human-admin-only invite route. Invite redemption is
  authorized by that invite and OAuth proof; loopback and agent credentials are not human proof.
- Role defaults and any operation that can grant `is_admin` are human-admin-only, except the initial
  human admin established by `POST /teams`.

Sending an Envelope still requires the sender to **hold the occupancy** of `from` (replaces token==member). All read endpoints return a **viewer-scoped projection** per the recipient's `visibility_level`.

## A.8 Error / refusal codes

Add `claim_conflict` (seat occupied; 409), `expired_grant` (410/403). Reuse `forbidden` (bad key / not allowed to observe / not admin), `not_found` (no such seat/role), and surface account states via `refused.code` (`disabled`/`banned`), or a human's hold on the seat (`halted`, ADR 501 — the message names who and why). `held` is a refusal by an enforced Team hold (A.15, ADR 516 — the message names the effect, the human and the end time). `version_mismatch` covers an older client hitting this server. `rate_limited` (429) covers the OAuth per-IP buckets and, on Cloud, the per-team request budget (ADR 622) — the next move is retry, never re-authenticate.

## A.9 Migration

- `members` → `seats` (+ `role`, `account_status`; drop `token_hash`). Add `roles`, `grants`, `requests`, `audit`, and team `policy`/`agent_key_hash`, per-human `credential_hash`.
- Schema migration; since musterd is pre-1.0 and local, a one-shot reset of existing local DBs is acceptable (documented), or a best-effort migration that mints an agent key, creates one role per distinct `members.role`, turns members into `active` seats, and marks the creator admin.
- Surface changes: `team add` provisions a seat (no token); MCP env `MUSTERD_TOKEN` → `MUSTERD_AGENT_KEY` (+ optional pre-issued `MUSTERD_GRANT`) — the seat is resolved from `.musterd/binding.json` (`claim`), not baked into the env (`MUSTERD_CLAIM` survives only as a manual override for binding-less/CI folders, PR #58); `init` and CLI `claim` use the claim/request flow.

## A.10 Portable wake context (unreleased — ADR 209)

This section specifies the additive portable-continuity contract before implementation. It does not
change a Team’s wake authorization: enrollment, loop toggles, rate caps, and the host actuator stay
the ADR 131/179/191/199 mechanism.

### Wake context request and response

```jsonc
// recipient-authenticated client → server
POST /teams/:slug/wake-context
{ "act_id": "01J…" } // exactly one of act_id or lane_id is required

// server → recipient
{
  "context": {
    "version": 2, // 1 from a daemon before ADR 430; then no `context`/`budget`
    "wake": {
      "kind": "reply|handoff|review|work_order",
      "act_id": "01J…"?,
      "lane_id": "01J…"?
    },
    "objective": { "action": "reply|review|continue_lane|begin_lane" },
    "state": {
      "lane": { "id":"01J…", "state":"…", "owner_seat":"Ada"?, "branch":"…"? }?,
      "thread": { "id":"01J…", "participant_count":2, "unread_count":1, "latest_act":"handoff"? }?,
      "memory": { "headline":"…", "saved_at":<ms>, "size_bytes":<int> }?
    },
    "fetch": ["inbox_thread", "lane_detail", "seat_memory", "git_artifact"],
    "delivery": {
      "requirement": "portable|transcript_required",
      "intended": "fresh|resume"
    }
  }
}
```

**The `context` block (v2, ADR 430).** `WakeContextPacket` gains `version: 2`, an additive `context` block, and a `budget` field. `context`
carries the waking thread's last eight acts (each `{id, from, act, ts, body, truncated}`, bodies cut
at 600 characters, plus `omitted`), an `open` ledger of unanswered directed acts and owned lanes
(`{kind, id, from?, title, age_ms}`, titles only, at most 12), on lane wakes the lane `detail` and the
recipient's own newest `status_update` naming it, and the recipient's memory body. Every body is
attributed to its sender and thread; the composed wake line and the interrupt line remain ids-only.
The serialized `context` block is capped at 12,288 bytes, filled memory → thread → lane → open; a
truncated or dropped category is named in `fetch`, which in v2 lists only what did not fit (new value
`open_items`). `budget` reports `{limit_bytes, used_bytes}`. The packet is derived at read time from
canonical rows, never stored. Authorization is unchanged from A.10. `residency.context_read` records
`version`, `used_bytes`, per-category bytes, `thread_acts`, `omitted`, and emitted `fetch` categories
and never a body, headline, or title; a refused read records `residency.context_denied` with the
caller and target kind only. A recipient handed `version: 1` follows A.10's fetch ritual. ADR 654 adds optional `provenance: {writer, suspect, line}` to `context.memory`: who saved the note (`writer` `{surface?, workspace?, node?, machine?}`, or `null` for a save made before the stamp) and whether, on an agent seat, it was last saved from another folder or machine than the woken session (`suspect`). The stamp is client-reported at claim, so `suspect: false` never means verified.

The packet is a server-derived orientation index. It MUST NOT contain an Envelope body, a seat-memory
body, a lane title, source text, or other agent-authored free text. The full bodies remain explicit,
recipient-scoped reads. The packet creates no durable context store.

A server MUST authorize an `act_id` request only when the Act was delivered to the calling Member. It
MUST authorize a `lane_id` request only when the caller owns the Lane or is the recipient of the
current review/handoff derivation for it. A disallowed request MUST return `forbidden` without
revealing whether the Act or Lane exists.

### Delivery selection and reporting

Wake Orders MAY add `continuity_requirement: "portable"|"transcript_required"` and
`intended_delivery: "fresh"|"resume"`. Omission preserves legacy behavior for a mixed-version
daemon/host pair.

`portable` selects a fresh spawn. `transcript_required` is a server-controlled classification that
the initial implementation permits only for a recent directed reply; it is never selected by an
Envelope body. The host MAY resume only if local capture and policy checks pass and must retain the
same-lease fresh fallback. Handoff, review, and work-order wakes are portable.

Ordinary inbox reply wakes retain legacy delivery unless the team residency policy's
`portable_inbox_replies` cohort flag is enabled (its default is `false`). When enabled, those
orders are also portable/fresh. This is a rollout selector, not a sender-controlled field.

### Deferred acts and wake eligibility

An act its recipient deferred (a `wait` carrying `meta.defer_ref`) is not a wake reason: the
Member said "not now". Deferred targets are suppressed from the wake candidate set whether or not
their condition has since fired.

When the team residency policy's `raised_deferral_wakes` flag is enabled (default `false`), a
deferral whose condition HAS fired becomes a candidate again. Such an order always takes the
`batched` lane, whatever lane its act would otherwise derive and even when that act is urgent — a
deferral must not jump the interrupt line it removed the act from. A seat pinned to the `interrupt`
lane therefore never receives one. Rate limiting is unchanged: the act id remains the exhaustion
key.

Wake reports MAY add `delivery_outcome: "fresh"|"resumed"|"fresh_fallback"`, plus non-content
measurements `transcript_bytes`, `transcript_age_ms` and — when the host weighed the transcript's
replayable records against the hygiene bound (ADR 427) — `resume_weight_bytes`. No report carries a
session ID or transcript path. A `fresh_fallback` outcome means a resume attempt failed and the fallback fresh session
occupied.

## A.11 Shared Seeds before Lanes (unreleased — ADR 291)

A **Seed** is a captured Team idea, distinct from a Lane. Shared-Seed ingest accepts only
`source: "slack"` with a non-empty `meta.user`; a human Member's optional `slack_user_id` resolves
that identity (ADR 311). Its `relay_id`, Slack source, raw `body`, `captured_at`, Slack user id, and
resolved submitting Member are immutable. An unknown Slack user creates no Seed and advances the
cursor after a body-free `unknown_submitter` diagnostic; an unsupported source fails parsing and does
not advance the cursor. Every accepted capture starts `open`; ingest performs no semantic
classification of its body (ADR 312). Its lifecycle is
`open|exploring|needs_clarification|clarified|completed|promoted`. A Seed may have one active
agent explorer and a narrow public thread of clarification, answer, brief, or conclusion entries.

An exploration result carries one exhaustive final brief: problem and context, external evidence,
viable approaches and trade-offs, constraints, risks, unknowns, recommendation, and proposed Lane
title/detail. A non-actionable result also carries a conclusion and completion time. Promotion records
automatic/manual provenance, whether research was skipped, and its timestamp.

The additive HTTP surface is `GET /teams/:slug/seeds`, `GET /teams/:slug/seeds/:id`, and authenticated
claim, clarification, answer, final-brief, and manual-promotion operations. The server validates every
body with the corresponding Seed schema. Only an agent may claim/explore; only the active explorer asks
or finalizes; posting a question is the only transition into `needs_clarification`; only the submitting
Member answers. Promotion atomically creates one ordinary, unowned
Lane and links it to the Seed; retries return the existing linked Lane. No raw body, Slack user id, or
thread body appears in logs, telemetry, or audit details.

## A.12 Governed model authorization substrate (Increment 3 — ADR 411)

This additive server/protocol slice establishes the runtime boundary for the optional Aperture paved
road. It does not add a new Act, alter the `musterd/0.3` Envelope, launch a harness, configure
Tailscale/Aperture, or activate Team-wide enforcement. Its schemas are strict and versioned in
`@musterd/protocol`; its server implementation is migration 67 in `@musterd/server`.

The server-owned policy is:

```jsonc
{
  "version": 1,
  "enforcement": "off", // or "required"; omitted means "off"
  "team": { "models": ["provider/exact-model"], "quota": { "capacity": "$10", "rate": "$1/hour" }? },
  "members": { "Ada": { "models": ["provider/exact-model"], "quota": { "capacity": "$5", "rate": "$1/hour" }? } }
}
```

Model identifiers are exact lowercase `provider/model` values; floating names such as `latest` and
`default`, duplicate Team models, credential-like values, and Member model widening are rejected.
`enforcement` defaults to `off`, which leaves unmanaged Member and Presence behavior unchanged. The
`required` value is reserved for a later activation slice.

An active human Member may issue an authorization for an active agent Member only when that Member has
exactly one enrolled machine-node residence in `seat_nodes`. Issuance binds the Team, target Member,
node, launch correlation, expiry, and one of these currently authorizable contexts: an active owned
Lane or an unresolved directed Act. The protocol also parses an `orientation` context for forward
compatibility, but Increment 3 has no allowance record or issuance path for it; the server refuses it
with `denied_context_orientation` until a later ADR adds that authority. The server returns one opaque
`msla_` credential, stores only its SHA-256 hash, and records no credential in the public projection,
audit log, or request log. The matching agent Presence consumes the handoff exactly once; expiry,
revocation, replay, mismatch, and missing or held Presence are refusals.

The HTTP surfaces are admin-only policy replacement/read, human-authenticated launch issuance,
node-authenticated one-shot consumption, admin revocation, and node-authenticated
`/governed/authorize`. The final decision checks enrolled active node identity, the consumed launch and
live Presence, the durable Member↔node binding, the bounded work context, and the server-owned model
ceiling. It returns `decision: "allow"` or `decision: "deny"` with stable refusal codes such as
`denied_node_binding`, `denied_launch_expired`, `denied_presence_stale`,
`denied_context_lane`, `denied_context_orientation`, and `denied_model`. Refusal status is structured
and metadata-only; prompts, responses, provider payloads, and machine-local secrets never cross this
boundary.

## A.13 Remote MCP over HTTPS (Increment 1 — ADR 446)

Phone MCP apps (Claude, ChatGPT) cannot spawn a local adapter process; what they can do is add a
remote MCP server at a public HTTPS URL as a custom connector, speaking Streamable HTTP with
OAuth 2.1. The daemon is the authorization server for its own teams' humans — no third-party IdP —
and serves the adapter at `https://<host>/mcp/<team>` (the team rides the path because a phone app
configures exactly one URL and no musterd headers).

Two bearer kinds (`msat_` access, 1h; `msrt_` refresh, 30d, single-use rotation) are minted
`prefix + base64url(randomBytes)`, stored only as SHA-256, returned once, never logged, never in
audit `detail`. Scope is (team, member, client), bound at mint to a **human** seat — agent seats
stay on the claim handshake. An `msat_` authenticates exactly like an `mscr_` (self-identifying,
acting-seat must match-or-absent) with no session lease; presence derives from authenticated
activity (ambient). Credential rotation revokes the seat's OAuth chains with it.

The flow is discovery → dynamic client registration (public clients only) → authorization code
with PKCE S256 (REQUIRED; `plain`/`none` refused) → bearer tokens. Codes are single-use, 90s TTL,
bound to client + redirect URI + challenge + team + member; redirects match registered URIs
exactly; reuse of a burned refresh revokes the whole chain. OAuth + bearer routes refuse non-TLS
unless loopback. Token errors are OAuth-shaped (`invalid_grant`, `invalid_client`); audit verbs
are `oauth.client_registered / oauth.code_issued / oauth.token_issued / oauth.token_rotated /
oauth.token_reused_revoked / oauth.revoked` — who, which client, when; never the secret.

### Increment 3 — Client ID Metadata Documents (ADR 470)

Authorization-server metadata advertises `client_id_metadata_document_supported: true` and
continues to publish `registration_endpoint` for Dynamic Client Registration (DCR). DCR remains
available for clients that need it. On authorization GET and POST, the server resolves a registered
DCR client first. Only a DCR miss may resolve `client_id` as a Client ID Metadata Document (CIMD)
URL; resolution happens after the authorization per-IP rate limit. This changes OAuth HTTP
metadata only and does not change the `musterd/0.3` Envelope or handshake.

A CIMD document must have an exact matching `client_id`, a non-empty `client_name` of at most 200
characters, at least one entry in `redirect_uris`, grant types containing `authorization_code` and
`refresh_token`, response types containing `code`, and support for token endpoint authentication
method `none` either in `token_endpoint_auth_method` or
`token_endpoint_auth_methods_supported`. Unknown fields are ignored. The server does not fetch
`jwks_uri` or implement `private_key_jwt`. Every listed redirect URI passes the existing redirect
safety policy, and the requested URI must match one exactly. Invalid clients receive a generic
OAuth client error without a redirect.

The CIMD URL is at most 2,048 characters, uses HTTPS on port 443, has no userinfo, query, or
fragment, and has a non-empty path without `.` or `..` segments, including percent-encoded forms.
The server resolves all DNS answers once and rejects the URL if any answer is not globally
routable unicast, including IPv4-mapped IPv6 addresses. It pins the HTTPS connection to a validated
address while preserving the original hostname for TLS verification, SNI, and `Host`. It does not
follow redirects; it requires HTTP 200 and `application/json`, stops after 3 seconds, and reads no
more than 5 KiB. Fetch and validation failures do not reveal their cause. A full bounded-fetch pool
may return a retryable service failure.

Only valid documents are cached in a process-local 256-entry least-recently-used cache keyed by the
exact URL. Same-URL fetches are coalesced, and at most 16 unique metadata fetches may be in flight
per process. The cache lifetime is no longer than 5 minutes; `no-store` and `no-cache` responses
are not reused, and `max-age`, `Age`, and `Expires` may shorten the lifetime. Without explicit
freshness, the local maximum is 5 minutes. Errors are not cached.
The consent page shows the escaped client name with the CIMD hostname and does not fetch logos or
other remote presentation assets; DCR consent presentation is unchanged.

The token endpoint never resolves or fetches CIMD metadata. After a local DCR lookup, a
syntactically valid CIMD URL may reach grant matching, but code redemption and refresh rotation
must match the exact client ID already bound to the grant for that Team. CIMD metadata documents
are not persisted. Audit targets/details, logs, and traces omit CIMD URLs and fields derived from
fetched metadata; existing audit fields that would copy a CIMD `client_id` are null. No new trace
event is added.

Increment 1 serves the Done-line tools (`team_join` as no-op success when the bearer names the
seat, `team_inbox_check`, `team_send`) with the adapter's input shapes; the rest of the surface
converges in increment 3 after rehearsal says which tools a phone reaches for.

## A.14 Durable review promises (unreleased — ADR 490)

A review request is a root `request_help` Act with a typed `meta.review` artifact reference and a
direct Member recipient. It has no existing `thread`; its body is the review context. This form
rejects Team recipients and `meta.eligible`. Other `request_help` Acts, including untyped ones,
retain their existing lifecycle.

`meta.review` is one of:

- `{ "kind": "pr", "repo": "owner/name", "number": 123 }`, with a positive integer PR number;
- `{ "kind": "commit", "repo": "owner/name", "sha": "<40-or-64 hex digits>", "path?": "src/file.ts" }`, where `path` is repository-relative and has no `.` or `..` segment;
- `{ "kind": "lane", "id": "<Lane ULID>" }`;
- `{ "kind": "url", "url": "https://…" }`, absolute HTTPS with no userinfo, query string, or fragment.

Artifact references carry no credentials or signed access tokens. Implementations validate the
metadata through the shared protocol schema at every external boundary.

Only an `accept` from the directly named recipient, with `meta.in_reply_to` naming the root request,
creates a review promise. Its `thread` is the root request id. Repeated valid accepts derive one
promise, selected by the minimum `(ts, id)` pair; the selected Act's origin timestamp is
`accepted_at`. This timestamp uses the sender's clock. The request's direct recipient is the owner.

The server derives open promises from the request, its accepted reply, and the absence of a `resolve`
on the request's root thread. It returns these additive `NextBrief` arrays:

```jsonc
{
  "request_reviews": [
    {
      "request_id": "<Act ULID>",
      "requester": "nick",
      "owner": "Ada",
      "context": "Please check the migration",
      "review": { "kind": "pr", "repo": "org/repo", "number": 42 },
      "accepted_at": 1790812800000,
    },
  ],
  "requested_reviews": [
    /* same row shape, for the requester */
  ],
  "review_closures": [
    {
      "request_id": "<Act ULID>",
      "resolve_id": "<Act ULID>",
      "closer": "Lin",
      "resolved_at": 1790816400000,
    },
  ],
}
```

`request_reviews` belongs to the accepting Member; `requested_reviews` belongs to the requester.
Both include every matching open promise, oldest `accepted_at` first, with request id as the stable
tie-breaker. The closing `resolve` is Team-addressed so requester and owner both receive it. Any
Member may close the root thread, including the requester withdrawing the request. If a Member other
than the owner closes it, `review_closures` gives the owner one notice until that Member's inbox
cursor crosses the `resolve` Act. The requester sees the same `resolve` in the request thread.

The three arrays are optional and have no schema defaults. A supporting daemon emits all three,
including `[]`; omission means the daemon does not report the projection. CLI and MCP renderers
preserve that distinction. The weekly audit uses the Team-wide route below and abstains if it is
unsupported. This promise is a reminder derived from Acts: it adds no table, Act, timer, or proof
that review content or quality was checked. Lane acceptance remains represented by `owed_reviews`
and `review_debt`.

The weekly audit runs as the `sweep` service Member and cannot read another Member's per-caller
`requested_reviews` rows from `NextBrief`. A supporting daemon MUST expose
`GET /teams/:slug/review-promises?open=1` to an authenticated active Member of the named Team. It
returns `{ "review_promises": [...] }` with every open promise in that Team, ordered by
`accepted_at` ascending and then `request_id` ascending. Each row contains only `request_id`,
`requester`, `owner`, and `accepted_at`; it does not include the request context or artifact
reference. A supporting daemon MUST include `review_promises: []` when the Team has no open
promises. The weekly audit abstains if this route is unsupported and treats `[]` as a supported
empty population.

## A.15 Holds (unreleased — ADR 516)

A **hold** is a time-bounded Team rule that only a human admin sets or lifts. It is the one
authoritative place a Team says "this is paused"; Members read it, they do not restate it.

```jsonc
{
  "id": "<ULID>",
  "effect": "autorefresh_paused", // | "merges_paused" | "notice"
  "reason": "demo 14:00", // required, 1–280 chars; for "notice" it is the whole message
  "created_by": "nick", // the human Member who set it
  "created_at": 1791229200000,
  "expires_at": 1791234600000, // required; expires_at - created_at <= 43200000 (12h)
  "lifted_at": null,
  "lifted_by": null,
}
```

A hold is **active** while `lifted_at` is null and the reader's clock is before `expires_at`.
Active is derived at read; there is no status field and no timer. `effect` is a closed set:
`autorefresh_paused` and `merges_paused` are enforced (by the autorefresh tick and the PreToolUse
gate respectively); `notice` is never enforced, and a renderer MUST label it as not enforced.
An implementation MUST NOT treat an unknown `effect` as enforced.

Routes (all under `/teams/:slug`):

- `POST /holds {effect, reason, until?: number, for_ms?: number}` — exactly one of `until` (epoch
  ms) or `for_ms`. Caller MUST be an admin; an admin is human (A.1, ADR 172). Over the 12h cap
  answers `validation`. Returns `{ hold }`.
- `POST /holds/:id/lift` — admin. Lifting an ended hold answers `not_found`. Returns `{ hold }`.
- `GET /holds` — any authenticated Member. Returns `{ holds: [...], can_set?: boolean }`: active
  holds, soonest `expires_at` first. `?all=1` adds ended ones, newest first. `can_set` is whether the
  CALLER may set or lift (a human admin), computed by the server per reader; a client renders set and
  lift controls from it alone and never from a role it reads elsewhere. Omitted means the server
  predates it; a client reads that as `false`. The write routes decide regardless.

A joiner forwards both writes to its hub and answers `hub_unreachable` if it cannot reach it; it
never records a hold locally. The hub writes the row and its replicated event (`hold.set`,
`hold.lifted`, carried by the `policy` sync kind) in one transaction. `meta.hold` is
server-controlled: an implementation strips a client-supplied copy.

Setting and lifting each deliver one `message` from the human to the Team carrying
`meta.hold = {id, effect, expires_at, lifted?: true}`. `NextBrief` and `NextSummary` gain an
optional `holds` array of active holds; a supporting daemon emits it, including `[]`, and
omission means the daemon does not report holds.

**Proposals (increment 3).** Any Member MAY propose a hold with an `ask` (species `approve`)
carrying `meta.hold_proposal` `{effect, reason, until | for_ms}`; a supporting daemon MUST refuse
such an ask at send if the proposal is malformed, names an effect outside the set, or exceeds the
cap. An `accept` naming that ask in `meta.in_reply_to` activates the hold only when its sender is a
human admin; the hold's `created_by` is that human, and one proposal yields at most one hold. Any
other accept, a decline, or no answer activates nothing.

`POST /holds/check {tool, command}` (any Member) answers a `GateDecision`. A supporting daemon
re-tests `command` itself and denies — outcome `denied_held`, reason the `held` sentence — only when
the caller is not human, the command is merge-shaped (`gh pr merge`, or a `git push` whose refspec
names `main` or `master`), and a `merges_paused` hold is active. A PreToolUse gate asks only for
merge-shaped commands and fails open when the daemon cannot answer.

A Member's call refused by an enforced hold answers refusal code `held`, whose message names the
effect, the human and the end time: `held by nick until 15:30: demo 14:00`. At the gate this is the `denied_held` decision's reason.

## A.16 Calendar entries (unreleased — ADR 519)

A **calendar entry** is Team data: one dated item any active Member may read or write. Dates and
times are wall-clock in the entry's `tz`; an implementation MUST NOT convert them to UTC.

```jsonc
{
  "id": "<ULID>",
  "title": "Demo at Foundry Live", // 1–160
  "date": "2026-10-16", // YYYY-MM-DD in tz
  "start": "18:30", // HH:MM in tz, or null
  "end": null, // HH:MM in tz, or null
  "tz": "America/Los_Angeles", // IANA name
  "kind": "demo", // demo | topic | pitch | people | prep | deadline | milestone | event
  "status": "going", // going | pending | list | invited | waitlist | done | null
  "place": "SF", // ≤120
  "url": "https://…", // https only, or null
  "note": "", // ≤2000
  "pick": true, // shown in the Picks view
  "source": "", // ≤120, free text: where the entry came from
  "source_ref": null, // import identity (the artifact document id), or null
  "created_by": "nick",
  "created_at": 1791229200000,
  "updated_at": 1791229200000,
}
```

Routes (all under `/teams/:slug`, any authenticated active Member):

- `GET /calendar[?since=<epoch ms>]` — `{ entries: [...], deleted: [...], now }`, entries by
  `date` (all-day first), `start`, then `title`. With `since`, only entries whose `updated_at` is at
  or after it, and in `deleted` the ids deleted at or after it (empty without `since`). `now` is the
  server's clock at the read; a poller passes it back as its next `since`, so the client's clock
  never enters the comparison.
- `POST /calendar {entry without id/created_*/updated_at}` — returns `{ entry, outcome }`, `201`
  when `outcome` is `created`. A body whose `source_ref` names an entry the Team already has
  replaces that entry instead (`updated`, or `unchanged` when nothing differs).
- `PUT /calendar/:id {same}` — full replace (an omitted optional field reads as its default);
  returns `{ entry, outcome }`; unknown id answers `not_found`; a `source_ref` another entry holds
  answers `conflict`.
- `DELETE /calendar/:id` — a real delete; returns `{ ok: true }`; unknown id answers `not_found`.

Bodies MUST parse through `CalendarEntryInputSchema`; a failure answers `bad_request`. An observer
seat may read and not write (`forbidden`). Every write that changes a row is one audit row
(`calendar.entry_written` or `calendar.entry_deleted`, with `{id, by}`); an `unchanged` write
records nothing, so a second import of the same export changes nothing and audits nothing.

## A.17 Stored claims checked on read (unreleased — ADR 522)

When a supporting daemon returns a stored note — a seat's memory, a handoff, an insight — it MAY
attach `checks`: what the note asserts, checked against the Team's current state.

```jsonc
{
  "kind": "rule", // lane | hold | rule
  "ref": "Nobody merges until the demo.", // a lane id, a hold id, or the clause as written (≤160)
  "verdict": "unsourced", // current | ended | unsourced
  "line": "\"Nobody merges until the demo.\" — no active Team hold says this, so the Team is not paused. …",
}
```

- A **lane** check is emitted only for a lane that is `done`, `abandoned` or `parked` (`ended`).
- A **hold** check carries the hold's state: `current` while active (A.15), else `ended`.
- A **rule** check is `current` when an active hold carries the matching effect and `unsourced`
  otherwise. A rule check never denies anything.

`line` is conclusive: a reader acts on it and does not re-verify. At most six checks per note.

Carried on: `GET /memory` (`checks`); the wake context block (`context.checks`, each with
`source: memory | handoff` and an optional `source_id`); `NextBrief.why.checks`; the dream packet
(`memory.saved_at`, `memory.checks`, and `checks` on each learned insight). Every field is optional;
omission means no check (or a daemon that does not check).

## A.18 Insights retracted and superseded (unreleased — ADR 526)

An `insight` stays append-only; its standing is derived from later acts.

- **Retracted:** a `resolve` with `thread` equal to the insight's id, sent by the insight's author or
  by a human Member. The resolve's body is the reason. From any other Member it retracts nothing.
- **Superseded:** a later `insight` whose `meta.supersedes` (1..8 ids) names it. When the
  superseding insight's author is the original's author or a human, the original is **hidden**;
  otherwise it is annotated only.

A hidden insight MUST NOT be returned by `GET /memory/search` unless `all=1`, re-read in a dream
packet, or listed in a digest's learned section. Search hits MAY carry
`status: {retracted?: {by, at, reason}, superseded_by?: [{id, from, headline, hides}]}`; a dream
packet's insight MAY carry `superseded_by` (from other Members only — a hidden one is absent).

## A.21 A reply on a superseded acceptance ask (unreleased — ADR 545)

A `lane_review` ask is superseded once a re-route (`lane.review_rerouted`, named, departed or reaped)
names it as `superseded_ask`. While its Lane is still awaiting acceptance, a supporting server:

- MUST NOT let an `accept`, `decline` or `wait` that answers a superseded ask move the Lane, record a
  peer confirmation, or fire a human ask (ADR 188 §4) — the acceptance is the current holder's.
- MUST answer that act's ack with `lane_superseded {lane, ask, current}` — `ask` the superseded ask
  answered, `current` `{ask, reviewer}` for the acceptance ask open on the Lane now, or `null` when
  none is — and MUST NOT answer `lane_verdict`, `lane_escalation` or `lane_ack` for it.

## A.20 Peer-confirmed acceptance pending a human (unreleased — ADR 539)

On a Lane with a declared `risk` tag, an agent's `accept` on the `lane_review` ask is the peer stage
(ADR 188 §4), never the verdict. A supporting server:

- MUST answer that accept's ack with `lane_escalation {lane, human}` — `human` the Member the
  blocking human ask went to, or `null` when no human was live or when the answering node is a
  joiner (the hub decides on fold). It MUST NOT answer `lane_verdict` for it.
- MUST record `lane.review_peer_confirmed {lane, peer, grade, human_ask_fired, peer_accept}` and,
  when the human ask fires (then or later), `lane.review_human_asked {lane, human, ask, peer,
retried}`; both replicate on the lane kind.
- MUST, on the hub, ask the first human who comes live while the Lane is still awaiting acceptance
  and no `lane.review_human_asked` exists, carrying the peer's findings; it MUST NOT close the Lane
  or substitute an agent for the human (ADR 172).
- MUST treat a HUMAN's `accept` on a review ask of a risky Lane as the verdict (ADR 202), never as a
  peer stage.
- MAY mark `NextBrief.review_debt[]` rows `pending_human: true` with `peer_confirmed_by` while the
  state holds; omission means the server does not derive it.

## A.19 Policy review dates (unreleased — ADR 533)

The stored team policy doc (the sparse set of chosen knobs, ADR 185) carries `review_by` (epoch
ms): the date after which its admins are asked to look at it again. It is a property of the doc, not
a knob: the effective policy a reader consumes never carries it.

- A server MUST stamp `review_by` on every `POST /policy` that stores at least one knob: absent ⇒
  `now + 90 days`; named ⇒ kept if in the future and at most 365 days out, else `validation`. An
  empty doc carries none. The stamp travels in the doc's `policy.change`.
- Past `review_by`, a server MUST raise at most ONE `ask` per date (species `approve`, tier
  `standard`) to the Team from a service Member, carrying `meta.policy_review = {review_by, keys}`.
  `policy_review` is server-controlled: a client-supplied copy is stripped.
- A human admin's `accept` naming that ask in `meta.in_reply_to` re-confirms the doc (`review_by`
  moves to the default window from now); a `decline` replaces it with `{}`. Any other reply, or a
  second answer, changes nothing. Silence changes nothing: a review is a question, never a timer
  that unsets a rule.

## A.20 Up-next ranked per member (unreleased — ADR 536)

`NextBrief.up_next` — the open Lanes a Member could pick up — is a window of at most five on the
Team's pool, ordered for the reading Member. The pool is the same for every Member; the order is not.

- A server MUST withhold from `up_next` any `open` Lane whose `depends_on` names a Lane on the board
  that is not `done`. A dependency naming no Lane does not withhold. Parked Lanes are never offered.
- A server MUST order the remainder in lexicographic tiers from declared fields only: (1) a Lane the
  Member's live `why` handoff names, or any Lane under that handoff's `meta.goal_id`; (2) a Lane
  whose `role` the Member holds; (3) the oldest untouched Lane of a stalled in-flight Goal, then any
  Lane under an in-flight Goal; (4) a Lane whose `scope` overlaps the `scope` of a Lane the Member
  closed `done` within the last 30 days; (5) the rest. A `role` the Member does not hold places the
  Lane in tier 5 and never withholds it. Inside a tier: Goal-attached first, then oldest first.
- A server MUST NOT rank on anything inferred — a title, a diff, a model, a harness.
- `NextBrief` carries `up_next_total` (claimable `open` Lanes) and `up_next_blocked_total`
  (withheld for a dependency). Both default to 0: a brief from a server behind this appendix parses,
  and a renderer prints no count when both are 0.
- `NextBrief` carries `up_next_why`: one `{lane, tier, reasons}` row per `up_next` entry, in the
  same order. `tier` is the integer tier (1–5) that placed the Lane; `reasons` are fixed strings the
  server composes for every tier whose signal fired, in tier order — never text from a Lane or an
  Act — and empty for tier 5. Defaults to `[]`.
- This orders a read. It delivers no Act and selects no holder; role routing stays as ADR 272 §5
  left it.

## A.22 Idle-at-prompt wake (unreleased — ADR 558)

An open session idle at its prompt is pushed a turn when a teammate directs an act at its seat. The
daemon decides what rings; the adapter decides when (ADR 558 §2).

- `GET /teams/:slug/inbox/interrupt-check` accepts `seam=boundary|idle` (default `boundary`; an
  unparseable value is `boundary`, never a 400). `rail` keeps its meaning: the harness id.
- With `seam=idle`, a supporting server MUST answer from the boundary set plus every act
  `idleRingable(env, seat)` accepts: directed at the seat (by name or by `meta.eligible`), not from
  it, and `meta.urgent === true` or act ∈ {`steer`, `ask`, `request_help`, `handoff`}. A directed
  `ask`/`request_help`/`handoff` is discharged by an `accept`/`decline` naming it or by the seat's
  own reply to it. The line MUST be composed exactly as on the boundary seam.
- A server MUST answer `{raised: false, idle_wake: false}` and write no row when the seat's
  effective `ResidencyPolicy.idle_wake` (team default ⊕ seat override, default `true`) is false.
- A server MUST record `interrupt.raised` with `detail.seam: 'idle'` for an idle-seam raise, and
  MUST dedupe `interrupt.raised` per (seat, act) across both seams.
- `HeartbeatFrame` carries optional `hearing: 'idle'|'deaf'` and `hearing_reason` (≤ 80 chars).
  Absent means no change. A server SHOULD record `presence.hearing {hearing, reason}` on change.
- `POST /teams/:slug/inbox/idle-wake` takes a strict `IdleWakeReport`
  `{act, outcome: 'injected'|'failed'|'capped', harness, reason?, cap?: 'sender'|'session'}` and
  records `idle_wake.injected` or `idle_wake.capped`. It MUST refuse any other field (no line, no
  body).

## A.23 Read dates on Lanes (unreleased — ADR 644)

A Lane may declare the day its read is due, and carry the read's verdict. Both are declared; neither
is ever inferred from a title, a detail or a document.

- `reads_on` is a `YYYY-MM-DD` real day (A.16's date rule), wall-clock in the Team's calendar zone.
  It is accepted on open and on update; `null` on update clears it.
- `read_verdict` is `{outcome: 'met'|'missed'|'inconclusive', note, by, at}`, with `note` 1–280
  characters. A server MUST stamp `by` from the authenticated sender and `at` from its own clock. It
  rides an update, a submit or a resolve. A later verdict replaces an earlier one, and each write is
  one `lane.read_recorded` audit row.
- A server MUST refuse, with `validation`, a move to `done` on a Lane that has `reads_on` and no
  `read_verdict`. A move to `abandoned` is unaffected.
- A server MUST derive `read_status` on the Lane projection when `reads_on` is set: `read` (a
  verdict exists), else `dropped` (the Lane is `abandoned`), else `waiting` / `due` / `overdue` as
  today in the calendar zone is before, on or after `reads_on`. It is never stored, and a
  client-supplied copy is stripped. It is absent when `reads_on` is.
- A passed date raises nothing: no Act, no state change, no wake. A server behind this appendix
  sends neither field, and a reader treats that Lane as undated.

## A.24 A human seat's note is sealed to that human's machines (unreleased — ADR 657)

A human seat's note is encrypted on the human's own machines before it is saved. No server, hub or
peer holds it in plain text.

- A sealed note's stored `body` is `mssealed1.` + base64url JSON `SealedNote`
  `{v: 1, to: [{node, pk, epk, wrap}], iv, ct}`, and its `headline` is the fixed `sealed note`. `ct`
  is AES-256-GCM over `{headline, body}` under a random content key. Each `to` stanza wraps that key
  for one machine: X25519 between a fresh ephemeral key (`epk`) and the machine's public key (`pk`),
  HKDF-SHA256, then AES-256-GCM. Both keys are raw 32 bytes, base64url.
- `POST /teams/:slug/memory/recipients` `{public_key?}` (seat-authenticated) records the calling
  machine's public key on its node, and answers the strict `NoteRecipients`:
  - `{seal: true, node_id, recipients: [{node_id, label, public_key | null}]}` for a human seat,
    covering every node in the seat's trusted set, or just the asking node when the set is empty;
  - `{seal: false}` for an agent seat, with nothing recorded.

  An enrolled joiner forwards it to the hub as `POST /teams/:slug/sync/note-recipients`
  `{seat, public_key?}` under its machine credential. The hub records the key only for the node that
  authenticated.

- A server MUST refuse, with `bad_request`:
  - a human seat's save whose body is not a sealed note, or whose headline is not `sealed note`;
  - an agent seat's save whose body is a sealed note.
- A sealed body may be up to 16384 bytes. The 120-character headline and 8192-byte body caps apply
  to the plain text, and the client checks them before sealing.
- `checks` (A.17) are empty for a sealed note.
- A client that can open the note re-seals it when a keyed machine in the seat's set is missing from
  `to`. A machine not in `to` cannot open the note.

## A.25 Seat pulse (unreleased — ADR 660)

A seat's harness tool-call cadence reaches viewers of the team's own `/live` as counts and kinds
only, so the office can show _that_ a seat is working and nothing of _what_.

- Server → `seat_pulse`: `{ "type":"seat_pulse", "member":"miley", "ts": 1733760000000,
"intensity": 7, "kind": "run", "last_ts": 1733759998120 }`. `intensity` is the number of
  distinct harness tool calls (`PostToolUse` / `PostToolUseFailure` trace rows with a
  `tool_use_id`, ADR 445) in the trailing 60 s; `kind` is one of `read` | `edit` | `run` | `test`
  for the latest such call that folds to a kind, or `null`; `last_ts` is that call's producer time
  (0 when `kind` is null); `ts` is the server clock when the pulse was computed.
- The server sends it only to `team-all` subscribers (the firehose), at most once per seat per
  ~5 s, and **never for an idle seat**: no frame is the idle signal, and a viewer treats a pulse
  older than ~15 s as still. On `subscribe team-all` the server MAY send the current pulse of every
  seat with calls in its window.
- The frame carries exactly these six fields. A server MUST NOT add a tool name, path, command,
  session digest, harness or agent id to it.
- Additive to `musterd/0.3`: a client that does not recognise `seat_pulse` ignores it. `test` is in
  the enum; no server produces it until a classifier exists (ADR 660 Consequences).

## A.26 Metrics and samples on dated reads (unreleased — ADR 673)

A dated read may declare what it measures, collect one number per day against it, and carry the
measured value on its verdict.

- `metric` is `{name (1–80), unit (1–24), baseline: number|null, target: number, direction:
  'up'|'down', source, by, at}`. It is accepted on open and on update (`null` on update clears it).
  A server MUST stamp `by` and `at`, and MUST refuse, with `validation`, a metric on a Lane with no
  `reads_on`, or an update that clears `reads_on` under a standing metric. On input `source` is one
  of `manual` (default), `wake_latency_p50_ms` and `dispute_rate`; on read it is a plain string.
  Changing `target` or `direction` is recorded as `lane.metric_changed` with both values.
- `POST /teams/:slug/lanes/:id/samples` takes `{day: YYYY-MM-DD, value: number, n: int ≥ 0}` from
  any authenticated member of the Team and answers `201 {sample, replaced}`. A server MUST refuse it
  with `validation` when the Lane has no metric, and with `409` when the Lane is `done` or
  `abandoned`. A Lane has one sample per day: a later write for the day replaces the earlier one,
  and each write is one `lane.sample_recorded` audit row carrying what it replaced.
- The Lane projection carries `samples`, the newest 60 days oldest first, only when `metric` is
  set (including on `brief=1`).
- `read_verdict` gains optional `measured: {value: number, n: int ≥ 0}` and `evidence` (1–200
  characters: a URL, a repo path or an ADR ref, never followed). A server MUST refuse, with
  `validation`, a `met` or `missed` verdict without `measured` on a Lane with a metric.
  `inconclusive` never needs it.
- A server derives nothing from samples: no status, and no verdict. A server behind this appendix
  sends none of these fields, and a reader treats the Lane as measuring nothing.
## A.27 Human authority: A2 approval descriptors (unreleased — ADR 662)

A closed list of high-authority acts (`HIGH_AUTHORITY_ACTS` in protocol code, pinned by test)
is accepted only with an A2 signature: a device key bound to the human, signing a canonical
approval descriptor the server built — actor, act, target, payload digest (sha256 of the
canonical payload), audience (the team), expiry, and a one-use nonce. The act is refused
without it once that human has an enrolled device key; an agent-kind credential is refused
for a listed act outright. A Bearer [REDACTED], a channel HMAC (A1) or a button tap stays
advisory for every listed act.

- `POST /teams/:slug/authority/descriptors` `{act, target, payload, actor?}` → `201
{descriptor}`. Building a descriptor grants nothing; the nonce is spent by one verified
  presentation.
- A listed act carries its proof as `approval: {key_id, nonce, signature}` (request body, a
  lane patch's `approval` field, or an act's `meta.approval`). Signatures are Ed25519 over
  the descriptor's canonical signing bytes.
- Refusals write `authority.refused` with a reason (`no_signature`, `assurance_too_low`,
  `descriptor_mismatch`, `expired`, `nonce_reused`, `key_revoked`, `agent_credential`); an
  approval writes `authority.approved` with the assurance, authenticator kind and key id.
  No signature, nonce or descriptor payload is ever logged.
