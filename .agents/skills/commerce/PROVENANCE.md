# Provenance

Built 2026-11-06 by sloane with the `building-a-role-skill` method (ADR 586), lane
`01M6SBAS9KEBVKM52ZZ1FF1NSJ`, goal `commerce-role`, on team revive, at nick's request. Upstream
material was surveyed by a read-only researcher and its ideas adapted and rewritten in this team's
voice. No upstream file was copied whole. Licences follow ADR 579 (adapt only from MIT, Apache-2.0,
BSD, ISC, 0BSD, CC0, CC BY); the two adapted upstreams' licence texts are in `LICENSES/`. Commits were
pinned 2026-11-06 with `gh api repos/<owner>/<repo>/commits?per_page=1`.

## Adapted (ideas and structure, rewritten)

| Upstream | Commit | Licence | What was adapted |
| --- | --- | --- | --- |
| [stripe/ai](https://github.com/stripe/ai/tree/main/skills) `stripe-best-practices` and its billing, tax and security references | `12fbfa12bf7f1e953103ab2c443f85254cab8ef3` | MIT (`LICENSES/stripe-ai.LICENSE`) | Restricted and agent keys over secret keys; separate sandboxes over a shared test mode; the `[sr]k_live_` pre-commit pattern → `references/agent-access.md`. The skills are synced daily from docs.stripe.com; the GitHub copy at this commit is the adapted source, and version strings are linked, never copied. |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) `pricing`, `churn-prevention`, `paywalls` | `96798cf38736ecdba015a1d2b0521b0c8f8f41dd` | MIT (`LICENSES/marketingskills.LICENSE`) | Choosing the value metric before the model → `references/usage-and-model-pricing.md`; reviewing a pricing page for agents as well as people, an idea the upstream credits to Kyle Poyar / Growth Unhinged, and the split of voluntary and involuntary churn → `references/pricing-page-and-lifecycle.md`. Its paid partner tool picks and unsourced figures were left out. |

## Cited only

- Stripe's documentation (docs.stripe.com: billing, meters, webhooks, prorations, customer
  management, entitlements, Smart Retries, keys, MCP, tax, SCA, disputes, card testing): primary
  source under Stripe's site terms; cited and linked, never copied.
- [PaddleHQ/paddle-mcp-server](https://github.com/PaddleHQ/paddle-mcp-server)
  (`befead4560be014575fb49ec25b8a47ae1af27e1`, Apache-2.0) and Polar's hosted MCP: toolkit candidates
  for lane `01M6SBAVN6`; their modes are described in `references/agent-access.md`.
- [paypal/agent-toolkit](https://github.com/paypal/agent-toolkit)
  (`a3aa963960caf32912691a759879a8ce7a6018b2`, Apache-2.0): surveyed, out of scope.
- [anthropics/skills](https://github.com/anthropics/skills) (`ca45fc496a3436251f191354091d557da31c15b5`):
  surveyed; no billing skill.
- Every company pricing page, survey and regulator page named in `references/`: primary or secondary
  as marked there, read 2026-11-06.

## Research

`references/research.md` merges five researchers' notes and records what was not adopted and why.
