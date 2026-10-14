# Finding drift

Open to look for places where the declared record and what shipped disagree.

## 1. The kinds of drift

| Kind | The record says | Reality says | The usual correction |
| --- | --- | --- | --- |
| Shipped but still planned | A roadmap item is planned or building | A merged change delivered it | Mark it shipped, citing the merged change |
| Planned but already undone | An item is shipped | It was reverted or removed | Mark it, citing the revert; ask if unsure |
| Undeclared work | Nothing | A merged change added a user-visible feature | Add the item from the change's own words, or a stub with a note |
| Stale status | A decision is proposed | Its decision is in force in code and later decisions rely on it | Report it to the decision's author; status changes follow the team's rules |
| Stale prose | A doc describes old behaviour | The code behaves differently | Reword the stale sentence only |
| Dead links and names | A path, command or name | It no longer exists | Point it at the current one, or flag it |

## 2. Where to look

- The merged changes since the last run, against the roadmap and the docs they touch.
- Each decision's status line, against what later decisions and the code assume.
- Docs that describe behaviour, against the code they describe. Prefer docs that run (examples
  that are tests) and checks that compare code to docs mechanically; prose correctness is still a
  judgment.

## 3. Mechanical checks settle only definite claims

A check can say a path exists or a generated file matches its source. It cannot say a paragraph
is right. Use checks to find candidates; read the code and the merged change to decide.

## 4. Noise

A finder that reports dozens of items a run gets ignored. When a run finds many of one kind,
propose the few you are confident of and report the count with the command that produced it,
rather than opening a change per item. (Google SRE's rule for alerts applies to findings: each
should be actionable, cited.)
