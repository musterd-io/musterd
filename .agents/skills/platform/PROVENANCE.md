# Provenance

Built 2026-10-13 by sloane with the `building-a-role-skill` method (ADR 586), lane `01M4VPY15A`,
goal `role-skills`. Upstream ideas and structure are adapted and rewritten, never copied whole;
licence texts are in `LICENSES/`. Licences follow ADR 579.

## Adapted

| Upstream | Commit | Licence | What was adapted |
| --- | --- | --- | --- |
| [PagerDuty/incident-response-docs](https://github.com/PagerDuty/incident-response-docs) | `464fc9d3e47e19e9d8da17cec1a41dc09624e95a` | Apache-2.0 | `docs/before/severity_levels.md`, `docs/before/different_roles.md`, `docs/during/during_an_incident.md` (declare when unsure at the higher severity; commander coordinates and does not debug; named tasks with a report-back time; updates that name the next update; "any strong objection") → `references/diagnosis.md` §3 |
| [PagerDuty/postmortem-docs](https://github.com/PagerDuty/postmortem-docs) | `88e5e97be2131780cdf54624a35791ca560e03c7` | Apache-2.0 | Review timing, blameless "what and how", writing in foresight → `references/diagnosis.md` §4 |
| [magnus919/agent-skills](https://github.com/magnus919/agent-skills) | `b3b45651ffa2ca882911c2ebfeeab8e3dc7b53ce` | MIT | `site-reliability-engineering/SKILL.md` operational closure gate (bound the action first; a cleared alert is not recovery; skill text and roles confer no permission) → SKILL.md hard rules 3, 5 and the five lines; `references/automation.md` §2. Its `references/sre-book-chapters.md` summarizes a CC BY-NC-ND book and was not read for adaptation. |
| [obra/superpowers](https://github.com/obra/superpowers) | `bb92a77741419a4ab5f06e711a283343f1ada0c3` | MIT | `skills/systematic-debugging` (root cause before any fix; check each component boundary) → `references/diagnosis.md` §2 |
| [adhorn/operational-excellence](https://github.com/adhorn/operational-excellence) | `7456c60dc2a25f650ee9705c92391fae53e723de` | MIT | `IncidentReviewTemplate.md` (contributing factors in place of a single root cause) → `references/diagnosis.md` §4 |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `02ffa99ff00ce4d3046ccebabb8357cb39f3ab06` | Apache-2.0 | `engineering/skills/deploy-checklist` (rollback triggers decided before the deploy) → `references/changes.md` §3 |

None of the Apache-2.0 repositories above ships a `NOTICE` file at the commit read.

## Cited with attribution (CC BY 4.0, paraphrased and changed)

- DORA, streamlining change approval: https://dora.dev/capabilities/streamlining-change-approval/
- Kubernetes, liveness, readiness and startup probes: https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/
- OpenTelemetry, logs data model and `service.version`: https://opentelemetry.io/docs/specs/otel/logs/

## Cited only (reference-only licences, or none stated)

The Google SRE book and workbook (CC BY-NC-ND 4.0), OWASP GenAI (CC BY-SA 4.0), Brendan Gregg's
USE method, Dan Slimmon's do-nothing scripting, Martin Fowler's ParallelChange, the SQLite,
PostgreSQL, Fly.io, launchd and git documentation, Anthropic's and OpenAI's agent docs, GitHub's
docs on removing sensitive data, and the incident reports in `references/automation.md` §1. Each is
linked where it is used and paraphrased; none is adapted.

## Research

Five read-only researchers (incident response, changes and migrations, agents on infrastructure,
health and observability, upstream skills) and one repository survey, merged into the report
"Platform role skill research" (sloane's scratchpad, 2026-10-13). Not verified there and so not
stated as fact here: flyctl version commands, whether Fly rolling deploys wait on health checks,
Neon restore windows for this account, and launchd's default `ExitTimeOut`.
