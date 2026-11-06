# This team: musterd's commerce layer

Read before the first piece of work in a session. Everything specific to musterd is here; the core
and the other references stay the same for any team that holds this role.

While a row below says "not recorded", it means not recorded yet, never "none". Ask nick, or make
your call and label it a proposal, then add what you learn here.

## Who decides

nick decides prices, plans, discounts, trial terms, the payment provider, merchant-of-record or not,
tax registration (with an adviser), legal wording (with a lawyer), and every live write. He is the
human for every ask in SKILL.md's hard rule 2 and its Never alone list. sloane (comms) owns the words
on the pricing page and in billing emails; this role owns that their numbers are true.

## What this role works on, and where its state lives

| Thing | Where | Check it with |
| --- | --- | --- |
| The pricing decision | [ADR 461](../../../../docs/decisions/461-pricing-and-business-model.md), accepted 2026-11-06, and its dated Consequences notes | Read it; it wins over this file |
| The current plan and ranges to test | [`2026-11-06-pricing-proposal.md`](../../../../docs/superpowers/specs/2026-11-06-pricing-proposal.md): Local, Cloud Free (two people, a one-time trial of about 10 agent-hours), Pro (per person from the third, plus agent-hours), Org | Its §6 "Decided" list |
| What Cloud costs to run | The same proposal, §2: about $0.019 per agent-hour running, about $0.45 a month per sleeping seat, about $90–150 a month fixed (list prices read 2026-11-06) | Re-read Fly and Neon pricing, and Cloud's own records once teams use it |
| The hosted product | musterd Cloud, [ADR 475](../../../../docs/decisions/475-cloud-hosted-teams-postgres.md) (Neon Postgres, stateless Fly machines); one Fly machine per hosted seat, [ADR 662](../../../../docs/decisions/662-one-machine-per-hosted-seat.md), [ADR 816](../../../../docs/decisions/816-hub-starts-stops-fly-seat-machines.md) | `deploy/cloud*/fly.toml` |
| The account billing hangs off | The musterd account on the console (`app.musterd.io`); unified sign-in design §3 | [`2026-11-06-unified-sign-in-design.md`](../../../../docs/superpowers/specs/2026-11-06-unified-sign-in-design.md) |
| Billing build | Cloud increment 7, lane `01M3TTZJGX` | The lane board |
| Payment provider account | Not recorded. No provider is chosen (2026-11-06) | Ask nick |
| Tax registrations | Not recorded. None known (2026-11-06) | Ask nick |

## The decisions that govern it

| Decision | Says |
| --- | --- |
| ADR 461 §1 | The team layer is free and uncapped on your own computers, needs no account, and never becomes paid |
| ADR 461 §2 + Consequences 2026-11-06 | Cloud: two people free; per person from the third; Cloud agent-hours past an included block; the musterd account is the billing home |
| ADR 461 §3 | Org features are paid and unlocked by the musterd account; no license key |
| ADR 461 §5 | Prices are ranges set with design partners; a paid seat is priced well under one hour a month of the agent compute it saves |
| [`PRIVACY.md`](../../../../PRIVACY.md) | Self-hosted musterd does not phone home and carries no usage analytics. Measure conversion from Cloud and billing records only |
| AGENTS.md hard rule 5 | Secrets are shown once and stored only as sha256 server-side or chmod-600 on clients. Applies to payment keys |
| AGENTS.md hard rule 6 | No new runtime dependency (a payment SDK included) without an ADR |
| [ADR 708](../../../../docs/decisions/708-role-toolkits-provisioning.md) | A role's toolkit is provisioned to its seat; the commerce toolkit is lane `01M6SBAVN6` |

## Customers bring their own model keys

Today musterd sells no model usage: Cloud agent-hours bill the machine, never tokens. A musterd native
harness and a musterd LLM are in progress; how their model compute is priced is this role's first
lane (goal `commerce-role`), using `usage-and-model-pricing.md`.

## Local rules, each from something that happened

| Date | What happened | The rule |
| --- | --- | --- |
| 2026-11-06 | ADR 461's two-human free tier was rejected in its revision, then restored by nick the same day as the shape of the allowance | Read ADR 461's newest dated Consequences note before quoting the free tier; the Decision text alone is not the current plan |
| 2026-11-06 | The pitch deck's "How do you make money?" answer still described "a subscription with caps" after the revision | Check `docs/demo/pitch/script.md` for drift whenever pricing changes, and tell comms |
