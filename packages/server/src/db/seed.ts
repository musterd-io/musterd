import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import type { Driver } from './driver.js';

export interface SeededDawn {
  teamId: string;
  nick: { id: string; token: string };
  ada: { id: string; token: string };
  lin: { id: string; token: string };
}

/** Insert the canonical `dawn` fixture (01-data-model.md). Used by integration + scenario tests. */
export async function seedDawn(db: Driver): Promise<SeededDawn> {
  const team = await createTeam(db, { slug: 'dawn' });
  const nick = await addMember(db, team, {
    name: 'nick',
    kind: 'human',
    role: 'lead',
    lifecycle: 'forever',
  });
  const ada = await addMember(db, team, {
    name: 'Ada',
    kind: 'agent',
    role: 'backend',
    lifecycle: 'session',
  });
  const lin = await addMember(db, team, {
    name: 'Lin',
    kind: 'agent',
    role: 'frontend',
    lifecycle: 'session',
  });
  return {
    teamId: team.id,
    nick: { id: nick.row.id, token: nick.token },
    ada: { id: ada.row.id, token: ada.token },
    lin: { id: lin.row.id, token: lin.token },
  };
}
