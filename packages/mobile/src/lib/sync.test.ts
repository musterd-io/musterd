import type {
  CalendarEntry,
  CalendarEntryInput,
  CalendarWriteResponse,
} from '@musterd/protocol/calendar';
import { beforeEach, describe, expect, it } from 'vitest';
import { CalendarApiError, type CalendarApi } from './api';
import { isLocalId, LocalCalendar, memoryStore, type LocalStore } from './sync';

function input(over: Partial<CalendarEntryInput> = {}): CalendarEntryInput {
  return {
    title: 'Demo day',
    date: '2026-10-09',
    start: null,
    end: null,
    tz: 'America/Los_Angeles',
    kind: 'demo',
    status: null,
    place: '',
    url: null,
    note: '',
    pick: false,
    source: '',
    source_ref: null,
    ...over,
  };
}

/**
 * A daemon double with the SPEC A.16 semantics the phone depends on: a monotonic clock, `?since`
 * returning writes and deletes at or after it, and `updated_at` stamped on every write.
 */
class FakeDaemon implements CalendarApi {
  clock = 1000;
  rows = new Map<string, CalendarEntry>();
  deletes = new Map<string, number>();
  online = true;
  nextId = 0;
  refuse: string | null = null;

  private tick(): number {
    return ++this.clock;
  }
  private gate(): void {
    if (!this.online) throw new CalendarApiError('could not reach', 0, null);
  }

  seed(over: Partial<CalendarEntryInput> = {}): CalendarEntry {
    const t = this.tick();
    const e: CalendarEntry = {
      ...input(over),
      id: `srv${++this.nextId}`,
      created_by: 'nick',
      created_at: t,
      updated_at: t,
    };
    this.rows.set(e.id, e);
    return e;
  }
  edit(id: string, over: Partial<CalendarEntryInput>): void {
    const e = this.rows.get(id)!;
    this.rows.set(id, { ...e, ...over, updated_at: this.tick() });
  }
  drop(id: string): void {
    this.rows.delete(id);
    this.deletes.set(id, this.tick());
  }

  async list(since?: number) {
    this.gate();
    const now = this.tick();
    const entries = [...this.rows.values()].filter(
      (e) => since === undefined || e.updated_at >= since,
    );
    const deleted =
      since === undefined ? [] : [...this.deletes].filter(([, t]) => t >= since).map(([id]) => id);
    return { entries, deleted, now };
  }
  async create(body: CalendarEntryInput): Promise<CalendarWriteResponse> {
    this.gate();
    if (this.refuse) throw new CalendarApiError(this.refuse, 400, 'bad_request');
    // SPEC A.16: a POST naming a source_ref the Team already has replaces that entry.
    const same = [...this.rows.values()].find(
      (e) => body.source_ref !== null && e.source_ref === body.source_ref,
    );
    if (same) {
      const entry = { ...same, ...body, updated_at: this.tick() };
      this.rows.set(same.id, entry);
      return this.answer({ entry, outcome: 'updated' });
    }
    const t = this.tick();
    const entry: CalendarEntry = {
      ...body,
      id: `srv${++this.nextId}`,
      created_by: 'nick',
      created_at: t,
      updated_at: t,
    };
    this.rows.set(entry.id, entry);
    return this.answer({ entry, outcome: 'created' });
  }
  /** Set to drop the next write's answer after it commits — a Tailscale drop mid-response. */
  loseNextAnswer = false;
  private answer(r: CalendarWriteResponse): CalendarWriteResponse {
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new CalendarApiError('could not reach', 0, null);
    }
    return r;
  }
  async replace(id: string, body: CalendarEntryInput): Promise<CalendarWriteResponse> {
    this.gate();
    const e = this.rows.get(id);
    if (!e) throw new CalendarApiError('no such entry', 404, 'not_found');
    const entry = { ...e, ...body, updated_at: this.tick() };
    this.rows.set(id, entry);
    return { entry, outcome: 'updated' };
  }
  async remove(id: string): Promise<void> {
    this.gate();
    if (!this.rows.has(id)) throw new CalendarApiError('no such entry', 404, 'not_found');
    this.drop(id);
  }
}

let daemon: FakeDaemon;
let store: LocalStore;
let cal: LocalCalendar;

beforeEach(() => {
  daemon = new FakeDaemon();
  store = memoryStore();
  cal = new LocalCalendar(store, 'nick');
});

const titles = async (): Promise<string[]> => (await cal.entries()).map((e) => e.title).sort();

describe('pull', () => {
  it('a first sync takes everything; a later one only the delta, deletes included', async () => {
    const a = daemon.seed({ title: 'a' });
    daemon.seed({ title: 'b' });
    expect(await cal.sync(daemon)).toMatchObject({ offline: false, pushed: 0, dropped: [] });
    expect(await titles()).toEqual(['a', 'b']);

    daemon.edit(a.id, { title: 'a2' });
    daemon.seed({ title: 'c' });
    const b = [...daemon.rows.values()].find((e) => e.title === 'b')!;
    daemon.drop(b.id);
    await cal.sync(daemon);
    expect(await titles()).toEqual(['a2', 'c']);
  });

  it('offline leaves the device as it was and says so', async () => {
    daemon.seed({ title: 'a' });
    await cal.sync(daemon);
    daemon.online = false;
    expect((await cal.sync(daemon)).offline).toBe(true);
    expect(await titles()).toEqual(['a']);
  });
});

describe('writes on a plane', () => {
  it('a create shows at once, queues, and is replaced by the daemon copy on the next sync', async () => {
    daemon.online = false;
    const local = await cal.save(input({ title: 'pitch practice' }), null);
    expect(isLocalId(local.id)).toBe(true);
    expect(await titles()).toEqual(['pitch practice']);
    expect((await cal.sync(daemon)).offline).toBe(true);

    daemon.online = true;
    const r = await cal.sync(daemon);
    expect(r.pushed).toBe(1);
    const [e] = await cal.entries();
    expect(isLocalId(e!.id)).toBe(false);
    expect(daemon.rows.get(e!.id)?.title).toBe('pitch practice');
    expect(await store.pending()).toEqual([]);
  });

  it('two edits fold into one queued write against the original base', async () => {
    const a = daemon.seed({ title: 'a' });
    await cal.sync(daemon);
    const [mine] = await cal.entries();
    await cal.save(input({ title: 'a1' }), mine!);
    await cal.save(input({ title: 'a2' }), (await cal.entries())[0]!);
    const q = await store.pending();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ op: 'replace', base: a.updated_at, body: { title: 'a2' } });
    await cal.sync(daemon);
    expect(daemon.rows.get(a.id)?.title).toBe('a2');
  });

  it('deleting a never-delivered create cancels it — the daemon never hears of it', async () => {
    daemon.online = false;
    const local = await cal.save(input(), null);
    await cal.remove(local);
    expect(await store.pending()).toEqual([]);
    daemon.online = true;
    await cal.sync(daemon);
    expect(daemon.rows.size).toBe(0);
  });

  it('a delete is delivered, and a delete of something already gone is not an error', async () => {
    const a = daemon.seed();
    const b = daemon.seed();
    await cal.sync(daemon);
    const [ea, eb] = (await cal.entries()).sort((x, y) => (x.id < y.id ? -1 : 1));
    await cal.remove(ea!);
    await cal.remove(eb!);
    daemon.rows.delete(b.id); // gone without a trace in the delta
    const r = await cal.sync(daemon);
    expect(r.dropped).toEqual([]);
    expect(daemon.rows.has(a.id)).toBe(false);
    expect(await store.pending()).toEqual([]);
  });
});

describe('the daemon wins a conflict, and the phone says so', () => {
  it('an edit made while the daemon copy moved is dropped and named', async () => {
    const a = daemon.seed({ title: 'a' });
    await cal.sync(daemon);
    daemon.online = false;
    await cal.save(input({ title: 'mine' }), (await cal.entries())[0]!);
    daemon.edit(a.id, { title: 'theirs' });
    daemon.online = true;
    const r = await cal.sync(daemon);
    expect(r.dropped).toEqual([
      {
        title: 'theirs',
        reason: 'changed on the daemon while you were away — your edit was dropped',
      },
    ]);
    expect(await titles()).toEqual(['theirs']);
    expect(daemon.rows.get(a.id)?.title).toBe('theirs');
  });

  it('an edit to an entry deleted on the daemon is dropped and named', async () => {
    const a = daemon.seed({ title: 'a' });
    await cal.sync(daemon);
    await cal.save(input({ title: 'mine' }), (await cal.entries())[0]!);
    daemon.drop(a.id);
    const r = await cal.sync(daemon);
    expect(r.dropped).toEqual([
      { title: 'mine', reason: 'deleted on the daemon — your edit was dropped' },
    ]);
    expect(await cal.entries()).toEqual([]);
  });

  it('a delete loses to a newer daemon edit, and the entry comes back', async () => {
    const a = daemon.seed({ title: 'a' });
    await cal.sync(daemon);
    await cal.remove((await cal.entries())[0]!);
    daemon.edit(a.id, { title: 'still on' });
    const r = await cal.sync(daemon);
    expect(r.dropped[0]?.reason).toMatch(/kept/);
    expect(await titles()).toEqual(['still on']);
  });

  it('an edit with no conflict survives a pull and lands', async () => {
    const a = daemon.seed({ title: 'a' });
    daemon.seed({ title: 'b' });
    await cal.sync(daemon);
    const ea = (await cal.entries()).find((e) => e.id === a.id)!;
    await cal.save(input({ title: 'a-mine' }), ea);
    await store.setCursor(null); // force a full read: the unmoved daemon copy must not clobber the edit
    await cal.sync(daemon);
    expect(daemon.rows.get(a.id)?.title).toBe('a-mine');
    expect(await titles()).toEqual(['a-mine', 'b']);
  });
});

describe('a lost answer', () => {
  it('a create the daemon committed but never answered is not duplicated by the replay', async () => {
    const local = await cal.save(input({ title: 'demo day' }), null);
    expect(local.source_ref).toBe(local.id);
    daemon.loseNextAnswer = true;
    expect((await cal.sync(daemon)).offline).toBe(true);
    expect(daemon.rows.size).toBe(1); // it did land
    await cal.sync(daemon);
    expect(daemon.rows.size).toBe(1);
    expect((await cal.entries()).map((e) => e.title)).toEqual(['demo day']);
    expect(await store.pending()).toEqual([]);
  });
});

describe('refusals', () => {
  it('a refused create is dropped, named, and removed from the device', async () => {
    daemon.refuse = 'url must be https';
    await cal.save(input({ title: 'bad' }), null);
    const r = await cal.sync(daemon);
    expect(r.dropped).toEqual([{ title: 'bad', reason: 'refused: url must be https' }]);
    expect(await cal.entries()).toEqual([]);
    expect(await store.pending()).toEqual([]);
  });

  it('a server error keeps the queue and reports it', async () => {
    await cal.save(input(), null);
    daemon.create = async () => {
      throw new CalendarApiError('boom', 500, 'server_error');
    };
    const r = await cal.sync(daemon);
    expect(r.error).toBe('boom');
    expect(await store.pending()).toHaveLength(1);
  });
});

it('reset forgets the device copy, the queue and the cursor', async () => {
  daemon.seed();
  await cal.sync(daemon);
  await cal.save(input(), null);
  await cal.reset();
  expect(await cal.entries()).toEqual([]);
  expect(await store.pending()).toEqual([]);
  expect(await store.cursor()).toBeNull();
});
