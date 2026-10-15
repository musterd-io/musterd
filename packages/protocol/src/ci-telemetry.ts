import { z } from 'zod';

/**
 * ADR 610: one completed CI run, as the sampler read it off the forge. Shapes and timings only —
 * no log text, no PR body. `jobs` carries every job that ran (skipped ones are left out) so the
 * report can say which leaf moved, not only that the run did.
 */
/** A forge token: lower-case word characters and `-` (`success`, `pull_request`, `workflow_dispatch`). */
const TOKEN = /^[a-z0-9_-]+$/;
/** A job or branch name as the forge prints it — printable ASCII only, so nothing a terminal
 *  renderer could be made to interpret ever enters the ledger. */
const PRINTABLE = /^[\x20-\x7e]+$/;

export const CiJobSampleSchema = z.object({
  name: z.string().min(1).max(64).regex(PRINTABLE),
  conclusion: z.string().min(1).max(32).regex(TOKEN),
  duration_ms: z.number().int().min(0).max(86_400_000),
});
export type CiJobSample = z.infer<typeof CiJobSampleSchema>;

export const CiRunSampleSchema = z.object({
  /** The forge's run id — the dedupe key: a run is recorded once however often it is sampled. */
  run_id: z.string().regex(/^[0-9]{1,20}$/),
  head_sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  branch: z.string().min(1).max(256).regex(PRINTABLE),
  /** `push` (main), `pull_request`, `schedule`, `workflow_dispatch` (the probe). */
  event: z.string().min(1).max(32).regex(TOKEN),
  /** The forge's attempt counter: 2+ means someone re-ran it, the strongest flake signal there is. */
  attempt: z.number().int().min(1).max(100),
  conclusion: z.string().min(1).max(32).regex(TOKEN),
  /** Run creation, epoch ms — the bucket the run falls in. */
  created_at: z.number().int().min(0),
  /** Creation to completion, wall clock. */
  duration_ms: z.number().int().min(0).max(86_400_000),
  jobs: z.array(CiJobSampleSchema).max(64),
});
export type CiRunSample = z.infer<typeof CiRunSampleSchema>;

/** `POST /teams/:slug/telemetry/ci-runs` — one sampler tick's batch. */
export const CiRunBatchSchema = z.object({
  runs: z.array(CiRunSampleSchema).max(500),
});
export type CiRunBatch = z.infer<typeof CiRunBatchSchema>;

// ── Report projection (`Report.ci`) ────────────────────────────────────────────────────────────

/** One window's CI shape. A `null` percentile means the window had no completed main run. */
export const CiWindowSchema = z.object({
  /** Completed runs on main (push + the scheduled/probed full checks). */
  main_runs: z.number().int(),
  main_p50_ms: z.number().int().nullable(),
  main_p90_ms: z.number().int().nullable(),
  /** Main runs that concluded `failure` — the `main-red` count. */
  main_red: z.number().int(),
  /** Distinct PR head SHAs with at least one completed run. */
  pr_shas: z.number().int(),
  /** PR SHAs that went red and then green with no new commit (a re-run, or an attempt > 1 that
   *  succeeded) — the flake count. Over `pr_shas` is the flake rate. */
  pr_flaky: z.number().int(),
  /** Per-job p50 over every run in the window, slowest first, capped at the top 8. */
  jobs: z.array(z.object({ name: z.string(), runs: z.number().int(), p50_ms: z.number().int() })),
});
export type CiWindow = z.infer<typeof CiWindowSchema>;

/**
 * ADR 610: the CI trend — this window beside the one before it, so a reader sees drift, not a
 * number. Absent from a daemon that predates it; empty windows (no samples yet) are still sent.
 */
export const CiTrendSchema = z.object({
  window_days: z.number().int(),
  current: CiWindowSchema,
  previous: CiWindowSchema,
  /** The newest sampled run's creation time, or null when nothing has been sampled. */
  sampled_through: z.number().int().nullable(),
});
export type CiTrend = z.infer<typeof CiTrendSchema>;
