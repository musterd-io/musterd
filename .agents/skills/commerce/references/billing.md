# Billing: plans, seats, meters, webhooks, dunning, entitlements

Open for any billing integration work. Written against Stripe Billing because it is the common
choice for a small company that bills seats plus metered usage; the rules carry to other providers
with their own names. Every Stripe fact here was read in Stripe's documentation on 2026-11-06
(`research.md` §1); check the live page before relying on a limit, because limits change.

## Choosing the system

- **Stripe Billing with Meters** covers "flat fee and overages": seats plus one metered item. Stripe
  now recommends Metronome for new usage-based integrations, but Metronome's price is unpublished and
  it lacks Checkout and Dashboard parity
  ([compare](https://docs.stripe.com/billing/subscriptions/usage-based/compare-metronome)). Start on
  Meters; move when prepaid credits, commits or many dimensions are needed.
- **A merchant of record** (Paddle, Polar, Stripe Managed Payments) takes tax and chargeback
  liability for a higher fee. Before choosing one, confirm it can bill postpaid metered overage:
  Paddle's usage billing "never blocks usage or bills for overage" during its beta
  ([Paddle](https://developer.paddle.com/build/usage-based-billing)), and Managed Payments limits
  subscriptions to Checkout and Payment Links. The choice itself is the human's (SKILL.md, Never
  alone).
- **Not now:** a second billing system of record (Orb, Lago, OpenMeter) before there is revenue to
  reconcile. Lago is AGPL; that licence needs review before it is embedded or modified.

## Modelling free seats, paid seats and metered usage

One subscription, two items:

1. **Seats:** a licensed price with graduated tiers. The free tier carries no `flat_amount`, because
   "Stripe always bills the first flat rate tier when quantity=0"
   ([tiered pricing](https://docs.stripe.com/subscriptions/pricing-models/tiered-pricing)). Confirm in
   the sandbox that a zero `unit_amount` tier is accepted; the docs do not say.
2. **Usage:** a metered price on a meter, graduated, with the included block as its first tier.

Use graduated tiers. Volume tiers with billing thresholds can produce negative invoice lines
([thresholds](https://docs.stripe.com/billing/subscriptions/usage-based/thresholds)).

A team below the paid threshold usually needs **no provider subscription**: the product enforces the
free limits, and a team crossing the threshold goes through Checkout to put a payment method on file.
A zero-value subscription per free team adds webhook and dunning surface for no revenue. Any free
allowance the provider never bills must be **capped in the product**.

## Meters and usage

From [recording usage](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api):

- Every meter event gets a **deterministic `identifier`**, for example `{team}:{window_start}`, so a
  retried send cannot bill twice.
- Timestamps within the past 35 days and at most 5 minutes ahead are accepted. Accepted is not billed:
  usage that arrives after the invoice finalizes appears in summaries and on no invoice.
- One concurrent call per customer per meter in live mode: aggregate in the product and send one event
  per customer per window.
- Errors arrive asynchronously as thin events (`v1.billing.meter.error_report_triggered`,
  `v1.billing.meter.no_meter_found`). Without a thin-event destination they are silent.
- Invoices finalize after a grace period, 1 hour by default and at most 72
  ([grace period](https://docs.stripe.com/billing/subscriptions/usage-based/configure-grace-period)).
  A mid-cycle price change on a usage item drops the grace-period usage. Do not change usage prices
  mid-cycle.
- A billing threshold (`amount_gte`) invoices mid-cycle and caps exposure to a runaway meter.
- Meter only what the provider bills for us. When customers bring their own model keys, meter our
  compute, never their tokens.

## Seat changes and proration

From [prorations](https://docs.stripe.com/billing/subscriptions/prorations):

- Quantity changes prorate to the second by default. Preview with `invoices.create_preview`, show
  the amount, then apply with the **same `proration_date`**.
- Decide once, and write down, whether seat additions invoice immediately (`always_invoice`) or on
  the next invoice (`create_prorations`).
- If the latest invoice is unpaid, use `proration_behavior=none` for a downgrade, or the customer is
  credited for time never paid.
- Usage items are not prorated.
- With seats plus a meter on one subscription, the customer portal can cancel but **cannot update**
  it ([customer management](https://docs.stripe.com/customer-management)). Seat and plan changes run
  in the product through the API; the portal handles payment methods, invoices and cancellation.

## Webhooks

From [webhooks](https://docs.stripe.com/webhooks) and
[subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks):

- Verify the signature on the raw body; return 2xx fast; process from a queue.
- Order is not guaranteed and duplicates happen. Deduplicate on `event.id`, and on object id plus
  type; never order by `created`.
- On `invoice.paid`, re-fetch the subscription and grant only on `active` or `trialing`.
- Revoke on `unpaid` and `canceled`. `incomplete` expires after 23 hours.
- Handle `invoice.finalization_failed`: the subscription stays active while nothing is collected.
- A failed `invoice.created` delivery holds every auto-collected invoice for up to 72 hours.
- Also subscribe to `charge.dispute.created`, `charge.refunded` and
  `radar.early_fraud_warning.created`.
- A sandbox retries a failed webhook about 3 times over hours; live mode retries for 3 days. A test
  plan that leans on sandbox retries is incomplete.

## Idempotency

Every POST carries an idempotency key: a v4 UUID or a deterministic business key, never personal
data. Keys may be pruned after 24 hours; a reused key with different parameters errors
([idempotent requests](https://docs.stripe.com/api/idempotent_requests)).

## Failed payments and cancellation

- Smart Retries is on by default for new accounts: up to 8 retries within 2 weeks; hard declines
  never retry without a new payment method, which must go on the field that failed
  ([Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries)).
- Choose the end state explicitly (unpaid or canceled) and write it down. In `past_due`, keep access
  for a stated grace period with a banner. That counts as dunning. A new grant still needs
  `active` or `trialing`.
- Prefer `cancel_at_period_end` to immediate cancellation.

## Entitlements and reconciliation

- Stripe Entitlements are on/off features, persisted locally and reconciled after webhook failures
  ([entitlements](https://docs.stripe.com/billing/entitlements)). Quotas (seats, hour caps) stay in
  the product's own store.
- Run a nightly reconciliation: list subscriptions; compare status, seat quantity and the period's
  meter summary against the product; alert on any difference.

## Checkable rules

1. Idempotency key on every POST; deterministic identifier on every meter event.
2. Webhook: raw-body signature, dedupe on id, no ordering by time, 2xx before work.
3. Access granted only on a fresh read of an active subscription; revoked on unpaid or canceled.
4. `invoice.finalization_failed` handled.
5. Usage sent inside the grace window; no usage price change mid-cycle.
6. A thin-event destination listens for meter errors.
7. Seat changes previewed, then applied with the same proration date.
8. Graduated tiers; no flat amount on a tier that can see quantity zero.
9. Seat and plan changes in the product; the portal for payment methods, invoices and cancellation.
10. Nightly reconciliation with an alert.
