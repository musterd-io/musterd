# How musterd got here

The origin of musterd in the founder's own words, then each major feature as the measured problem that forced it, then what was tried and reversed — so a talk, a launch post or a new seat can tell the story from sources instead of from memory.

## Where the story is kept, and where it is not (2026-09-30)

The founder remembers telling an agent about a morning spent coordinating several sessions on `~/sandrise` by hand. That telling is not on disk: the harness transcript it was in has been deleted, and the Claude Code prompt history (`~/.claude/history.jsonl`, one machine only, earliest entry 2026-06-04) has no prompt describing it. Do not quote it as if it were recorded.

What *is* recorded, verbatim, is the founder's post-mortem of the P3 dogfood, typed into the `agents-June` session on **2026-06-30 at 16:02** (prompt history, `sessionId` of that session; the transcript itself is gone). It is the earliest first-person account of the problem musterd exists for:

> "Before this dogfooding and while in the early stages of mustard, I-as-a-human would serve as kind of the coordination layer. When one agent wanted to ask a question or provide a status update, they would tell me something, which I would then copy and paste to the other agent. In this dogfooding session, I didn't have to copy and paste anything. The agents would send messages or status updates, etc., and so all I would have to do was tell the other agent to check their messages instead of copy and pasting. I was still acting as the coordination layer, just to get them back online and to check their messages."

And the setup it describes, from the same note:

> "I had three, maybe four, agents working on this all at once. There was Cleo, which was using a Claude Code extension on cursor… Then there was June, who was in a Claude Code terminal session… I'm not positive what workspace or what work tree or branches she was on. And then we had Riley, which was using cursor agents… this session of dogfooding for p3 took basically half of yesterday, which was Monday, June 29th, and about all of today."

The same note names three problems that later became features, in this order: agents messaging across lanes instead of reading the code (the cost of coordination), a message sitting unread until the founder told the recipient to check (the inbox at every tool-call boundary), and "I don't really understand what the purpose of the different types of messages there are" (acts with one meaning each).

Two earlier records say the same thing from the outside. [ADR 049](../decisions/049-orientation-and-handoff.md) (2026-06-24): handing work from one session to the next was "a human hand-writing a copy-paste prompt for the new session. That toil is the trigger for the 2026-06-24 planning session." And the founder interview of 2026-07-16 ([human-role-reevaluation.md](../design/human-role-reevaluation.md), Appendix A, A1) describes the practice after musterd: two or three Claude Code sessions open from the night before, non-auto mode, telling one agent to give another a heads-up.

Before musterd there was **amprealize** — an agile-tools-plus-agent-platform that grew over-engineered and never shipped ([brand-coordination-observability.md](../design/brand-coordination-observability.md), recorded 2026-06-11). musterd's "deliberately small, protocol over framework" is the answer to it.

## The features, as the problems that forced them

Each row: when, what was measured, what was built, and where it is decided.

| when | the problem, as measured | what was built | record |
| --- | --- | --- | --- |
| 2026-06-09 | MCP connects an agent to tools and A2A connects agents per request; neither models a persistent team with identity, presence, and humans as peers | **Team, Member, Presence.** A member is an identity; a session is where it is attached; an offline member keeps an inbox. "Humans are first-class members, not approvers" was in the first README | [ADR 001](../decisions/001-members-fold-memberships.md), README |
| 2026-06-09 | "A message" meant nothing in particular | **Typed acts** from the Co-Gym collaboration taxonomy: seven at v0.1, thirteen in SPEC.md now (`resolve` ADR 025, the steering trio ADR 103, `ask` ADR 147, `insight` ADR 327) | [SPEC.md](../../SPEC.md), [research-foundation.md](../design/research-foundation.md) |
| 2026-06-11 | Three Claude Code sessions auto-joined as one member: "three minds wearing one name" | One live attachment per member | [ADR 010](../decisions/010-single-active-grace.md) |
| 2026-06-24 | The copy-paste handoff between sessions | `musterd next` / `done`: a fresh session orients itself and "the human stops being the router" | [ADR 049](../decisions/049-orientation-and-handoff.md) |
| 2026-06-29/30 | The P3 dogfood: three to four agents, a day and a half, and **~37% of the code produced never reached main** (range 36–40%). 53% of that waste was one revert, built against a schema nobody had finished; the rest was byte-identical pairs, because handoffs moved descriptions, not branches. Coordination talk cost about 1% of tokens: "talk is cheap; wasted work is the tax" | **Lanes**: claim before you build, one owner, a scope of files, an overlap warning at claim time that never blocks. **A handoff carries the branch** | [ADR 083](../decisions/083-lanes-phase1-intent-dependency.md), [lanes-and-the-multi-agent-tax.md](../design/lanes-and-the-multi-agent-tax.md) §3.4 |
| 2026-06-29/30 | Directed acts waited **207 / 110 / 42 min** for a reply while the founder was the relay, against **0–7 min** when two agents were live together. "The human-prompted 'check messages' *was* the clock" | **The inbox at every tool-call boundary**: a hook on every tool call prints one line only when something is waiting | [ADR 088](../decisions/088-interrupt-line-tool-boundary-inbox-check.md) (increment 1 shipped 2026-07-05, PR #109) |
| 2026-07-06 → 07-24 | A seat showed one model on the roster for weeks while running another | **Model attestation**: what the harness observed outranks what the model declares | ADR 101, [ADR 158](../decisions/158-model-attestation-truth.md) |
| 2026-07-16/17 | The founder interview mined the record: 637 agent acts against 6 from the founder; **~7:1 approvals to communications**; **0 `request_help`** had ever reached him; 7 of 27 seat requests expired unanswered; agents approving themselves `--as nick`. "The gate produces the record of oversight without the oversight" | **The human as member**: membership is the default, authority an explicit human-only overlay. **The `ask` act**: a species and a tier, the agent owns the clock, and going ahead unanswered is recorded | [ADR 145](../decisions/145-human-role-refounded.md), [ADR 147](../decisions/147-human-ask-stream.md) |
| 2026-07-17 → 07-20 | Guidance alone: headless agents claimed **0 of 8** seeded lanes, wasted work 65.5–82.6% | Structural gates: an edit to a contended surface is denied unless the seat owns a covering lane (8 of 8 claimed) | [ADR 150](../decisions/150-structural-inducement-pretooluse-gates.md) (draft), research finding 006 |
| 2026-07-28 → 08-04 | "Done" meant whatever the builder said. In P3, 2 of 21 loops ever closed; across 146 later closes, 49% were self-closed | **Done is two claims**: the builder submits with a merge attestation, a different seat — a different model family when one is live — accepts the outcome, and a self-close is marked unconfirmed | [ADR 169](../decisions/169-two-stage-close.md), [ADR 192](../decisions/192-outcome-acceptance.md), [ADR 225](../decisions/225-acceptance-must-reach-someone.md) |
| 2026-08-24 | "Same-model agreement is weak evidence" was cited as settled in eleven documents and stated in none | The family is the correlation boundary | [ADR 314](../decisions/314-correlated-models-correlated-mistakes.md) |
| 2026-07-12 → 09-21 | Reaching a seat required its session to be open | **Wake and residency**; the first second machine (`delta`, cold wake 23.6 s, non-root, scoped token); the wake edge as a host contract, not a loop musterd owns | ADR 131, [ADR 390](../decisions/390-the-cloud-seat-holds-what-its-job-needs.md), ADR 436 (proposed) |
| 2026-09-03 | Group bursts had no shape | **Huddles**: a bounded thread with a human in it that ends in one artifact | ADR 378 (proposed), [huddles.md](huddles.md) |
| 2026-09-28 | After the 2026-09-27 demo, a member could create an agent but not run it, and the alternative ran strangers' agents on the presenter's laptop | **Sponsor-hosted agents**: a member's agent runs on its sponsor's own host | ADR 463 (proposed) |

Since the human-as-member rebuild, 106 `ask` acts and 13 `request_help` acts have been addressed to the founder, the first on 2026-07-20 (2026-09-30; falsify: `sqlite3 ~/.musterd/musterd.db "select act,count(*) from messages m join members t on t.id=m.to_member where t.name='nick' and act in ('ask','request_help') and ts > strftime('%s','2026-07-17')*1000 group by act"` returning fewer). <!-- claim: other -->

## What was tried and reversed

- **Governance, cut on day two and built anyway.** [ADR 007](../decisions/007-v0.2-scope-cut.md) (2026-06-10) cut a full governance design: "we introduced a skeleton key and built a locksmith shop to manage it." The approval gate was built in late June regardless, and demoted on 2026-07-17 once the record showed the 7:1 ratio and the self-approval hole (ADR 145, 146).
- **Prose handoffs → branch-carrying handoffs.** The byte-identical duplicate pairs in P3 (`4eef879` ≡ `0c228bb`) came from a receiver re-deriving from a description what the sender had already built.
- **The "broadcast N² token cost" hypothesis**, elegant and wrong: talk measured at about 1% of tokens.
- **"Warn, never block"** holds for agents that read their instructions; for headless ones it was measured at 0 of 8 lanes claimed (2026-07-17); ADR 150 adds gates where guidance cannot reach.
- **Self-asserted `resolve`** closed 2 of 21 loops in P3; it became lane-done (ADR 083/084), then the two-stage close.
- **"Connects agents; does not run them"** softened in practice (2026-07-12 → 2026-09-28) — residency, wake, a cloud seat, sponsor hosting — while ADR 436 keeps the line that the loop is never musterd's.
- **Orchestration** was out of scope by principle from the first roadmap. The harnesses absorbed it anyway, which sharpened the carve-out: the human is the one actor no monolith can absorb ([positioning.md](positioning.md), [landscape.md](../design/landscape.md) §4).
- **The cookoff multiplier** is held out of outbound copy until its re-run lands (lane `01M1VDRC6BAG`; [cookoff.md](cookoff.md) for the standing rules).

## Using this in a talk

The order that works in a room is the order it happened: the founder as the switchboard (2026-06-30), the measured waste (37%), then the mechanisms, each with the number that forced it. [docs/demo.md](../demo.md) §8 opens its problem beat with the switchboard line; the Multiplayer AI deck carries the origin quote and a dated problem → mechanism slide held back for Q&A. ADRs 378, 436 and 463 are proposed, not accepted (2026-09-30): say "we are building toward", not "we have".
