import { humanCommand } from '../commands/human.js';
import { tourCommand } from '../commands/tour.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';

/**
 * Start the tour from the end of `musterd init` (spec 2026-10-10-first-run-tour-design). Init's
 * folder is bound to the agent's seat, and the tour must act as the person, so this first gives the
 * person a workspace of their own (`musterd human`, which reuses the credential init just minted),
 * then runs the tour from it.
 */
export async function startTourAsPerson(person: string, team: string): Promise<number> {
  const made = await humanCommand({ positionals: [person], flags: { team }, metaPairs: [] });
  if (made !== 0) return made;
  const home = loadConfig().teamHome[team];
  if (!home) throw new CliError(`no workspace recorded for ${person} on ${team}`, 1);
  process.chdir(home);
  return tourCommand({ positionals: [], flags: {}, metaPairs: [] });
}
