# Own model, native harness, or neither — research readout (2026-10-13)

Lane `01M4VMDE6MWCZQMY47J8HGJQS1` · asked by nick, researched and written by ryder · exploratory;
freezes once its recommendations land (or are refused) in ADRs.

Three open lanes carry three related bets: a lightweight macOS console
(`01M03AEZ1BVFB7T3FQPVWHNWF9`, [design 2026-08-20](2026-08-20-macos-console.md)), self-hosted model
training via Unsloth (`01M0FS6J5AYBAT47MERMZTMC3N`), and native harness phase 2
(`01KZVX17EN3Z1YKD4EV9K66K4T`, [spec 2026-08-12](../superpowers/specs/2026-08-12-native-harness-phase-2-design.md),
[ADR 251](../decisions/251-native-backend-musterd-as-its-own-harness.md)). Nick's prior going in: the
console is not worth building; the other two are interesting. This readout treats every earlier
design doc as history, measures what the daemon holds today, and reads the October 2026 field.

**The short answer.** Close the console lane. Do not build a native harness as a product; grow three
things the harness spec wanted that do not need a loop (verification, request-path metering,
replay into any harness). Do not train a coding model or a judge. Run one bounded, cheap
experiment on a coordination-only seat, with a kill criterion, and let its result close the Unsloth
lane either way.

## 1. What the daemon says today

Measured against `~/.musterd/musterd.db` and `trace.db` on 2026-10-13.

| What                                | Number                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Acts (messages)                     | 24,768 · 10.7 MB of body text · ~15k/month run rate (Sep 9,625; Oct 6,594 in 13 d) |
| Acts by kind                        | message 11,361 · status_update 8,206 · ask 1,873 · accept 1,532 · resolve 558 · request_help 279 · handoff 180 · decline 177 · steer 96 · challenge 17 |
| Acts by family, last 30 d           | claude 8,504 · openai 1,648 · human/unstamped 1,211 · other 729 · xai 676 · google 137 |
| Trace corpus (ADR 445, 7-day content retention) | 52,845 events · 168 sessions · 7 seats · 13,237 rows with content = 43 MB |
| Wakes                               | 4,286 leases all-time · 646 priced wakes · $199 total priced cost · 86 h wall     |
| Enrolled residency by harness       | claude-code 7 · grok 2 · opencode 2 · codex 1 · musterd (native) **0**           |
| Native harness rail                 | `wake_turns` **0 rows** · presences on surface `musterd` **0** · 728 lines of code |
| Seat footprint (docs/perf)          | Claude.app ~1.4 GB RSS floor; quitting it returned ~9 GB of swap                 |

Two readings matter for the decision.

**The native harness is dormant, not nascent.** Phase 1 ran its one owner-gated experiment in August
and nothing since: no seat is enrolled on it, no transcript rows exist, and the 728 lines it occupies
are a quarter of the Claude Code backend. Whatever argument exists for it must be made from the
field, not from momentum.

**The ADR 436 trigger fires, early.** `pnpm wake:rail` reads: Grok 0/37 settled wakes priced, Codex
0/38, OpenCode 0/32, Claude Code 42/61; Grok's median prompt floor is 12.2× Claude Code's (2,878k
vs 237k tokens). The binding read is 2026-10-21, but on today's numbers both clauses hold. ADR 436
says that reopens "owning the loop, one engine per provider" by a new ADR. This readout is the
input to that ADR, and §3 argues the trigger should be answered without a loop.

## 2. Own model: the field in October 2026

Full source list in the lane's research notes; the load-bearing facts:

- **Open weights are at parity on saturated benchmarks and well behind on the hard agentic ones.**
  SWE-bench Verified is retired as contaminated by both Vals and BenchLM (Opus 5 97.0, DeepSeek V4
  Pro 96.4, GLM 5.3 95.4). On Terminal-Bench 4.0 run independently by Artificial Analysis, Sonnet 5.5
  scores 63.6 and Opus 5.5 59.6 against the best open entry, GLM-5.3, at about 42. Artificial
  Analysis's own open-weights writeup puts the gap on TerminalBench Hard at 43–46% vs 61%.
- **The open models that could replace coding seats are ~1T-parameter MoEs.** DeepSeek V4 Pro,
  Kimi K3, GLM 5.3. They do not run on a Mac. Hosted, they cost $1.30–2.85 per M input tokens
  (DeepInfra), a 2–7× saving on Sonnet/Opus, paid in measured agentic quality.
- **Haiku 5.5 already sits at open-weight prices.** $0.10/$0.50 per M tokens, against Qwen3.5-9B
  hosted at $0.10/$0.15. A $5.4k Mac Studio never breaks even on coordination-seat volume.
- **Fine-tuning that moved coding ability used executable trajectories, not messages.** SWE-Gym:
  491 successful trajectories gave +13.6 points on a 32B model. SWE-smith ~5k. Nemotron-SWE
  59k–238k. Agent Lightning v1.0 (Microsoft, Aug 2026) took Qwen3.5-9B from 41.8 to 56.4 on
  Verified with 6k examples and RL through an LLM proxy. The failure literature is consistent:
  trajectory SFT on small models is unreliable, forgets, and overfits; multi-turn GRPO reward
  design is fragile (naïve dense rewards cost up to 14 points).
- **The hosted fine-tuning door is closing.** OpenAI stops accepting self-serve fine-tuning jobs
  after 2027-01-06; Anthropic has never offered tuning on a current model; Gemini 3 has none. Any
  tuned model is open-weight, self-served or on Together/Fireworks. Qwen 3.8+ moved off Apache
  to a Qwen Community License; Qwen 3.5/3.6 and Gemma 4 stay Apache 2.0.
- **Judges.** Small fine-tuned judges are in-domain classifiers that need a frontier fallback; the
  general ones trained on 100k–300k labelled examples. musterd has zero quality labels on its acts.
- **Precedents.** Cognition (SWE-1.x) and Cursor (Composer 2.5, on Kimi 2.5 weights) trained their
  own agent models on thousands of GB200s inside their own harnesses; the win they claim is
  latency and harness co-design, not quality. Niche wins exist for routers and triage (Switchcraft
  −84% cost; NVIDIA's "SLMs are the future of agentic AI" is exactly the log-cluster-tune
  recipe). No startup has published training a coordination or orchestration model.

What this means against our data:

| Target                                 | Data we have                        | Verdict                                                       |
| -------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| (c) a coding-agent model               | 43 MB of 7-day traces, 0 graders    | **No.** Wrong data by two orders of magnitude; wrong hardware |
| (b) a coordination-quality judge       | 24.8k acts, 0 quality labels        | **Not yet.** Label 500–1,500 first and run frontier-as-judge  |
| (a) a coordination-only seat           | 24.8k structured acts               | **A $20 weekend experiment**, not a strategy (§4)             |

## 3. Native harness: the field in October 2026

- **Everything the phase-2 spec wanted from a loop is now commodity.** Headless mode, resume,
  sandbox backends, MCP, hooks, subagents, isolated workspaces: present in at least six MIT/Apache
  harnesses. OpenCode is at 213k stars, Hermes Agent (Nous) at 253k, pi (Earendil) at 115k with a
  `durable` package that checkpoints every model and tool call. A source study of eleven harnesses
  (arXiv 2609.00006) found all converged on the same 29 patterns and ships a 90-line minimum
  harness. Clones are cheap; the ceiling is not.
- **Model–harness co-training is real and grows per generation.** Ronacher ("Better Models: Worse
  Tools", July 2026): Opus 4.8 / Sonnet 5 invent keys when given pi's nested edit schema because
  Claude Code's client silently repairs malformed calls and post-training rewards its flat schema.
  Copilot CLI exposes `apply_patch` to Codex models and `Edit(old,new)` to Claude. Counter-evidence:
  Databricks' internal benchmark had pi + Opus 4.8 beating Claude Code and Codex on pass rate at
  under half the cost, sending ~3× less context per turn. The honest read: a harness that copies
  the vendor tool shapes exactly can match or beat the vendor harness; a harness with its own tool
  schema pays a growing tax.
- **Subscription economics are the vendor moat, and policy moves on 30 days' notice.** Anthropic
  banned Pro/Max OAuth in third-party harnesses (enforced Jan 2026, ToS Feb), announced a separate
  Agent SDK credit for June 15, then paused it the same day. Cloud sessions, Desktop, Routines,
  Dispatch, Remote Control, Channels and cross-machine session messaging are gated to Claude Code
  with a claude.ai sign-in. A musterd harness is a third-party harness under that ToS: its users pay
  API rates where Claude Code users pay $200 flat.
- **Nobody ships musterd's three differentiators as a product primitive.** Independent
  verification of an agent's claims (Fowler and Anthropic both name it as the gap; Pramana-style
  attestation is a paper); request-path cost enforcement (Claude Code's `maxBudgetUsd` is a
  client-side estimate, off by default; Codex has no dollar cap; Paperclip's budgets admit in-flight
  work can overshoot); cross-harness, cross-model replay (pi-durable, Managed Agents, LangGraph
  checkpoints are each single-vendor).
- **The closest competitor does not own a harness.** Paperclip (101.5k stars, MIT): org chart,
  persistent identities, budgets, heartbeats, drives Claude Code, Codex, Cursor, Gemini, OpenCode,
  pi, Hermes and Kimi. OpenAI's Symphony is the vendor version of the same bet. Both prove the
  coordination layer reaches ten harnesses without a loop of its own.
- **Independent harnesses do not make money as harnesses.** OpenCode sells a gateway; Cline raised
  $32M on enterprise; Kilo was acquired by Anaconda; pi was acquired by Earendil; Aider, one
  maintainer, has not committed since May 2026. The harness is given away.
- **The Mac console is funded, crowded and absorbed.** Conductor raised a $22M Series A in March
  by pitching upward to "managing AI organizations"; Superset, cmux, Vibe Kanban, Emdash, Claude
  Squad are all open; and Claude Code Desktop (rebuilt April 14 around parallel sessions), the Codex
  app and Cursor 3's agents window each ship it natively. Nick's prior holds.

## 4. Recommendations

**1. Close `01M03AEZ1B` (macOS console) as refused by principle.** Record the refusal in the
ROADMAP data, not as an ADR; nothing was decided that an ADR must freeze. The one thing that doc
got right, "the coordination is the moat, the terminal is a commodity", is the argument for
everything below.

**2. Answer the ADR 436 trigger without a loop.** The trigger fires on *pricing* and *floor*. Both
are solved by owning the request path, not the loop: a metering gateway (`ANTHROPIC_BASE_URL` /
`OPENAI_BASE_URL`, which Claude Code, Codex, OpenCode, Grok and pi all honour) that attributes
every model call to a seat and lane, prices it from the response usage, and refuses the next call
when the wake budget is spent. That prices Grok, Codex and OpenCode wakes from the same source,
measures the floor per harness directly, and is enforcement at the boundary, which Paperclip and
Codex cannot do. The new ADR the trigger demands should decide this, and should say that
"one engine per provider" is reversed, not deferred.

**3. Retire native harness phase 2 as a harness; keep its three pillars as daemon features.**

- *Verification as protocol* — a daemon-side check of a seat's claimed outcome (commit exists on
  the branch, PR open and on that head, CI green, lane state) that records every claim
  confirmed, unconfirmed or unverifiable. This is the claim-vocabulary section of the phase-2 spec,
  minus the loop. It applies to every harness the day it lands and is the thing nobody ships.
- *Request-path metering* — item 2.
- *Replay into any harness* — the daemon keeps the wake context packet (ADR 430) and transcripts;
  resume goes through `claude --resume`, Codex thread ids, OpenCode sessions or pi-durable
  checkpoints, never through a loop musterd maintains. If a jailed, model-agnostic executor is ever
  required (a customer's VPC with no vendor CLI allowed), embed pi (MIT, four tools, `durable`) with
  musterd's tools injected rather than growing `native.ts`.

Keep the 728-line native backend as the reference row ADR 436 §2 already made it. Do not give it
file or bash tools. Lane `01M3TV3VEKVTNY4QSDNWV9FDF6` (native harness loads AGENTS.md) is moot and
should close with phase 2.

**4. Run one experiment on the Unsloth lane, then close it either way.** Re-scope
`01M0FS6J5A` from "evaluate self-hosted training" to a pre-registered, one-weekend test:

- *Task:* given a seat's inbox state and wake packet, emit the next act (kind, recipient, thread,
  well-formed meta, short body). Training set: the acts from the strongest-stamped models in the
  24.8k, with accept/resolve outcomes as weak labels; held-out 1k.
- *Model:* QLoRA on Qwen3.5-9B or Gemma 4 12B (Apache 2.0), MLX-LM on an M-series Mac overnight
  (~48 min/epoch at 5k examples on an 8B) or ~$5 of H100.
- *Baseline:* prompted Haiku 5.5 on the same held-out split.
- *Kill criterion, pre-registered:* if the tuned model does not beat prompted Haiku 5.5 on
  act-kind and recipient accuracy and on schema validity, the lane closes with the finding and
  Track B stays where ADR 110 left it.

The dollar win is near zero either way (Haiku 5.5 and a hosted 9B both cost ~$20–30/month at our
coordination volume). What the experiment buys is three other things: whether our acts are
learnable at all, which doubles as a data-quality audit; a local seat that never rate-limits and
answers in under a second, which is the demo story "musterd's traces trained a seat"; and the
second `AgentLoopEngine` row that ADR 101's model-diversity claim has never had. If it passes, the
follow-on is a finding under `docs/research/` and a hosted-weights option on the binding ladder,
not a training program.

**5. Do not label a judge yet.** When the verification rail in item 3 produces
confirmed/unconfirmed outcomes per act, those are the labels a judge would train on; until then a
frontier model with the rubric is the judge, and it is cheaper than the labelling effort.

## 5. What would change this

- Anthropic or OpenAI enforce a subscription split that makes wake-driven seats illegal under
  Claude Code or Codex. Then a model-agnostic executor becomes necessary, and the answer is
  embedding pi, not writing a loop.
- A customer needs seats in a VPC where no vendor CLI is permitted. Same answer.
- The metering gateway in item 2 cannot price a harness because it bypasses `BASE_URL` (Cursor's
  cloud agents, Claude Code cloud sessions). Then those harnesses stay unpriced by construction and
  the rail says so; it is not a reason to own the loop.
- The coordination-seat experiment passes by a wide margin. Then the open question is a hosted
  weights option on the ladder, and ADR 110's Stage 2 gate (dataset with honest N, ADR 184 DoD)
  still stands between that and a judge.

## Sources

Measured: `pnpm wake:rail` 2026-10-13; `~/.musterd/musterd.db` (`messages`, `audit`,
`wake_leases`, `wake_turns`, `residency`, `presence`); `~/.musterd/trace.db`; `docs/perf/seat-footprint.md`.

Field (October 2026): Vals AI SWE-bench board · BenchLM SWE-bench Verified and Terminal-Bench 2.1
· Artificial Analysis Terminal-Bench 4.0 and "recent open-weights launches" · SWE-Gym (arXiv
2412.21139) · SWE-smith (arXiv 2504.21798) · Nemotron-SWE-v1 (HF) · Agent Lightning v1.0 (arXiv
2608.17528) · SkyRL (arXiv 2511.16108) · multi-turn GRPO reward fragility (arXiv 2604.02869) ·
"Reach or Solve?" (arXiv 2609.19636) · Unsloth RL guide and requirements · MLX-LM on M5 Max
(contracollective.com) · DeepInfra, OpenRouter, claude.com pricing · judge survey (arXiv
2403.02839) · Cognition SWE-1.5 · Cursor Composer · NVIDIA SLM position paper (arXiv 2506.02153)
· Fowler, "Harness engineering memo" · Anthropic, "Effective harnesses for long-running agents"
and "Building agents with the Claude Agent SDK" · LangChain, "Tuning Deep Agents" · Harness-Bench
(arXiv 2605.27922) · eleven-harness source study (arXiv 2609.00006) · Ronacher, "Better Models:
Worse Tools" · Bustamante, "Model-Harness-Fit" · Earendil on the Databricks result · pi 1.0 and
pi-durable · Paperclip (GitHub) · Symphony (InfoQ) · Claude Code feature-availability page ·
Anthropic Agent SDK subscription pause (The New Stack, VentureBeat) · Conductor Series A · Claude
Code Desktop rebuild (MacRumors) · GitHub API star counts and licences read 2026-10-13.
