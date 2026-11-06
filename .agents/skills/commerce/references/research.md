# Research report: the commerce craft

Step 2 of `building-a-role-skill`, run 2026-11-06 for lane `01M6SBAS9KEBVKM52ZZ1FF1NSJ`. Five
read-only researchers, one per part, each read primary sources first and marked every finding
verified (read at the source that day) or inferred. sloane merged the notes into this report and wrote
the skill from it. The researchers' raw notes were kept outside the repository; what the skill relies
on is restated here with its source.

## The parts

| § | Part | Reference it feeds |
| --- | --- | --- |
| 1 | Billing systems: subscriptions, seats, meters, webhooks, dunning, entitlements | `billing.md` |
| 2 | Usage pricing for AI and developer tools: seats, compute, credits, own keys, caps | `usage-and-model-pricing.md` |
| 3 | Tax, payment compliance and payment risk | `tax-and-compliance.md` |
| 4 | Pricing page and lifecycle: limits, upgrades, price changes, discounts, conversion | `pricing-page-and-lifecycle.md` |
| 5 | Existing agent skills, rule sets and provider MCP servers | `agent-access.md`, `PROVENANCE.md` |

## §1 Billing systems

- Stripe now names Metronome "the recommended starting point for all new integrations" of usage
  billing; basic Billing Meters "remains fully supported" and covers flat fee plus overage. Metronome
  lacks Checkout and Dashboard parity and its price is unpublished (verified, Stripe docs).
- Meter limits that shape design: 35-day past window; usage after invoice finalization is never
  billed; one concurrent call per customer per meter; asynchronous thin-event errors (verified).
- With seats plus a meter, the customer portal can cancel but not update a subscription (verified).
- Webhooks: no ordering guarantee; duplicates; re-fetch before granting; `invoice.finalization_failed`
  leaves the subscription active; sandbox retries are far shorter than live (verified).
- Merchants of record: Paddle's usage billing beta never bills overage; Lemon Squeezy is migrating
  into Stripe Managed Payments, which adds 3.5% and limits subscriptions to Checkout (verified).
- Gaps: whether a zero `unit_amount` tier is accepted; whether Managed Payments supports metered
  prices; the US card processing rate.

## §2 Usage pricing

- Fifteen pricing pages read (Cursor, GitHub Copilot, Replit, Vercel, v0, Supabase, OpenRouter,
  Anthropic, Factory, Devin, Warp, Zed, and others): the common shape is seat or plan fee plus a
  currency allowance plus overage near list price plus a customer cap (verified per page; the pattern
  is inferred).
- Published markups: Zed +10%, Warp +20% on pay-as-you-go, OpenRouter 5.5–8% on credit purchases;
  Vercel AI Gateway and Replit at list price (verified).
- Cursor's June 2025 change and refund (verified, Cursor's blog); Replit's 2025 effort pricing
  complaints (secondary, The Register).
- Growth Unhinged 2026, about 230 companies: hybrid 37% against 25% a year earlier; median target AI
  margin about 50% (verified on the post; per-question denominators unstated). Its 2025 edition does
  not reconcile with that baseline.
- Gaps: OpenAI's pricing page (403); survey data split for small companies.

## §3 Tax, compliance, risk

- EU VAT from the first sale for non-EU sellers to consumers; non-Union OSS quarterly with nil returns;
  UK registration with no threshold; Texas $500,000 (verified, official pages and Stripe docs).
- Stripe Tax calculates and can file in the US and the Irish OSS; registration choice and liability
  stay with the seller (verified / inferred).
- PCI: hosted fields keep card data off our servers; annual attestation; the 2025 SAQ A change is from
  secondary summaries only (gap: the PCI SSC text).
- SCA mandates for metered charges name how the amount is determined (verified, Stripe).
- Disputes: one final submission, 7–21 days; Visa flags at 5 and 0.5%, Mastercard at 100 and 1.5%
  (verified, Stripe).
- Renewal law: the FTC click-to-cancel rule was vacated in July 2025; California's amended law applies
  from July 2025 (both secondary, law-firm summaries).
- Gaps: a state-by-state SaaS taxability matrix; EU and UK invoice rules; the California statute text.

## §4 Pricing page and lifecycle

- Eight pricing pages read; none states every limit's behaviour (verified per page).
- PostHog's handbook on price changes: about 60 days' notice, a limited transition, "nobody gets legacy
  pricing forever" (verified). GitLab 2023 and Docker 2023 as the change and reversal cases.
- Growth Unhinged March 2026, n = 200: median free-to-paid 8%, card-required trials 30%; the
  denominator is undefined (verified). OpenView's medians are now second-hand only.
- Measuring without telemetry: the hosted service's records plus the billing provider's (the
  researcher's design, inferred).

## §5 Upstream skills and tools

- Stripe's `stripe-best-practices` skill and references (github.com/stripe/ai, MIT, pinned): adopted
  as ideas: restricted keys over secret keys, sandboxes over shared test mode, the `[sr]k_live_`
  pre-commit pattern.
- marketingskills `pricing`, `churn-prevention`, `paywalls` (MIT, pinned): adopted selectively: the
  value metric first, the agent-readable pricing-page lens (credited there to Kyle Poyar). Left out:
  vendor partner picks and unsourced figures.
- Provider MCP servers: Stripe hosted (agent keys, approvals, the 2026-11-30 migration), Paddle
  (Apache-2.0, read-only and sandbox modes), Polar (sandbox server, read-only OAuth), PayPal (cite
  only). Stripe's old agent packages are deprecated: skip.
- anthropics/skills holds nothing on billing.

## Not adopted, and why

- Metronome, Orb, Lago or OpenMeter before there is revenue: a second system of record; Lago's AGPL
  needs review.
- Paddle for metered overage while its beta never bills overage.
- Volume tiers with thresholds: negative invoice lines.
- Product telemetry to measure conversion: breaks musterd's no-analytics promise.
- Any unsourced figure from the surveyed skills (for example a dunning "recovery ROI").

## Open questions only the team can answer

1. Which payment provider, and whether to use a merchant of record (nick, with an adviser).
2. Where musterd registers for tax as Cloud sells abroad (nick, with an adviser).
3. Whether a read-only agent key can be built from Stripe's permission presets (to verify in the
   sandbox when an account exists).
