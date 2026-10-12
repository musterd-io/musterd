import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { resolveProject } from '@musterd/protocol/project';
import { flagStr, type Parsed } from '../args.js';
import type { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import { checkAgainstBoard } from '../import/check.js';
import { renderList, renderPreview, renderSaved } from '../import/render.js';
import { formatFor, parseImportFile } from '../import/rows.js';
import { saveStage } from '../import/save.js';
import { defaultSheetName, exampleDiagnostics, writeSheet } from '../import/sheet.js';
import {
  createStage,
  ensureImportsDir,
  importsDir,
  listStages,
  readStage,
  writeStage,
} from '../import/stage.js';
import { githubSource, githubToken, repoFromRemote } from '../import/trackers/github.js';
import { jiraAuth, jiraSource } from '../import/trackers/jira.js';
import { linearKey, linearSource } from '../import/trackers/linear.js';
import { runTrackerImport } from '../import/trackers/run.js';
import { findWorkspaceDir, resolve } from './helpers.js';

const USAGE =
  'usage:\n' +
  '  musterd import <file.csv|file.jsonl>   check against the board, preview, and stage (creates nothing)\n' +
  '  musterd import save <id>               create the staged goals and lanes (re-run resumes)\n' +
  '  musterd import list                    staged imports in this workspace\n' +
  '  musterd import sheet [path]            a blank sheet to fill in by hand (never overwrites)\n' +
  '  musterd import github [owner/repo] [--limit N]\n' +
  '                                         open issues from GitHub (gh auth token, or GITHUB_TOKEN);\n' +
  '                                         run it again to re-sync — reads only, writes nothing back\n' +
  '  musterd import linear <TEAM-KEY> [--limit N]\n' +
  '                                         open issues from Linear (LINEAR_API_KEY); run it again to re-sync\n' +
  '  musterd import jira <site> <PROJECT-KEY> [--limit N]\n' +
  '                                         open issues from Jira (JIRA_EMAIL+JIRA_API_TOKEN, JIRA_PAT, or\n' +
  '                                         anonymous on a public site); run it again to re-sync';

/** `musterd import` (spec 2026-10-10 "bring work in"): two steps — preview+stage, then save. */
export async function importCommand(parsed: Parsed): Promise<number> {
  const [first, second] = parsed.positionals;
  if (!first) throw new CliError(USAGE, 2);
  const ws = findWorkspaceDir();
  if (!ws)
    throw new CliError(
      'musterd import needs a musterd workspace — run `musterd init` here first',
      2,
    );
  ensureImportsDir(ws);

  if (first === 'list') {
    process.stdout.write(renderList(listStages(ws), Date.now()) + '\n');
    return 0;
  }

  if (first === 'sheet') {
    const path = second ? resolvePath(second) : join(importsDir(ws), defaultSheetName(Date.now()));
    writeSheet(path);
    const rel = relative(process.cwd(), path) || path;
    process.stdout.write(
      `✓ wrote ${rel}\n` +
        '  fill it in, one row per goal or lane, and delete the two example rows; then: ' +
        `musterd import ${rel}\n`,
    );
    return 0;
  }

  const { team, http } = resolve(parsed.flags);

  if (first === 'save') {
    if (!second) throw new CliError(USAGE, 2);
    const stage = readStage(ws, second);
    const result = await saveStage(stage, {
      team,
      port: http,
      persist: (s) => writeStage(ws, s),
      now: Date.now,
    });
    process.stdout.write(
      renderSaved(readStage(ws, stage.id), result, liveUrlFor(http, team)) + '\n',
    );
    return 0;
  }

  if (first === 'github') {
    const own = ownRepo();
    const repo = second ?? repoFromRemote();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new CliError(`"${repo}" is not owner/repo — e.g. musterd import github acme/app`, 2);
    // Credentials before anything else: a refused or missing token is the fix to print first.
    const source = githubSource({
      repo,
      token: githubToken(),
      ...(process.env['MUSTERD_GITHUB_API'] ? { apiBase: process.env['MUSTERD_GITHUB_API'] } : {}),
    });
    return runTrackerImport(source, {
      ws,
      team,
      http,
      project: resolveProject({ explicit: flagStr(parsed.flags, 'project') }),
      rerun: `github ${repo}`,
      legacyGithub: own?.toLowerCase() === repo.toLowerCase(),
      ...limitFlag(parsed),
    });
  }

  if (first === 'linear') {
    // Positional, not --team: --team already names the musterd team on every command.
    const key = second?.trim().toUpperCase();
    if (!key || !/^[A-Z0-9]+$/.test(key))
      throw new CliError(
        'usage: musterd import linear <TEAM-KEY> [--limit N]   (the Linear team key, e.g. ENG)',
        2,
      );
    const source = linearSource({
      team: key,
      key: linearKey(),
      ...(process.env['MUSTERD_LINEAR_API'] ? { endpoint: process.env['MUSTERD_LINEAR_API'] } : {}),
    });
    return runTrackerImport(source, {
      ws,
      team,
      http,
      project: resolveProject({ explicit: flagStr(parsed.flags, 'project') }),
      rerun: `linear ${key}`,
      ...limitFlag(parsed),
    });
  }

  if (first === 'jira') {
    // Positional, not --site/--project: --project already names the musterd project.
    const [, rawSite, rawKey] = parsed.positionals;
    const key = rawKey?.trim().toUpperCase();
    if (!rawSite || !key || !/^[A-Z][A-Z0-9_]*$/.test(key))
      throw new CliError(
        'usage: musterd import jira <site> <PROJECT-KEY> [--limit N]   (e.g. issues.apache.org/jira CLI)',
        2,
      );
    const site = /^https?:\/\//.test(rawSite) ? rawSite : `https://${rawSite}`;
    try {
      new URL(site);
    } catch {
      throw new CliError(`"${rawSite}" is not a Jira site URL`, 2);
    }
    return runTrackerImport(jiraSource({ site, project: key, auth: jiraAuth() }), {
      ws,
      team,
      http,
      project: resolveProject({ explicit: flagStr(parsed.flags, 'project') }),
      rerun: `jira ${rawSite} ${key}`,
      ...limitFlag(parsed),
    });
  }

  const path = resolvePath(first);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CliError(`cannot read ${first}`, 2);
  }
  const format = formatFor(path);
  const { rows, diagnostics: rowDiagnostics } = parseImportFile(text, format);
  const [goals, board] = await Promise.all([
    http.goals(team),
    http.laneBoard(team, { history: true }),
  ]);
  const plan = checkAgainstBoard(rows, { goals: goals.goals, lanes: board.lanes });
  const stage = createStage(
    ws,
    {
      team,
      project: resolveProject({ explicit: flagStr(parsed.flags, 'project') }),
      created_at: Date.now(),
      source: { path, sha256: createHash('sha256').update(text).digest('hex'), format },
      goals: plan.goals,
      lanes: plan.lanes,
      linked_goals: plan.linkedGoals,
      diagnostics: [...rowDiagnostics, ...exampleDiagnostics(rows), ...plan.diagnostics],
    },
    Date.now(),
  );
  process.stdout.write(renderPreview(stage) + '\n');
  return stage.diagnostics.some((d) => d.level === 'error') ? 1 : 0;
}

/** This workspace's own GitHub repo, or null — phase 1's `github#N` refs can only mean this one. */
function ownRepo(): string | null {
  try {
    return repoFromRemote();
  } catch {
    return null;
  }
}

function limitFlag(parsed: Parsed): { limit?: number } {
  const raw = flagStr(parsed.flags, 'limit');
  if (raw === undefined) return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new CliError(`--limit wants a whole number, got "${raw}"`, 2);
  return { limit: n };
}

/** The team's /live viewer, served by the daemon on its own origin (ADR 132). */
function liveUrlFor(http: HttpClient, team: string): string {
  return `${http.server}/live?team=${encodeURIComponent(team)}`;
}
