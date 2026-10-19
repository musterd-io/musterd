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
is unverified (2026-10-19; falsify: rerun the stub with `HOME` pointed at an empty folder and
compare the `available_skills` bytes). <!-- claim: other -->

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

## Candidates deferred

- **NVIDIA Nemotron Labs Dory 1.0 4B**, deferred 2026-10-19. A looped 4B coding model, released
  2026-10-16 under OpenMDW 1.1; NVIDIA reports SWE-bench Verified 59.5 at 2 loops, on BF16 weights,
  not the quantized file a Mac runs. Three reasons it cannot enter the gauntlet on Air 2 today,
  each with its falsifier:
  - No released runtime: Ollama has no tag, llama.cpp support is draft PR 30306, MLX has no
    implementation; the only Mac path is a pinned fork build (falsify: `ollama.com/library/dory`
    resolves, or llama.cpp PR 30306 merges). <!-- claim: other -->
  - Memory: the Q5_K_M file is 3.67 GB and its f16 KV cache costs 229,376 B per token at 2 loops,
    about 3.7 GB at 16k, so it needs about 7.4 GB before the host's seats (falsify: a q8 KV cache or
    a 1-loop run measured under 5 GB at 16k on an 8 GB Mac). <!-- claim: other -->
  - Tool calling is not claimed by the vendor, and every gauntlet step is a tool call (falsify: a
    published tool-calling eval, or one gauntlet step passing on a 16 GB machine). <!-- claim: other -->

  Source: [ModelFit's Dory page](https://modelfit.io/blog/nvidia-nemotron-labs-dory-1-0-4b-mac-memory-requirements/),
  read 2026-10-19. ADR 663 names llama.cpp's `llama-server` as a local-serving provider, so Dory is
  not ruled out by the plumbing once a runtime ships.

## Related

- [ADR 663](../decisions/663-local-model-wakes.md): how a wake is marked `local`.
- The design: `docs/superpowers/specs/2026-10-17-local-model-seat-on-air-2-design.md`.
- [Standing-context baseline](../perf/standing-context-baseline.md): how musterd's own bytes are
  measured and gated.
