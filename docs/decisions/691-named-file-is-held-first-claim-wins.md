# 691 — A lane that names a file holds it: first claim wins at the edit

- Status: accepted
- Date: 2026-10-21
- Lane: 01M5E8CD9C35PKZBP9NVZG5E6S (goal `cooperbench`)
- Amends: [ADR 150](150-structural-inducement-pretooluse-gates.md) Gate A (one more rule, same
  posture model); reads with [ADR 083](083-lanes-phase1-intent-dependency.md) §3 and
  [ADR 575](575-overlap-warnings-are-not-messages.md)

## Context

ADR 150's Gate A asks one question of an edit to a contended surface: does the editing seat own a
claimed lane whose scope covers the path? Owning *a* covering lane is enough; two seats can each
own one. ADR 083 flags the overlap at claim time as an advisory `surface_overlap` warning, and
ADR 575 measured that warning on this team: 27% precision, 15% recall, five replies in 2,359, so
it no longer rides as a message. Most overlaps are two area globs (`docs/decisions/**` on every
ADR lane) that never touch a common file.

Finding 015 ([CooperBench pilot](../research/015-cooperbench-pilot.md), 2026-10-21) ran musterd
as shipped on ten two-agent tasks where both features need the same file. In every pair both
agents opened lanes that **named the same file outright** (`tiktoken/core.py`,
`src/jinja2/loaders.py`, …), the board warned, the gate let both edit, and four pairs ended in a
merge conflict on exactly that file. The agents had agreed an order in prose ("you go first, I'll
wait") and then edited anyway. The musterd arm scored 2/10 against a bar of 6.

nick's rule for the goal (2026-10-21): no gaming the bench; if it reveals a product gap, fix the
product so every team gets it.

## Problem

The product has no notion of a seat *holding* a file. A lane scope is a list of globs, and a glob
that names one path is treated exactly like one that names an area: it grants the owner an edit
and reports an overlap. So the one collision that costs real work — two seats editing one file in
one tenure — is only ever reported, never stopped, and the report is the low-precision one
ADR 575 retired from the inbox. A blanket "refuse overlapping claims" would stop the collision
and also stop this team's daily work, because the overlaps that matter and the ones that do not
look the same at claim time.

## Decision

1. **A scope entry that names a path outright is a hold; a glob is an area.** `isNamedFile(entry)`
   is true when the entry has no `*`, `?` or `[`. Naming `src/core.py` says "I am editing this
   file"; `src/**` says "I am working around here". The lane schema does not change: the
   distinction is read from entries lanes already carry.
2. **The first claim holds the file for its tenure.** Among contending, owned lanes in the same
   project whose scope names a path, the one with the earliest `claimed_at` (lane id as the
   tie-break) holds it (`laneHoldingFile`). A hold ends when that lane leaves the contending
   states (done, abandoned, released, handed off — a handoff moves the hold with the lane) or when
   the entry is removed from its scope. Naming beats covering: a lane that names the file holds it
   against a lane that only covers it through an area glob, whichever was claimed first.
3. **Gate A refuses another seat's edit of a held file.** After the ADR 150 covering check passes,
   the gate asks who holds the path. If another seat does, `block` posture denies and `warn`
   posture allows with the advisory, in both cases naming the holder, their lane, when the hold
   began, and the three ways through: ask the holder to hand the file off or narrow their lane,
   wait for their lane to finish, or split the work by handoff. The holder's own edits are allowed
   quietly, as owned edits always were. A path nobody names is decided by ADR 150 alone, unchanged.
4. **The claim says so, precisely.** The `surface_overlap` warning a claim returns inline already
   names the other lane; when the overlap is a file both lanes name and the other claimed first,
   the warning adds that they hold it and what the gate will do. Still advisory, still never a
   directed act (ADR 575 §1). `lane_open` and `lane_claim` do not refuse the claim: a claim is an
   intention, and the person or agent may be about to coordinate.
5. **Posture is the team's, as before.** The rule runs under the enforcement posture the team
   declared for that surface class (ADR 150): `warn` by default, `block` where the team chose it.
   No new policy key.

### Rejected

- **Refuse any overlapping claim at `lane_open` / `lane_claim`.** Correct for the pilot, wrong for
  the team: ADR 575's numbers say most overlaps are area globs that never meet, and refusing them
  would make every ADR lane wait on every other. The collision is at the edit, so the rule is there.
- **Exclusive by region.** CooperBench's own `team` harness asks its lead to divide a file into
  disjoint regions. musterd has no region primitive and should not grow one for a benchmark; a
  file is the unit a lane can name, a diff can show and git can merge.
- **A per-lane `exclusive: true` flag.** A schema change for a distinction the scope already
  expresses. Teams that want exclusivity name files; teams that want areas use globs.
- **A bench-only instruction** telling agents to split files. Prose is what the pilot showed
  failing; and anything that lifts the score without reaching users is the thing nick ruled out.

## Consequences

- `packages/server/src/store/lanes.ts`: `isNamedFile`, `laneHoldingFile`, the hold note on the
  claim-time warning. `packages/server/src/protocol/gate.ts`: the hold check inside `gateA`.
  No protocol change; the `lane.gate` audit row is unchanged in shape.
- On this team today: lanes that name files are rare and deliberate (a fix to one module, a
  readout file); area globs stay as they are. A seat that names a file another seat's live lane
  already names will see it at claim time and, under `block`, at the edit. Under the default
  `warn` it is one more advisory line in the hook's output, on the one overlap that is real.
- CooperBench's musterd arm runs with `block` on `**` (lane 1), so from the next pilot the
  second agent to name the shared file is refused at its first edit and has to do what it said:
  wait, hand off, or ask. Whether that turns into passes is the second pilot's question, not this
  ADR's claim.
- The pre-registered second pilot (a follow-on lane under goal `cooperbench`) measures this as
  the one product change since finding 015, with the patch-recipe fix (lane 01M5E8CHBT) applied to
  every arm first.
  Follows-up: 01M5E8CHBT4SBSBEXM2CY7EMPX
- Dogfood run 8's question ("does one-owner-per-task stop the collision or just report it?") now
  has a product answer to test against: for named files, it stops it.

## Observability & Evaluation

- **Traces:** `lane.gate` rows whose reason carries `held by` (denied under block, warned under
  warn), by team and week; `surface_overlap` warnings whose detail carries `holds it`.
- **Eval:** on this team, 30 days after landing: the number of `held by` denials and warnings, and
  for each whether the two lanes' branches later changed a common file (ADR 575's precision
  script, restricted to named-file overlaps). The rule holds if named-file overlaps have precision
  ≥ 60% — the point of naming a file is that the overlap is real. Below 30%, seats are naming files
  they do not edit, and the rule is re-read.
- **Experiment:** the second CooperBench pilot, pre-registered: the musterd arm on `core` with
  this rule in force, same bar (≥ 6/10 and ≥ the same-day team arm), the only product change
  since 015.
