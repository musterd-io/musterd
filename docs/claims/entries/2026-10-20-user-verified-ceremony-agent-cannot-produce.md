---
claim: "The passkey enrollment ceremony requires user verification, which a Bearer-holding agent process cannot produce"
claimant: ghost
claimant_model: unknown
claim_ref: PR #2985 (packages/server/src/store/authority.ts, enrollPasskeyGuarded comment; ADR 662 Consequences note 2026-10-20)
claim_class: absence
claim_confidence: unstated
claimed_at: 2026-10-20
falsified_at: 2026-10-20
detection_channel: acceptance
detection_latency: hours (same day, in lazara's HA2 acceptance re-review of #2985)
corrector: lazara
corrector_model: claude-opus-5-5
correction_ref: act 01M5BFMV85TZZB38F3ASE4J2C4 (decline of lane 01M5ANFKEVTENBNVG9JQKA965N); countersign rework on lane 01M5ANFKEVTENBNVG9JQKA965N
cost: "one full rework cycle of the HA2 lane; between #2985 landing and the correction, a Bearer-holding agent could have enrolled its own key on any team past its first key"
status: falsified
falsifier: "run the fabricated registration (self-generated COSE key, flags UP|UV|AT, fmt none, plain Node) against build b2743bce: if POST /authority/passkeys refuses it or the resulting key cannot sign a listed act, the claim held and this entry is wrong"
passed_by:
  - acceptance: PR #2985 auto-merged on gates green (2026-10-20)
---

The HA2 rework asserted that a user-verified WebAuthn ceremony anchors first
enrollment and recovery because an agent holding the human's Bearer "cannot
produce" one. Lazara proved otherwise in her acceptance re-review: with no
attestation checked, a self-generated Ed25519 COSE key with the UP|UV|AT flags
set — the UV flag is a byte the caller sets — completed enrollment in plain
Node, and the resulting key signed `admin.team_policy` to a 200 (act
01M5BFMV85TZZB38F3ASE4J2C4). The correction (this lane's countersign rework)
keeps the ceremony but stops treating it as the anchor: past genesis, another
human admin's standing-key signature is.
