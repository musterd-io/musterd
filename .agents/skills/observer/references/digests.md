# Digests, status reports and dashboards

Open to write a report someone reads.

## 1. The shape

```
<Team or goal> — <window>
Needs a person (n): <item — why — id>, …
Changed since <last report>: <goal or lane — what moved — id>, …
Unchanged: <one line>
Not seen: <gaps>
```

Readable in under a minute. (Anthropic's `internal-comms` skill, Apache-2.0, uses a
progress / plans / problems update readable in 30 to 60 seconds; this shape puts problems first.)

## 2. What to put first

- **Symptoms before causes**: report that a goal is stuck before why you think it is (Google SRE
  book, cited).
- **Actionable and new**: every item in "needs a person" is something a person can do something
  about, and was not already in the last report unchanged. A repeated item says how long it has
  waited.
- **Waiting on a human** is the most useful line most days: asks unanswered, acceptances not
  given, decisions not made.

## 3. Team-level signals

The four golden signals of service monitoring, adapted to a team (an inference, not a standard):

| Signal | For a team |
| --- | --- |
| Latency | How long work waits: asks unanswered, lanes awaiting acceptance |
| Traffic | Lanes opened and landed in the window |
| Errors | Lanes sent back, checks failing on the main branch, incidents open |
| Saturation | Open lanes per member who can build; goals with no active lane |

Report a signal only if its reader uses it. A number nobody acts on is noise.

## 4. Dashboards

A dashboard is a report that refreshes. The same rules hold: exceptions on top, the unchanged part
small, every number links to its source, and the time the data was read is on the screen.

## 5. Incidents

When something is broken: say so early, say what is affected, and say when the next update
comes. Do not wait for the cause. (Status-page practice, cited.)
