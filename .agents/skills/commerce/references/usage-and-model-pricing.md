# Usage and model pricing: seats, metered compute, credits, keys

Open for any pricing model, credit design, model-compute price, cap or margin question. **You model
and advise; the human decides the price** (SKILL.md, Charter). Facts below were read on the
companies' own pages on 2026-11-06 (`research.md` §2) unless marked; pricing pages change monthly, so
re-read a row before it is quoted anywhere.

## The common shape in this market

Across fifteen AI and developer-tool pricing pages read on 2026-11-06, the common design is: a seat or
plan fee, an allowance in currency (often equal to the plan price), overage at or near the model
provider's list price, and a cap the customer sets. Examples: GitHub Copilot credits at $0.01 each
with alerts at 75/90/100%; Vercel Pro with a $200 default on-demand budget and optional auto-pause;
Supabase Pro with a spend cap on by default; Warp's plan as "$20 of usage at API rates".

Margin comes from the subscription, unused allowance, add-ons, or a **published** markup: Zed list
+10%, Warp pay-as-you-go 20% above API rates, OpenRouter a 5.5–8% fee on credit purchases. Vercel's
AI Gateway and Replit charge list price with no markup. Nobody in the sample hides a token markup.

## Choosing a value metric

The value metric is what the customer pays more for as they get more value. Pick it first; the
model follows from it (marketingskills `pricing`, MIT, adapted; `PROVENANCE.md`).

- **Seats** are predictable and match "a team formed". They undercharge heavy compute.
- **Metered compute** matches cost. It is unpredictable for the buyer unless capped and alerted.
- **Hybrid** (seats plus metered compute) is now common: 37% of about 230 B2B companies surveyed by
  Growth Unhinged in 2026, against 25% a year earlier in the same survey. Its 2025 edition reported a
  different baseline; do not chain the two years.
- **Credits** abstract several meters into one balance. They hide the unit; if used, one credit is one
  published price.

## Pricing model compute the team runs itself

When the team sells model inference it runs (its own model or harness), choose one of:

| Option | Who it suits | Watch |
| --- | --- | --- |
| Pass-through at list price, no markup | Trust first; margin from plans and add-ons | Say "list price, no markup" |
| Published markup on list price | Simple, honest margin | Publish the percentage |
| A fee on credit purchases | Prepaid buyers | Auto top-up off by default |
| An allowance inside the plan, then overage | Predictable bills | State what the allowance buys, in currency or tokens |

Reported AI gross margins sit near 50% (Growth Unhinged 2026 median *target*; ICONIQ 45% in 2025,
from secondary coverage), well below the 70–80% of classic software. Do not price inference on
software margins. A margin below about 50% needs a stated reason.

## Bring-your-own keys

- When the customer brings model keys, their model spend is outside your meters and budgets. Say so
  in the product and point to the provider's own spending limits.
- Never fall back silently from the customer's key to compute you bill for. Vercel documents that a
  failed BYOK request falls back to its own key and is charged to credits; if you do anything like
  it, it is opt-in and shown.

## Keeping bills predictable

Mechanisms in use, each from the product's own page: caps on by default (Supabase); a default budget
with alerts (Vercel); alerts at 75/90/100% (Copilot); a hard stop that says when access resumes
(Anthropic's 429 at a tier cap); falling back to an included model instead of billing (Copilot);
asking before a paid action when its cost is unbounded (Replit).

## The backlash record

- **Cursor, June–July 2025:** a change in what the allowance bought, plus "unlimited" that applied
  only to one mode. Cursor apologised and refunded unexpected usage from June 16 to July 4
  ([Cursor](https://cursor.com/blog/june-2025-pricing), verified). The lesson: say what a unit buys,
  never say "unlimited" over a throttle, and give notice before the unit changes.
- **Replit, 2025:** effort-based agent pricing with no per-task estimate; users reported bills of
  about $1,000 a week against $180–200 a month before (The Register, 2025-09-18; secondary, user
  reports).

## Checkable rules

1. Every metered line has a cap or budget at signup, alerts at 75/90/100%, and a hard stop unless the
   customer opts in to overage.
2. Allowances are shown in currency or hours; one unit is one published price.
3. "Unlimited" is never used over a fallback, throttle or fair-use limit.
4. Any markup on resold inference is published as a number, or the page says "list price, no markup".
5. Customer-key spend is labelled as outside the product's budgets; no silent fallback to billed
   compute.
6. Every compute price is checked against its cost, with the arithmetic shown; margin under about 50%
   carries a stated reason.
7. A paid action with an unbounded cost asks first, and the meter's lag is stated.
8. A change in what a unit or allowance buys is a price change (SKILL.md, hard rule 8).

## Do not adopt

Opaque effort units with no estimate; "unlimited" over a throttle; auto top-up or overage on by
default; a hidden markup; software-margin assumptions applied to inference; chained year-on-year
survey figures from editions that disagree.
