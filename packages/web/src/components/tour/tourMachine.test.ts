import type { Envelope, Lane, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  advance,
  canGoBack,
  agentNow,
  clock,
  hintFor,
  readinessOf,
  suggestAgent,
  ticketStage,
  timeline,
  initialState,
  modelOf,
  stepLines,
  stepTitle,
  entryLabel,
  tourEntry,
  tourLaneOf,
  ulidTime,
  verdictLine,
  type TourState,
} from './tourMachine';

const LANE = '01M4M4DDYFFX7FFD5YVRAQ1C50';
const env = (over: Partial<Envelope>): Envelope =>
  ({
    id: `e${Math.random()}`,
    team: 'revive',
    from: 'dolly',
    to: { kind: 'team' },
    act: 'message',
    body: '',
    thread: null,
    meta: null,
    ts: 1,
    ...over,
  }) as Envelope;
const waiting = (step: TourState['step']): TourState => ({
  ...initialState('nick', 'dolly'),
  step,
  laneId: LANE,
  requestId: 'req1',
});
const member = (name: string, kind: string, model?: string) =>
  ({ name, kind, presences: model ? [{ model }] : [] }) as unknown as MemberSummary;
const lane = (title: string, state: string, id = LANE) => ({ id, title, state }) as unknown as Lane;
const TITLE = "[tour] nick: summarise this repo's README in three lines";

describe('tour machine — the CLI tour’s rules, on the web', () => {
  it('walks what → team → give_work on Continue, and give_work only on the lane opening', () => {
    let s = initialState('nick', 'dolly');
    s = advance(s, { type: 'continue' });
    expect(s.step).toBe('team');
    s = advance(s, { type: 'continue' });
    expect(s.step).toBe('give_work');
    expect(advance(s, { type: 'continue' })).toBe(s);
    s = advance(s, { type: 'lane_opened', laneId: LANE, requestId: 'req1' });
    expect(s).toMatchObject({ step: 'claims', laneId: LANE, requestId: 'req1' });
  });

  it('moves on the agent’s claim of THIS lane only', () => {
    const s = waiting('claims');
    const other = env({ meta: { lane_claim: { lane: 'OTHER' } } });
    expect(advance(s, { type: 'act', env: other })).toBe(s);
    const someoneElse = env({ from: 'ghost', meta: { lane_claim: { lane: LANE } } });
    expect(advance(s, { type: 'act', env: someoneElse })).toBe(s);
    const claim = env({ meta: { lane_claim: { lane: LANE } } });
    expect(advance(s, { type: 'act', env: claim }).step).toBe('hands_back');
  });

  it('takes the acceptance ask routed to the viewer, and keeps its id for the verdict', () => {
    const ask = env({
      id: 'ask1',
      act: 'ask',
      to: { kind: 'member', name: 'nick' },
      meta: { lane_review: { lane: LANE } },
    });
    expect(advance(waiting('hands_back'), { type: 'act', env: ask })).toMatchObject({
      step: 'judge',
      askId: 'ask1',
    });
    const toTeam = { ...ask, to: { kind: 'team' } } as Envelope;
    expect(advance(waiting('hands_back'), { type: 'act', env: toTeam }).step).toBe('hands_back');
  });

  it('records a decline only when it answers the tour’s own request', () => {
    const stray = env({ act: 'decline', body: 'no', meta: { in_reply_to: 'other' } });
    expect(advance(waiting('claims'), { type: 'act', env: stray }).outcome).toBeUndefined();
    const no = env({ act: 'decline', body: 'busy', meta: { in_reply_to: 'req1' } });
    const s = advance(waiting('claims'), { type: 'act', env: no });
    expect(s).toMatchObject({ step: 'claims', outcome: 'declined', declineReason: 'busy' });
    expect(advance(s, { type: 'skip_to_record' }).step).toBe('record');
  });

  it('sends back to hands_back, counts it, and the agent’s self-close goes to record', () => {
    let s: TourState = { ...waiting('judge'), askId: 'ask1' };
    s = advance(s, { type: 'verdict', accept: false });
    expect(s).toMatchObject({ step: 'hands_back', sentBack: 1 });
    expect(s.askId).toBeUndefined();
    const resolve = env({ meta: { lane_resolve: { lane: LANE } } });
    expect(advance(s, { type: 'act', env: resolve })).toMatchObject({
      step: 'record',
      outcome: 'self_closed',
    });
  });

  it('says the verdict in the four forms of spec §4', () => {
    const s = waiting('record');
    expect(verdictLine({ ...s, outcome: 'accepted' }, 'nick')).toBe('accepted by nick');
    expect(verdictLine({ ...s, outcome: 'accepted', sentBack: 2 }, 'nick')).toBe(
      'sent back by nick, then accepted by nick',
    );
    expect(verdictLine({ ...s, outcome: 'self_closed' }, 'nick')).toBe('closed by dolly itself');
    expect(verdictLine({ ...s, outcome: 'declined' }, 'nick')).toBe('declined by dolly');
  });
});

describe('tour text', () => {
  const vars = { you: 'nick', agent: 'dolly', lane: LANE, model: '' };

  it('titles a step by its place in the script', () => {
    expect(stepTitle('judge')).toBe('Step 6 of 9 · You judge it');
  });

  it('drops the model line with no attested model, except on record', () => {
    expect(stepLines(waiting('team'), vars).join('\n')).not.toMatch(/running/);
    expect(stepLines(waiting('team'), { ...vars, model: 'opus' }).join('\n')).toMatch(
      /dolly is running opus/,
    );
    const record = stepLines({ ...waiting('record'), outcome: 'accepted' }, vars);
    expect(record[1]).toBe(
      'opened by nick · claimed by dolly · model unattested · accepted by nick',
    );
  });

  it('drops a line naming the agent until one is chosen', () => {
    const lines = stepLines(initialState('nick', ''), { ...vars, agent: '' });
    expect(lines.join('\n')).not.toMatch(/\{agent\}|you give\s/);
    expect(lines[0]).toBe('musterd puts your agents on a team with you.');
  });

  it('shows only the latest hint that is due', () => {
    expect(hintFor('claims', 59_000, vars)).toBeNull();
    expect(hintFor('claims', 61_000, vars)).toMatch(/^Still waiting/);
    expect(hintFor('claims', 181_000, vars)).toMatch(/take a few minutes/);
  });

  it('drops the terminal-only Ctrl-C sentence from a hint on the web', () => {
    expect(hintFor('claims', 181_000, vars)).not.toMatch(/Ctrl-C|musterd tour/);
    expect(hintFor('claims', 181_000, vars)).toMatch(/waits as long as it takes\.$/);
  });
});

describe('tour entry (spec §2–3)', () => {
  const roster = [member('nick', 'human'), member('dolly', 'agent', 'claude-opus-5-5')];

  it('offers Take the tour to a human with an agent and no tour lane', () => {
    expect(tourEntry([], roster, 'nick')).toEqual({ kind: 'take' });
  });

  it('offers nothing to an agent viewer, before the board is read, or with no agent', () => {
    expect(tourEntry([], roster, 'dolly')).toEqual({ kind: 'none' });
    expect(tourEntry(null, roster, 'nick')).toEqual({ kind: 'none' });
    expect(tourEntry([], [member('nick', 'human')], 'nick')).toEqual({ kind: 'none' });
  });

  it('resumes an open tour lane, and offers it again once it closed', () => {
    expect(tourEntry([lane(TITLE, 'claimed')], roster, 'nick').kind).toBe('resume');
    expect(tourEntry([lane(TITLE, 'done')], roster, 'nick')).toEqual({ kind: 'again' });
    expect(tourEntry([lane(TITLE, 'done')], [member('nick', 'human')], 'nick')).toEqual({
      kind: 'none',
    });
    expect(tourEntry([lane(TITLE.replace('nick', 'alfie'), 'open')], roster, 'nick').kind).toBe(
      'take',
    );
  });

  it('labels a first run and a re-run, and nothing else', () => {
    expect(entryLabel({ kind: 'take' })).toBe('Take the tour');
    expect(entryLabel({ kind: 'again' })).toBe('Take the tour again');
    expect(entryLabel({ kind: 'none' })).toBeNull();
  });

  it('finds the newest of two lanes with the title (after Start over)', () => {
    const old = lane(TITLE, 'abandoned', '01M4M4DDYF0000000000000000');
    const fresh = lane(TITLE, 'open', '01M4MZZZZZ0000000000000000');
    expect(tourLaneOf([fresh, old], 'nick')?.id).toBe(fresh.id);
    expect(tourLaneOf([old, fresh], 'nick')?.id).toBe(fresh.id);
  });

  it('reads the model from the roster, treating unknown as none', () => {
    expect(modelOf(roster, 'dolly')).toBe('claude-opus-5-5');
    expect(modelOf([member('dolly', 'agent', 'unknown')], 'dolly')).toBe('');
  });

  it('decodes the time a lane opened from its ULID', () => {
    // Reference values from the `ulid` package's decodeTime, which the CLI tour uses.
    expect(ulidTime('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(1469922850259);
    expect(ulidTime(LANE)).toBe(1791677085647);
  });
});

describe('while the tour waits on the agent', () => {
  const m = (over: Record<string, unknown>) =>
    ({ name: 'ghost', kind: 'agent', presence: 'online', ...over }) as unknown as MemberSummary;

  it('counts the wait as m:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(47_400)).toBe('0:47');
    expect(clock(185_000)).toBe('3:05');
  });

  it('says musterd is waking an offline agent only when its wake can reach it', () => {
    expect(agentNow(m({ presence: 'offline', wakeable: true }), 'claims')).toMatch(/waking it/);
    expect(
      agentNow(m({ presence: 'offline', wakeable: true, wakeability: 'enrolled_host_stale' }), 'claims'),
    ).toMatch(/can't wake it/);
    expect(agentNow(m({ presence: 'offline' }), 'claims')).toMatch(/can't wake it/);
  });

  it('reads an online agent as idle or busy, and as working once it has the lane', () => {
    expect(agentNow(m({ posture: 'idle' }), 'claims')).toBe('ghost is online and has the request.');
    expect(agentNow(m({ posture: 'working' }), 'claims')).toMatch(/busy with other work/);
    expect(agentNow(m({}), 'hands_back')).toMatch(/working on the lane/);
    expect(agentNow(undefined, 'claims')).toBeNull();
  });

  it('ranks an agent ready, busy, asleep or unreachable, and suggests the readiest', () => {
    const ready = m({ name: 'dolly', posture: 'idle' });
    const busy = m({ name: 'izzo', posture: 'working' });
    const asleep = m({ presence: 'offline', wakeable: true });
    expect(readinessOf(ready)).toBe('ready');
    expect(readinessOf(busy)).toBe('busy');
    expect(readinessOf(asleep)).toBe('asleep');
    expect(readinessOf(m({ presence: 'offline' }))).toBe('unreachable');
    expect(suggestAgent([asleep, busy, ready], ['ghost', 'izzo', 'dolly'])).toBe('dolly');
    expect(suggestAgent([asleep, busy], ['ghost', 'izzo'])).toBe('izzo');
    expect(suggestAgent([asleep], ['ghost', 'nobody'])).toBe('ghost');
  });
});

describe('the lane ticket', () => {
  it('moves opened → claimed → submitted → closed with the steps', () => {
    expect(ticketStage(initialState('nick', 'dolly'))).toBe(0);
    expect(ticketStage(waiting('claims'))).toBe(1);
    expect(ticketStage({ ...waiting('claims'), outcome: 'declined' })).toBe(1);
    expect(ticketStage(waiting('hands_back'))).toBe(2);
    expect(ticketStage(waiting('judge'))).toBe(3);
    expect(ticketStage({ ...waiting('record'), outcome: 'accepted' })).toBe(4);
    expect(ticketStage({ ...waiting('record'), outcome: 'self_closed' })).toBe(4);
  });

  it('tells the lane’s story from the record, oldest first, and nothing else', () => {
    const t0 = ulidTime(LANE);
    const acts = [
      env({ id: 'claim', ts: t0 + 47_000, meta: { lane_claim: { lane: LANE } } }),
      env({ id: 'open', from: 'nick', ts: t0, meta: { lane_open: { lane: LANE } } }),
      env({ id: 'req1', from: 'nick', act: 'request_help', ts: t0 + 1 }),
      env({ id: 'st', act: 'status_update', body: 'reading the README', ts: t0 + 50_000 }),
      env({ id: 'ask1', act: 'ask', ts: t0 + 66_000, meta: { lane_review: { lane: LANE } } }),
      env({ id: 'ok', from: 'nick', act: 'accept', ts: t0 + 80_000, meta: { in_reply_to: 'ask1' } }),
      env({ id: 'noise', from: 'izzo', act: 'status_update', body: 'other work', ts: t0 + 5 }),
      env({ id: 'other', meta: { lane_claim: { lane: 'OTHER' } }, ts: t0 + 6 }),
      env({ id: 'old', act: 'status_update', body: 'before the tour', ts: t0 - 9_000 }),
    ];
    expect(timeline(acts, waiting('record')).map((e) => e.text)).toEqual([
      'You opened the lane',
      'You asked dolly to take it',
      'dolly claimed it',
      'dolly: reading the README',
      'dolly submitted it for your review',
      'You accepted it',
    ]);
    expect(timeline(acts, initialState('nick', 'dolly'))).toEqual([]);
  });

  it('tells a decline of the request', () => {
    const no = env({ id: 'no', act: 'decline', body: 'busy', meta: { in_reply_to: 'req1' }, ts: 9 });
    expect(timeline([no], waiting('claims')).map((e) => e.text)).toEqual(['dolly said no']);
  });
});

describe('back', () => {
  const base = (step: TourState['step'], laneId?: string): TourState => ({
    ...initialState('nick', 'dolly'),
    step,
    ...(laneId ? { laneId } : {}),
  });

  it('steps back from team and give_work while no lane exists', () => {
    expect(advance(base('team'), { type: 'back' }).step).toBe('what');
    expect(advance(base('give_work'), { type: 'back' }).step).toBe('team');
  });

  it('never steps back once the lane is real, or from the first step', () => {
    const claims = base('claims', LANE);
    expect(advance(claims, { type: 'back' })).toBe(claims);
    expect(canGoBack(base('give_work', LANE))).toBe(false);
    const what = base('what');
    expect(advance(what, { type: 'back' })).toBe(what);
  });

  it('team waits for continue: nothing else moves it', () => {
    expect(advance(base('team'), { type: 'continue' }).step).toBe('give_work');
  });
});
