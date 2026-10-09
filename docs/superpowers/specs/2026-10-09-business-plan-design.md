# Business plan — brainstorm state (draft)

**Status:** draft, in progress. Started 2026-10-09 by alfie with nick; lane `01M4F48ZEE`. This is the
brainstorm's working state, not a plan. Nothing here is a commercial decision — those are nick's.
Stale on purpose: nick asked for a **fresh start**. [ADR 461](../../decisions/461-pricing-and-business-model.md)
and [`traction-plan.md`](../../design/traction-plan.md) (sloane, 2026-09-16) are treated as dated claims
to check, not as the base.

## What nick said (2026-10-09)

- **What musterd is:** helps you work together with your agents as a team. Agnostic of harness, agent
  or model. Persistent teams reduce wasted work and conflicts across projects, and keep team and
  project context with you wherever you go. For dev teams working alongside agents; for organizations
  working with org- and team-level context to expand capacity, in dev work and knowledge work.
- **First customer:** product and dev teams. Solo builders feed in; organizations and knowledge work are
  the expansion path.
- **12-month goal:** traction first, and funding is also needed.
- **Evidence today:** no one outside the team has used musterd. It has only been seen in demos.
- **Capacity:** nick, full time, solo.
- **Runway:** about 3 months of personal funding (said "a couple", then corrected to 3).
- **Spend:** about $500 a month for one person — Claude, OpenAI, Grok and Cursor subscriptions, a couple
  of domains, fly.io, ubicloud, cloudflare, GitHub. It does **not** include future user scale or
  musterd Cloud.
- **Open to:** accelerators, incubators and cohorts; real funding; paid design partners; hiring if needed.

## What follows from it

With zero outside users, a revenue projection would be invention. The plan is a staged set of bets, each
buying the evidence the next needs: first outside users, then retention, then willingness to pay, then
funding. Costs can be modeled honestly from today; revenue cannot yet.

Fundraising and traction both outlast 3 months of runway, so the plan needs a bridge.

## Chosen approach: C — accelerator applications and paid design partners on one calendar

- **A. Accelerator-led.** Fastest route to cash and credits. Weakness: zero outside users makes the
  applications thin, and decision dates belong to the programs.
- **B. Design-partner-led.** Produces the evidence. Weakness: at an illustrative $200–500 a month each,
  three partners are $600–1,500 a month — proof of demand, not a living.
- **C (chosen).** The design partners are the traction evidence in the applications, and each deadline
  dates an install. The first go/no-go was a week-6 check; since the first-run gaps are already known it
  is now an observable 10-minute install test (see "First 10 minutes and retention").

## First 10 minutes and retention (nick, 2026-10-09)

- **First 10 minutes:** a new team wants to understand how musterd or a musterd agent helps, how to get
  started, and then either to bring an existing project in as work items or to plan new work.
- **Why they come back:** all work in one place; agents pick work up easily; humans see how work is
  progressing and stay in the loop.

**Gaps nick named (checked read-only against the repo, not tested as a new user):**

1. No path imports work from outside musterd. The README quickstart ends at "agent online", not at "your work
   is on a board".
2. It is not intuitive why, when, or for what benefit to add agents to the team.
3. No guided tour of what musterd is, what value it has, and how to use it.

**Consequence for approach C:** the install experience is a known problem, so the week-6 go/no-go is
replaced by an observable check: a stranger goes from install to their own work on the board in 10 minutes,
with nick watching but not helping. The first design partners get concierge onboarding by hand; every
repeated step is a candidate for the product to do itself. Costs nick's time, with about 25 days to the YC
deadline.

### When to add an agent

nick's own reasons: capacity to build, research or brainstorm something new; a different model, to try it
or get another perspective; a specific role or domain the team lacks. He rarely adds a seat to pick up
existing work. Hypotheses about new teams (untested): an independent reviewer on another model; a second
tool joining; a human teammate bringing their own agent; a parallel seat on a backlog slice.

The likely lead reason is **connect the agents you already have**, not "add a seat": see the founders'
setups below. This is a power user's view plus guesses; hold it until a design partner confirms it.

## Design partners (nick, 2026-10-09)

- **Candidates:** nick's wife, and a few founders he met recently (not cold, but new relationships). Aim for
  at least two who are not friends or family, so the evidence holds in an application.
- **Founders' setups:** Claude Code, Cursor, Codex, opencode, Grok, plus personal agents (muse, instinct,
  hermes, dots, usually one per person). One to three repos; many dev agents each.
- **Tested in musterd:** the five coding harnesses are first-class in the code. nick has **never tried**
  the personal agents (muse, instinct, hermes, dots) in musterd; muse the model via opencode is covered by
  opencode. Do not promise personal-agent support in an application until one has joined a team.

## Verified 2026-10-09 (web search; re-check before relying)

- **YC W27:** on-time deadline **Nov 2, 2026, 8pm PT**; decision about Dec 11; batch Jan–Mar 2027, SF.
  Several sources agree; one says checked against YC's page on Aug 29.
  [ycroaster](https://www.ycroaster.com/tools/yc-application-deadline),
  [roundfunded](https://www.roundfunded.com/en/blogs/yc-batches-2026-dates-acceptance-rate),
  [YC apply](https://ycombinator.com/apply).
- **a16z speedrun:** SR007 ended (Demo Day Oct 6). SR008 is about late Jan–Apr 2027. The Oct 12–Nov 1
  priority window in the traction plan is third-party sourced only — unconfirmed. Check
  speedrun.a16z.com/apply. [a16z](https://a16z.com/applications-for-a16z-speedrun-sr007-are-now-open/),
  [FAQ](https://speedrun.a16z.com/faq).
- **PearX:** listed Oct 4 deadline has passed.
- **Open Accelerator Residency** (Boston, free, no equity): lists Oct 25, page inconsistent.
- The traction plan's §12 table (Conviction Embed, Neo, SPC, Sequoia Arc, OpenAI Grove, AI Grant, HF0,
  Mozilla Builders, Google for Startups, Claude for Startups, Techstars/Antler/Alchemist/500) is dated
  2026-09-16 and **not yet re-verified**.

## Plan structure (nothing written yet)

1. Who the product and dev teams are, and why they would switch.
2. The 90-day growth and design-partner plan.
3. Open-source strategy and monetization.
4. The financial model: costs, runway, scenarios — every assumption labeled as one.
5. Needs: infrastructure, people, credits.

## Open questions

- **Next question for nick:** what do you want to be able to show on Nov 2 (YC deadline), given about 25
  days solo and the three first-run gaps above: how is the time split between building the first-run fixes
  and recruiting partners?
- What in `traction-plan.md` is stale, and what has sloane learned since 2026-09-16? Asked of sloane on
  2026-10-09; no reply recorded yet.
- Cost-to-serve for musterd Cloud (hosting, Postgres, relay per team) — no figure exists.

## Not here

Pricing numbers, revenue forecasts and hiring decisions. Those wait for evidence and for nick.
