# Diagnosis and incidents

Open when something is down, slow, wedged or wrong, during an incident, and for the review after.

## 1. Read the freshest evidence first

Before any log tail, in this order:

1. **The live health check.** Is the service answering now, and which build does it report?
2. **The process.** Is it running? When did it start? What did the last one exit with? (On macOS,
   `launchctl print gui/$UID/<label>` shows the last exit status; on Linux, `systemctl status`.)
3. **Log lines newer than the last start.** Filter by time. Everything older describes a process
   that no longer exists.
4. **What changed recently.** The last deploy, refresh, merge, config edit or migration, and when.
   Most outages follow a change (the Google SRE book puts it at roughly 70%; cited only:
   [sre.google](https://sre.google/sre-book/introduction/), CC BY-NC-ND).

Why the order: an error log keeps every crash since the file was created, so a long tail of old
errors looks like a crash loop on a healthy service. A fix applied to history breaks the present.
"Freshest evidence first" is this skill's own synthesis of the sources below.

## 2. Work from a hypothesis, and write it down

- **One hypothesis at a time**, with the observation that would confirm it and the one that would
  rule it out. Test, record the result (negative results too), then move on.
- **Root cause before the fix.** A fix you cannot explain is a guess; under pressure guessing feels
  faster and is slower (after obra/superpowers' `systematic-debugging`, MIT).
- **Check each boundary.** In a chain (client → daemon → database, CI → build → deploy), find where
  the data stops being right before you change anything inside one component.
- **For resource problems, use USE**: for each resource (CPU, memory, disk, file descriptors, the
  database's writer lock, the connection pool), check utilization, saturation and errors. Any
  saturation is worth a look ([Brendan Gregg](https://www.brendangregg.com/usemethod.html), cited).
- **Avoid the anti-methods** Gregg names: looking only where the light is, changing things at
  random to see what happens, and blaming another component without evidence.
- **Preserve evidence before you restart.** A restart that fixes a wedged process also deletes the
  stack, the open connections and the state that would have told you why. Take what you can first
  (a stack sample, the health output, the last lines) unless every second down costs more.

## 3. Incidents

Adapted from PagerDuty's incident response documentation (Apache-2.0; `PROVENANCE.md`).

**When it is an incident.** Declare one when members or users cannot work, when a second person is
needed, or when it is still not understood after an hour. If unsure of the severity, pick the higher
one; never argue about severity while it is happening.

**Roles, even on a small team.** One person may hold several:

- **Commander.** Coordinates, decides, and does not debug. Gives each task to one named member with
  a time to report back ("izzo, check the migration log, back in 10 minutes"), never "can someone…".
- **Operator.** The only one who changes the system during the incident. Uncoordinated changes by
  several hands make the cause impossible to find.
- **Scribe.** Keeps a timestamped timeline, with where each fact came from.

**The loop.** Size it up, stop the bleeding (roll back the last change if it is the likely cause),
update everyone, verify, repeat. Every update says when the next one comes. To decide quickly, ask
"any strong objection?"; waiting for everyone to agree stalls the response.

**Ending it.** It is over when the user-facing path works and stays working for a stated window,
not when the alert clears.

## 4. After: the review

Write it within a few days while memory is fresh. (PagerDuty's own targets are 3 days for its most
severe incidents and 5 business days for the next; a target of your team's goes in `team.md`, and
until it does, say "within a few days".) Blameless means asking what happened and how, and leaving out who.

**State only what the record shows.** Every line of the review comes from the notes, logs, acts or
commits, or is marked as an inference or an open question. Do not fill a gap with what usually
happens: who was commander, whether anyone posted, why a restart was tried. Ask instead.

- **Timeline** in one timezone, each line with its source (log, act, commit, chat).
- **Contributing factors**, plural. Most incidents have several; a single "root cause" hides the
  rest (after adhorn/operational-excellence's incident review, MIT).
- **What went well**, so it is kept.
- **Action items**, few, each a lane or ticket. Propose an owner and a date, and mark them as
  proposed for the team to confirm; never assign work in a member's name on your own.
- **Written in foresight**: what people knew at the time, before the review taught anyone more.

## 5. Runbooks

A runbook is for a tired reader in the middle of the night: the symptom it is for, the checks in
order, the exact commands, what each result means, when to stop and escalate, and how to undo.
Keep commands copy-pasteable and test them. Start manual and automate one step at a time; a
"do-nothing" script that prints each step and waits for the operator is a good first version
([Dan Slimmon](https://blog.danslimmon.com/2019/07/15/do-nothing-scripting-the-key-to-gradual-automation/), cited).
A runbook nobody has run in a quarter is probably wrong; date it, and re-run it.
