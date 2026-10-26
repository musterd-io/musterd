# Seat-credential recovery — a workspace whose binding lost its `msac_`

After a team's bootstrap cutover, a workspace whose binding still carries the retired team key 401s on every routine call while `claim` still says the seat is live — and the repair is a local-first seat-credential rotate, not a re-claim and not a mint.

## The trap

Once a team runs `musterd team bootstrap cutover` ([ADR 350](../decisions/350-retire-legacy-team-bootstrap-key.md)), every routine call must carry the seat credential (`msac_`, [ADR 077](../decisions/076-v0.3-p3-1-credential-grant-substrate.md) §prefix dispatch). A workspace whose binding has only the retired `mskey_` (or a `claim_seat` bootstrap key) gets refused on all of them with the same sentence: *a bootstrap key only claims a seat; routine calls need the seat credential that claim returns*.

It looks reparable with `claim` and is not: claim is the one verb a key-holder may still perform,
so it succeeds (it re-occupies the seat and refreshes the lease) while restoring nothing the key
cannot authenticate with. Observed on this team, 2026-10-26 (ghost): `musterd claim` printed
`already live on revive in this folder` twice, and `GET /teams/<slug>/inbox` still returned 401 each
time; the same-401 span in the slice of daemon `http_request` log I read runs 2026-10-26 06:12 to
12:25 UTC over `/inbox`, `/telemetry/tool-calls` and `/trace/events` (an older slice had rotated
away, so treat "days" as unproven here). <!-- claim: defect --> Falsify: after any repair that only
re-claims, run `musterd inbox` — it exiting 4 with the bootstrap-key sentence while `claim` exits 0
is what a missing seat credential looks like; an inbox that prints means the claim was the broken
piece and re-claiming was the fix.

The same-shaped wall, cousin not twin: a stale CLI build prints a *different* refusal — `your CLI build … differs from the daemon` on `musterd status` — and its fix is a rebuilt checkout plus a re-claim (ADR 135), not a rotate. Triage on that string before touching anything below.

## The mint is a dead end here

The refusal text's own suggestion, a team admin's `musterd team bootstrap mint --seat <seat> --install`, does not repair it — deliberately, not incidentally. The mint issues a *scoped bootstrap credential* ([ADR 344](../decisions/344-scoped-rotatable-agent-bootstrap-credentials.md)), which is another claims-only `mskey_`: minting, installing, and then `claim --key <that>` re-occupies the seat and restores routine calls 401-per-401. Observed 2026-10-26 (ghost, the mint returned a `mskey_`-prefixed key at 07:17 UTC; a claim with it landed at 07:19; the first `inbox` after it still 401'd). <!-- claim: defect --> Falsify: if a minted-and-installed key did restore routine calls, the first inbox after the claim would exit 0 — it did not on try 1 or try 2, and the provider-stop shipper would have shipped it.

(The ADR 662 detour this road cost an afternoon: the mint is a `credential_mint` high-authority act, so an admin who reaches it anyway then hits *authority refused (no_signature)* from a signature that would have been spent for nothing. See the follow-up lane: the CLI mint does not even collect that proof — `commands/team.ts` has no `no_signature` retry, unlike `setPolicySigned`, `send` and the lane-verdict rail.)

## The repair

`POST /teams/<slug>/members/<seat>/agent-seat-credential/rotate` — the rotate exists for exactly this lost-credential shape and it is local-first by design: `authProvision` with `humanAdminRequired: false` returns early for a loopback peer on a self-hosted daemon (`trustsLocalPeer`, `packages/server/src/cloud/localTrust.ts` — cloud mode never takes this path). It mints a fresh `msac_`, revokes the seat's stale session leases, and returns the credential once. Serving only agent seats is the same guard's other half — a human seat's rotate demands the human-admin credential, so the local trust can never manufacture one.

Steps, run from the seat's own machine (observed working 2026-10-26; the `musterd inbox` right after printed a full day of history):

1. `curl -X POST "http://localhost:4849/teams/<slug>/members/<seat>/agent-seat-credential/rotate"` → the body carries `seat_credential`.
2. Write it into the workspace binding at `.musterd/binding.json` as `seat_credential` — the field the claim merge-guard reads and the first field `bindingCredential` checks (`packages/cli/src/commands/helpers.ts`). Never print the secret in the act log or on screen (hard rule 5); a redirect-to-file plus script beats a shell echo.
3. `musterd claim` — it re-occupies with the new credential and the seat is ordinary again.

Falsify the whole recipe by the refusal, not the ritual: after step 3, `musterd inbox` must exit 0 on the first try; a second identical-success inbox proves nothing further, and an inbox that still 401s means the rotate hit a different member row than the binding's `claim.name` — check the two names first.

One cost to expect, not fear: the rotate revokes existing session leases for that seat (`agent_session_lease.revoked` audit rows, `reason: credential_rotated`), so a wake mid-flight of that seat may fail once around the repair and the next wake takes it. Observed 2026-10-26: no teardown beyond the revoked lease rows. <!-- claim: other --> Falsify: the seat's wake log around the rotate shows a `FAILED` row whose lease id is one of the revocation rows — if the host loop keeps waking on a revoked lease, this paragraph is wrong.

Related: [An authorised migration with no owner does not happen](authorised-but-unowned.md) — the cutover this trap lives behind, and the page that caught it shipping half-run; [ADR 662](../decisions/662-one-machine-per-hosted-seat.md) — why nothing here lets an agent exercise a human credential: the rotate mints an agent-kind `msac_` only.
