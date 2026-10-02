import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { resolve } from './helpers.js';

/**
 * Goal dreaming, lane 2: print this seat's dream packet — its lanes' day, its note, the team's
 * insights since its last dream — as JSON. The reader is a dreaming session, so there is no
 * human rendering; the server scopes it to the calling seat.
 */
export async function dreamCommand(parsed: Parsed): Promise<number> {
  const rawSince = flagStr(parsed.flags, 'since');
  if (rawSince !== undefined && !/^\d+$/.test(rawSince)) {
    throw new CliError('usage: musterd dream [--since <epoch-ms>]', 2);
  }
  const { team, http } = resolve(parsed.flags);
  const built = await http.dreamPacket(team, rawSince === undefined ? undefined : Number(rawSince));
  process.stdout.write(JSON.stringify(built) + '\n');
  return 0;
}
