# 513 — Role-gated routes: a declared route denies the seats that do not hold its role

- Status: accepted
- Date: 2026-10-05
- Deciders: dolly (lane `01M44T6343`, PR #2084), on nick's direction (2026-10-04, after the courier
  role's first transfer)
- Amends: [ADR 150](150-structural-inducement-pretooluse-gates.md) (a third class kind beside
  `contended-surface` and `costly-action`)
- Relates to: [ADR 227](227-roles-as-the-aptitude-layer.md) §3 (the warn → refuse ramp),
  [ADR 261](261-role-permission-profiles.md) (a role's harness rules are compiled into its holders), <!-- vocab:ok -->
  [ADR 501](501-halt-as-revocation.md) (which harnesses have a PreToolUse rail)

## Context

The courier role (2026-10-04) carries team material between machines. Its first route is Taildrop
(`tailscale file cp`). The role's toolkit compiles `Bash(tailscale file cp *)` into the holder's
harness allow list (ADR 261). That grants the holder the route. It stops nobody else.

A non-holder is stopped today by two things. Its harness has no allow rule, so the call needs a
permission prompt or meets a classifier. And the courier skill tells it to ask the holder instead.
In a session with a permissive mode, neither of those is a refusal. Before this change the courier
skill said so, and named lane `01M44T6343` as the missing deny. This ADR is that lane.

## Problem

A route off the machine is the one place where "anyone can run it" is the wrong default. A file
that leaves through Taildrop cannot be called back. Moving it should go through the seat the team
named for it, with its one-line record. The harness permission layer cannot express "deny, and say
who to ask". Each harness spells it differently, and two of them (Codex, OpenCode) have no
PreToolUse rail at all.

## Decision

1. **A third enforcement class kind, `role-route`, with a required `role`.** It lives where every
   gate class lives, which is the admin-set and audited team policy (ADR 150). A `role` on any
   other kind is refused at parse. A `role-route` without one is refused too.
2. **The daemon adjudicates from the stored policy.** On a match, the hook posts the class as
   today. The daemon looks the class up by name in the team's own policy and reads its `role` and
   `posture` there. It never takes them from the request, so a client cannot soften `block` to
   `warn` or name a role it holds. A class the policy no longer declares passes, like any
   undeclared call.
3. **Who passes.** Holders of the role pass quietly. Humans pass, as at the ADR 227 infra gate:
   they are the operators the gate serves.
4. **Everyone else, by posture.** `warn` proceeds with the holders named. `block` denies with the
   holders named, the `request_help` shape from the role's skill, and the route-around line Gate B
   already carries. With no holder, the text says to ask a human to assign the role.
5. **Posture is the team's choice per class.** This is how ADR 227 §3's ramp is kept. The
   mechanism allows both. Declaring Taildrop at `block` is a policy act by an admin:

   ```
   musterd team policy --enforce-route 'courier:taildrop=tailscale file cp *' --enforce-posture block
   ```

   ADR 227 waited for warn → redirect evidence before hardening the infra-touch gate. That ramp was
   written for infra verbs, which a seat can undo. A transfer off the machine cannot be undone, so
   `block` is the right posture for it from the first declaration.
6. **Audit.** The decision writes the existing `action.gate` row, shapes only. Its detail gains
   `kind: 'role-route'` and `role`, so a warn → redirect join can be read per role.

## Alternatives rejected

- **Declare routes in the role's toolkit.** A toolkit is a provisioning recipe that "carries no
  authority" (ADR 272). A non-holder's workspace never loads the courier toolkit, so the gate there
  could not see the route.
- **Trust the client's posture and role, as the other two kinds do.** Those kinds were built for a
  cooperative model in which the policy table is the only input. A role-route decides who may run
  something, so the role must come from the stored policy.
- **Deny in the harness permission layer.** That means one spelling per harness, no holder in the
  message, and no audit row.

## Consequences

- Reaches harnesses with a PreToolUse rail: Claude Code, Cursor and Grok. Codex and OpenCode have
  none (ADR 501's halt frame), so for them the compiled permission layer remains the only
  enforcement. The courier skill says so.
- An older CLI cannot parse a policy holding a `role-route` class. Its gate fails open, the ADR 150
  guard, and its `team policy` view errors. A daemon downgraded below this change cannot parse a
  stored policy that holds one. Clear the class before a downgrade.
- The courier skill's "not a gate on other seats" paragraph is rewritten in this change to point
  here.

## Observability & Evaluation

- **Traces:** `action.gate` rows with `detail.kind = 'role-route'`, carrying `role`, `posture` and
  `outcome` (`allowed`, `warned` or `denied`). Never the command text (ADR 051).
- **Eval:** the dataset is those rows joined to the next directed `request_help` from the same seat
  to a holder within ten minutes. The baseline is zero rows, because the gate is new. Pass: every
  `denied` row is followed by a `request_help` to a holder, or by no further attempt. A `denied` row
  followed by the same file moving some other way is a fail.
- **Experiment:** declare Taildrop at `block` on revive. A non-holder seat runs one
  `tailscale file cp` and must be denied with dolly named. Falsified if a non-holder on Claude Code
  completes a `tailscale file cp` while the class is declared.
