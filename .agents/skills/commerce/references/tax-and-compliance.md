# Tax and compliance: sales tax and VAT, PCI scope, SCA, disputes, fraud, renewal law

Open for any tax setting, checkout change, card-saving flow, dispute, fraud signal or renewal wording.
Much of this is **legal or tax advice territory**: you prepare and check; the named human or adviser
decides (SKILL.md, Never alone). Facts below were read on 2026-11-06 (`research.md` §3); items marked
*secondary* come from law-firm or vendor summaries; the primary text was not read.

## Sales tax, VAT and GST

- **US:** each state sets its own nexus rules, and you register before you collect. Texas: $500,000
  of Texas revenue over the preceding 12 months, collecting by the first day of the fourth month
  after crossing ([Texas](https://comptroller.texas.gov/taxes/sales/remote-sellers.php)). California's
  $500,000 threshold is written for tangible goods
  ([CDTFA](https://www.cdtfa.ca.gov/industry/wayfair.htm)); whether software as a service is taxable
  varies by state and is the adviser's call.
- **EU consumers, non-EU seller:** VAT can be owed from the first sale; the EUR 10,000 threshold
  helps only EU-based sellers. The non-Union One Stop Shop gives one registration and one quarterly
  return, due by the end of the month after the quarter, with a nil return when nothing sold
  ([Stripe EU](https://docs.stripe.com/tax/supported-countries/european-union),
  [EU OSS](https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en)).
- **EU businesses:** with a valid VAT number the customer accounts for VAT (reverse charge), and the
  invoice says so. A business customer without a validated number is taxed as a consumer.
- **UK consumers:** a non-UK seller of digital services registers for UK VAT; no threshold applies
  ([gov.uk](https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers)).
- **Stripe Tax** calculates, monitors thresholds, and can file in the US and the Irish non-Union OSS.
  You still choose where to register, assign each product's tax code, and carry the liability. It
  does not handle domestic reverse charge.
- **A merchant of record** is the legal seller: it files and remits tax and takes refunds,
  chargebacks and PCI burden, for a higher fee. Choosing one is the human's decision with an adviser.

## PCI scope

- Card data goes from the customer to the provider through hosted Checkout or Elements and never
  through your servers. You may store brand, last four and expiry. You still attest PCI compliance
  every year ([Stripe security guide](https://docs.stripe.com/security/guide)).
- Since 31 March 2025, SAQ A eligibility includes confirming the site is not open to script attacks
  that could affect checkout (*secondary*: Adyen, usd.de summaries; read the PCI SSC text before
  relying on it).
- **Never** on your servers, in logs, in acts or in commits: card number, CVC, track data, PIN, the
  payment form's request bodies, or a secret key.

## Strong Customer Authentication (EEA cards)

- For charges made later without the customer present, authenticate when the card is saved
  (`setup_future_usage=off_session`, or a SetupIntent with `usage=off_session`), then mark later
  charges off-session ([Stripe SCA](https://docs.stripe.com/strong-customer-authentication)).
- The mandate the customer agrees to covers permission, frequency and **how the amount is
  determined**, which matters for metered billing.
- Handle `incomplete` and `requires_action`: email the customer a way to authenticate.
- For a US-acquired merchant, EEA cards are "one leg out", so SCA is best-effort; build for it anyway.

## Disputes and monitoring programmes

- A dispute usually allows 7–21 days. One evidence submission, final; a missed deadline loses
  ([responding](https://docs.stripe.com/disputes/responding)). Assemble evidence; a human submits it.
- Visa's programme flags an account at 5 disputes and 0.5% in a month, counts early fraud warnings,
  and refunds do not reduce the count. Mastercard's starts at 100 chargebacks and 1.5%
  ([monitoring programs](https://docs.stripe.com/disputes/monitoring-programs)). Alert well below.
- Prevention for subscriptions: easy online cancel, terms shown and agreed before the card, a reminder
  before a trial ends, renewal reminders, a clear statement descriptor.

## Card testing

Attackers use card-saving steps as well as payments, so a free signup that saves a card is a target.
Signs: spikes in failed card setups, 402s and `generic_decline`. Defences: hosted Checkout or the
Payment Element, server-side CAPTCHA, sign-in before the payment form, rate limits per IP and per
customer, velocity rules ([card testing](https://docs.stripe.com/disputes/prevention/card-testing)).

## Renewal and cancellation law

- The FTC's "click to cancel" rule was vacated by the Eighth Circuit on 8 July 2025 and is not in force
  as of 2026-11-06 (*secondary*: law-firm summaries). Older federal law (ROSCA) still applies.
- California's automatic renewal law, as amended from 1 July 2025: separate express consent, consent
  records kept at least 3 years, an annual reminder, notice of material changes including price, and
  online cancellation (*secondary*; the statute text was not read). Whether a law applies to a
  given customer is the lawyer's call.

## Checkable rules

1. Card data enters only through hosted fields; grep code and logs for card-number and CVC shapes and
   for any route that receives card fields; fail on a hit.
2. No `[sr]k_live_` key in the repository or a client; webhook signatures verified; TLS 1.2+.
3. Every product and price carries an explicit tax code; any threshold alert reaches a human the same
   day.
4. EU and UK business customers without a validated VAT number are taxed as consumers; reverse-charge
   invoices carry the note.
5. Each OSS quarter has a calendar entry, including nil returns.
6. Saved cards are set up for off-session use; the mandate text names how the amount is calculated;
   `requires_action` triggers an email.
7. Dispute ratio and early fraud warnings are tracked monthly, with an alert well below 0.5%.
8. Every new dispute is flagged within a day with its deadline; evidence is assembled for a human.
9. A spike in failed card setups opens an incident; CAPTCHA and rate limits are confirmed on card
   setup.
10. Checkout shows renewal terms and price with separate consent; online cancel exists; reminders are
    scheduled for trial end, annual renewal and price change; consent records are kept.
