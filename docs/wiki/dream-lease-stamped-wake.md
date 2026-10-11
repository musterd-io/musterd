# Dream lease file stamped wake

A dream wake writes `.musterd/wake-lease.json` with `provenance: "wake"` even when Presence settles to dream.

## The literal stamp

`holdWakeLease` in `packages/cli/src/host/wakeLeaseFile.ts` writes `provenance: 'wake'` as a literal, for every harness that uses it. The file is the take-over handle ([wake take-over per harness](wake-take-over-per-harness.md)); the derivation on Presence is a different field.

A dream wake's `.musterd/wake-lease.json` stamps `provenance: "wake"` (2026-10-08 wanderer grok 01M4FJV48NB6CEZP908FRWH5XX and lazara Claude Code 01M4GF95C3JYCCZ5X9ZWN8SF6D; seen again 2026-10-10 grokbot grok lease 01M4MQ12BP7KNQ91Q6QFJHJF97, insight 01M4MQE6XRWPSHJ7FWRP7T0WWV; falsify: `holdWakeLease` on origin/main writes the lease derivation instead of the literal `wake`, or a dream wake's `.musterd/wake-lease.json` `provenance` field reads `dream`) <!-- claim: defect -->

`.gitignore` on origin/main still has no `wake-lease.json` line, so the file also dirties porcelain. The lease_id matches the wake that just started, so it is written after the freshen check and is not the line that skipped it — see [dream wake checkout](dream-wake-checkout.md).

Related: [wake leases](wake-leases.md), [wake take-over per harness](wake-take-over-per-harness.md), [dream wake checkout](dream-wake-checkout.md).
