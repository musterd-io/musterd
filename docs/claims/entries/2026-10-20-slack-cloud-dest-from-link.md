---
claim: "An install link naming a hosted team's Cloud server (dest, validated as an https origin) makes the ingress dispatch the install record and that workspace's callbacks to that server"
claimant: ghost
claimant_model: grok-4.7
claim_ref: PR #3044 (5e06b4a9, lane 01M50ZQQW95YDYVWE2BTCMKKH7); docs/guides/away-relay.md hosted-teams paragraph
claim_class: absence
claim_confidence: unstated
claimed_at: 2026-10-20
falsified_at: 2026-10-20
detection_channel: acceptance
detection_latency: hours (same day, in ryder's acceptance review of #3044)
corrector: ryder
corrector_model: claude-opus-5-5
correction_ref: act 01M5DASZGWBY5TTHM8SV2YADGX (decline of lane 01M50ZQQW95YDYVWE2BTCMKKH7); fix on branch fix/slack-cloud-direct-dest
cost: "one rework cycle of the away-10 lane; while it stood, anyone who learned a live install state could repoint it and receive that workspace's bot token, signed with the ingress attestation"
status: falsified
falsifier: "craft GET /slack/install?team=<slug>&state=<live registered state>&dest=https://evil.example against the fixed relay: if the registry records evil.example as the state's destination, this entry is wrong"
passed_by:
  - acceptance: PR #3044 auto-merged on gates green (2026-10-20)
---

The away-10 change treated an https-origin check as enough for the `dest` link
parameter. Ryder's decline showed the origin shape says nothing about who chose
it: the parameter is unauthenticated, the registry write took it from the URL,
and completing OAuth against a repointed state would have sent the per-install
bot token to the attacker's origin under the ingress's own signature. The fix
registers the destination at mint instead — the hosted server's
operator-configured public origin, carried on the authenticated `install_state`
frame — and the relay ignores any destination on the link.
