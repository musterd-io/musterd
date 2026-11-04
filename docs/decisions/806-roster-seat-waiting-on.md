# 806 — The app roster says who a seat is waiting on

- Status: accepted
- Date: 2026-11-04

## Context

Lane 01M6M6G228 (#3844) made /live say "waiting on nick · 42m" on a seat that has an open ADR 773
question to a person. ADR 792 holds a seat's shift wakes while it waits on its own question, so
without that line an idle seat reads as merely on shift. The phone's Seats screen (ADR 791) shows
the same seats, and it still says only the seat's lane. The roster delivery
(`AppDeliverySchema`, `kind: 'roster'`) has no field for an open question, so the phone cannot
say it (lane 01M6M84GPJ, nick 2026-11-04).

## Problem

How does the phone learn which seats wait on a question, and on whom, without asking for anything
else?

## Decision

1. **The roster seat gains an optional `waiting`.** It is `{ to: string | null, since: number }`
   or absent: `to` is the addressee's member name, or `null` for a question to the team, and
   `since` is when the seat asked (`asked_at`, ms). It is optional, so an old phone ignores it
   and an old daemon never sends it.
2. **The daemon fills it from the same open questions /live reads.** That is each seat's oldest
   open ADR 773 question (`openQuestions`, which is oldest first). This is the rule /live's
   `waitingOn` applies to the envelopes, so the two surfaces agree.
3. **The phone's Seats line puts it second.** The line under a seat's name reads, in order: a
   quick action's outcome right after a press, then "Waiting on nick · 42m" (or "Waiting on the
   team · 42m"), then the seat's lane. The wait is the daemon's fact, not the seat's text, so it
   is not labelled "their lane".
4. **Who builds what.** The schema field and the daemon's fill are a protocol lane (engineer). The
   phone line is lane 01M6M84GPJ (ios-engineer).
   Follows-up: 01M6MAPBSTCRNV6JHE4Z1Q18BS (wire and daemon), 01M6M84GPJT80HWETRJJ1HBQZ9 (phone).

## Consequences

- The roster grows one small object per waiting seat. `APP_ROSTER_MAX` and the push-size limit are
  unchanged, because the roster is pulled, not pushed (ADR 791, amended 2026-11-03).
- The phone shows the addressee's name, which is already on the roster's team. Nothing new
  leaves the daemon: no question text, no options.
- 2026-11-04 (lane `01M6MAPBST`, fifty): decisions 1–2 landed. `AppDeliverySchema`'s roster seat carries the optional `waiting {to, since}`, and `buildAppRoster` fills it from `openQuestions`, oldest first per asker. The phone line follows in lane `01M6M84GPJ`.

## Observability & Evaluation

- Traces: n/a. The roster fetch is already audited as a sealed delivery (`auditSealed`), and the
  field adds no new event.
- Eval: n/a. This is not agent-facing. Correctness is pinned by the schema round-trip, a daemon test
  that the seat with an open question carries `waiting` and others do not, and the phone's line
  order test.
- Experiment: falsified if a seat that /live shows as "waiting on nick" shows only its lane on the
  phone's Seats screen after a pull.
