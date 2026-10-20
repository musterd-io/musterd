import { createHash, randomBytes } from 'node:crypto';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';

/**
 * The distributed Slack app's daemon-side install record (ADR 668 decisions 2/5, lane
 * 01M50ZQGWYNZKNWDNDDRP41W5B). A human here mints a one-time install state (stored only
 * as sha256, shown once); the relay's OAuth flow exchanges Slack's code and holds the
 * resulting record; on its next connect the daemon syncs the record, checks it against a
 * live state this daemon minted, and only then stores it. An install record a daemon
 * never asked for installs nothing.
 *
 * The per-install bot token replaces the team-policy `slack_bot_token` (decision 5; the
 * policy key stays as a fallback until its own retirement change). The token is a
 * credential: never audited, logged, exported or returned by any listing (hard rule 5).
 * Revocation is a row state, so a revoked workspace stays refused rather than vanishing.
 */

export interface SlackInstall {
  slackTeamId: string;
  installerSlackId: string;
  installedAt: number;
  revokedAt: number | null;
}

const STATE_TTL_MS = 10 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Mint a one-time install state for this team; the caller shows it once, in the link. */
export async function createSlackInstallRequest(
  db: Driver,
  input: { teamId: string; actor: string; now?: number },
): Promise<{ state: string; expiresAt: number }> {
  const now = input.now ?? Date.now();
  const state = randomBytes(32).toString('base64url');
  await db.run(
    `INSERT INTO slack_install_requests (team_id, state_hash, created_by, created_at, consumed_at)
     VALUES (?, ?, ?, ?, NULL)`,
    [input.teamId, sha256(state), input.actor, now],
  );
  return { state, expiresAt: now + STATE_TTL_MS };
}

export type RecordSlackInstallResult =
  | { ok: true; install: SlackInstall }
  | { ok: false; reason: 'no_live_request' };

/**
 * Store one install record the relay held for this team. The record's state must hash to
 * a live, unconsumed request this daemon minted for this team — that is what makes the
 * install this team's act rather than anything a relay or caller asserted.
 */
export async function recordSlackInstall(
  db: Driver,
  input: {
    teamId: string;
    actor: string;
    slackTeamId: string;
    botToken: string;
    installerSlackId: string;
    state: string;
    installedAt: number;
    now?: number;
  },
): Promise<RecordSlackInstallResult> {
  const now = input.now ?? Date.now();
  const request = await db.get<{ created_at: number; consumed_at: number | null }>(
    `SELECT created_at, consumed_at FROM slack_install_requests
      WHERE team_id = ? AND state_hash = ?`,
    [input.teamId, sha256(input.state)],
  );
  if (!request || request.consumed_at !== null || now - request.created_at > STATE_TTL_MS) {
    await appendAudit(db, input.teamId, {
      actor: input.actor,
      action: 'channel.slack_install_refused',
      target: input.slackTeamId,
      result: 'deny',
      detail: { channel: 'slack', reason: 'no_live_request', installer: input.installerSlackId },
    });
    return { ok: false, reason: 'no_live_request' };
  }
  await db.run(
    `UPDATE slack_install_requests SET consumed_at = ? WHERE team_id = ? AND state_hash = ?`,
    [now, input.teamId, sha256(input.state)],
  );
  await db.run(
    `INSERT INTO slack_installs (team_id, slack_team_id, bot_token, installer_slack_id, installed_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(team_id, slack_team_id) DO UPDATE SET bot_token = excluded.bot_token,
       installer_slack_id = excluded.installer_slack_id, installed_at = excluded.installed_at,
       revoked_at = NULL`,
    [input.teamId, input.slackTeamId, input.botToken, input.installerSlackId, input.installedAt],
  );
  await appendAudit(db, input.teamId, {
    actor: input.actor,
    action: 'channel.slack_installed',
    target: input.slackTeamId,
    result: 'allow',
    detail: { channel: 'slack', installer: input.installerSlackId },
  });
  return {
    ok: true,
    install: {
      slackTeamId: input.slackTeamId,
      installerSlackId: input.installerSlackId,
      installedAt: input.installedAt,
      revokedAt: null,
    },
  };
}

/** The team's live install, token included — store-internal; listings never carry it. */
export async function getSlackInstallBotToken(
  db: Driver,
  teamId: string,
): Promise<{ slackTeamId: string; botToken: string } | null> {
  const row = await db.get<{ slack_team_id: string; bot_token: string }>(
    `SELECT slack_team_id, bot_token FROM slack_installs
      WHERE team_id = ? AND revoked_at IS NULL
      ORDER BY installed_at DESC LIMIT 1`,
    [teamId],
  );
  return row ? { slackTeamId: row.slack_team_id, botToken: row.bot_token } : null;
}

/** Installations for display: routing facts only, never a token. */
export async function listSlackInstalls(db: Driver, teamId: string): Promise<SlackInstall[]> {
  const rows = await db.all<{
    slack_team_id: string;
    installer_slack_id: string;
    installed_at: number;
    revoked_at: number | null;
  }>(
    `SELECT slack_team_id, installer_slack_id, installed_at, revoked_at FROM slack_installs
      WHERE team_id = ? ORDER BY installed_at`,
    [teamId],
  );
  return rows.map((r) => ({
    slackTeamId: r.slack_team_id,
    installerSlackId: r.installer_slack_id,
    installedAt: r.installed_at,
    revokedAt: r.revoked_at,
  }));
}

/** Revoke one workspace's install: its token stops working here and stays refused. */
export async function revokeSlackInstall(
  db: Driver,
  input: { teamId: string; actor: string; slackTeamId: string; now?: number },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const existing = await db.get<{ revoked_at: number | null }>(
    `SELECT revoked_at FROM slack_installs WHERE team_id = ? AND slack_team_id = ?`,
    [input.teamId, input.slackTeamId],
  );
  if (!existing || existing.revoked_at !== null) return false;
  await db.run(`UPDATE slack_installs SET revoked_at = ? WHERE team_id = ? AND slack_team_id = ?`, [
    now,
    input.teamId,
    input.slackTeamId,
  ]);
  await appendAudit(db, input.teamId, {
    actor: input.actor,
    action: 'channel.slack_install_refused',
    target: input.slackTeamId,
    result: 'deny',
    detail: { channel: 'slack', reason: 'revoked' },
  });
  return true;
}
