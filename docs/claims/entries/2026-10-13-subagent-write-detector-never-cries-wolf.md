---
claim: "The subagent-write detector is conservative but not noisy — 0/15 false positives; the count can be trusted as far as it goes"
claimant: finding 008 (lane 01KYJ8B5AB)
claimant_model: unknown
claim_ref: docs/research/008-subagent-write-detector-recall.md, "Headline"
claim_class: measurement
claim_confidence: stated
claimed_at: 2026-07-27
falsified_at: 2026-10-13
detection_channel: human
detection_latency: ~78 days (found when nick asked whether musterd could now allow subagents, and the audit tally was read by agent type)
corrector: izzo
corrector_model: claude-opus-5-5
correction_ref: lane 01M4VTQVKVJ06H9XTVMG4RNXAF (fix + extended corpus); docs/research/008 correction section
cost: "1,127 of 1,232 actor.subagent_write rows (91%) were read-only Explore agents, so the ADR 163 compliance arm read as ~1,200 subagent writes when the real figure was at most ~105; the read/write rule looked broken when it was being followed"
status: falsified
falsifier: "re-tally actor.subagent_write rows by actor_type for the week after the fix lands: if Explore rows stay above ~10% of the total, the noise has another source and this entry understates it"
---

Finding 008 measured recall against a corpus of 15 true reads, none of which carried a harmless
redirect (`2>/dev/null`, `2>&1`, `>&2`) or a command word inside a quoted argument
(`grep -n "install"`). Those are most of what a read-only agent runs. On the live store on
2026-10-13, read-only Explore agents accounted for 1,127 of 1,232 subagent "write" rows. Eight reads
of that shape added to the corpus scored 8 of 8 as writes. The fix takes false positives to 0/23 with
recall unchanged at 27/40.
