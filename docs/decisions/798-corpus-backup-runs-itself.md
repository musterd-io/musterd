# 798 — The corpus backup runs itself

- Status: accepted
- Date: 2026-11-04
- Lane: `01M6JGWHFHQP8178DSX6ZZ1DJ0`
- Amends: ADR 280 decision 4 (the snapshot script uploads nothing; upload is an explicit manual step)

## Context

ADR 280 built the snapshot rail and, deliberately, made the off-machine upload a manual,
explicit act: the raw corpus contains agent prose, and a script silently shipping it would be
ADR 184's failure mode in a backup's clothes. Nick then named the destination — the private
`corpus-backups` bucket on the `exn-corpus-backup` Supabase project — and the first off-machine
copy landed 2026-09-05, with the cadence recorded as "explicit manual … owner ghost".

Nobody ran it again. On 2026-11-04 the newest snapshot on disk was still 2026-09-05, while the
corpus had grown from 184 MB raw to 1,635 MB raw (measured: `pnpm corpus:snapshot --dry-run`;
`trace.db` alone is 780 MB because the 30-day content prune stops at the last snapshot's
watermark). Two months of acts, traces and the data behind findings 012–031 existed only on one
laptop disk. Nothing alerted: there was no check whose job was to notice.

## Problem

A manual cadence with a named owner and no staleness check is a control that cannot fail loudly.
It read as "backed up" for two months while not backing anything up.

## Decision

1. **The backup runs itself, weekly.** `pnpm corpus:backup` (`scripts/corpus/backup.ts`) takes a
   snapshot, uploads it to the private bucket nick named, verifies every object's remote size
   against the local size, and stamps `~/.musterd/corpus-backups/LAST.json`. A launchd agent
   (`studio.sandrise.musterd-corpus-backup`, Sundays 04:00) runs it unattended. This reverses
   ADR 280 decision 4's manual-only upload for this destination only: the destination was
   nick's explicit choice, the bucket is private, and this is storage of the raw corpus, never
   publication (ADR 184 is untouched).
2. **Credentials never enter the repo or the plist.** They live in `~/.musterd/corpus-backup.env`
   (chmod 600) and are read at run time; the service key is never printed.
3. **Large artifacts split.** The bucket caps one object at 50 MB (measured 2026-11-04: a
   112 MB resumable create answers 413), so artifacts over 40 MB upload as ordered
   `.part-NNN` slices. The snapshot manifest's whole-artifact sha256 verifies reassembly.
4. **Staleness can fail.** `pnpm corpus:check` exits 1 when the newest snapshot or the last
   verified upload is over 14 days old, or missing. The control is registered in
   `docs/controls/registry.ts` with an exercise, and a pre-registered watch
   (`docs/watches/2026-11-04-corpus-backup-cadence.md`) owns the question of whether the
   weekly job actually fires unattended, with a death date.
5. **Fails closed.** Any failure — missing credentials, snapshot error, size mismatch — exits
   non-zero and leaves `LAST.json` untouched, so the check goes stale instead of the backup
   quietly half-landing.

## Consequences

- Exercised 2026-11-04: snapshot `2026-11-04T05-48-03-769Z` (36 files, 225.8 MB stored)
  uploaded and verified; `trace.db`'s three parts were downloaded, reassembled, and their
  sha256 matched the snapshot manifest (`dd04e2ce…`). The launchd job was installed and
  kickstarted the same day.
- The 20 MB economics of ADR 280 no longer hold: a weekly snapshot now stores ~226 MB.
  Keeping every snapshot forever remains the local rule; the bucket holds every upload too.
  If bucket storage becomes a cost, that is a new decision, not a silent prune here.
- A laptop asleep at Sunday 04:00 misses that week's run; launchd fires on next wake, and the
  14-day check bound absorbs one missed week but not two.
- Follows-up: `docs/watches/2026-11-04-corpus-backup-cadence.md` — resolved or void by 2026-12-04.

## Observability & Evaluation

- **Traces:** `~/.musterd/corpus-backups/backup.log` (launchd stdout/stderr), `LAST.json` local
  and at `research-corpus/LAST.json` in the bucket, each snapshot's `MANIFEST.json` uploaded last
  so its presence means the upload completed.
- **Eval:** `scripts/corpus/check.test.ts` pins the staleness cases, including the exact
  2026-09-05 → 2026-11-04 lapse this ADR answers; `pnpm corpus:check` is the runnable form.
- **Experiment:** the watch above. Falsifier: `LAST.json` older than 8 days at any weekly read
  before 2026-12-04 means the automation is not firing unattended, whatever the plist says.
