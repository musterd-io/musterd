# Spend controls — design

Lane `01M4RSW1D09R89RVSARG8PKXND`. Spec lane for the seed `01M4GPX7SB9PFRRX9GPX00D502`
("Admin controls", nick via Slack): at an AI agent talk a speaker said you always need admin
controls, but they now trust agents with a lot more, including access to their money.
Steer (nick, 2026-10-12): **caps first** — the spec leads with a team budget plus enforcement
on measured cost; approvals for costly acts is a named follow-up, not this lane.

## Outcome

An admin sets one number — the team's spend cap in USD — and past it, the team denies new
agent actuation: once observed priced model cost reaches the rolling cap, agents stop getting
new spend and humans steer. That is the bound, stated with its limits: cost reported late
can overshoot before the total catches up, and unpriced or external spend is invisible to
it. Not a dashboard, not an alert — a bound on what the team can see, and the trust the
speaker described becomes something an admin can grant and the team can read.

## Decisions (nick, 2026-10-12, via the seed steer)

1. **Caps before approvals.** A cap binds aggregate trust with one number; approvals add
   per-act friction and cap no aggregate. Approvals for costly acts is a follow-up lane.
2. **Bound measured cost, not money.** Money moves outside musterd on the agent's own
   keys and tools, which musterd cannot see. What the team bounds is the wake/model cost it
   already measures (`cost_usd` on wake reports). The spec — and every surface that shows
   the cap — says this, so nobody reads "spend cap" as payment interception.
3. **Reuse gate-deny, not halt.** A breach denies new spend the way `merges_paused` denies
   merges at `/holds/check` today: a `denied_held`-style outcome with a shapes-only audit
   row. Halt is per-seat revocation with a named human reason and a resume; a team over
   budget is not a misbehaving seat, so halt is the wrong granularity.
4. **Warn first, then deny.** The existing `over_budget` flag stays as the warning layer;
   enforcement engages past the cap — the protocol source already names this direction
   ("spend control stays cooldown/caps/watchdog"). Humans pass while agents are denied,
   as `merges_paused` does — an over-budget team can still be steered by its people.

## The cap

- **One policy key: `spend_cap_usd`.** It slots beside `sponsored_agent_cap` in team policy:
  a sparse override, defaults on read, audited `policy.change` in one tx. Unset means
  unbounded, which preserves today's behavior exactly — no team pays for a default it never
  chose. Admin-set through the same `POST /policy` path as every other cap.
- **Measured against the number the report already computes.** The denominator is the 7-day
  team total `cost_usd_total` from `deriveWakeMetrics` — the same sum `report` shows, over
  the same fixed window. One definition of spend, read in two places. No new accounting.
- **Priced cost only.** Leases with no reported cost (`unpriced_sessions`) are excluded from
  the total today, deliberately. The cap enforces on reported cost and says so: what isn't
  priced can't be bounded. Closing the unpriced floor is its own lane, not this one.
- **Breach behavior.** While the 7-day total is at or above the cap: agent actuation that
  would spend is denied with a held-style outcome and audit row; humans pass; the team sees
  a notice naming the cap, the total, and the window. Recovery is automatic — the rolling
  window falls back under the cap on its own, so unlike halt there is nothing to resume.
  No manual reset, no per-seat reason.

## Failure handling

- **Cap unset:** everything behaves as today. The enforcement path must be dead code, not a
  zero-valued cap (zero would deny all spend on first read).
- **Cost arrives late:** harness-attested cost lands at run exit, so a burst of wakes can
  overshoot before the total catches up. The spec accepts bounded overshoot and says so;
  exactness would need pre-authorization per wake, which is approvals, the follow-up.
- **Unpriced burst:** a team spending entirely off-report burns free under the cap. Known
  gap, stated on the surface that shows the cap — the alternative is blocking unpriced
  harnesses, which is a product decision, not a default.
- **Never throws the pull loop:** enforcement reads must fail open to measuring (log and
  keep the inbox path), the way `deliverFoldedLive` fails open to the inbox.

## Verify first (checked 2026-10-12, read-only)

- Cost source is audit rows (`residency.woke` / `residency.wake_cost` …), summed per lease
  with supplementary-cost-wins dedupe — `packages/server/src/store/insights.ts:675-836`.
- Team total and per-seat flag already derived: `cost_usd_total`, `WakeSeatCost.budget_usd`,
  `over_budget` ("FLAGS — nothing was stopped") — `packages/protocol/src/insights.ts:282-294`.
- Policy mechanics: sparse override + read-time defaults + audited replace
  (`setPolicy` / `applyPolicyChange`) — `packages/server/src/store/teams.ts:638-687`;
  numeric-cap precedent `sponsored_agent_cap` 1..100 default 3
  (`packages/protocol/src/credentials.ts:219-224`).
- Deny precedent: `merges_paused` re-tested server-side at `/holds/check`, denies
  non-humans, humans pass — `packages/server/src/transport/http.ts:3730-3764`.
  (`autorefresh_paused` tick-side enforcement was NOT found on any tick path — do not
  cite it as live.)
- ADR 461 is proposed, per-human Cloud pricing, agents never counted, usage-based pricing
  explicitly rejected on privacy grounds (`docs/decisions/461-pricing-and-business-model.md:141-143`).
  This cap meters operational cost, not acts for billing — the spec must keep that line
  visible or it reopens the rejected question by accident.

## Delivery order

1. **This lane** (`01M4RSW1D09R89RVSARG8PKXND`): the spec — this document.
2. Increment 1 (`01M4S0WNZ5CM73HHKV4VAMTAQ3`): `spend_cap_usd` policy key (read path,
   defaults, validation range), report display (cap beside the team total, warn state),
   no enforcement. Proves the number is real before anything denies on it.
   Range, report fields, and the display-only bound: [ADR 602](../../decisions/602-spend-cap-display.md).
3. Increment 2 (`01M4SB4BZBQDHWFWH4RXBNR7CQ`, depends on increment 1): gate enforcement —
   deny agent actuation at/over cap, humans pass, notice surface, audit rows. The bound.
   [ADR 611](../../decisions/611-spend-cap-holds-wakes.md).
4. Named follow-up (`01M4SB4CJPTCSCYK3X8KGY2W33`, not this arc): approvals for costly acts
   above a threshold.
5. Named follow-up (`01M4SB4D7RTW21W62NKCPDV816`): the unpriced floor (bound what isn't
   priced, or decide to block unpriced harnesses explicitly).

## Testing

- Increment 1: policy round-trip (set/unset/default), report shows cap and warn state,
  unset behaves as today byte-for-byte.
- Increment 2: at-cap denies agent wake/actuation with the held outcome + audit row;
  humans pass; recovery when the window rolls under; late-arriving cost overshoots
  bounded and asserted, not exact; enforcement-read failure fails open to measuring.
- The 317 ms fold→socket number (latency step 2b) is a different axis and stays out.

## Out of scope

- Intercepting or approving external payments, purchases, transfers. musterd sees
  measured model cost; everything else is outside the boundary sentence.
- Per-seat caps beyond the existing `budget_usd` flag. The team total is the new
  control; seats keep theirs.
- Usage-based billing or anything that prices acts. ADR 461 rejected it; this spec
  does not relitigate it.
- Blocking unpriced harnesses, auto-expiry of the cap, per-goal or per-lane budgets.
- Sandbox runtime, schedule enforcement, custom RBAC, multi-admin delegation — the
  standing out-of-scope list.
