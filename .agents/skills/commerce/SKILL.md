---
name: commerce
description: How a team takes money correctly — subscription and metered billing, payment providers, usage metering, tax and payment compliance, payment risk, pricing-page and plan-change mechanics, and an agent's own safe access to a payment account. Use for any billing integration, meter, webhook, plan or seat change, invoice, refund or dispute, tax setting, pricing page, price change, or question about what a customer will be charged. Prices and terms are the human's call; this skill makes a decided price into a bill a customer can trust.
---

# commerce

This skill teaches the craft of charging customers. The decisions it serves live elsewhere: the
team's pricing decision, its privacy promise, and its secrets rule win over anything here. If this
file disagrees with them, they win and this file has a bug. Fix it with a PR.

This file is the core and is always read. Each craft has a reference under
`.agents/skills/commerce/references/`; the routing table says which to open. Read the reference
before doing that craft's work, every time.

## Sources (read before the first piece of work in a session)

1. `references/team.md`: who decides, the team's pricing decision and its current plan, which
   provider and accounts exist, and the local rules. Read it first.
2. The sources it names: the pricing decision record, the privacy promise, the secrets rule, the
   architecture of the hosted product. Read them; do not recall them.
3. The provider's own documentation for any API you touch, at the version the account pins. Fees,
   limits and API versions change; a number copied into this skill is stale by design, so it links
   instead.

## Charter

- **You own the mechanics:** the billing integration, meters, webhooks, entitlements, invoices,
  dunning, the pricing page's correctness, tax settings, and the record of every money event.
- **You advise on prices; a human decides them.** Price, plan shape, discounts, trial length and
  every change to what an existing customer pays are the human's call, recorded in the team's
  decision record. You model, cost and test them.
- **Legal, tax and risk judgments go to a person.** You prepare; the named human or adviser decides
  (§Never alone).
- **You never hold card data.** Card numbers enter only through the provider's hosted fields.

## Hard rules

Each exists because breaking it once costs more than any feature earns.

1. **No live secret key, ever, in your hands.** Work in a provider sandbox by default. In live mode
   use only a restricted, agent-tagged, read-only key, with the provider's approval rules on.
   Never a full-access live key (`sk_live_…`). Reason: an agent's mistake with a live key moves
   real money and cannot be taken back. (`references/agent-access.md`)
2. **Every live write is a to-human ask first:** a price, a refund, a subscription change, a tax
   registration, a coupon. The provider may also confirm; the ask still comes first. Reason: money
   moved is a promise to a customer, and only a person can make it.
3. **No card data and no secret in code, logs, acts or commits.** Grep before every commit for card
   number shapes and `[sr]k_live_` patterns; fail on a hit. Reason: one log line can put the whole
   company in PCI scope or leak a key. (`references/tax-and-compliance.md`)
4. **Every money event is idempotent.** Every write to the provider carries an idempotency key; every
   meter event carries a deterministic identifier; every webhook is deduplicated by event id. Reason:
   retries are normal, and a retried charge is a double charge.
5. **Access follows the provider's state, read fresh.** Grant or extend access only after
   re-fetching the subscription and seeing it active; revoke on unpaid or canceled. Never trust a
   single webhook, or its order. Reason: events arrive out of order and a paid invoice is not always
   an active subscription.
6. **No surprise bills.** Every metered line has a cap or budget on by default, alerts before the
   cap, a stated rate in hours or currency (never opaque units), and a dated message when it stops.
   Reason: surprise charges are the most common pricing backlash in this market.
7. **Every number on a public page, an invoice or a reply is checkable.** It names its unit, period
   and what happens at the limit, and it matches the provider's configured price. Reason: a wrong
   price on a page is a promise a stranger can hold you to.
8. **Free stays free for those who have it.** Never lower a free allowance or raise an existing
   customer's price without the human's decision, written notice, and the transition the decision
   sets. Reason: taking back what people already have costs more trust than it earns.

## Never alone (route to the named human or adviser)

Where and whether to register for tax; the product's tax classification; filing or answering a tax
authority; choosing a merchant of record or changing the seller entity; terms of service, refund
policy and auto-renewal wording, and whether a law applies; signing a PCI attestation; submitting
dispute evidence; refunds beyond the written policy; price changes for existing customers; any reply
to a card network, a provider risk review or an account-information request.

## Checks that catch most mistakes

- Before proposing any action at a payment provider, read `references/team.md` for which provider and
  accounts exist. If none is recorded, say so and write the plan for the sandbox; never offer to "pull
  it from the provider today" against an account nobody has made.
- Preview before change: any seat or plan change shows the prorated amount first, from the
  provider's preview, and applies it with the same proration date.
- Usage lands before the invoice finalizes, inside the provider's grace window; no price change on
  a usage item mid-cycle.
- A webhook handler verifies the signature on the raw body, returns 2xx fast, and processes from a
  queue.
- `invoice.finalization_failed` (or the provider's equivalent) is handled: the subscription stays
  active while nothing can be collected.
- A nightly reconciliation compares subscription status, seat count and the period's usage against
  the product's own records and alerts on any difference.
- Free tiers that the provider never bills are capped in the product, since nothing upstream will
  stop them.
- Every claim about cost, margin or conversion names its source, date, numerator and denominator.

## Routing

| You are working on | Open first |
| --- | --- |
| Plans, seats, meters, webhooks, proration, dunning, entitlements, reconciliation | `references/billing.md` |
| A pricing model, credits, model-compute pricing, caps and alerts, margin | `references/usage-and-model-pricing.md` |
| Sales tax, VAT, PCI scope, SCA, disputes, fraud, renewal law | `references/tax-and-compliance.md` |
| A pricing page, an upgrade or downgrade flow, a price change, discounts, conversion figures | `references/pricing-page-and-lifecycle.md` |
| Keys, sandboxes, a payment provider's MCP server, approvals | `references/agent-access.md` |
| Where any of the above came from | `references/research.md` |

## Definition of done

- [ ] The reference for this craft was opened and followed
- [ ] Sandbox first; no live key used beyond read-only; every live write went through an ask
- [ ] Idempotency on every write; webhook dedupe; access read fresh
- [ ] The grep for card data and live keys is clean
- [ ] Caps, alerts and the stop message exist for every metered line touched
- [ ] Every public number matches the provider's configured price and states its limit behaviour
- [ ] Nothing in §Never alone was decided without its person
- [ ] The team's decision record and docs were updated in the same change when behaviour changed
