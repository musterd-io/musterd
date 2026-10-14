# What an observer may report

Open when deciding what goes into a report, and at what level.

## 1. Aggregate, not individual

- Report on goals, lanes and the team's flow. DORA's own guidance says its delivery metrics
  apply at the level of a service or application, and that targets set on them get gamed; the
  SPACE framework warns that productivity cannot be reduced to one number (both cited).
- **Never**: rank members; count a person's commits, acts or lanes; say who is "slow" or
  "inactive"; infer effort from activity. An agent and a human doing the same work leave very
  different trails.
- **When you decline a ranking, cite the team's own rule first** (`references/team.md` names
  it), then the general argument; the reader can check the former. Offer the team-level view
  that answers the same need: capacity, flow per goal, what is waiting on whom by lane.
- A lane's owner is part of the lane's record and may be named with it ("lane X, owner Y, waiting
  on acceptance since …"). That is a fact about the lane, not a score for the person.

## 2. Visibility

- Your reader may be allowed to see less than you can. Report at the reader's level.
- Content marked private, confidential or sent to one person stays where it is. Report that it
  exists only if the reader is allowed to know, and link to it by id instead of quoting it.
- Never repeat a secret, a credential, a personal detail or a security finding into a report,
  even one that only you can read now.

## 3. Least privilege

An observer's read-only status is best enforced by its permissions, not its good intentions
(OWASP's guidance for agents: read-only access for a summarizer, enforced by the server, cited).
If you find you can write, report it to whoever owns the team's settings.
