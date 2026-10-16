# 530 — lane.risk must be declared at open when the scope reaches a human

- Status: accepted
- Date: 2026-10-06
- Deciders: dreamy
- Lane: `01M47BHCV6X5NWMNF0H8R87G0Q`

## Context

`lane.risk` has carried, since ADR 169, the one input that decides whether an acceptance ask is
answered by a peer or escalated to a human. Per `lanes.ts`, **any** declared risk tag routes the
review ask human-first: the ADR 188 two-stage gate, where a peer's `accept` on a risky lane fires a
blocking ask at a human, and `laneReroute` stamps `human_required: lane.risk.length > 0`. It was
designed to be declared, never inferred, so a lane author names the risk rather than the system
guessing from the diff.

It was also declared nowhere. Neither `musterd lane open` nor the MCP `lane_open` tool exposed a
`--risk` / `risk` flag — the protocol accepted the field, but no surface let a caller set it.
Every lane therefore opened with `risk: []` from the schema default.

## Problem

Every lane I audited on 2026-10-05 was `risk: []` — including the two `/board` lanes
(#2104, #2121) whose acceptance question was axis 4 (Feel — a human's read of a rendered surface).
Those two reached me as the top-rung `cross_family` pick, I could not judge a visual surface, and a
human had to salvage them with a manual re-route. The mechanism that would have routed them to a
human — the risk tag — sat silently at its default because nothing at open ever asked. The system
was never told, and a default is not a decision.

## Decision

1. **`musterd lane open` and the MCP `lane_open` accept an explicit `--risk` / `risk`.**
2. **A lane whose declared scope reaches a human-visible surface cannot open silently.** When the
   scope overlaps `packages/web/**` or `packages/mobile/**` (`scopeIsHumanVisible`), the open is
   refused until the author passes `risk` — a tag list, or `none`.
3. **`--risk none` stands alone.** It records "no human-judgement risk", and it is never quietly
   padded with extra tags or treated as the default. Same posture as a misspelt `--stakes`: an
   ambiguous declaration fails rather than being laundered into the default.
4. **A scope that touches no rendered surface opens silently, as before.**
5. **The author still declares the tag. The guard only refuses a default; it never infers one.**
   That preserves the deliberate split in ADR 234: `risk` routes to a human, `stakes` prices the
   review, and neither is derived from the other or from the diff.

`scopeIsHumanVisible` is a pure helper in `@musterd/protocol`, so the CLI and MCP agree on what
counts as human-visible; a sibling prefix like `packages/webhooks/` is deliberately not matched.

## Consequences

- _(2026-10-16, ADR 631.)_ Declaring `user-facing` still satisfies this open-time guard. It no longer,
  by itself, asks a human. `none` is still an explicit waiver. A big change is another tag or
  `stakes: high`; a large landed diff asks a human even when the only tag is `user-facing`.

- New human-visible lanes must say `risk` once. A lane with empty surface (the default) is not
  treated as web-visible — if its work is really rendered, the author must declare the surface for
  the guard to fire. This is the intended trade: a guard that guesses from nothing is worse than a
  prompt that needs the scope named, and every existing surface will either name its scope or stand
  at `risk: []` as it always did.
- The two lanes tonight still routed to a peer, correctly under the default. This lane changes
  *future* lanes; it does not reinterpret a close.
- A lane declared `--risk none` for a scope that nonetheless renders a human surface has explicitly
  waived the human gate — that is now a visible statement on the lane, auditable later, rather than
  a silent default.
- The Cloud/infra-prerequisite shape (#2097) and the multi-path bundle (#2105) are not covered: they
  carry no human-judgement `risk` tag and the guard would correctly *not* prompt for them. That is a
  real gap, but it is not this lane.

## Observability & Evaluation

- **Traces:** none new.
- **Eval:** on `main`, count lanes opened on a human-visible scope with `risk` empty. Expected:
  after this ships, all successful opens of such a scope carry a declared risk (the empty default
  would have been refused); before, every one was `[]` (tonight's count was all eight).
- **Experiment:** none; the falsifier is a lane that opens with `risk: []` on a human-visible scope
  after this ships — the refusal should have caught it.
