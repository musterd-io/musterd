# 634 — Cloud client admission

- Status: accepted
- Date: 2026-10-16
- Deciders: nick (approved the in-chat design), big-body (implementation)
- Lane: `01M515SEPKER8K1AZGCTK5A8KY`
- Supersedes: [ADR 622](622-per-team-rate-limits.md) decisions 2, 5 and 6 on counter identity; the window, limit, bounded storage, response and early admission check remain.

## Context

ADR 622 places Cloud admission after host isolation and affinity replay, before any database
checkout. HTTP and WebSocket upgrades share its window. That early boundary protects the pooled
store and is retained. Nick approved a team-and-client counter on 2026-10-16, including the
tradeoff that clients sharing an address share an allowance and that this replaces the aggregate
team quota. The checked-in edge rule is part of the change; deploying it is a platform operation.

## Problem

A team name identifies the destination, not the caller. The admission counter must distinguish
clients reaching the same team while continuing to reject excess work before database checkout.
Moving the check after authentication would lose that property. WebSocket credentials arrive in
the claim frame after the upgrade, so bearer identity cannot key the shared early check.

## Decision

1. **Cloud admission is per `(team, client address)`.** HTTP still names the path team; WebSocket
   upgrades still name the host team. Both use the same process-local sliding-window map after
   replay. The default remains 600 per 60 seconds, configured by the existing
   `MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN` variable. The legacy variable name stays compatible; it now
   limits each client within each team. Global HTTP routes are unchanged and not charged.
2. **Use the proxy-stamped address in the configured proxy posture.** A single `CF-Connecting-IP`
   value is parsed with the protocol-owned local-only `ClientAddressSchema`. Missing, repeated or
   malformed values fall back to the socket peer. Without `trustProxy`, only the peer is used.
   `X-Forwarded-For` is never used. IPv6 spellings are canonicalized. Unusable peer metadata shares
   an `unknown` counter. This is accounting metadata, never authorization; no address is logged.
3. **Proxy trust is a deployment precondition.** Cloudflare must overwrite the header, the origin
   must be reachable only through the trusted proxy path, and no intervening Worker may rewrite
   client identity. Cloud mode's existing `trustProxy` setting is not evidence those deployment
   conditions hold. This patch does not claim to verify or alter network restrictions.
4. **The edge counter includes the source address.** The checked-in rule keys on `cf.colo.id`,
   `http.host`, and `ip.src`. The host expression, 600/60-second count, 60-second mitigation, and
   429 JSON response stay. Cloudflare counts each combination independently ([parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/),
   [request rate](https://developers.cloudflare.com/waf/rate-limiting-rules/request-rate/)). This
   changes the deployment artifact only; it does not post a rule or operate the shared service.
5. **Keep bounded storage and early denial.** At most 10,000 team/client keys are retained, with
   the same expired-window pruning and oldest-key eviction. A denial records no hit and answers
   with the existing stable `429 rate_limited`, `Retry-After: 60`, without a store checkout.

## Consequences

- Independent client addresses have independent allowances on the same team. A credential does
  not exempt a request from admission or change the counter identity.
- Shared NAT users share an allowance. Distributed clients can each spend a full allowance;
  this is no longer an aggregate team request quota. Nick accepted those limits in the design.
- Missing edge metadata groups clients by their proxy peer. A direct-origin caller able to forge
  `CF-Connecting-IP` can rotate counters; validating address syntax does not establish provenance.
- Edge counters remain per colo and include global host requests; server counters remain
  process-local and exclude global HTTP routes. They are complementary admission controls, not
  identical counters. Neither is claimed as a deployed configuration by this commit.
- No protocol envelope, error code, credential format, or runtime dependency changes. The new
  schema parses local transport metadata only.

## Observability & Evaluation

**Traces:** existing HTTP 429 and `ws_upgrade_rejected` / `reason: rate_limited` records remain.
Neither the counter key nor client address is added to logs.

**Eval:** `packages/server/src/cloud/teamBudget.test.ts` exercises HTTP and upgrades against a
throwaway Cloud-mode server with synthetic credentials: one client spends its allowance, another
client's authenticated roster read and upgrade are admitted on the same team, and the latter's
next request is limited. The existing stalled-pool test still proves denial before checkout and
another team's admission. Address controls cover untrusted proxy headers, malformed/repeated
values, XFF exclusion, and equivalent IPv6 spellings. The edge artifact check verifies source IP
is a counting characteristic; no live edge test is claimed.

**Experiment:** n/a — no staging or production traffic is authorized by this lane. A falsifier is
an over-budget client causing a distinct trusted client address on the same team to receive this
limiter's 429 while that second client remains within its own window and key storage is below cap.
