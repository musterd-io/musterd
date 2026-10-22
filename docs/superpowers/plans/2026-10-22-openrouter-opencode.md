# OpenRouter support for OpenCode

## Goal

Support OpenRouter in both interactive OpenCode sessions and Musterd-triggered OpenCode wakes.
OpenCode remains responsible for provider accounts and credentials. Musterd-triggered calls use the
existing wake metering gateway; ordinary interactive calls do not.

## Increments

| Increment | Lane | Work | Acceptance |
| --- | --- | --- | --- |
| 1/4 | `01M5JDT3SGXG2SBNEACSWJ4Q5Y` | Record ADR 714 before implementation and keep the plan and decision aligned. | ADR 714 specifies interactive credential ownership, wake-only routing, usage attribution, unknown-price behavior, and an evaluation method. |
| 2/4 | `01M5JE041SXYC7BNA8J7V90RH0` | Explain OpenCode's native OpenRouter connection and model selection in Musterd onboarding/help, without taking over provider config. | Onboarding does not write or expose keys, replace existing provider configuration, or change the selected model. The docs show how a Member connects OpenRouter and selects it for a session. |
| 3/4 | `01M5JE08RMK8QAQ4BVW9DAYHWS` | Add OpenRouter as a wake-scoped gateway route and meter its model usage. Confirm how OpenRouter usage/pricing interacts with the existing price table and wake budget before enabling general use. | A controlled upstream test proves routing, usage/model attribution, credential forwarding without logging, known-price accounting, unknown-price reporting, and budget behavior. If unknown-price calls can evade the budget, constrain or refuse them before enabling this path and record that behavior in ADR 714. |
| 4/4 | `01M5JE0E5B5X4ZK6MFH35VPDPJ` | Complete acceptance coverage and update the CLI architecture/ADR consequences. | Tests cover both paths and their isolation; documentation states interactive billing is OpenRouter-side and wake costs are recorded by Musterd only when price information is available. |

## Constraints

- No Musterd storage or export of the OpenRouter API key.
- Interactive OpenCode provider setup stays under OpenCode's native account flow.
- Only Musterd-triggered wakes receive the gateway base URL override; project/global OpenCode config
  remains untouched.
- Preserve the gateway's existing rule that unknown prices are reported as unpriced, never guessed.
- Do not claim wake-budget protection for OpenRouter until acceptance coverage proves the configured
  behavior for supported and unknown model prices.

## References

- [ADR 714 — OpenRouter with OpenCode](../../decisions/714-openrouter-opencode.md)
- [ADR 583 — Metering gateway, not a loop](../../decisions/583-metering-gateway-not-a-loop.md)
- [OpenCode provider documentation](https://docs.opencode.ai/docs/providers/)
- [OpenRouter usage accounting](https://openrouter.ai/blog/announcements/smarter-charts-inline-svgs-and-live-usage-accounting/)
