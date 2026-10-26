# Local model gauntlet

The pre-registered setup for the local model gauntlet on Air 2: the seat, the candidate slate, the Ollama and OpenCode settings, the memory watcher, and the table each candidate's result goes into.

Lane `01M55R1FN3M1BPFQ5J5RH2QGX1`. The design, the five steps and the verdict rule are in spec §4.1–4.2
(`docs/superpowers/specs/2026-10-17-local-model-seat-on-air-2-design.md`); this page fixes what the
spec left to the day. nick runs it on Air 2. Written 2026-10-26 by dolly, before any model is pulled.

## The seat

**swan**, a new roster seat created by nick on Air 2 (a new seat, so its history is only this run).
OpenCode harness. Its binding carries `local: true` (ADR 663). Set it only once Air 2's CLI and
adapter run a build that knows the field: an older `BindingSchema` refuses the binding and the seat
goes quiet.

## The slate (fixed 2026-10-26, in this order)

| # | Candidate | Ollama model | Why it is here |
| --- | --- | --- | --- |
| 1 | Qwen3.5 4B | `qwen3.5:4b` | The comparison point: the best-known small model with tools and thinking. Replaces `qwen3:4b` as the baseline. |
| 2 | Spark-X2.6-4B | `hf.co/bartowski/Spark-X2.6-4B-GGUF:Q4_K_M` | The newest (released 2026-10-21, Apache 2.0). Sliding-window attention on 27 of 36 layers keeps context cheap. |
| 3 | MiniCPM5-2B | `openbmb/minicpm5-2b` | The best published BFCL v4 under 4B (66.6, vendor-reported). The smallest download. |
| 4 | Granite 4.2 3B | `granite4.2:3b` | Optional: a model family no seat on the team runs, so its reviews would count as cross-family. |

Memory, from each model's `config.json` at an f16 cache (arithmetic, not measured; a q8 cache halves
the context columns):

| Candidate | File | KV / token | Context at 16k |
| --- | --- | --- | --- |
| `qwen3.5:4b` | 3.3–4.0 GB | 32,768 B (8 of 32 layers) | 0.5 GiB |
| Spark-X2.6-4B Q4_K_M | 2.62 GB | 36,864 B on 9 full-attention layers, plus a fixed ~57 MB for 27 layers with a 512-token window | ~0.6 GiB |
| MiniCPM5-2B Q4_K_M | 1.56 GB | 43,008 B (42 layers × 2 KV heads × 128) | 0.66 GiB |
| `granite4.2:3b` | 2.2 GB | 81,920 B | 1.25 GiB |

Known risks, each checked by the gauntlet itself, not before:

- **Spark-X2.6-4B: who publishes it is unclear.** The Hugging Face account is `XHToken`, and the
  model card names the lab SparkLLM. One third-party site links it to iFlytek; the card does not.
  Its benchmarks appear only as charts. Its official Ollama tag is the 8.2 GB BF16 file, which does
  not fit, hence the community Q4 file. It needs Ollama 0.34.1 or later.
- **MiniCPM5-2B: tool calls are XML.** OpenBMB ships a `minicpm5` parser for vLLM and SGLang. Its
  Ollama page does not list the `tools` capability. If step 1 shows no tool call reaching OpenCode,
  record that as the failure; llama.cpp's `llama-server` is the other runtime ADR 663 accepts.
  Independent write-ups report it weak on long agent runs (Terminal-Bench 8.6 against 25.8 for
  `qwen3.5:4b`).

Considered and left out on 2026-10-26:

- **Nanbeige4.2-3B:** it runs its 22 layers twice. That is about 180 KB of cache per token, 2.75 GiB at 16k.
  An independent paper ([arXiv 2608.13987](https://arxiv.org/abs/2608.13987)) found the released
  checkpoint completed 0% of agentic tasks until patched.
- **LFM2.5-2.6B:** the cheapest context of all (16,384 B per token). Liquid AI says it is not meant
  for agentic coding, and it writes Pythonic tool calls. It is the first reserve if every candidate
  fails on memory.
- **Dory 4B**, **Gemma 4 E2B/E4B**: see [local model context floor](local-model-context-floor.md).
  Qwen3.6 and 3.8 have no size under 27B.

## Ollama on Air 2

Set before the first pull, in the environment of the Ollama server:

```sh
OLLAMA_MAX_LOADED_MODELS=1     # one model at a time
OLLAMA_KEEP_ALIVE=5m           # unload when idle, so memory returns to the seats
OLLAMA_FLASH_ATTENTION=1       # required for a quantized KV cache
OLLAMA_KV_CACHE_TYPE=q8_0      # halves the context cost
OLLAMA_CONTEXT_LENGTH=16384    # the trimmed floor (~15k) rounded up to the next 4k
```

The OpenAI-compatible endpoint takes no `num_ctx` per request, so the context is set on the server.
Record the value used per candidate. If a candidate fails for length, raise it by 4k and record
that.

## swan's workspace `opencode.json`

In swan's workspace, never in `~/.config/opencode/`: a global pin would relabel all five seats on
Air 2. Swap `model` per candidate (`ollama/` plus the Ollama model name from the slate).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen3.5:4b",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (Air 2)",
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": {
        "qwen3.5:4b": {},
        "hf.co/bartowski/Spark-X2.6-4B-GGUF:Q4_K_M": {},
        "openbmb/minicpm5-2b": {},
        "granite4.2:3b": {}
      }
    }
  }
}
```

Use the `provider` key, not `providers`. OpenCode 2.1 marks `provider` deprecated, and its
replacement `providers` moves the base URL under `settings`. musterd's ADR 663 check
(`packages/cli/src/host/backends/opencodeLocal.ts`) reads only `provider.<id>.options.baseURL`, so a
config written in the new shape is not marked `local`.
- ADR 663 does not read the `providers` shape (2026-10-26; falsify: a wake on a workspace whose `opencode.json` uses only `providers` records `unpriced_reason: local`) <!-- claim: other -->

The prompt trims from [the context floor](local-model-context-floor.md) (the skill list, unused
built-in tools, the global instruction file) are not in this file. Where OpenCode 2.x reads the
skill list from is still unverified there. Measure swan's first request with the same stub method
before candidate 1, and record the bytes here.

## The memory watcher

Runs on Air 2 for the whole gauntlet. It samples every 5 s. On the first **warn** reading while a
model is loaded, or when two samples in a row are missed, it unloads the model and raises a
notification. Peak per candidate comes from its log.

```sh
#!/bin/zsh
# swan-memwatch: spec §4.1's sampler and §4.5's first kill trigger.
log=~/swan-memwatch.log
last=$(date +%s)
while true; do
  now=$(date +%s)
  level=$(sysctl -n kern.memorystatus_vm_pressure_level)   # 1 normal, 2 warn, 4 critical
  swapins=$(vm_stat | awk '/Swapins/ {gsub(/\./,"",$2); print $2}')
  model=$(ollama ps 2>/dev/null | awk 'NR==2 {print $1}')
  echo "$(date -u +%FT%TZ) level=$level swapins=$swapins model=${model:--}" >> $log
  if [[ -n $model ]] && { (( level >= 2 )) || (( now - last > 15 )); }; then
    ollama stop "$model"
    echo "$(date -u +%FT%TZ) KILL model=$model level=$level gap=$((now - last))s" >> $log
    osascript -e "display notification \"unloaded $model (level $level)\" with title \"swan-memwatch\""
  fi
  last=$now
  sleep 5
done
```

Swap-ins climbing during an act are read from the log afterwards; the script does not act on them.
The other §4.5 triggers (another seat's wake failing, the hub pull timing out, load average above 8
for five minutes, a hand unload) are nick's to watch.

## The wake watchdog (spec §5, decided here)

The host loop's `--timeout` defaults to 300 s and is a ceiling for every seat on the host. At finding
003's 50–60 s per act, a ten-act drain in one wake can exceed it. Decided: **split the drain, do not
raise the host timeout.** The unread inbox persists across wakes, so the next wake continues the
drain. Step 3 passes when all ten acts are read with no human help, over however many wakes. Each
watchdog kill is recorded with its wake, and is not counted as a model failure.

## Results

One row per candidate, filled as each finishes. The verdict rule is the spec's: a failure at step 1
or 2 drops the candidate; one at 3–5 is recorded and drops it unless nothing passes.

| Candidate | Orient | Attest | Drain | In-thread | Claim+submit | s/act (median, worst) | Peak pressure | `num_ctx` | Kept? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `qwen3.5:4b` | | | | | | | | | |
| Spark-X2.6-4B | | | | | | | | | |
| MiniCPM5-2B | | | | | | | | | |
| `granite4.2:3b` | | | | | | | | | |

## Sources

Read 2026-10-26: the `config.json` of each model on Hugging Face (`Qwen/Qwen3.5-4B`,
`XHToken/Spark-X2.6-4B`, `openbmb/MiniCPM5-2B`, `ibm-granite/granite-4.2-3b`, `Nanbeige/Nanbeige4.2-3B`,
`LiquidAI/LFM2.5-2.6B`); file sizes from `bartowski/Spark-X2.6-4B-GGUF` and `openbmb/MiniCPM5-2B-GGUF`;
[ollama.com/openbmb/minicpm5-2b](https://ollama.com/openbmb/minicpm5-2b);
[ollama.com/SparkLLM/Spark-X2.6-4B](https://ollama.com/SparkLLM/Spark-X2.6-4B);
[MarkTechPost on MiniCPM5-2B](https://www.marktechpost.com/2026/09/07/openbmb-releases-minicpm5-2b-a-2-52b-dense-model-averaging-53-9-across-34-benchmarks-and-built-to-run-on-device/);
[explainx on Spark-X2.6-4B](https://explainx.ai/blog/spark-x2-6-4b-open-weights-on-device-model-claims-vs-verified-2026);
[BenchLM BFCL v4](https://benchlm.ai/benchmarks/bfcl-v4); OpenCode's schema at
`https://opencode.ai/config.json` (OpenCode 2.1.4).
