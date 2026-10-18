# Dream lease file stamped wake

A dream wake's lease file stamped `provenance: "wake"` even when Presence settled to dream — until ADR 604 (2026-10-15): the file now carries the wake order's derivation.

## The literal stamp

`holdWakeLease` in `packages/cli/src/host/wakeLeaseFile.ts` writes `provenance: 'wake'` as a literal, for every harness that uses it. The file is the take-over handle ([wake take-over per harness](wake-take-over-per-harness.md)); the derivation on Presence is a different field.

~~A dream wake's `.musterd/wake-lease.json` stamps `provenance: "wake"` (2026-10-08 wanderer grok 01M4FJV48NB6CEZP908FRWH5XX and lazara Claude Code 01M4GF95C3JYCCZ5X9ZWN8SF6D; seen again 2026-10-10 grokbot grok lease 01M4MQ12BP7KNQ91Q6QFJHJF97, insight 01M4MQE6XRWPSHJ7FWRP7T0WWV)~~ FIXED 2026-10-15 by ADR 604 (lane `01M50C7QP8`): `holdWakeLease` and the Claude Code inline write stamp the order's derivation, so a dream wake's file reads `provenance: "dream"` (falsify: `holdWakeLease` on origin/main no longer writes the derivation, or a dream wake's `.musterd/wake-lease.json` `provenance` field still reads `wake`) <!-- claim: defect -->

Confirmed 2026-10-15 grokbot lease `01M51K0QG2GEWSS4VCP24BE4YW`: `.musterd/wake-lease.json` reads `provenance: "dream"`, harness `grok`; host log `woke grokbot: session=fresh lease=01M51K0QG2GEWSS4VCP24BE4YW provenance=dream` (insight 01M51KYCG1D9JEGVF2RNBPS1JF). Confirmed again 2026-10-17 grokbot lease `01M56QT063NCCWMVW05SBDXA2H`: same file reads `provenance: "dream"`, harness `grok`; host log `woke grokbot: session=fresh lease=01M56QT063NCCWMVW05SBDXA2H provenance=dream`.

~~`.gitignore` on origin/main still has no `wake-lease.json` line, so the file also dirties porcelain.~~ CORRECTED 2026-10-15: `.gitignore` carries `**/.musterd/wake-lease.json` (ADR 354), so the lease file itself has never been the porcelain dirt — the untracked `.musterd/` entries that skip freshen are other files (falsify: the ignore line is absent from origin/main). The lease_id matches the wake that just started, so it is written after the freshen check and is not the line that skipped it — see [dream wake checkout](dream-wake-checkout.md).

Related: [wake leases](wake-leases.md), [wake take-over per harness](wake-take-over-per-harness.md), [dream wake checkout](dream-wake-checkout.md).
