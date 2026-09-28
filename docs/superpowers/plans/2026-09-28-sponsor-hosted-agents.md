# Sponsor-Hosted Agents Implementation Plan

> **For agentic workers:** Implement in your own musterd seat and lane (CLAUDE.md: write work stays in a seat). Steps use checkbox (`- [ ]`) syntax for tracking. Each task is one PR on its own branch from fresh `origin/main`; the increments are ordered and each lands alone.

**Goal:** A sponsored agent gets a running process on its sponsor's own machine, provisioned by the sponsor's own `musterd host` under sponsor-scoped authority; ADR 456's takeover residual closes in server code.

**Architecture:** Server: a `host_provisions` table and two routes beside the residency wake-lease routes; a sponsor-scoped authorizer beside `authAdmin`/`authGovernance`; policy checks in `connectRefusal`, `applyPolicyChange`, invite mint, and the account-status write. CLI: the `musterd agent` seat-provisioning sequence extracted into `onboard/provisionSeat.ts`, then driven by a new provision step in `host/loop.ts`.

**Tech Stack:** TypeScript, zod (`@musterd/protocol` schemas at every boundary), better-sqlite3, vitest, pnpm workspaces. Node ≥22.

**Spec:** `docs/superpowers/specs/2026-09-28-sponsor-hosted-agents-design.md`

## Global Constraints

- Hard rule 1: **no `@musterd/protocol` schema change without an ADR.** Task 0 writes ADR 462 first; every protocol change below cites it.
- Hard rule 4: every HTTP body, tool arg and argv is parsed through a protocol zod schema at the boundary.
- Hard rule 5: never log a secret; credentials are `sha256` at rest. Provisions never carry a secret.
- Hard rule 8: implement in your seat; no writing subagents.
- Git workflow (ADR 106): branch from fresh `origin/main`, fast gates `pnpm typecheck && pnpm lint && pnpm format:check` before push, `gh pr create` + `gh pr merge --squash --auto --delete-branch`, then `lane_submit`. Commit trailer: `Co-authored-by: <seat> <seat@revive.musterd>`.
- Docs and code never disagree at the end of a commit (hard rule 3). Architecture `## File tree` blocks are drift-checked (`arch-trees:check`): every new source file gets a described line in `docs/architecture/0N-*.md`.
- Vocabulary (ADR 098): Goal / Lane / Phase / increment; `pnpm vocab:check` runs in `format:check`.
- Canonical layout (ADR 447): a provisioned workspace lives at `~/musterd/<team>/<repo>/<agent>`.
- Default `agent_connect` stays `'sponsor'`; default `invite_requires_expiry` is `false`; `agent_host.max_per_host` default 5; `agent_host.policy.budget_usd` has no default and is required for a claim.
- Provision states: `pending | claimed | ready | failed | cancelled`. Pending older than 15 minutes cancels.
- Coordinate with ghost (lane 01M3FAPB32, ADR 449 increment 3) before touching `store/sponsoredAgents.ts` — it landed as #1764; rebase onto it.

## Review Focus

1. A **sponsor host key polling wake-leases** must never receive an order for a seat the sponsor does not sponsor, even when both seats are enrolled on the same host label. Test in Task 3.
2. A member who **loses standing between claim and report** (disabled, expired, removed) must not have their provision reported `ready`; the report must be refused and the row `failed`. Test in Task 5.
3. A team whose policy is already `agent_connect: 'any_member'` must have that policy **refused at connect time** the moment any agent is hosted, not only at policy-set time. Test in Task 6.
4. A `claim_seat` mint by a sponsor for a name that is **their own agent but removed** (`left_at` set) must be refused, not minted for a tombstone. Test in Task 2.
5. The provisioner must **never re-provision an existing workspace** for a row it already reported (host restarted between report and next tick): a second claim of the same agent yields no second worktree. Test in Task 8.

---

### Task 0: ADR 462 — sponsor-hosted agents (supersedes the unmerged ADR 460)

**Files:**
- Create: `docs/decisions/462-sponsor-hosted-agents.md` (number from `pnpm adr:next`; if it is not 462, use what it prints everywhere below)
- Modify: `docs/superpowers/specs/2026-09-28-sponsor-hosted-agents-design.md` (Status line → "accepted as ADR NNN")

**Interfaces:**
- Produces: the ADR number every later commit footer cites as `Refs ADR-NNN`.

- [ ] **Step 1: Branch, push a draft PR, take the number (ADR 223: publish before writing)**

```bash
git fetch origin main && git checkout -b docs/adr-sponsor-hosted-agents origin/main
pnpm adr:next
git commit --allow-empty -m "docs(adr): reserve ADR NNN — sponsor-hosted agents" -m "Co-authored-by: stanley <stanley@revive.musterd>"
git push -u origin docs/adr-sponsor-hosted-agents
gh pr create --draft --title "ADR NNN: sponsor-hosted agents (supersedes ADR 460)" --body "Draft. Spec: docs/superpowers/specs/2026-09-28-sponsor-hosted-agents-design.md"
```

- [ ] **Step 2: Write the ADR** — skeleton per `07-conventions.md` (Context, Problem, Decision, Consequences, Observability & Evaluation). Decision = spec §3 + §4 verbatim in ADR voice; "Considered and rejected" = spec §9; Eval = Scenario D's 2-minute line plus the spec §5 falsifiers. Header lines:

```markdown
# NNN — Sponsor-hosted agents: a sponsored agent runs on its sponsor's own machine, provisioned by the sponsor's own host

- Status: proposed — 2026-09-28
- Date: 2026-09-28
- Lane: `01M3FBKS3987E8FDXC4WQ8FY6C` (goal `seat-continuity`)
- Supersedes: ADR 460 (never merged; branch `docs/adr-auto-wake-created-agents`, PR #1765 closed)
- Builds on: ADR 131 (residency), ADR 344 (seat-scoped credentials), ADR 395 (host key), ADR 447 (layout), ADR 449/452/456/459 (sponsored agents)
- Design: `docs/superpowers/specs/2026-09-28-sponsor-hosted-agents-design.md`
- Review gate: big-body (security) on Decision §1 (sponsor-scoped authority)
```

- [ ] **Step 3: Gates and land**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add docs && git commit -m "ADR NNN: sponsor-hosted agents (supersedes ADR 460)" -m "Co-authored-by: stanley <stanley@revive.musterd>"
git push && gh pr ready && gh pr merge --squash --auto --delete-branch
gh pr close 1765 --comment "Withdrawn: superseded by ADR NNN (sponsor-hosted agents)."
```

Ask big-body for the security review by `team_send {act:'request_help', to:'big-body'}` naming the PR and Decision §1.

---

### Task 1: Protocol — `agent_host`, `invite_requires_expiry`, provision schemas, `hosting` discriminator

**Files:**
- Modify: `packages/protocol/src/credentials.ts` (PolicySchema, after `sponsored_agent_cap`; PolicyOverrideSchema)
- Create: `packages/protocol/src/hostProvisions.ts`
- Modify: `packages/protocol/src/index.ts` (export the new module)
- Modify: `packages/protocol/src/residency.ts` (`WakeOrderSchema.reason`)
- Test: `packages/protocol/src/credentials.test.ts`, `packages/protocol/src/hostProvisions.test.ts`
- Modify: `docs/architecture/02-protocol.md` file tree (add `hostProvisions.ts — host provision rows, claim/report bodies (ADR NNN)`)

**Interfaces:**
- Produces:
  - `PolicySchema.agent_host: { max_per_host: number (int 1..100, default 5), policy: ResidencyPolicyOverride (default {}) }` with `.default({})`.
  - `PolicySchema.invite_requires_expiry: z.boolean().default(false)`.
  - `HostProvisionStateSchema = z.enum(['pending','claimed','ready','failed','cancelled'])`.
  - `HostProvisionSchema = { id, team, agent, sponsor, host: string|null, state, claimed_by: string|null, claimed_at: number|null, ready_at: number|null, failed_reason: string|null, created_at: number }`.
  - `HostProvisionsClaimBodySchema = { host: z.string().min(1).max(120) }`; `HostProvisionsClaimResponseSchema = { provisions: HostProvision[] }`.
  - `HostProvisionReportBodySchema = z.discriminatedUnion('state', [{state:'ready'}, {state:'failed', reason: z.string().min(1).max(200)}])`.
  - `WakeOrderSchema.reason: z.enum(['provisioned']).optional()`.
  - `SponsoredAgentHostingSchema = z.enum(['sponsor_host','connect_link'])`.

- [ ] **Step 1: Failing tests**

`packages/protocol/src/credentials.test.ts` — append:

```ts
describe('PolicySchema.agent_host / invite_requires_expiry (ADR NNN)', () => {
  it('defaults: max_per_host 5, empty policy, invites need no expiry', () => {
    const p = PolicySchema.parse({});
    expect(p.agent_host).toEqual({ max_per_host: 5, policy: {} });
    expect(p.invite_requires_expiry).toBe(false);
  });
  it('bounds max_per_host to 1..100 and keeps budget_usd optional at the schema (required at claim, not here)', () => {
    expect(PolicySchema.safeParse({ agent_host: { max_per_host: 0 } }).success).toBe(false);
    expect(PolicySchema.safeParse({ agent_host: { max_per_host: 101 } }).success).toBe(false);
    expect(PolicySchema.parse({ agent_host: { policy: { budget_usd: 2 } } }).agent_host.policy.budget_usd).toBe(2);
  });
  it('PolicyOverrideSchema keeps agent_host sparse', () => {
    expect(PolicyOverrideSchema.parse({ agent_host: { max_per_host: 2 } })).toEqual({ agent_host: { max_per_host: 2 } });
  });
});
```

`packages/protocol/src/hostProvisions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  HostProvisionReportBodySchema,
  HostProvisionSchema,
  HostProvisionsClaimBodySchema,
} from './hostProvisions.js';

describe('host provision schemas (ADR NNN)', () => {
  it('round-trips a row', () => {
    const row = {
      id: '01ABC', team: 'acme', agent: 'dana-scout', sponsor: 'dana', host: 'dana-mbp',
      state: 'claimed', claimed_by: 'dana-mbp', claimed_at: 1, ready_at: null, failed_reason: null, created_at: 0,
    };
    expect(HostProvisionSchema.parse(row)).toEqual(row);
  });
  it('a failed report needs a reason; a ready report refuses one', () => {
    expect(HostProvisionReportBodySchema.safeParse({ state: 'failed' }).success).toBe(false);
    expect(HostProvisionReportBodySchema.safeParse({ state: 'ready', reason: 'x' }).success).toBe(false);
    expect(HostProvisionReportBodySchema.parse({ state: 'failed', reason: 'clone' })).toEqual({ state: 'failed', reason: 'clone' });
  });
  it('claim body bounds the host label', () => {
    expect(HostProvisionsClaimBodySchema.safeParse({ host: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @musterd/protocol test -- credentials hostProvisions` — expect FAIL (unknown export / missing key).

- [ ] **Step 3: Implement**

`packages/protocol/src/credentials.ts`, after `sponsored_agent_cap`:

```ts
  /**
   * Sponsor-hosted agents (ADR NNN §4.2). `max_per_host` bounds live enrolled sponsored seats per
   * host label; `policy` is the residency override every provisioned seat enrolls with. `budget_usd`
   * inside it is REQUIRED for a claim to succeed — checked at claim, not here, so `parse({})` stays
   * inert and a team that never hosts never sees it.
   */
  agent_host: z
    .object({
      max_per_host: z.number().int().min(1).max(100).default(5),
      policy: ResidencyPolicyOverrideSchema.default({}),
    })
    .default({}),
  /**
   * ADR NNN §4.4.3: when true, `POST /invites` without `member_until` is refused. Required on any
   * team that sets `agent_connect: 'any_member'` (the setter enforces the pair).
   */
  invite_requires_expiry: z.boolean().default(false),
```

`PolicyOverrideSchema` — add `agent_host: z.object({ max_per_host: z.number().int().min(1).max(100).optional(), policy: ResidencyPolicyOverrideSchema.optional() }).optional()`.

`packages/protocol/src/hostProvisions.ts`:

```ts
import { z } from 'zod';

/** ADR NNN §4.2: one row per sponsored agent awaiting a process on its sponsor's host. */
export const HostProvisionStateSchema = z.enum(['pending', 'claimed', 'ready', 'failed', 'cancelled']);
export type HostProvisionState = z.infer<typeof HostProvisionStateSchema>;

export const HostProvisionSchema = z.object({
  id: z.string(),
  team: z.string(),
  agent: z.string(),
  sponsor: z.string(),
  host: z.string().nullable(),
  state: HostProvisionStateSchema,
  claimed_by: z.string().nullable(),
  claimed_at: z.number().int().nullable(),
  ready_at: z.number().int().nullable(),
  failed_reason: z.string().nullable(),
  created_at: z.number().int(),
});
export type HostProvision = z.infer<typeof HostProvisionSchema>;

/** Body of `POST /teams/:slug/host/provisions` — the host's claim poll (host-key auth). */
export const HostProvisionsClaimBodySchema = z.object({ host: z.string().min(1).max(120) });
export type HostProvisionsClaimBody = z.infer<typeof HostProvisionsClaimBodySchema>;
export const HostProvisionsClaimResponseSchema = z.object({ provisions: z.array(HostProvisionSchema) });
export type HostProvisionsClaimResponse = z.infer<typeof HostProvisionsClaimResponseSchema>;

/** Body of `POST /teams/:slug/host/provisions/:id/report`. */
export const HostProvisionReportBodySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready') }).strict(),
  z.object({ state: z.literal('failed'), reason: z.string().min(1).max(200) }).strict(),
]);
export type HostProvisionReportBody = z.infer<typeof HostProvisionReportBodySchema>;

/** How `team_agent_create` answered: a host of the sponsor's will run it, or here is the link. */
export const SponsoredAgentHostingSchema = z.enum(['sponsor_host', 'connect_link']);
export type SponsoredAgentHosting = z.infer<typeof SponsoredAgentHostingSchema>;
```

`packages/protocol/src/residency.ts` `WakeOrderSchema` — add after `lane`:

```ts
    /** ADR NNN §4.2: the one-time first wake of a freshly provisioned seat. */
    reason: z.enum(['provisioned']).optional(),
```

Export from `index.ts`: `export * from './hostProvisions.js';`.

- [ ] **Step 4: Run** the two test files — PASS. Then `pnpm --filter @musterd/protocol test` (coverage ≥95%).

- [ ] **Step 5: Docs + commit**

Add the file-tree line in `docs/architecture/02-protocol.md`. Then:

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add packages/protocol docs/architecture/02-protocol.md
git commit -m "feat(protocol): agent_host policy, host provision schemas, provisioned wake reason" -m "Refs ADR-NNN" -m "Co-authored-by: stanley <stanley@revive.musterd>"
```

---

### Task 2: Server — sponsor-scoped authority (`authSponsorOf`) on mint, grant, enroll, revoke

**Files:**
- Create: `packages/server/src/transport/authSponsor.ts`
- Modify: `packages/server/src/transport/http.ts:2704` (`/agent-bootstrap-credentials`), `:2612` (`/grants`), `:3134` (`/residency/enroll`), `:3228` (`/residency/revoke`)
- Test: `packages/server/src/transport/sponsor-authority-http.test.ts`
- Modify: `docs/architecture/03-server.md` file tree (`transport/authSponsor.ts — sponsor-scoped authorizer: a member's power over agents they sponsor (ADR NNN §4.1)`)

**Interfaces:**
- Consumes: `authMember`, `getMemberByName`, `resolveCapabilities`, `memberStandingRefusal` (store/members.ts); `bearer`, `actingSeat`, `agentSessionLease` (http.ts helpers — export them if not already).
- Produces:

```ts
export interface SponsorAuth { team: TeamRow; member: MemberRow; agent: MemberRow; sponsorScoped: true }
/** Throws `forbidden` unless caller is a live human in good standing who sponsors `agentName`, and the agent is live. */
export function authSponsorOf(ctx: Ctx, slug: string, req: IncomingMessage, agentName: string): SponsorAuth
/** Admin → admin auth; else sponsor-of. Returns `{team, member, sponsorScoped: boolean}`. */
export function authAdminOrSponsorOf(ctx: Ctx, slug: string, req: IncomingMessage, agentName: string): { team: TeamRow; member: MemberRow; sponsorScoped: boolean }
```

- [ ] **Step 1: Failing tests** — `sponsor-authority-http.test.ts` using the harness shape of `sponsored-agents-http.test.ts` (copy its `post`, `addHuman`, `beforeEach`/`afterEach` verbatim, slug `auth-t`):

```ts
describe('sponsor-scoped authority (ADR NNN §4.1)', () => {
  it('a sponsor mints a claim_seat credential for their own agent; not for another member’s', async () => {
    const dana = await addHuman('dana');
    const eve = await addHuman('eve');
    await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
    const ok = await post('/teams/auth-t/agent-bootstrap-credentials', { use: 'claim_seat', target: 'dana-scout' }, dana);
    expect(ok.status).toBe(201);
    expect(ok.json.agent_key).toMatch(/^msac_/);
    const no = await post('/teams/auth-t/agent-bootstrap-credentials', { use: 'claim_seat', target: 'dana-scout' }, eve);
    expect(no.status).toBe(403);
  });
  it('a sponsor may not mint claim_role, nor a host key for a label — only claim_seat/host for their agents', async () => {
    const dana = await addHuman('dana');
    const r = await post('/teams/auth-t/agent-bootstrap-credentials', { use: 'claim_role', target: 'research' }, dana);
    expect(r.status).toBe(403);
  });
  it('a sponsor issues a standing seat grant for their own agent only', async () => {
    const dana = await addHuman('dana');
    await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
    const ok = await post('/teams/auth-t/grants', { scope: 'seat', target: 'dana-scout', lifetime: 'standing' }, dana);
    expect(ok.status).toBe(201);
    const wrongScope = await post('/teams/auth-t/grants', { scope: 'role', target: 'research', lifetime: 'standing' }, dana);
    expect(wrongScope.status).toBe(403);
  });
  it('a sponsor enrolls and revokes residency for their own agent', async () => {
    const dana = await addHuman('dana');
    await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
    const en = await post('/teams/auth-t/residency/enroll', { seat: 'dana-scout', harness: 'claude-code', host: 'dana-mbp' }, dana);
    expect(en.status).toBe(200);
    expect(en.json.grant).toMatch(/^msgr_/);
    const rv = await post('/teams/auth-t/residency/revoke', { seat: 'dana-scout' }, dana);
    expect(rv.status).toBe(200);
  });
  it('Review Focus 4: a removed agent of the sponsor’s is not mintable', async () => {
    const dana = await addHuman('dana');
    await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
    await post('/teams/auth-t/members/dana-scout/remove', {}, nick);
    const r = await post('/teams/auth-t/agent-bootstrap-credentials', { use: 'claim_seat', target: 'dana-scout' }, dana);
    expect(r.status).toBe(404);
  });
  it('audit rows for sponsor-scoped mints carry sponsor_scoped: true', async () => {
    const dana = await addHuman('dana');
    await post('/teams/auth-t/members/agents', { name: 'dana-scout' }, dana);
    await post('/teams/auth-t/agent-bootstrap-credentials', { use: 'claim_seat', target: 'dana-scout' }, dana);
    const audit = await fetch(`${base}/teams/auth-t/audit`, { headers: { authorization: `Bearer ${nick}` } }).then((r) => r.json());
    const row = audit.entries.find((e: any) => e.action === 'bootstrap_credential.minted' && e.actor === 'dana');
    expect(row.detail.sponsor_scoped).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @musterd/server test -- sponsor-authority` — FAIL (403 from `authAdmin`).

- [ ] **Step 3: Implement `authSponsor.ts`**

```ts
import type { IncomingMessage } from 'node:http';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { authMember, getMemberByName, memberStandingRefusal } from '../store/members.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { resolveAccountStatus, resolveCapabilities } from '../store/rows.js';
import { actingSeat, agentSessionLease, bearer } from './requestAuth.js';

export interface SponsorAuth { team: TeamRow; member: MemberRow; agent: MemberRow; sponsorScoped: true }

/**
 * ADR NNN §4.1: a member's authority over the agents they sponsor — and nothing else. Live human,
 * good standing, `can_create_agents` not withdrawn, `agent.sponsored_by === member.id`, agent live.
 * The refusal for a live agent someone else sponsors is `forbidden`; for a name that is not a live
 * sponsored agent it is `not_found` (a removed name is never re-minted for, Review Focus 4).
 */
export function authSponsorOf(ctx: Ctx, slug: string, req: IncomingMessage, agentName: string): SponsorAuth {
  const { team, member } = authMember(ctx.db, slug, bearer(req), actingSeat(req), agentSessionLease(req));
  if (member.kind !== 'human' || member.observer === 1)
    throw new MusterdError('forbidden', 'only a human member acts for the agents they sponsor (ADR NNN §4.1)');
  const standing = memberStandingRefusal(member);
  if (standing) throw standing;
  if (resolveCapabilities(member).can_create_agents === false)
    throw new MusterdError('forbidden', 'an admin turned off agent creation (and hosting) for this seat');
  const agent = getMemberByName(ctx.db, team.id, agentName);
  const s = agent ? resolveAccountStatus(agent) : null;
  if (!agent || agent.kind !== 'agent' || agent.left_at !== null || s === 'archived')
    throw new MusterdError('not_found', `no live sponsored agent "${agentName}" in "${slug}"`);
  if (agent.sponsored_by !== member.id)
    throw new MusterdError('forbidden', `"${agentName}" is not an agent you sponsor`);
  return { team, member, agent, sponsorScoped: true };
}

export function authAdminOrSponsorOf(
  ctx: Ctx, slug: string, req: IncomingMessage, agentName: string,
): { team: TeamRow; member: MemberRow; sponsorScoped: boolean } {
  const { team, member } = authMember(ctx.db, slug, bearer(req), actingSeat(req), agentSessionLease(req));
  if (resolveCapabilities(member).is_admin) return { team, member, sponsorScoped: false };
  const s = authSponsorOf(ctx, slug, req, agentName);
  return { team: s.team, member: s.member, sponsorScoped: true };
}
```

If `bearer`/`actingSeat`/`agentSessionLease` are module-private in `http.ts`, move them into a new `transport/requestAuth.ts` and import from both places (add its file-tree line too).

- [ ] **Step 4: Wire the four routes.** In each, replace the single `authAdmin`/`authGovernance` call:

`/agent-bootstrap-credentials`:
```ts
        const body = parseOrBadRequest(BootstrapCredentialBody, await readJson(req));
        const { team, member, sponsorScoped } =
          body.use === 'claim_seat'
            ? authAdminOrSponsorOf(ctx, slug, req, body.target)
            : authAdmin(ctx, slug, req);
```
(parse the body first so `target` is known; keep the existing not-found checks). Add `sponsor_scoped: sponsorScoped` to the audit `detail`.

`/grants`: parse first; `body.scope === 'seat' ? authAdminOrSponsorOf(ctx, slug, req, body.target) : authAdmin(...)`.

`/residency/enroll` and `/residency/revoke`: parse first; `authAdminOrSponsorOf(ctx, slug, req, body.seat)` in place of `authGovernance` — keep `viaFallback` as `false` on the sponsor path (`const viaFallback = false`). For revoke, the existing "seat or admin" path stays; the sponsor branch is added.

- [ ] **Step 5: Run** the file — PASS. Run `pnpm --filter @musterd/server test -- residency-http bootstrap grants` to confirm no admin regression.

- [ ] **Step 6: Docs + commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add packages/server docs/architecture/03-server.md
git commit -m "feat(server): sponsor-scoped authority over sponsored agents (mint, grant, residency)" -m "Refs ADR-NNN" -m "Co-authored-by: stanley <stanley@revive.musterd>"
```

This is increment 1 of the spec: open its PR now, request big-body's security review, and land it alone before Task 3.

---

### Task 3: Server — sponsor host keys see only the sponsor's seats

**Files:**
- Modify: `packages/server/src/transport/http.ts:1408` (`authAgentKeyOnly` → return `{ team, sponsorId: string | null }`), `:3276` (`/residency/wake-leases`)
- Modify: `packages/server/src/store/residency.ts:1394` (`claimWakeLeases` gains `opts.sponsorId`)
- Test: `packages/server/src/transport/sponsor-host-key-http.test.ts`

**Interfaces:**
- Consumes: `BootstrapCredential.created_by` (a member *name*), `getMemberByName`, `resolveCapabilities`.
- Produces:
  - `authAgentKeyOnly(ctx, slug, req, host?) → { team: TeamRow; sponsorId: string | null }` — `sponsorId` is set when the presented credential is a `host` credential whose creator is a live non-admin human; `null` for admin-created host keys and the legacy team key.
  - `claimWakeLeases(db, teamId, teamSlug, host, presenceTimeoutMs, now?, opts?: { sponsorId?: string | null })` — with `sponsorId` set, only enrollments whose member has `sponsored_by === sponsorId` are considered.

- [ ] **Step 1: Failing test**

```ts
describe('sponsor host key (ADR NNN §4.1, Review Focus 1)', () => {
  it('a host key minted by a sponsor polls wake-leases and sees only the sponsor’s seats', async () => {
    const dana = await addHuman('dana');
    const eve = await addHuman('eve');
    await post('/teams/hk-t/members/agents', { name: 'dana-scout' }, dana);
    await post('/teams/hk-t/members/agents', { name: 'eve-scout' }, eve);
    // both enrolled on the SAME host label
    await post('/teams/hk-t/residency/enroll', { seat: 'dana-scout', harness: 'claude-code', host: 'shared' }, dana);
    await post('/teams/hk-t/residency/enroll', { seat: 'eve-scout', harness: 'claude-code', host: 'shared' }, eve);
    const hk = await post('/teams/hk-t/agent-bootstrap-credentials', { use: 'host', target: 'shared' }, dana);
    expect(hk.status).toBe(201);
    // a directed act to each agent makes both due
    await post('/teams/hk-t/messages', { to: 'dana-scout', act: 'message', body: 'hi' }, nick);
    await post('/teams/hk-t/messages', { to: 'eve-scout', act: 'message', body: 'hi' }, nick);
    const leases = await post('/teams/hk-t/residency/wake-leases', { host: 'shared' }, hk.json.agent_key);
    expect(leases.status).toBe(200);
    expect(leases.json.orders.map((o: any) => o.seat)).toEqual(['dana-scout']);
  });
});
```
(Use whichever act-send route the existing residency tests use to make a seat due; copy from `residency-http.test.ts`.)

- [ ] **Step 2: Run** — FAIL (eve-scout appears, or 403 on the host mint).

- [ ] **Step 3: Implement.** In `/agent-bootstrap-credentials`, the `use: 'host'` case: `authAdminOrSponsorOf` needs an agent name, so instead: admin → allowed; else `authMember` and require the caller to be a live human with `can_create_agents` (reuse the first half of `authSponsorOf` — extract `authSponsorCaller(ctx, slug, req): { team, member }` from it). In `authAgentKeyOnly`, on the host-credential success branch compute:

```ts
    const creator = credential.created_by ? getMemberByName(ctx.db, team.id, credential.created_by) : undefined;
    const sponsorId = creator && !resolveCapabilities(creator).is_admin && creator.left_at === null ? creator.id : null;
    return { team, sponsorId };
```
Legacy-key branch returns `{ team, sponsorId: null }`. Update every caller (`/doorbell/rings`, `/doorbell/rings/:id/surfaced`, wake-turn/progress/report) to destructure `team`. In `/residency/wake-leases`, pass `{ sponsorId }` to `claimWakeLeases`; in `claimWakeLeases`, after `const member = getMemberById(...)`: `if (opts?.sponsorId && member.sponsored_by !== opts.sponsorId) continue;`.

- [ ] **Step 4: Run** the file and `pnpm --filter @musterd/server test -- residency` — PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(server): a sponsor's host key polls only the sponsor's seats" -m "Refs ADR-NNN" -m "Co-authored-by: stanley <stanley@revive.musterd>"
```

---

### Task 4: Server — authority closed in code (connect refusal while hosted, cascade on disable/ban, invite expiry policy)

**Files:**
- Modify: `packages/server/src/store/sponsoredAgents.ts:80` (`connectRefusal` gains `hosted: boolean`)
- Modify: `packages/server/src/transport/sponsoredAgentMint.ts:70` (`issueAgentConnect` passes hosted)
- Modify: `packages/server/src/store/members.ts:767` (`setMemberGovernance`) and `:794` (`cascadeSponsoredRevocation`)
- Modify: `packages/server/src/store/teams.ts` (`applyPolicyChange` — find by name) — the pair rule
- Modify: `packages/server/src/transport/http.ts:2777` (`/invites`)
- Test: `packages/server/src/store/sponsoredAgents.test.ts`, `packages/server/src/store/members.test.ts` (or new `members.cascade.test.ts`), `packages/server/src/transport/policy-pair-http.test.ts`

**Interfaces:**
- Consumes: `getResidency(db, teamId, memberId)` (residency.ts:466), `revokeResidency`, `revokeAllForMember` (store/oauth.ts).
- Produces:
  - `connectRefusal(caller, agent, policy, teamSlug, opts?: { hosted?: boolean })` — `hosted` true ⇒ `conflict` "…is hosted on <host>; unenroll it first".
  - `anyHostedSponsoredAgent(db, teamId): { agent: string; host: string } | null` in `store/residency.ts`.
  - `cascadeSponsoredRevocation` now also calls `revokeResidency` and `revokeAllForMember` per descendant; returns the same rows.
  - `setMemberGovernance` calls `cascadeSponsoredRevocation` when `accountStatus` transitions to `disabled` or `banned` from something else.
  - `applyPolicyChange` refuses `agent_connect: 'any_member'` unless `invite_requires_expiry: true` is also stored (`validation`), and refuses it when `anyHostedSponsoredAgent` is non-null (`conflict`).
  - `/invites` refuses a body without `member_until` when `getPolicy(...).invite_requires_expiry` (`validation`).

- [ ] **Step 1: Failing tests**

`sponsoredAgents.test.ts` — append:
```ts
describe('connectRefusal while hosted (ADR NNN §4.4.1)', () => {
  it('refuses a connect link for an enrolled agent even for its sponsor', () => {
    const { db, team, human } = teamWithHuman();
    const { member: agent } = createSponsoredAgent(db, team, human, { name: 'scout' });
    const err = connectRefusal(human, agent, 'sponsor', team.slug, { hosted: true });
    expect(err?.code).toBe('conflict');
    expect(err?.message).toMatch(/hosted/);
  });
});
```

`members.cascade.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember, getMemberById, setMemberGovernance } from './members.js';
import { enrollResidency, getResidency } from './residency.js';
import { createSponsoredAgent } from './sponsoredAgents.js';
import { createTeam } from './teams.js';

describe('cascade on disable/ban (ADR NNN §4.4.2)', () => {
  it('disabling a sponsor disables their agents and revokes their residency', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'acme' });
    const { row: dana } = addMember(db, team, { name: 'dana', kind: 'human' });
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    enrollResidency(db, team.id, agent.id, { harness: 'claude-code', host: 'h', policy: undefined }, 'dana');
    setMemberGovernance(db, dana.id, 'disabled', dana.capabilities ?? '{}');
    expect(getMemberById(db, agent.id)!.account_status).toBe('disabled');
    expect(getResidency(db, team.id, agent.id)).toBeNull();
  });
});
```
(Match `enrollResidency`'s real signature from `residency.ts:319`.)

`policy-pair-http.test.ts` (HTTP harness, slug `pp-t`):
```ts
it('any_member requires invite_requires_expiry, and is refused while an agent is hosted', async () => {
  const r1 = await post('/teams/pp-t/policy', { agent_connect: 'any_member' }, nick);
  expect(r1.status).toBe(400);
  const r2 = await post('/teams/pp-t/policy', { agent_connect: 'any_member', invite_requires_expiry: true }, nick);
  expect(r2.status).toBe(200);
  const dana = await addHuman('dana');
  await post('/teams/pp-t/members/agents', { name: 'dana-scout' }, dana);
  await post('/teams/pp-t/residency/enroll', { seat: 'dana-scout', harness: 'claude-code', host: 'h' }, dana);
  const r3 = await post('/teams/pp-t/policy', { agent_connect: 'any_member', invite_requires_expiry: true }, nick);
  expect(r3.status).toBe(409);
});
it('invite without member_until is refused when invite_requires_expiry', async () => {
  await post('/teams/pp-t/policy', { invite_requires_expiry: true }, nick);
  const r = await post('/teams/pp-t/invites', {}, nick);
  expect(r.status).toBe(400);
  const ok = await post('/teams/pp-t/invites', { member_until: Date.now() + 3_600_000 }, nick);
  expect(ok.status).toBe(201);
});
```

- [ ] **Step 2: Run** the three — FAIL.

- [ ] **Step 3: Implement** each per the Interfaces block. In `issueAgentConnect`: `const hosted = getResidency(ctx.db, team.id, agent.id) !== null;` then `connectRefusal(caller, agent, policy, team.slug, { hosted })`. In `setMemberGovernance`, read the current row's `account_status` first; if the new value is `disabled`/`banned` and the old was neither, call `cascadeSponsoredRevocation(db, teamId, id)` — the function needs `team_id`; read it from the row. In `cascadeSponsoredRevocation`, after the `UPDATE`: `revokeResidency(db, teamId, child.id)` and `revokeAllForMember(db, child.id)` (check their real signatures; import lazily to avoid a cycle if `oauth.ts` imports `members.ts`).

- [ ] **Step 4: Run** `pnpm --filter @musterd/server test -- sponsoredAgents members.cascade policy-pair sponsored-agents-http` — PASS.

- [ ] **Step 5: Commit** — `feat(server): close ADR 456's residual in code — hosted agents unconnectable, cascade on disable/ban, invite expiry policy` / `Refs ADR-NNN`. This is increment 2: its own PR.

---

### Task 5: Server — `host_provisions` table, claim/report routes, creation hook, cancel-with-fallback

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (version 77)
- Create: `packages/server/src/store/hostProvisions.ts`
- Modify: `packages/server/src/transport/sponsoredAgentMint.ts:24` (`mintSponsoredAgent` inserts a row, returns `hosting`)
- Modify: `packages/server/src/transport/http.ts` (two routes after `/residency/wake-leases`; `/members/agents` reply)
- Modify: `packages/server/src/transport/mcpHttp.ts:228` (`team_agent_create` text names which happened)
- Modify: `packages/server/src/store/residency.ts` (`recordHostSeen` gains sponsor; `claimWakeLeases` derives the `provisioned` candidate)
- Modify: `packages/server/src/index.ts` (or wherever `startExpiredMemberSweep` is started — `grep -rn startExpiredMemberSweep packages/server/src`) — start the provision cancel sweep
- Test: `packages/server/src/store/hostProvisions.test.ts`, `packages/server/src/transport/host-provisions-http.test.ts`
- Modify: `docs/architecture/03-server.md` file tree (`store/hostProvisions.ts — sponsor-host provision rows: insert on mint, atomic claim, report, 15-minute cancel (ADR NNN §4.2)`)

**Interfaces:**
- Produces (`store/hostProvisions.ts`):

```ts
export const PROVISION_PENDING_TTL_MS = 15 * 60 * 1000;
export interface HostProvisionRow { id: string; team_id: string; member_id: string; sponsor_id: string; host: string | null; state: HostProvisionState; claimed_by: string | null; claimed_at: number | null; ready_at: number | null; failed_reason: string | null; created_at: number }
export function insertProvision(db, teamId, memberId, sponsorId, now?): HostProvisionRow
/** Host labels this sponsor's host keys have polled from in the last `withinMs`. */
export function sponsorHostsSeen(db, teamId, sponsorId, now, withinMs = 10 * 60 * 1000): string[]
/** Atomic: pending rows for this sponsor (or all, sponsorId null = admin key) → claimed by `host`; respects max_per_host via `liveHostedCount`. Rows past the cap are left pending. */
export function claimProvisions(db, teamId, host, sponsorId: string | null, maxPerHost, now?): HostProvisionRow[]
export function liveHostedCount(db, teamId, host): number
export function reportProvision(db, teamId, id, host, body: HostProvisionReportBody, now?): HostProvisionRow  // throws not_found / conflict
export function cancelStaleProvisions(db, now?): HostProvisionRow[]   // pending older than TTL → cancelled
export function toProvision(row, teamSlug, agentName, sponsorName): HostProvision
```
- `recordHostSeen(db, teamId, host, now, sponsorId?: string | null)` — `host_liveness` gains a nullable `sponsor_id` column (same migration).
- `claimWakeLeases`: a `ready` provision with `ready_at` set and `first_wake_at IS NULL` yields one immediate candidate `{ reason: 'provisioned' }` with `composed_line` = `you were just created by <sponsor>; greet them with team_send and ask what to build`, then sets `first_wake_at` (add the column).

- [ ] **Step 1: Migration 77**

```ts
  {
    version: 77,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS host_provisions (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id),
          member_id TEXT NOT NULL REFERENCES members(id),
          sponsor_id TEXT NOT NULL REFERENCES members(id),
          host TEXT,
          state TEXT NOT NULL CHECK (state IN ('pending','claimed','ready','failed','cancelled')),
          claimed_by TEXT,
          claimed_at INTEGER,
          ready_at INTEGER,
          first_wake_at INTEGER,
          failed_reason TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_host_provisions_team_state ON host_provisions(team_id, state);
        CREATE INDEX IF NOT EXISTS idx_host_provisions_member ON host_provisions(member_id);
      `);
      const cols = db.prepare(`SELECT name FROM pragma_table_info('host_liveness')`).pluck().all() as string[];
      if (!cols.includes('sponsor_id')) db.exec('ALTER TABLE host_liveness ADD COLUMN sponsor_id TEXT');
    },
  },
```

- [ ] **Step 2: Failing store tests** (`hostProvisions.test.ts`):

```ts
describe('host provisions (ADR NNN §4.2)', () => {
  it('insert → claim is atomic and one host wins', () => {
    const { db, team, human } = teamWithHuman();
    const { member: agent } = createSponsoredAgent(db, team, human, { name: 'scout' });
    const row = insertProvision(db, team.id, agent.id, human.id);
    expect(row.state).toBe('pending');
    const a = claimProvisions(db, team.id, 'h1', human.id, 5);
    const b = claimProvisions(db, team.id, 'h2', human.id, 5);
    expect(a.map((r) => r.id)).toEqual([row.id]);
    expect(b).toEqual([]);
    expect(a[0]!.claimed_by).toBe('h1');
  });
  it('a sponsor key claims only its own rows; an admin key (null) claims all', () => { /* two sponsors, two rows; assert filtering */ });
  it('max_per_host leaves rows pending', () => { /* enroll 5 seats on h1 via enrollResidency, insert a 6th provision, claim → [] and row still pending */ });
  it('report ready sets ready_at; report by another host is conflict; a second report is conflict', () => { /* … */ });
  it('cancelStaleProvisions cancels pending rows older than 15 minutes only', () => { /* insert at now-16m and now-1m; expect one cancelled */ });
  it('sponsorHostsSeen returns labels polled by this sponsor within 10 minutes', () => { recordHostSeen(db, team.id, 'h1', now, human.id); expect(sponsorHostsSeen(db, team.id, human.id, now)).toEqual(['h1']); });
});
```
Write each `/* … */` body out in full when implementing — the shape is the first test's.

- [ ] **Step 3: Run** — FAIL. **Step 4: Implement `store/hostProvisions.ts`** per the Interfaces block, using `db.transaction` for claim and `ulid()` for ids. `liveHostedCount` = `SELECT COUNT(*) FROM residency r JOIN members m ON m.id = r.member_id WHERE r.team_id = ? AND r.host = ? AND m.sponsored_by IS NOT NULL AND m.left_at IS NULL` (confirm the residency table name in `residency.ts`).

- [ ] **Step 5: Failing HTTP tests** (`host-provisions-http.test.ts`):

```ts
it('creation with a live sponsor host queues a provision and answers hosting: sponsor_host', async () => {
  const dana = await addHuman('dana');
  const hk = await post('/teams/hp-t/agent-bootstrap-credentials', { use: 'host', target: 'dana-mbp' }, dana);
  await post('/teams/hp-t/residency/wake-leases', { host: 'dana-mbp' }, hk.json.agent_key); // heartbeat
  const r = await post('/teams/hp-t/members/agents', { name: 'dana-scout' }, dana);
  expect(r.json.hosting).toBe('sponsor_host');
  const claim = await post('/teams/hp-t/host/provisions', { host: 'dana-mbp' }, hk.json.agent_key);
  expect(claim.json.provisions).toHaveLength(1);
  expect(claim.json.provisions[0].agent).toBe('dana-scout');
});
it('creation with no live host answers hosting: connect_link and queues nothing', async () => { /* … expect connect_url present, claim → [] */ });
it('Review Focus 2: a sponsor disabled between claim and report cannot report ready', async () => {
  /* claim as above; POST /members/dana/disable (admin) — find the real governance route; then report ready with hk → 403; row reads failed */
});
it('a ready provision yields exactly one provisioned wake', async () => {
  /* claim; enroll dana-scout via dana; report ready; poll wake-leases twice: first has one order with reason 'provisioned' and composed_line naming dana; second has none */
});
it('a pending provision older than 15 minutes cancels and the sponsor gets the connect link', async () => {
  /* insert via store with created_at = now-16m (use server.ctx.db if exposed, else fake timers); run cancelStaleProvisions; inbox for dana contains a message with meta.agent_connect_fallback and a connect_url */
});
```

- [ ] **Step 6: Implement routes and hook.**

In `mintSponsoredAgent`: after the audit row,
```ts
  const hosts = sponsorHostsSeen(ctx.db, team.id, sponsor.id, Date.now());
  const hosting: SponsoredAgentHosting = hosts.length > 0 ? 'sponsor_host' : 'connect_link';
  if (hosting === 'sponsor_host') insertProvision(ctx.db, team.id, member.id, sponsor.id);
```
Return `{ member, hosting, connect_url, connect_expires_at }` (the link is always returned; the tool text leads with whichever applies).

Routes (after `/residency/wake-leases`):
```ts
      if (method === 'POST' && rest === '/host/provisions') {
        const body = parseOrBadRequest(HostProvisionsClaimBodySchema, await readJson(req));
        const { team, sponsorId } = authAgentKeyOnly(ctx, slug, req, body.host);
        recordHostSeen(ctx.db, team.id, body.host, Date.now(), sponsorId);
        const rows = claimProvisions(ctx.db, team.id, body.host, sponsorId, getPolicy(ctx.db, team.id).agent_host.max_per_host);
        for (const row of rows) appendAudit(ctx.db, team.id, { actor: null, action: 'host.provision_claimed', target: row.id, result: 'allow', detail: { host: body.host } });
        return sendJson(res, 200, { provisions: rows.map((r) => toProvision(r, team.slug, nameOf(r.member_id), nameOf(r.sponsor_id))) });
      }
      const provisionReport = rest.match(/^\/host\/provisions\/([^/]+)\/report$/);
      if (method === 'POST' && provisionReport) {
        const body = parseOrBadRequest(HostProvisionReportBodySchema, await readJson(req));
        const hostLabel = /* the row's claimed_by — look the row up first, then */ ;
        const { team, sponsorId } = authAgentKeyOnly(ctx, slug, req, hostLabel);
        // Review Focus 2: the sponsor must still stand
        const row = reportProvision(ctx.db, team.id, decodeURIComponent(provisionReport[1]!), hostLabel, body);
        …audit host.provision_ready / host.provision_failed…
        return sendJson(res, 200, { provision: toProvision(...) });
      }
```
In `reportProvision`, before marking `ready`, check `memberStandingRefusal(getMemberById(db, row.sponsor_id))` and the agent's standing; on refusal mark `failed` with `sponsor_lost_standing` and throw `forbidden`.

Also in `/residency/wake-leases`, pass `sponsorId` to `recordHostSeen`.

Cancel sweep: next to `startExpiredMemberSweep`, add a 60 s interval calling `cancelStaleProvisions`; for each cancelled row, `issueAgentConnectNonce` for the agent (issuer = sponsor) and `routeEnvelope` a daemon-composed `message` to the sponsor: body `no host of yours claimed <agent> in 15 minutes — open this link on the device that will run it: <url>`, `meta: { agent_connect_fallback: { agent } }`.

`claimWakeLeases`: before `dueCandidates`, query `SELECT id, sponsor_id FROM host_provisions WHERE team_id=? AND member_id=? AND state='ready' AND first_wake_at IS NULL`; if found, push one immediate candidate with `reason: 'provisioned'`, `composed_line` as specified, then `UPDATE … SET first_wake_at = ?` inside the same transaction.

`team_agent_create` text: when `hosting === 'sponsor_host'`: `Created agent "<n>" on <slug>. Your host <label> is setting it up; it will greet you shortly. (If it doesn't within 15 minutes you'll get a connect link.)`; otherwise today's text.

- [ ] **Step 7: Run** `pnpm --filter @musterd/server test` — PASS, coverage ≥85%.

- [ ] **Step 8: Docs + commit** — `feat(server): host provisions — sponsor-host claim/report, creation hook, provisioned first wake, 15-minute fallback` / `Refs ADR-NNN`. Increment 3: its own PR.

---

### Task 6: CLI — extract `provisionSeat` from `musterd agent`

**Files:**
- Create: `packages/cli/src/onboard/provisionSeat.ts`
- Modify: `packages/cli/src/commands/agent.ts:132-238` (call the extraction)
- Modify: `packages/cli/src/client.ts` (add `claimProvisions(slug, host)`, `reportProvision(slug, id, body)`)
- Test: `packages/cli/src/onboard/provisionSeat.test.ts`
- Modify: `docs/architecture/04-cli.md` file tree (`onboard/provisionSeat.ts — the one seat-provisioning sequence: credential, grant, binding, permissions, spec, harness wiring — shared by \`musterd agent\` and the host provisioner (ADR NNN §4.3)`)

**Interfaces:**
- Produces:

```ts
export interface ProvisionSeatInput {
  team: string; name: string; server: string;
  harness: HarnessAdapter;            // from onboard/harnesses
  http: Pick<HttpClient, 'mintBootstrapCredential' | 'issueGrant'>;
  workspace: Workspace;               // already created by provisionWorkspace
  model?: string; driver?: string; profileName?: string;
}
export interface ProvisionSeatResult { agentKey: string; granted: boolean; mcpError: string | null }
/** Steps 2–5 of ADR 065's sequence, exactly as agent.ts did them; throws on credential mint failure, never on grant/permissions/harness failure (reported in the result). */
export async function provisionSeat(input: ProvisionSeatInput): Promise<ProvisionSeatResult>
```
- `HttpClient.claimProvisions(slug: string, host: string): Promise<HostProvisionsClaimResponse>` → `POST /teams/:slug/host/provisions`, parsed by `HostProvisionsClaimResponseSchema`.
- `HttpClient.reportProvision(slug: string, id: string, body: HostProvisionReportBody): Promise<{ provision: HostProvision }>`.

- [ ] **Step 1: Failing test** — a fake `http` whose `mintBootstrapCredential` returns `{ agent_key: 'msac_x' }` and `issueGrant` returns `{ token: 'msgr_y' }`, a fake harness whose `configure` records its args, a tmp workspace dir; assert `binding.json` written with `agent_key`, `grant`, `claim: {mode:'seat', name}`, `autojoin: true`, mode 0600; `workspace.json` spec written without the key; harness `configure` called once with an entry carrying no secret in env (`buildEntry`'s existing invariant).

- [ ] **Step 2: Run** — FAIL (module missing). **Step 3: Implement** by moving lines 132–238 of `agent.ts` into `provisionSeat.ts` unchanged except for parameters; `agent.ts` keeps argv parsing, `addMember`, `writeSeatFile`, `provisionWorkspace`, output. **Step 4: Run** `pnpm --filter @musterd/cli test -- provisionSeat agent` — PASS (existing `agent.test.ts` must still pass).

- [ ] **Step 5: Commit** — `refactor(cli): extract provisionSeat from musterd agent` / `Refs ADR-NNN`.

---

### Task 7: CLI — `musterd agent` works for a non-admin sponsor

**Files:**
- Modify: `packages/cli/src/commands/agent.ts:87-131`
- Test: `packages/cli/src/commands/agent.test.ts`

**Interfaces:**
- Consumes: Task 2's routes (a sponsor may mint/grant for their own agent). `http.addMember` stays admin-only; for a sponsor the member already exists (created by `team_agent_create`).

- [ ] **Step 1: Failing test** — fake http where `addMember` throws `CliError('forbidden')` and `roster` lists `dana-scout` as `kind: 'agent'` with `sponsored_by` = caller; run `agentCommand` for `dana-scout`; expect exit 0 and `provisionSeat` called (spy). A `forbidden` on a name NOT on the roster still fails with the forbidden message.

- [ ] **Step 2–4:** in the `catch` after `addMember`, treat `err.code === 'forbidden'` like `conflict` **only if** the roster shows the name as an existing agent; then proceed as `reused`. Run — PASS.

- [ ] **Step 5: Commit** — `feat(cli): musterd agent provisions a workspace for an agent you sponsor without admin` / `Refs ADR-NNN`.

---

### Task 8: CLI — the provisioner in `musterd host`

**Files:**
- Create: `packages/cli/src/host/provisioner.ts`
- Modify: `packages/cli/src/host/loop.ts:232` (`pollHostOnce` runs the provision step after the lease loop when `deps.provision !== false`)
- Modify: `packages/cli/src/commands/host.ts` (`--no-provision`, `--clone`, `musterd host provisions` subcommand)
- Modify: `packages/cli/src/help/catalog.ts` (the two flags and the subcommand)
- Test: `packages/cli/src/host/provisioner.test.ts`, `packages/cli/src/host/loop.test.ts`
- Modify: `docs/architecture/04-cli.md` file tree (`host/provisioner.ts — claims a sponsor's host provisions and stands each seat up: workspace, credential, binding, harness, residency, report (ADR NNN §4.3)`)

**Interfaces:**
- Consumes: `provisionSeat` (Task 6), `provisionWorkspace(name, {team, cwd, home, branch})`, `HttpClient.claimProvisions/reportProvision/enrollResidency`, `upsertHostEntry` (host/registry.ts), `ensureHostKey` (commands/residency.ts — export it).
- Produces:

```ts
export interface ProvisionDeps {
  client: Pick<HttpClient, 'claimProvisions' | 'reportProvision' | 'enrollResidency' | 'mintBootstrapCredential' | 'issueGrant' | 'policy'>;
  team: string; server: string; host: string; harness: HarnessAdapter;
  repoRoot: string;            // the host's own workspace's git toplevel
  clone: boolean;              // --clone: full clone instead of worktree
  provisionWorkspace?: typeof provisionWorkspace; provisionSeat?: typeof provisionSeat;
  upsertHostEntry?: typeof upsertHostEntry; existsSync?: typeof existsSync; log: (line: string) => void;
}
/** One tick: claim → for each row: (skip if workspace dir already exists and is bound to this seat — Review Focus 5) → workspace → provisionSeat → enroll → report ready | failed {reason: step}. Never throws. */
export async function provisionOnce(deps: ProvisionDeps): Promise<{ claimed: number; ready: number; failed: number }>
```
- `HostPollDeps.provision?: false | Omit<ProvisionDeps, 'client' | 'team' | 'server' | 'host' | 'log'>`.

- [ ] **Step 1: Failing tests** (`provisioner.test.ts`, injected fakes, tmp dirs):
  1. one claimed row → `provisionWorkspace` called with `{team, cwd: repoRoot}`, `provisionSeat` called, `enrollResidency` called with `{seat, harness, host, policy: <the team's agent_host.policy>}`, `reportProvision(…, {state:'ready'})`, `upsertHostEntry` called with the new dir.
  2. `provisionSeat` throws → `reportProvision(…, {state:'failed', reason:'credential'})`, no enroll.
  3. `enrollResidency` throws → `failed {reason:'enroll'}`.
  4. Review Focus 5: `existsSync(dir)` true and the dir's `binding.json` names this seat → no `provisionWorkspace`, straight to enroll + ready.
  5. team policy `agent_host.policy.budget_usd` undefined → nothing claimed locally? No — the server refuses at claim (Task 5); here assert that a claimed row whose policy lacks `budget_usd` is reported `failed {reason:'no_budget'}` and the log names `musterd team policy set agent_host.policy.budget_usd <n>`.

  `loop.test.ts` — append: with `deps.provision` set and a fake client returning one provision, `pollHostOnce` calls the provisioner once per tick; with `provision: false` it never calls `claimProvisions`.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `provisioner.ts` per the interface; branch name `agent/<name>`; on `clone: true` call `git clone <repoRoot> <dir>` via `execFileSync` then write `.git/info/exclude` with `.musterd/`. In `host.ts`, derive `repoRoot` from `gitToplevel(process.cwd())`, `harness` from the host workspace's binding (`binding.session?.harness ?? 'claude-code'`), and pass `provision` unless `--no-provision`. `musterd host provisions` → `GET`-less: reuse `claimProvisions`? No — claiming has side effects; add `HttpClient.listProvisions(slug, host)` → `GET /teams/:slug/host/provisions?host=` (add that read route to Task 5's server work: same auth, no claim) and render `id · agent · state · reason`.

- [ ] **Step 4: Run** `pnpm --filter @musterd/cli test` — PASS. **Step 5: Commit** — `feat(cli): musterd host provisions a sponsor's newly created agents` / `Refs ADR-NNN`. Increment 4's PR carries Tasks 6–9.

---

### Task 9: Scenario D — the end-to-end acceptance

**Files:**
- Create: `packages/cli/src/scenarios/sponsorHosted.scenario.test.ts` (next to the existing Scenario A/B/C files — `ls packages/cli/src/scenarios` or wherever `pnpm test:scenarios` points)
- Modify: `docs/architecture/06-testing.md` (Scenario D section)

- [ ] **Step 1: Write the scenario** using the Scenario B harness shape (a real in-process server on port 0, real CLI client, a fake `ActuatorBackend` whose `wake` records the `WakeSpec` and claims the seat as the woken session would — copy the fake from `loop.test.ts`):
  1. team `sd-t`, admin `nick`, non-admin human `dana`.
  2. dana mints a host key for label `dana-mbp` and runs `pollHostOnce` once (heartbeat).
  3. dana calls `POST /members/agents {name:'dana-scout'}` → `hosting: 'sponsor_host'`.
  4. `pollHostOnce` with `provision` deps (fake workspace/seat functions writing to a tmp dir) → provision reported `ready`.
  5. `pollHostOnce` again → exactly one wake order for `dana-scout` with `reason: 'provisioned'` and `composed_line` containing `dana`; fake backend "occupies" and sends `team_send message → dana`.
  6. dana's inbox has a message from `dana-scout`. Elapsed < 120 s (assert < 10 s in-process).
  7. `POST /members/agents/dana-scout/connect` as dana → 409 (hosted).
  8. admin disables dana → `dana-scout` `account_status: 'disabled'`, residency gone, next `pollHostOnce` yields no orders.

- [ ] **Step 2: Run** `pnpm --filter @musterd/cli test -- sponsorHosted` — PASS. Add it to `pnpm test:scenarios`.

- [ ] **Step 3: Docs** — `06-testing.md` Scenario D paragraph mirroring §6 of the spec; **Step 4: Commit** — `test(scenarios): Scenario D — a sponsor's host runs the agent they created` / `Refs ADR-NNN`.

---

### Task 10: Docs sweep (increment 5)

**Files:**
- Modify: `docs/architecture/01-data-model.md` (`host_provisions`, `host_liveness.sponsor_id`, `members` sponsor semantics)
- Modify: `docs/architecture/03-server.md` (routes; sponsor-scoped authority paragraph under auth)
- Modify: `docs/architecture/04-cli.md` (`musterd host` provisioning; `musterd agent` for sponsors)
- Modify: `docs/design/security.md` (trust-domain paragraph: a sponsored agent shares its sponsor's account; containers are the opt-in next increment)
- Modify: `docs/demo.md` §7 (the "agents run in worktrees as the host user" line → points at ADR NNN; the demo is done, mark §7 historical)
- Modify: `ROADMAP.md` via `content/roadmap.data.ts` + `pnpm roadmap:gen` (add: container isolation on the sponsor's machine; team-shared hosts; Cloud runtime)
- Modify: `SPEC.md` Appendix A if any new wire route belongs there (host provisions are daemon-local HTTP, not envelope acts — likely no change; confirm)
- Modify: `docs/implementation-plan.md` (milestone line: sponsor-hosted agents landed, ADR NNN)

- [ ] **Step 1:** make each edit; **Step 2:** `pnpm format:check` (runs `arch-trees:check`, `roadmap:check`, `vocab:check`, `change-adr:check`); **Step 3:** commit `docs: sponsor-hosted agents — architecture, security, roadmap` / `Refs ADR-NNN`; **Step 4:** after merge, `lane_submit` lane 01M3FBKS39 with `{pr, sha, authorized_by:'nick'}` and follow its reply. Amend ADR NNN `## Consequences` with a dated "landed" note listing the five PRs.

---

## Self-review (done 2026-09-28)

- **Spec coverage:** §4.1 → Tasks 2–3; §4.2 → Tasks 1, 5; §4.3 → Tasks 6–8; §4.4 (1–3) → Task 4, (4) → Task 5's cancel sweep + existing `sweepExpiredMembers` (add `cancelStaleProvisions` for expired agents' rows to Task 5 Step 6); §4.5 → Task 1; §4.6 → Tasks 7–8; §5 falsifiers → Tasks 2, 3, 4, 9; §6 → Tasks 2–9; §7 increments → PR boundaries named at Tasks 2, 4, 5, 8, 10.
- **Placeholders:** the `/* … */` bodies in Tasks 5 and 8 name the exact assertions to write; no TBDs.
- **Type consistency:** `authAgentKeyOnly` returns `{team, sponsorId}` from Task 3 onward and Task 5 consumes that; `claimProvisions(db, teamId, host, sponsorId, maxPerHost)` matches its route call; `provisionSeat`'s `http` slice matches `ProvisionDeps.client`.
- **Review Focus:** 1 → Task 3, 2 → Task 5, 3 → Task 4 (connect-time check via `hosted`), 4 → Task 2, 5 → Task 8.
