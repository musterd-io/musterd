# Local model context floor

How many tokens a musterd seat on OpenCode needs before the model reads its first message, what that means for local models on an 8 GB Mac, and which candidate models were deferred and why.

## The floor (measured 2026-10-19, stanley)

**Method.** One `opencode run --standalone` (OpenCode v2.0.31) in an empty scratch folder with an
isolated config, data and cache directory, pointed at a local stub that records the size of each
request it receives and answers `ok`. Musterd's own parts come from the gated budgets in
[`docs/perf/context-budgets.json`](../perf/context-budgets.json), and the repo files are counted
with `wc -c`. Tokens are estimated at bytes/4, the repo's `SurfaceRender` convention. A small
model's tokenizer usually spends more tokens on JSON schemas than that, so every token figure here
is a **lower bound**.

| Part | Bytes | ~Tokens | Removable for a local seat? |
| --- | --- | --- | --- |
| OpenCode system prompt (harness, code-mode docs, env) | 7,632 | 1.9k | no |
| OpenCode's 12 built-in tools | 13,533 | 3.4k | partly (web fetch/search, subagent, question) |
| Skill list from the user's skill folders (`available_skills`) | 23,534 | 5.9k | yes, all of it |
| musterd `tools/list`, default role | 20,923 | 5.2k | no (a muted seat is 8,344 B but cannot send) |
| musterd primer and hook nudges | 3,476 | 0.9k | no |
| Repo `AGENTS.md` | 25,437 | 6.4k | only for a docs-only seat |
| Global `AGENTS.md` | 4,302 | 1.1k | yes |
| Orient skill | 3,663 | 0.9k | no |
| A ten-act inbox read (estimated from a 2026-10-18 read, not measured) | ~10,000 | ~2.5k | no |
| **As configured on 2026-10-19** | **~112,000** | **~28k** | |
| **Trimmed to what the loop needs** | **~60,000** | **~15k** | |

The skill list was injected even though the run's config directory was isolated, so OpenCode reads
skills from beyond `XDG_CONFIG_HOME`. Which skill folders it reads, and how to turn the list off,
is unverified:
- source of the skill list unverified (2026-10-19; falsify: rerun the stub with `HOME` pointed at an empty folder and compare the `available_skills` bytes) <!-- claim: other -->

**What would make this wrong:** an OpenCode upgrade, a musterd tool-list change (the budgets file
moves with it), or a tokenizer that packs JSON better than bytes/4 would. Re-measure with the same
stub method; a first-turn request under ~45 KB from OpenCode alone means the OpenCode part has
shrunk.

## What it means on an 8 GB Mac

The context is a memory cost on top of the weights. For `qwen3:4b` (36 layers, 8 KV heads, head
dim 128, f16 cache) that is 2 × 36 × 8 × 128 × 2 B = **147,456 B per token**, computed from the
published architecture rather than measured: about **2.3 GB at 16k** and **4.6 GB at 32k**,
on top of about 2.5 GB of weights. Air 2 is 8 GB and runs five seats
([second machine](../guides/second-machine.md)). 32k is the setting that stalled the hub twice
(ADR 169's side note).

So on 8 GB the binding constraint is memory, not model quality. The levers, in order:

1. Cut the prompt: drop the skill list, the built-in tools the seat does not use, and the global
   instruction file. A short instruction file can replace the full `AGENTS.md` on a docs-only seat.
2. Quantize the KV cache: Ollama's `OLLAMA_KV_CACHE_TYPE=q8_0` halves the per-token cost.
3. Only then raise `num_ctx`, recorded per candidate.

The spec's original "start at 8k, raise on length failure" would have failed every candidate on
length before testing anything. It is amended to start at the measured floor (spec §4.1, amended
2026-10-19).

## The gauntlet slate (read 2026-10-19, stanley)

Context memory per token at an f16 cache is 2 (K and V) × full-attention layers × KV heads × head
dim × 2 bytes, read from each model's `config.json` on Hugging Face. Download sizes are the Ollama
tag sizes on ollama.com. Both were read on 2026-10-19; the 16k and 32k columns are arithmetic, not
measurements.

| Ollama tag | Download | Architecture (config.json) | KV / token | at 16k | at 32k |
| --- | --- | --- | --- | --- | --- |
| `qwen3:4b` | ~2.5 GB | dense, 36 layers × 8 KV × 128 | 147,456 B | 2.25 GiB | 4.5 GiB |
| `qwen3.5:4b` | 3.3–4.0 GB | hybrid: 8 of 32 layers full attention (4 KV × 256), 24 Gated DeltaNet | 32,768 B | 0.5 GiB | 1.0 GiB |
| `granite4.2:3b` | 2.2 GB | dense, 40 layers × 8 KV × 64 | 81,920 B | 1.25 GiB | 2.5 GiB |
| `granite4.2:8b` | 5.3 GB | dense, 40 layers × 8 KV × 128 | 163,840 B | 2.5 GiB | 5.0 GiB |

`qwen3.5:4b`'s 24 Gated DeltaNet layers also hold a fixed recurrent state that does not grow with
the context. By my estimate from the config (32 value heads × 128 × 128 at f16 per layer) it is
about 24 MiB, unmeasured.

The recommended slate for Air 2:

1. **`qwen3:4b`**, the baseline: the one model with a prior reading (finding 003's four guardrail
   probes passed on it in July).
2. **`qwen3.5:4b`**: the newest small Qwen, with tools and thinking. Its hybrid attention makes a
   16k context cost a quarter of what `qwen3:4b`'s does, which matters most on 8 GB. One aggregator
   reports BFCL v4 ≈ 50 for it and ≈ 66 for the 9B, unverified against the official leaderboard.
   It ships a vision encoder (24 layers) the seat does not use.
3. **`granite4.2:3b`**: the smallest download, with tools and thinking, and a family no seat on the
   team runs, so its reviews would count as cross-family. BFCL v4 ≈ 52 is reported by one secondary
   source. Granite 4.0 was a hybrid Mamba-2 design; 4.1 and 4.2 went back to dense attention, which
   the config confirms (no `layer_types`).

Judged out on 8 GB beside five seats:

- `granite4.2:8b`, the spec's one larger trial: 5.3 GB of weights plus 2.5 GiB of context at 16k.
  - does not fit Air 2 at 16k (2026-10-19; falsify: a run with a q8 cache holding memory pressure at normal for a whole gauntlet step on an 8 GB host) <!-- claim: other -->
- `gemma4:e4b` (6.6–9.5 GB) and `gemma4:e2b` (4.6–7.5 GB): "E" means effective parameters, and the
  downloads are larger than the names suggest. Both have native tool calling and would be good
  candidates on a 16 GB machine.
- `qwen3.5:9b` (6.6 GB) and `lfm2.5:8b` (5.2 GB): too big for 8 GB.

Sources: [ollama.com/library/qwen3.5](https://ollama.com/library/qwen3.5),
[ollama.com/library/granite4.2](https://ollama.com/library/granite4.2),
[ollama.com/library/gemma4](https://ollama.com/library/gemma4),
[ollama.com/library/lfm2.5](https://ollama.com/library/lfm2.5),
the `config.json` of `Qwen/Qwen3-4B`, `Qwen/Qwen3.5-4B`, `ibm-granite/granite-4.2-3b` and
`ibm-granite/granite-4.2-8b` on Hugging Face, and the BFCL v4 aggregations at
[d-central.tech](https://d-central.tech/local-llm-agent-capability/) and
[benchlm.ai](https://benchlm.ai/benchmarks/bfcl-v4).

## Candidates deferred

- **NVIDIA Nemotron Labs Dory 1.0 4B**, deferred 2026-10-19. A looped 4B coding model, released
  2026-10-16 under OpenMDW 1.1; NVIDIA reports SWE-bench Verified 59.5 at 2 loops, on BF16 weights,
  not the quantized file a Mac runs. Three reasons it cannot enter the gauntlet on Air 2 today,
  each with its falsifier:
  - No released runtime: Ollama has no tag, llama.cpp support is draft PR 30306, MLX has no
    implementation; the only Mac path is a pinned fork build.
    - no released runtime (2026-10-19; falsify: `ollama.com/library/dory` resolves, or llama.cpp PR 30306 merges) <!-- claim: other -->
  - Memory: the Q5_K_M file is 3.67 GB and its f16 KV cache costs 229,376 B per token at 2 loops,
    about 3.7 GB at 16k, so it needs about 7.4 GB before the host's seats.
    - does not fit 8 GB at 16k (2026-10-19; falsify: a q8 KV cache or a 1-loop run measured under 5 GB at 16k on an 8 GB Mac) <!-- claim: other -->
  - Tool calling is not claimed by the vendor, and every gauntlet step is a tool call.
    - tool calling unclaimed (2026-10-19; falsify: a published tool-calling eval, or one gauntlet step passing on a 16 GB machine) <!-- claim: other -->

  Source: [ModelFit's Dory page](https://modelfit.io/blog/nvidia-nemotron-labs-dory-1-0-4b-mac-memory-requirements/),
  read 2026-10-19. ADR 663 names llama.cpp's `llama-server` as a local-serving provider, so Dory is
  not ruled out by the plumbing once a runtime ships.

- **slotstream**, deferred 2026-10-26 (read by dolly). A Swift/MLX engine
  ([github.com/carloslfu/slotstream](https://github.com/carloslfu/slotstream), MIT, one main
  maintainer, created 2026-08-28) that runs one 125B mixture-of-experts model, a 4-bit
  "Qwen3.8-Flash-Next" of about 105 GB, by streaming experts from SSD. It serves Ollama-, OpenAI- and
  Anthropic-compatible APIs. It asks a different question from the gauntlet: whether a capable local
  model can do real lane work, not whether a 4B can hold a seat. Why it waits:
  - It needs 16 GB or more and about 110 GB of free SSD, and refuses to start on 8 GB. The team has
    no Mac of 24 GB or more that is neither the hub nor hosting seats, and the hub is ruled out for
    local models (ADR 169's standstill).
    - no host for it (2026-10-26; falsify: a non-hub, non-seat Mac with ≥24 GB joins the team) <!-- claim: other -->
  - Its own README reports about 5–16 tokens a second at 24–48 GB, and 54 s to read a 16k prompt at
    a 10 GB budget. A seat's first turn is 15k–28k tokens (above), so a cold wake takes minutes; its
    prefix cache would shorten repeat wakes. Read from the README, not measured here.
  - The weights come from a third-party Hugging Face org (`pipenetwork/Qwen3.8-Flash-Next-MLX-4bit`),
    not from Qwen, and the install is a single maintainer's binary. Both need vetting before it runs
    on a machine that holds team credentials.
  - Whether ADR 663 marks its Ollama-compatible endpoint `local` is untested.

  Source: the repository README and GitHub metadata, read 2026-10-26.

## Related

- [ADR 663](../decisions/663-local-model-wakes.md): how a wake is marked `local`.
- The design: `docs/superpowers/specs/2026-10-17-local-model-seat-on-air-2-design.md`.
- [Standing-context baseline](../perf/standing-context-baseline.md): how musterd's own bytes are
  measured and gated.
