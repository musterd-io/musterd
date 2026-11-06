# Pricing proposal — what musterd Cloud costs us, how it is packaged, and what to test

- Date: 2026-11-06
- Lane: `01M6SA1B52A6J3B8FJKR04SJ0M`, goal `launch`
- Written by: sloane (comms), with nick. **Advisory.** Every price here is a range to test with design
  partners. None is set. The pricing decision is nick's
  ([ADR 461](../../decisions/461-pricing-and-business-model.md), accepted 2026-11-06).
- Builds on: ADR 461 (the shape), the business plan brainstorm
  ([`2026-10-09-business-plan-design.md`](./2026-10-09-business-plan-design.md)), the pitch ledger's
  comparables ([`docs/demo/pitch/script.md`](../../demo/pitch/script.md), Q&A ledger).

## 1. What nick decided today

nick, 2026-11-06, in session:

1. **Two people on one team are free.** Two humans on the same team "is what really makes musterd
   interesting". Billing starts **per person from the third**.
2. **Plus Cloud agent-hours**, metered: the hours an agent runs on a musterd Cloud machine.
3. **Bring your own model keys.** musterd sells no model usage for now. A musterd native harness and a
   musterd LLM are in progress. When they ship, model compute that musterd runs becomes a revenue line
   of its own, priced then.
4. **No deadline.** The aim is steady progress.

This is ADR 461 §2's allowance made concrete: "measured in people on the team, agent hours in musterd
Cloud, or both". It is recorded there as a dated Consequences note. The Decision is unchanged.

## 2. What musterd Cloud costs us to run

The floor under every price. List prices read 2026-11-06; machine sizes from our own deploy configs.

| Cost | Driver | Our config | List price | Per unit |
| --- | --- | --- | --- | --- |
| **A Cloud agent, running** | One Fly machine per hosted seat ([ADR 662](../../decisions/662-one-machine-per-hosted-seat.md)), stopped when idle ([ADR 816](../../decisions/816-hub-starts-stops-fly-seat-machines.md)) | `shared-cpu-2x`, 2 GB (`deploy/cloud-agent/fly.toml`) | $13.39 a month running full time, billed by the second ([Fly](https://docs.fly.io/about/pricing), `iad`) | **≈ $0.019 per agent-hour** |
| **A Cloud agent, asleep** | Its 3 GB volume is billed while stopped | `initial_size = "3gb"` | $0.15 per GB-month | **≈ $0.45 per seat a month** |
| **The team servers** | Shared by every hosted team ([ADR 475](../../decisions/475-cloud-hosted-teams-postgres.md): N ≥ 2 stateless machines) | `performance-1x`, 2 GB (`deploy/cloud/fly.toml`) | $33.00 a month each | **≈ $66 a month**, fixed |
| **The console** | One for every account | `shared-cpu-1x`, 512 MB (`deploy/console/fly.toml`) | $3.69 a month | **≈ $4 a month**, fixed |
| **Postgres** | One Neon database, every team (ADR 475) | Neon Launch | $0.106 per CU-hour; $0.35 per GB-month storage ([Neon](https://neon.com/pricing)) | ≈ $19 a month at 0.25 CU always on; ≈ $76 at 1 CU (illustrations; nothing measured yet) |
| **Drawer files** | Cloud teams only ([Drawer brief](./2026-11-06-drawer-brief.md)) | R2 | ≈ $0.015 per GB-month, 10 GB free | ≈ $0.15 a team a month at 10 GB |
| **Outbound data** | North America and Europe | — | $0.02 per GB (Fly) | small for text; grows with Drawer sharing |
| **Model compute** | — | Bring your own keys | **$0 to us** | — |

What follows from the table:

- **The fixed floor is about $90–150 a month** (team servers, console, Postgres at the two
  illustrations) before a single team signs up. It is the same at one team or a hundred, until load says
  otherwise. The §8.1 load test that sized `performance-1x` is where that answer lives.
- **A person costs us almost nothing at the margin.** A team's rows in a shared Postgres are cents. A
  per-person price is nearly all margin once the floor is covered.
- **A Cloud agent-hour is the one cost that scales with use**, at about two cents an hour plus about
  45 cents a month per sleeping seat. Model compute stays off our books while keys are the customer's.
- Not yet measured: Postgres compute per active team, and the real hours a Cloud agent runs in a month.
  Both are read from Cloud's own records once teams use it (ADR 461, Observability: aggregated, hosted
  side only).

## 3. Packaging

| Plan | Who | What it includes | What it costs |
| --- | --- | --- | --- |
| **Local** | Anyone, on their own computers | Everything in the team layer: members, agents, lanes, `/live`, the Drawer, federation. No account | **Free, uncapped, for good** (ADR 461 §1) |
| **Cloud Free** | A team of up to two people on musterd Cloud | A hosted team; agents connected from your own computers, unlimited and uncounted; **a one-time trial block of Cloud agent-hours** | **Free** |
| **Pro** | A team that adds a third person | Everything in Cloud Free; **per person from the third**; a larger included block of agent-hours per paid person; Drawer storage included | **Per person per month**, plus agent-hours past the included block |
| **Org** | Several teams, or a governance buyer | SSO, signed audit export, retention policy, multi-team admin, support (ADR 461 §3), on Cloud or your own computers | Per person, at a premium, usually yearly |

Rules that keep the bill predictable (the pricing checklist in
`.agents/skills/comms/references/positioning-and-gtm.md`):

- **Agents connected from your own computers never count.** Only agents musterd Cloud runs use
  agent-hours. That keeps ADR 461's promise not to tax the thing the product multiplies.
- **Included hours, then a visible meter.** Each plan includes a block of hours. Past it, the rate is
  shown before it is charged. A team can set a cap that stops Cloud agents at its limit.
- **Two people stay free whatever else changes.** That is the line nick drew, and the free local line in
  ADR 461 §1 holds beside it.

## 4. Price ranges to test (proposals for design partners)

Anchors, each from the pitch ledger (read 2026-10-19/20; re-read before quoting): Band $17.99 a month per
user (single user); Party $20 or $200 a month flat with "no per-seat fees"; Conductor $50 a month Pro,
$60 per user per month for Teams.

| Item | Range to test | Why there |
| --- | --- | --- |
| **Pro, per person from the third** | **$15–25 a month**, $20 as the first number said aloud | Inside the band the neighbours set for one person, below Conductor's team seat. Five paid people at $20 cover the fixed floor (§2) |
| **Trial agent-hours, Cloud Free** | **About 10 hours, once** per team | Enough to see an agent keep working while every laptop is closed, which is what the hours pay for. At ≈ $0.019 an hour it costs us about 20 cents a team, and nothing after |
| **Included agent-hours, per paid person** | **50–100 hours a month** | Under $2 of our cost per person |
| **Agent-hours past the block** | **$0.05–0.10 an hour** | Several times our ≈ $0.019 cost, so idle-machine and support overhead are covered; still small next to the model spend the customer already pays with their own keys |
| **Org** | Quoted per deal; test **$40–60 per person** a month on a yearly contract | Governance buyers compare with seats in their existing tools; no ledger row yet, so this is the least certain line |

**ADR 461 §5's price rule** (a paid seat is priced well under one hour a month of the agent compute it
saves) needs one more number before it can be checked: what an hour of agent compute costs a team on its
own keys. That figure gets a ledger row before any price page cites the rule.

## 5. Finding out what people will pay

The business plan's partner guide holds the money question until after a partner has used musterd
(question 7). This adds the questions that turn answers into a range, after the Van Westendorp price
sensitivity method. Ask them as written, after the session, and record the words and the name
(`docs/design/traction-log.tsv`, kind `quote`, with consent):

1. For a hosted team for your whole team, at what price per person a month would it be **so cheap** you
   would doubt it is any good?
2. At what price would it be **a bargain**: a good buy for what you get?
3. At what price would it start to feel **expensive**, though you would still think about it?
4. At what price would it be **too expensive** to consider?
5. If Cloud agents were billed by the hour on top, past an included block, what would make that bill
   feel fair?
6. Who signs for this at your company, and does a yearly plan help or hurt?

Five to ten answers make a range worth acting on. Under about forty, report them as "k of n", never as
a percent (comms hard rule 4).

## 6. Decided, and what is still open

Decided by nick, 2026-11-06:

1. **Test the ranges in §4 as written.**
2. **Cloud Free gets a one-time trial block of agent-hours** of about 10, used once. Cloud
   Free without hours still holds a hosted team with nothing to run, members on any network, agents
   connected from their own computers (unlimited and uncounted), the board, asks, `/live`, the record
   and the Drawer. The hours buy agents that keep working while every laptop is closed; the trial lets
   a team feel that once.
3. **The paid plan is called Pro.** The ladder is Local / Cloud Free / Pro / Org. "Team" was ruled out
   because it is the glossary's word for the group itself.
4. **"musterd Cloud" keeps its name** for now (sloane's advice; nick did not move it).
5. **A person is billed once per account** (question `01M6SCHH9K`). Someone who is the third or later
   member on several paid teams pays one Pro seat, counted on their musterd account across all their
   paid teams. A team's member count decides only whether it has reached its third person.

Still open:

1. When musterd's own harness and LLM ship: whether model compute is sold as credits, per token, or
   inside the plan. This is the first lane for the commerce role (goal `commerce-role`).

## 7. Next steps

1. nick reads §4 and §6.
2. The willingness-to-pay questions go into the partner guide in the business plan brainstorm.
3. A Cloud cost readout once teams use it: Postgres compute per active team, and agent-hours per seat a
   month. Its figures replace §2's illustrations.
4. The first price page waits for §5's answers, and states ADR 461 §5's rule beside them.
