import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SOFTWARE_GAME_ID,
  STANDING_TITLE,
  TITLE_PREFIX,
  applyChannelTitle,
  clauseTail,
  decideTitle,
  isSessionTitle,
  sessionTitle,
  streamTitleEnv,
  type TitleGoal,
  type TitleLane,
} from './channelTitle.js';

const AUDIT = `${TITLE_PREFIX}the twitch channel audit`;
const WATCH = `${TITLE_PREFIX}building the /watch page`;

function lane(over: Partial<TitleLane> = {}): TitleLane {
  return { state: 'active', goal_id: null, title: 'a lane title nobody should ship raw', ...over };
}

function goal(over: Partial<TitleGoal> = {}): TitleGoal {
  return { id: 'g', title: 'a goal title', ...over };
}

describe('clauseTail', () => {
  it('lowercases the spec tails and keeps a period inside a name', () => {
    expect(clauseTail('the Twitch channel audit')).toBe('the twitch channel audit');
    expect(clauseTail('building the /watch page')).toBe('building the /watch page');
    expect(clauseTail('getting musterd.io indexed')).toBe('getting musterd.io indexed');
  });

  it('cuts on a clause mark, not on a bare period, and drops an ADR number', () => {
    expect(clauseTail('the watch page — and then a second thought')).toBe('the watch page');
    expect(clauseTail('office realism: the rest of the sentence is too long to keep')).toBe(
      'office realism',
    );
    expect(clauseTail('ship the page (draft notes after)')).toBe('ship the page');
    expect(clauseTail('what is the watch page? more after')).toBe('what is the watch page');
    expect(clauseTail('Publish ADR 711 before lunch')).toBe('publish before lunch');
    expect(clauseTail('building the `/watch` page')).toBe('building the /watch page');
  });

  it('refuses an empty clause, a digit, and a tail over 35 characters', () => {
    expect(clauseTail('   ')).toBeNull();
    expect(clauseTail('page 2 of the audit')).toBeNull();
    expect(clauseTail('a'.repeat(36))).toBeNull();
    expect(clauseTail('a'.repeat(35))).toBe('a'.repeat(35));
  });
});

describe('isSessionTitle', () => {
  it('accepts the standing title even though its tail is past 35', () => {
    expect(STANDING_TITLE.slice(TITLE_PREFIX.length).length).toBeGreaterThan(35);
    expect(isSessionTitle(STANDING_TITLE)).toBe(true);
  });

  it('accepts a generated title and refuses a newline, a digit, and a capital tail', () => {
    expect(isSessionTitle(AUDIT)).toBe(true);
    expect(isSessionTitle(`${AUDIT}\n`)).toBe(false);
    expect(isSessionTitle(`${TITLE_PREFIX}page 2`)).toBe(false);
    expect(isSessionTitle(`${TITLE_PREFIX}The Audit`)).toBe(false);
    expect(isSessionTitle('not a title')).toBe(false);
  });
});

describe('sessionTitle', () => {
  it('uses the goal story, then the goal title, then the one lane', () => {
    expect(
      sessionTitle({
        lanes: [lane({ goal_id: 'g' })],
        goals: [goal({ story: 'One logo everywhere…' })],
      }),
    ).toBe(`${TITLE_PREFIX}one logo everywhere`);
    expect(
      sessionTitle({
        lanes: [lane({ goal_id: 'g' })],
        goals: [goal({ story: 'getting musterd.io indexed' })],
      }),
    ).toBe(`${TITLE_PREFIX}getting musterd.io indexed`);
    expect(
      sessionTitle({
        lanes: [lane({ goal_id: 'g', title: 'building the /watch page' })],
        goals: [
          goal({
            story: 'this story is ' + 'far too long '.repeat(5),
            title: 'the Twitch channel audit',
          }),
        ],
      }),
    ).toBe(AUDIT);
    expect(
      sessionTitle({
        lanes: [lane({ goal_id: 'g', title: 'building the /watch page' })],
        goals: [goal({ title: 'ADR 711 and then 40 characters of process' })],
      }),
    ).toBe(WATCH);
  });

  it('stands when the session has more than one goal', () => {
    expect(
      sessionTitle({
        lanes: [
          lane({ goal_id: 'a', title: 'building the /watch page' }),
          lane({ goal_id: 'b', title: 'the twitch channel audit' }),
        ],
        goals: [
          goal({ id: 'a', story: 'building the /watch page' }),
          goal({ id: 'b', story: 'the twitch channel audit' }),
        ],
      }),
    ).toBe(STANDING_TITLE);
  });

  it('ignores an incident and a lane that is not being worked', () => {
    expect(
      sessionTitle({
        lanes: [
          lane({ state: 'active', goal_id: 'g', title: 'building the /watch page' }),
          lane({ kind: 'incident', goal_id: 'other', title: 'the daemon is down' }),
          lane({ state: 'open', goal_id: 'third', title: 'not started' }),
        ],
        goals: [goal({ story: 'building the /watch page' })],
      }),
    ).toBe(WATCH);
  });

  it('uses the one lane when nothing points at a live goal, and stands otherwise', () => {
    expect(sessionTitle({ lanes: [lane({ title: 'the twitch channel audit' })], goals: [] })).toBe(
      AUDIT,
    );
    expect(
      sessionTitle({
        lanes: [lane({ goal_id: 'g', title: 'building the /watch page' })],
        goals: [goal({ retracted: { by: 'nick', at: 1 }, story: 'building the /watch page' })],
      }),
    ).toBe(WATCH);
    expect(
      sessionTitle({
        lanes: [lane({ title: 'one' }), lane({ title: 'two' })],
        goals: [],
      }),
    ).toBe(STANDING_TITLE);
    expect(sessionTitle({ lanes: [], goals: [] })).toBe(STANDING_TITLE);
  });

  it('stands when every clause is overlong or contains a digit', () => {
    expect(
      sessionTitle({
        lanes: [lane({ goal_id: 'g', title: 'page 2' })],
        goals: [goal({ story: 'a'.repeat(40), title: 'also ' + 'a'.repeat(40) })],
      }),
    ).toBe(STANDING_TITLE);
  });
});

describe('decideTitle', () => {
  const desired = WATCH;
  const prev = AUDIT;

  it('leaves a human title', () => {
    expect(
      decideTitle({
        currentTitle: 'Nick typed this',
        currentGameId: SOFTWARE_GAME_ID,
        desired,
        prev,
      }),
    ).toEqual({ kind: 'leave', line: 'title left alone — channel title is not one we set' });
  });

  it('sets when we own the standing title and the desired one differs', () => {
    expect(
      decideTitle({
        currentTitle: STANDING_TITLE,
        currentGameId: SOFTWARE_GAME_ID,
        desired,
        prev: '',
      }),
    ).toMatchObject({ kind: 'set', title: desired });
  });

  it('keeps a title and category that already match', () => {
    expect(
      decideTitle({ currentTitle: desired, currentGameId: SOFTWARE_GAME_ID, desired, prev }),
    ).toEqual({ kind: 'keep', line: 'title unchanged' });
  });

  it('sets when the title matches and the category does not', () => {
    expect(decideTitle({ currentTitle: desired, currentGameId: '1', desired, prev })).toMatchObject(
      { kind: 'set', title: desired },
    );
  });

  it('updates a channel still showing the previous title we set', () => {
    expect(
      decideTitle({ currentTitle: prev, currentGameId: SOFTWARE_GAME_ID, desired, prev }),
    ).toMatchObject({ kind: 'set', title: desired });
  });

  it('owns an empty title, and treats a restored old title as a person’s once we have moved on', () => {
    expect(decideTitle({ currentTitle: '', currentGameId: '', desired, prev: '' })).toMatchObject({
      kind: 'set',
    });
    expect(
      decideTitle({ currentTitle: prev, currentGameId: SOFTWARE_GAME_ID, desired, prev: desired }),
    ).toMatchObject({ kind: 'leave' });
  });
});

describe('streamTitleEnv', () => {
  it('passes both slots, and substitutes when a value is not a session title', () => {
    expect(streamTitleEnv(WATCH, '')).toEqual([
      '--env',
      `MUSTERD_STREAM_TITLE=${WATCH}`,
      '--env',
      'MUSTERD_STREAM_TITLE_PREV=',
    ]);
    expect(streamTitleEnv('nope', `${AUDIT}\n`)).toEqual([
      '--env',
      `MUSTERD_STREAM_TITLE=${STANDING_TITLE}`,
      '--env',
      'MUSTERD_STREAM_TITLE_PREV=',
    ]);
  });
});

describe('applyChannelTitle', () => {
  const token = 'oauth-secret-value';
  const clientId = 'client-secret-id';
  const env = {
    MUSTERD_TWITCH_TOKEN: token,
    MUSTERD_TWITCH_CLIENT_ID: clientId,
    MUSTERD_STREAM_TITLE: WATCH,
    MUSTERD_STREAM_TITLE_PREV: '',
  };

  function channel(title: string, gameId: string) {
    return { data: [{ title, game_id: gameId }] };
  }

  it('does not call twitch when the token or the client id is missing', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error('should not be called');
    };
    expect(await applyChannelTitle({}, fetchImpl)).toBe('title off — twitch token unset');
    expect(await applyChannelTitle({ MUSTERD_TWITCH_TOKEN: token }, fetchImpl)).toBe(
      'title off — twitch token unset',
    );
    expect(calls).toBe(0);
  });

  it('sets the title and the category when the standing title is ours', async () => {
    const bodies: unknown[] = [];
    const line = await applyChannelTitle(env, async (url, init) => {
      const href = String(url);
      if (href.endsWith('/users')) return json(200, { data: [{ id: '42' }] });
      if (init?.method === 'PATCH') {
        bodies.push(JSON.parse(String(init.body)));
        return json(204, null);
      }
      return json(200, channel(STANDING_TITLE, '1'));
    });
    expect(line).toBe('title set');
    expect(bodies).toEqual([{ title: WATCH, game_id: SOFTWARE_GAME_ID }]);
  });

  it('does not patch when the title and the category already match', async () => {
    let patches = 0;
    const line = await applyChannelTitle(env, async (url, init) => {
      if (init?.method === 'PATCH') patches += 1;
      if (String(url).endsWith('/users')) return json(200, { data: [{ id: '42' }] });
      return json(200, channel(WATCH, SOFTWARE_GAME_ID));
    });
    expect(line).toBe('title unchanged');
    expect(patches).toBe(0);
  });

  it('leaves a human title and does not patch', async () => {
    let patches = 0;
    const line = await applyChannelTitle(env, async (url, init) => {
      if (init?.method === 'PATCH') patches += 1;
      if (String(url).endsWith('/users')) return json(200, { data: [{ id: '42' }] });
      return json(200, channel('Nick typed this', '1'));
    });
    expect(line).toBe('title left alone — channel title is not one we set');
    expect(patches).toBe(0);
  });

  it('names a rejected token and does not patch', async () => {
    let patches = 0;
    const line = await applyChannelTitle(env, async (_url, init) => {
      if (init?.method === 'PATCH') patches += 1;
      return json(401, { message: token });
    });
    expect(line).toBe('title off — twitch token rejected');
    expect(patches).toBe(0);
    expect(line).not.toContain(token);
  });

  it('never puts the token or the client id in the line, even when the error does', async () => {
    const line = await applyChannelTitle(env, async () => {
      throw new Error(`connect ${token} ${clientId}`);
    });
    expect(line).toBe('title off — could not read the channel');
    expect(line).not.toContain(token);
    expect(line).not.toContain(clientId);
  });
});

describe('entrypoint', () => {
  it('applies the title once, before ingest, and ignores a missing subcommand', () => {
    const entry = readFileSync(
      fileURLToPath(new URL('../../../../scripts/broadcast/entrypoint.sh', import.meta.url)),
      'utf8',
    );
    const applyAt = entry.indexOf('stream apply-title');
    expect(applyAt).toBeGreaterThan(-1);
    expect(entry.indexOf('stream apply-title', applyAt + 1)).toBe(-1);
    expect(applyAt).toBeLessThan(entry.indexOf('while :; do'));
    expect(applyAt).toBeLessThan(entry.indexOf('bin.js broadcast'));
    expect(entry).toContain('stream apply-title || true');
  });
});

function json(status: number, body: unknown): Pick<Response, 'ok' | 'status' | 'json'> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
