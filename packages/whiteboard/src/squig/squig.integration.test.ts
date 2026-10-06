/**
 * The adapter against a real Squig companion (ADR 524). Runs only where a built checkout exists
 * (`~/.squig/src` or SQUIG_CHECKOUT) — CI has none, so it skips there and the in-memory suite in
 * provider.test.ts is the gate. On a dev machine it proves the op shapes Squig actually accepts.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seatActor } from '../port.js';
import { probeSquigCheckout } from './checkout.js';
import { SquigProvider } from './provider.js';

const probe = probeSquigCheckout();
const ADA = seatActor('ada');

describe.skipIf(!probe.ok)('SquigProvider on a real Squig checkout', () => {
  let dir: string;
  let provider: SquigProvider;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-squig-live-'));
    process.env['WHITEBOARD_DATA_DIR'] = dir;
    if (probe.ok) provider = new SquigProvider(probe.checkout);
  });

  afterAll(async () => {
    await provider?.closeAll();
    delete process.env['WHITEBOARD_DATA_DIR'];
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens, places, reads back, edits and closes through the live companion', async () => {
    const { created } = await provider.open('live');
    expect(created).toBe(true);
    expect(await provider.editorUrl('live')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/\?local=1#token=/,
    );

    const [c] = (await provider.add('live', ADA, [{ kind: 'cluster', title: 'Risks' }])).ids;
    const { ids, version } = await provider.add('live', ADA, [
      { kind: 'note', text: 'cold start', detail: 'why', cluster: c! },
      { kind: 'note', text: 'cost' },
    ]);
    await provider.add('live', ADA, [
      { kind: 'link', from: ids[0]!, to: ids[1]!, label: 'drives' },
    ]);

    const outline = await provider.read('live');
    expect(outline.items.map((i) => [i.kind, i.text]).sort()).toEqual([
      ['cluster', 'Risks'],
      ['link', 'drives'],
      ['note', 'cold start'],
      ['note', 'cost'],
    ]);
    expect(outline.items.find((i) => i.text === 'cold start')).toMatchObject({
      cluster: c,
      detail: 'why',
    });
    expect((await provider.read('live', outline.version)).items).toEqual([]);

    const { refused } = await provider.edit('live', ADA, [
      { op: 'retitle', id: ids[1]!, text: 'cost, monthly' },
      { op: 'delete', id: ids[0]! },
    ]);
    expect(refused).toEqual([]);
    const diff = await provider.read('live', version);
    expect(diff.removed).toContain(ids[0]);
    expect(diff.items.some((i) => i.text === 'cost, monthly')).toBe(true);
    expect(diff.items.some((i) => i.kind === 'link')).toBe(false);

    const final = await provider.close('live');
    expect(final.items.map((i) => i.text).sort()).toEqual(['Risks', 'cost, monthly']);
  });

  it("runs Squig's own tools on a linked board: draw attributed, render a PNG, read history (ADR 527)", async () => {
    const file = join(dir, 'repo', 'team.squig.json');
    mkdirSync(join(dir, 'repo'), { recursive: true });
    provider.link('team', file);
    await provider.open('team');
    const doc = await provider.squigTool('team', 'get_document', {});
    const drawn = await provider.squigTool(
      'team',
      'edit_document',
      {
        revision: doc['revision'],
        operations: [{ op: 'note', text: 'a raw sticky', x: 0, y: 0 }],
      },
      ADA,
    );
    const [id] = drawn['createdIds'] as string[];
    expect((await provider.read('team')).items.find((i) => i.id === id)).toMatchObject({
      text: 'a raw sticky',
      createdBy: ADA,
    });
    const png = await provider.squigTool('team', 'render_document', { format: 'png' });
    expect(png['mimeType']).toBe('image/png');
    expect(String(png['base64']).length).toBeGreaterThan(100);
    expect(
      ((await provider.squigTool('team', 'history', {}))['revisions'] as unknown[]).length,
    ).toBeGreaterThan(0);
    expect(existsSync(file)).toBe(true);
    await provider.close('team');
  });
});
