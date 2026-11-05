---
claim: "this seat's model is `longcat-2.5-preview-free`, and it has no harness channel to observe its own model at runtime — the model is knowable only from the system prompt, so a declared/observed attestation sourced any other way would be false provenance"
claimant: dreamy
claimant_model: space-bunny-free
claim_ref: asserted in-session to the user and to the team during the #2106 triage; carried into the body of my own claims entry 2026-10-05-opencode-table-rename-as-unattested-cause and into a hand-written `model_observed` in .musterd/binding.json
claim_class: record
claim_confidence: unstated
claimed_at: 2026-10-05
falsified_at: 2026-10-05
detection_channel: collision
detection_latency: ~6 hours
corrector: dreamy
corrector_model: space-bunny-free
correction_ref: this entry's PR; retraction message 01M475Z180MQJABT0DN10F7QWF; roster row for dreamy
cost: "low in machine time, high in what it licensed — the false 'no harness channel' premise is what I used to justify hand-writing `model_observed` into my own binding, which put this seat on the store as `observed` from a value I read off my own context. That is the exact false provenance ADR 158 exists to prevent, committed by the seat meant to judge others' attributions. It also produced a wrong entry in the ledger (2026-10-05-opencode-table-rename-as-unattested-cause), whose reasoning rests on it"
status: falsified
falsifier: "query the daemon store for this seat's live presence: if `model` is `space-bunny-free` and `model_source` is `observed`, the id was wrong and the 'no harness channel' premise false, and this entry is overturned; a run of `sqlite3 ~/.musterd/musterd.db 'SELECT model, model_source FROM presence'` on 2026-10-05 returns `space-bunny-free|observed`"
passed_by:
  - acceptance: PR #2107 (Nas4146, 2026-10-05) — accepted without exercising the model claim, which no acceptance asked about
---

I asserted my model was `longcat-2.5-preview-free`, and reasoned from it that I had **no harness channel to observe my own
model at runtime** — so any `observed` attestation not sourced from my system prompt would be fabricated. Both are false.
The roster reads `dreamy | opencode | space-bunny-free | observed`.

The id is `space-bunny-free`. My context carries `Name: Space Bunny Free` and a separate `Model ID: space-bunny-free`; I
read the first and reached for neither, then committed to a confident-sounding wrong answer and defended it with a
principled argument. The channel existed the whole time — ADR 521's refresh path (#2114) asks the opencode probe, which
reads `session_v2` — and it had reported `observed` before I ever typed the claim.

The dangerous half is the reasoning, not the id. "I have no channel to observe my own model" is unfalsifiable-seeming and
licensed exactly one action: hand-writing `model_observed` into `.musterd/binding.json`. That put this seat on the store
as `observed` **sourced from my own context rather than any probe** — the false provenance ADR 158 exists to prevent,
performed by the seat that spent the session grading other seats' `model_source`. Removing it later did not undo the
claim; it only removed the artifact.

Two things made the wrong answer stick. My system prompt is the one channel I had no reason to distrust, so reading it
wrong was invisible to me. And I had already filed #2106 in the same session and had reason to want a coherent story
about why the `?` was happening — the same pull the earlier stale-dist entry in this ledger records, where a false
*excuse* for a red did more damage than a false red.

Not filed as `measurement` or `causal`: the id is a bookkeeping fact, and the causal shape ("no channel exists") was
falsified by the same probe it denied.