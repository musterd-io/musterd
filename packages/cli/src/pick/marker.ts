import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ADR 626: a terminal pick reaches its seat through the workspace, not an act. `musterd pick` runs
 * in the seat's own folder and leaves this marker; the seat's interrupt check (every harness's hook
 * runs it in the same folder) shows it once and deletes it.
 */
export interface PendingPick {
  lane: string;
  title: string;
  requested_by: string;
  at: number;
}

const FILE = 'pending-pick.json';

export function writePendingPick(workspaceDir: string, pick: PendingPick): void {
  const dir = join(workspaceDir, '.musterd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify(pick) + '\n', { mode: 0o600 });
}

const LANE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MEMBER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TITLE_MAX = 120;

/**
 * The line the seat is shown, once. The words are ADR 626 Decision 2's. The marker is a file any
 * process in the workspace could write, so every field is held to its shape before it reaches the
 * seat's context: a ULID lane, a member-shaped name, and a title with no control bytes, no quotes
 * to break out of its quoting, and a hard length cap. Anything else is not shown.
 */
export function pendingPickLine(p: PendingPick): string | null {
  if (!LANE_ID.test(p.lane) || !MEMBER_NAME.test(p.requested_by)) return null;
  const title = p.title
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f"“”]/g, ' ')
    .slice(0, TITLE_MAX);
  return (
    `musterd: ${p.requested_by} picked lane ${p.lane.slice(0, 10)} for you in the lane picker ` +
    `(terminal, unattested): "${title}". Reply with a 3–5 line plan, then start unless redirected.`
  );
}

/** Read the marker and delete it; null when there is none or it does not parse (deleted too). */
export function takePendingPick(workspaceDir: string): string | null {
  const path = join(workspaceDir, '.musterd', FILE);
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, 'utf8')) as Partial<PendingPick>;
    if (
      typeof p.lane !== 'string' ||
      typeof p.title !== 'string' ||
      typeof p.requested_by !== 'string'
    )
      return null;
    return pendingPickLine(p as PendingPick);
  } catch {
    return null;
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      /* a marker we cannot delete is shown again next time — never a failure on the hook */
    }
  }
}
