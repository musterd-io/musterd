import { describe, expect, it } from 'vitest';
import { createActors } from './actors';
import { solidHit } from './nav';
import { assignSeats } from './seating';
import type { OfficeNode } from './types';

/**
 * Nobody walks through furniture (swetha, 2026-10-28: "avatars will walk through furniture. they
 * should not be able to walk through anything"). Every kind of trip, for a full office, stepped frame
 * by frame: a member who is up on their feet (`sit` low) is never standing inside a drawn footprint
 * — a desk, a chair, the couch, a shelf, a plant. Brushing an edge is a body's width, not a clip, so
 * a hit counts only past `SLACK` units in.
 */

const SLACK = 4;

function node(name: string): OfficeNode {
  return {
    name,
    kind: 'agent',
    service: false,
    woken: false,
    presence: 'online',
    activity: 'working',
    posture: 'working',
    state: null,
    color: 'hsl(200, 60%, 60%)',
    role: '',
    surface: null,
    model: null,
    workTitle: null,
    workSource: null,
    laneState: null,
    moreLanes: 0,
    dnd: false,
    offline_reason: null,
    last_seen_at: null,
    created_at: null,
    sponsored_by: null,
  };
}

const NAMES = Array.from({ length: 14 }, (_, i) => `m${i}`);

function office() {
  const nodes = NAMES.map(node);
  const actors = createActors();
  const placements = assignSeats(nodes);
  actors.setHomes(placements, new Map(nodes.map((n) => [n.name, n])), true);
  // Each member's own chair is where they get up from and sit back down: not a clip.
  const own = new Map<string, string>();
  for (const [name, at] of placements) if (at.kind === 'desk') own.set(name, `chair-${at.slot}`);
  return { actors, own };
}

/** Run every walk to the end; the clips seen on the way, as `who · tag · inset`. */
function clipsOf(start: (a: ReturnType<typeof createActors>) => void): string[] {
  const { actors, own } = office();
  start(actors);
  const out = new Map<string, { who: string; tag: string }>();
  // A seat someone sits down in (the couch, an armchair) is stepped onto on the way down: not a clip.
  const satIn = new Set<string>();
  for (let i = 0; i < 6000 && actors.active(); i++) {
    actors.step(0.05);
    for (const [name, p] of actors.poses()) {
      const hit = solidHit(p.lx, p.ly);
      if ((p.sit ?? 0) > 0.2) {
        if (hit) satIn.add(`${name} ${hit.tag}`);
        continue; // seated or lowering into a seat: a chair is where you sit
      }
      if (hit && hit.inset > SLACK && hit.tag !== own.get(name))
        out.set(`${name} · ${hit.tag} · ${p.lx.toFixed(0)},${p.ly.toFixed(0)} · ${hit.inset.toFixed(0)}`, {
          who: name,
          tag: hit.tag,
        });
    }
  }
  return [...out].filter(([, h]) => !satIn.has(`${h.who} ${h.tag}`)).map(([line]) => line);
}

const pairs = NAMES.map((n, i) => [n, NAMES[(i + 5) % NAMES.length]!] as const);

describe('nobody walks through furniture', () => {
  it('on a walk to a teammate (help, handoff)', () => {
    expect(
      clipsOf((a) => {
        for (const [from, to] of pairs) a.walk(from, { kind: 'help', to, urgent: false });
      }),
    ).toEqual([]);
  });

  it('on a trip to the wall board (claim, pin, move, toss)', () => {
    expect(
      clipsOf((a) => {
        NAMES.forEach((n, i) => {
          const kind = i % 4;
          if (kind === 0) a.claim(n, i + 1);
          else if (kind === 1) a.pin(n, i + 1, 'done');
          else if (kind === 2) a.move(n, i + 1, 'active');
          else a.toss(n, i + 1);
        });
      }),
    ).toEqual([]);
  });

  it('on an errand (coffee, water, the fridge, a phone call)', () => {
    expect(
      clipsOf((a) => {
        NAMES.forEach((n, i) => {
          const kind = i % 4;
          if (kind === 0) a.ambientWalk(n);
          else if (kind === 1) a.errandWater(n);
          else if (kind === 2) a.errandFridge(n, () => 0.3);
          else a.errandPhone(n, () => 0.3);
        });
      }),
    ).toEqual([]);
  });

  it('on a desk chat or an aisle meet', () => {
    expect(
      clipsOf((a) => {
        for (const [x, y] of pairs.slice(0, 6)) a.deskChat(x, y, () => 0.4);
        for (const [x, y] of pairs.slice(6, 12)) a.aisleMeet(x, y, () => 0.4);
      }),
    ).toEqual([]);
  });

  it('on a deliver to an acceptor', () => {
    expect(
      clipsOf((a) => {
        pairs.forEach(([from, to], i) => a.deliver(from, to, i + 1));
      }),
    ).toEqual([]);
  });
});
