# Pricing page and lifecycle: limits, upgrades, price changes, discounts, conversion

Open for a pricing page, a plan or seat change flow, a limit's behaviour, a price change, a discount
or any conversion figure. The page's words belong to the comms role and the human; you own that every
number and limit on it is true and matches what the provider will charge. Facts below were read on the
companies' own pages on 2026-11-06 (`research.md` §4) unless marked.

## What a pricing page states

- Of eight developer-tool pricing pages read (Supabase, Vercel, Linear, Sentry, Tailscale, GitLab,
  PostHog, Plausible), none states what happens at every limit. The free tier's cap behaviour is the
  one most often missing (Supabase, Linear, GitLab).
- Good patterns: Vercel's $200 default on-demand budget with alerts and optional auto-pause; Supabase
  Pro's spend cap on by default; PostHog's alerts at 80% and 100% of a billing limit
  ([PostHog limits](https://posthog.com/docs/billing/limits-alerts)).
- Show the monthly price. Linear and GitLab show only per-seat prices billed yearly, which hides what a
  small team pays to start. Sentry shows both, about 10% off for yearly.
- A page written for agents as well as people (plain text, every limit in words, no image-only
  tables) is now part of a pricing-page review (marketingskills `pricing`, MIT; the lens is credited
  there to Kyle Poyar / Growth Unhinged; `PROVENANCE.md`).

## Behaviour at a limit

Three behaviours are in use, and the page must say which applies:

1. **Hard stop:** PostHog's billing limit (data over it "is lost forever"), Sentry's quota, Vercel Hobby.
2. **Cap on by default, opt out to pay as you go:** Supabase Pro, Vercel's default budget.
3. **Soft limit, trued up on the next invoice:** Tailscale seats.

Notify the billing owner before the limit (80% and 100%) and say, at the stop, what stopped and when it
resumes.

## Upgrades and downgrades

- Preview before every change: the provider's preview invoice shows the prorated amount; apply the
  change with the same proration date (`billing.md`).
- Seats can be credited when a member is inactive: Slack credits a seat after a member is inactive for
  more than 28 days ([Slack fair billing](https://slack.com/help/articles/218915077)). Worth proposing;
  the human decides.

## Price changes for existing customers

The human decides every price change. When one is decided:

- **Notice:** PostHog's handbook sets about 60 days, a limited transition (about three months for
  self-serve) and "nobody gets legacy pricing forever"; it calls a free tier "easy to increase ... very
  painful to decrease" ([PostHog handbook](https://posthog.com/handbook/engineering/feature-pricing.md)).
- **Transition:** GitLab's 2023 rise from $19 to $29 held existing customers at $24 for a year
  (from the primary post as quoted in search results).
- **What goes wrong:** Docker announced the end of its free team plan in March 2023, apologised two days
  later and reversed it within ten days
  ([Docker](https://www.docker.com/blog/we-apologize-we-did-a-terrible-job-announcing-the-end-of-docker-free-teams/)).
  Unity's per-install fee (2023) and Heroku's free-tier removal (2022) are the other cases, from press
  reports.

## Discounts

Publish eligibility as text. Examples in use: Sentry's open-source sponsorship (Business features, no
term limit, an OSI-approved licence); GitLab's free Ultimate for qualifying open-source projects,
startups and education; PostHog's startup credits; Linear's free Business plan for startups under 50
people through partners; about 10% off for yearly prepay (Sentry). Which discounts exist is the human's
call.

## Conversion figures

- Growth Unhinged's March 2026 survey (n = 200 B2B products): median free-to-paid 8%, and 30% for
  trials that require a card; the article does not define the denominator
  ([Growth Unhinged](https://www.growthunhinged.com/p/how-to-improve-free-to-paid-conversion)). Cite it
  with that caveat or not at all.
- OpenView's widely quoted medians are second-hand now (its benchmark page returns 404); do not cite
  without the report itself. No open-source-to-paid benchmark with a stated denominator was found.
- Every conversion figure names its numerator, denominator and window. Under about forty, report "k of
  n", never a percent.

## Measuring without product analytics

When a product promises no usage analytics, measure only where the buyer knowingly touches your
systems: the hosted service's own records (team created, the member that crosses the paid threshold,
time to a paid invoice, seats per invoice, metered hours), the billing provider's records
(subscriptions, cancellations and their reasons, failed payments), and public aggregates (package
downloads, repository stars). Local-to-hosted conversion per person cannot be measured; report cohort
ratios labelled as correlation. Adding telemetry to measure it breaks the promise.

## Checkable rules

1. Every limit on the page states its number, unit, period and behaviour at the limit.
2. Caps or budgets are on by default for new paid customers; turning them off is explicit.
3. The billing owner is notified at 80% and 100% of any cap or free allowance, before any over-limit
   charge.
4. Every plan or seat change shows the prorated amount first.
5. A decided price increase carries the notice and transition the human set, and says up front that
   legacy pricing ends.
6. A free allowance is never lowered for existing users without the human's decision and a long
   runway.
7. Every conversion figure names numerator, denominator and window.
8. Discount eligibility is published as text.
9. The monthly price is shown wherever a yearly price is.

## Do not adopt

Product telemetry to measure conversion; silent data drops at a cap; yearly-only per-seat prices with
no monthly price; overage marked "see pricing"; per-install or runtime fees on self-hosted use;
untraceable churn statistics.
