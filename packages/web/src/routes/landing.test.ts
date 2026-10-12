import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8');

describe('landing page', () => {
  it('uses the typographic hero, not the canvas office scene', () => {
    expect(src()).toContain('LightHero');
    expect(src()).not.toMatch(/components\/Hero\/Hero|office-scene/);
  });
  it('no longer pulls the /live stylesheet', () => {
    expect(src()).not.toContain('Live.css');
  });
  // ADR 428: ONE office, and the stream is it. `OfficeProof` is gone; a second office block is the
  // defect this asserts against coming back. ADR 567 (2026-10-12, superseding ADR 560's order): the
  // office is the hero's right column, then the chain, why and getting started.
  it('runs hero (with the office), chain, why, getting started, and has no second office block', () => {
    const order = src();
    expect(order).not.toContain('OfficeProof');
    const at = (c: string) => order.indexOf(`<${c}`);
    const seq = ['LightHero', 'Chain', 'WhyTalk', 'GettingStarted', 'Teasers', 'Boundary', 'SiteFooter'];
    for (const c of seq) expect(at(c), c).toBeGreaterThan(-1);
    for (let i = 1; i < seq.length; i++) expect(at(seq[i - 1]!)).toBeLessThan(at(seq[i]!));
    // §0a.1: these three said the chain as claims; the chain section says it once, about one lane.
    expect(order).not.toMatch(/ClaimToAccepted|WhatIs|HowItWorks|RecordCard/);
    // The office lives in the hero, once.
    expect(order).not.toContain('<StreamSection');
    const hero = readFileSync(
      fileURLToPath(new URL('../components/site/LightHero.tsx', import.meta.url)),
      'utf8',
    );
    expect(hero.match(/<StreamSection \/>/g)).toHaveLength(1);
  });
});

/**
 * The one office slot (ADR 428). These assertions moved here from the deleted `OfficeProof` and
 * kept their reasons: the constraints belong to the still, not to whichever component holds it.
 */
describe('the office slot in the stream section', () => {
  const stream = readFileSync(
    fileURLToPath(new URL('../components/site/StreamSection.tsx', import.meta.url)),
    'utf8',
  );
  // Comments stripped for the negative assertions below: a guard against a string RENDERING must
  // not fire on the prose explaining why it does not. Caught by this file on 2026-09-18, where the
  // doc comment's "a visitor between sessions saw nothing" tripped the state-neutrality check.
  const rendered = stream.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // The alt text is already written, shipping and reviewed on /watch. Retyping it is how two
  // surfaces start describing the same image differently.
  it('renders the still with the IMPORTED alt, never a retyped one', () => {
    expect(stream).toContain('alt={WATCH_COPY.stillAlt}');
    expect(rendered).not.toMatch(/alt="[^"]/);
  });

  // A still and not the live canvas, because the scene costs ~51 ms/draw on a GPU-less box and a
  // marketing page must not charge that to a visitor (lane 01M2TM6C6XF6). If someone ever mounts
  // the scene here, this is the test that should stop them.
  it('uses the static capture, not the office scene', () => {
    expect(stream).toContain('office-still.png');
    expect(rendered).not.toMatch(/office-scene|mountOffice|OfficeScene/);
  });

  // Explicit dimensions still, and eager with a high priority: since ADR 567 it is the hero's
  // picture, the first image on the page, so lazy would deprioritise the visual a reader waits on.
  it('cannot shift layout, and is eager now that it is the hero', () => {
    expect(stream).toMatch(/width=\{1200\}/);
    expect(stream).toMatch(/height=\{630\}/);
    expect(stream).toContain('fetchPriority="high"');
    expect(rendered).not.toContain('loading="lazy"');
  });

  // "Whose office is this?" — answered in the one paragraph left (homepage-copy-spec §0a.5): the team
  // in the picture is the team that builds musterd. The desk-outlasts-the-session sentence left the
  // page on purpose; /watch carries it.
  it('says whose office this is, without a state word in the heading', () => {
    expect(rendered.replace(/\s+/g, ' ')).toContain('This is that team claiming work');
    expect(stream).toContain('Watch the team build it');
    expect(rendered).not.toMatch(/build it, live/);
    expect(stream).not.toContain('npx @musterd/cli init'); // the repo is private (2026-10-03)
  });

  // The still is what `unknown` and `dark` both show, so the caption rendered alongside it must be
  // true in either — it may not claim the channel is live, and may not invent a schedule (spec §2).
  it('never claims live while the still is the thing on screen', () => {
    // The still now yields to a STARTED replay as well as to a live channel (lane 01M32JE1ZP).
    expect(stream).toContain("liveness !== 'live' && !replaying");
    // The live claim moved into WATCH_COPY when /watch and the homepage stopped keeping two
    // copies of one sentence, so assert the GATE rather than the literal: the claim is reachable
    // only from the live branch, whatever the string happens to say.
    expect(stream).toMatch(/liveness === 'live'\s*\?\s*WATCH_COPY\.stateLive/);
    // The dark/unknown caption is the one that ships prerendered; it must not assert liveness.
    expect(stream).toContain('The team works in sessions, so the channel is dark between them.');
  });
});

// Comments stripped and whitespace collapsed: a guard against a string RENDERING must not fire on
// the prose explaining why it does not, and JSX wraps a sentence across lines where prettier likes.
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

// ADR 320 decision 5 (2026-09-16): the landing leads with names, never with containment, and the
// category noun is never bare (decision 4). ADR 563 (2026-10-12): the claim is the team.
describe('the hero', () => {
  const hero = read('../components/site/LightHero.tsx');

  // Scoped 2026-09-17 after big-body's cross-family security read (act 01M2PH26PH): the unscoped
  // claim reads as a promise about everything an agent does. ADR 563 decision 2: the subhead names
  // the people as members and says what the reader gets before how.
  it('scopes the naming claim to the roster, and puts a human on it', () => {
    expect(hero).not.toMatch(/Every act has a name on it/);
    expect(hero).toContain('the people you work with are named members of one team');
    expect(hero).toContain('who stands behind it');
    expect(hero).toContain('shows who did');
    expect(hero).not.toContain('which model did it');
    expect(hero).not.toContain('Any member can say no');
  });
  it('has no contrast frame, and says what a click leads to', () => {
    expect(hero).not.toMatch(/not watching from outside/);
    expect(hero).not.toMatch(/Watch it live/); // a state claim in prerendered HTML
    expect(hero).toContain('Watch the team work');
    expect(hero).toContain('Private preview. We write to you when there is a seat for your team.');
  });
  it('carries the office as its right column (ADR 567), not a record card', () => {
    expect(hero).toContain('<StreamSection />');
    expect(hero).not.toContain('RecordCard');
  });

  it('no surface here uses the critic\'s noun', () => {
    expect(hero).not.toMatch(/swarm/i);
  });
});

// homepage-copy-spec §0a (2026-10-12): one argument, five sections, every fact at most twice.
describe('the 2026-10-12 cut', () => {
  const chain = read('../components/site/Chain.tsx');
  const why = read('../components/site/WhyTalk.tsx');
  const start = read('../components/site/GettingStarted.tsx');
  const boundary = read('../components/site/Boundary.tsx');

  // §0.2: acceptance arrives after the merge, so it is "done", never "ships on its author's word".
  it('the chain walks one real lane through four stops, and separates landing from done', () => {
    expect(chain).toContain('One piece of work, from claimed to accepted');
    expect(chain).toContain('One lane from our own board, as the board recorded it.');
    for (const label of ['Claimed', 'Model', 'Landed', 'Accepted']) expect(chain).toContain(`label: '${label}'`);
    expect(chain).toContain('Landing is not the same as done.');
    // ADR 235: an owner CAN close its own lane, recorded unconfirmed — the page says so rather than
    // claiming an agent cannot (miley's decline of 01M4RCBNZ3, 2026-10-12).
    expect(chain).toContain(
      "Accepting work is a teammate's act; an agent that closes its own lane is recorded as unconfirmed.",
    );
    expect(chain).not.toMatch(/cannot set it for itself/);
    expect(chain).toContain('reported Claude Sonnet 5.5, and the record kept that with the lane');
    expect(chain).not.toMatch(/Nothing ships|ships on its author/);
    // Stop 2 says what the record kept and stops — the old contrast frame stays out.
    expect(chain).not.toMatch(/not what the agent says about itself/);
    expect(chain).not.toMatch(/who asked|asked for it|requested by/i);
  });

  it('the chain shows a dated capture of the real board card, never a live query', () => {
    expect(chain).toMatch(/captures\/board-lane-\d{4}-\d{2}-\d{2}\.webp/);
    expect(chain).toContain('The lane on our board, captured <span className="nowrap">2026-10-12</span>.');
    expect(chain).not.toMatch(/fetch\(|useBoardData|useLiveStream/);
  });

  it('Why agents talk: answers the audience beside a real ask, and dates the proof', () => {
    expect(why).toContain('A shared file can hold a result. Talk carries what is not a result yet');
    expect(why).toContain('An agent that needs one asks you, and the ask waits in your inbox until you answer.');
    expect(why).toContain('wasted 65 to 83 percent of their work');
    expect(why).toContain('One project, a pilot, measured in July 2026.');
    // The frame shows the answer, so the caption says "answered" (§0a.4).
    expect(why).toContain('An ask from an agent to a person, answered in the inbox. Captured');
    // §0a.1: left the page on purpose.
    expect(why).not.toMatch(/more than a third of the code/);
    expect(why).not.toMatch(/You are probably already running more than one/);
    expect(why).not.toMatch(/wt__move/);
    // The pair must not be borrowed as a transferable rate (ADR 294).
    expect(why).not.toMatch(/\bevery team\b|\byour team will\b/i);
  });

  it('keeps the scoped boundary sentence and the sandbox disclaimer, verbatim, above the footer', () => {
    expect(boundary).toContain(
      'musterd does not sandbox your agents; your own host, sandbox and provider controls still do that. It names the work that goes through the team.',
    );
  });

  // The /start row links the first-ten-minutes page (dreamy's lane 01M4GQ2NR438YWWYRH7RTTYP9X);
  // a "Today" row must never link to a page that 404s, so this pins the link it carries.
  it('Getting started links the first-ten-minutes page, and nowhere that does not exist', () => {
    expect(start).toContain('FIRST_TEN_MINUTES_PATH');
    expect(start).toContain('See your first ten minutes');
    expect(start).toContain('What the first session looks like, step by step');
  });

  it('Getting started says what exists today and what does not, once, without a state word or a date', () => {
    expect(start).toContain('What you can do today, and what comes next.');
    // §0a.6: the hero says "private preview" and carries the seat promise; this section does not.
    expect(start).not.toMatch(/private preview/);
    expect(start).not.toMatch(/We write to you/);
    expect(start).toContain("status: 'Not yet'");
    expect(start).toContain('Install and connect your agents.');
    for (const code of [chain, start]) {
      expect(code).not.toMatch(/\b(live|now|currently)\b/i);
    }
    // The "Not yet" row promises nothing: no link, no date.
    expect(start).toMatch(/status: 'Not yet'[\s\S]*?link: null/);
  });
});

// The prerendered HTML of both pages shipped a facade badge reading LIVE and the label
// 'live broadcast', unconditionally, before any player loaded — while /watch read REAL liveness
// for its eyebrow and state line one element over. A string that is true in only one state may
// never be the fallback for an unknown state (watch-page-copy-spec §4.1; homepage-copy-spec §2).
describe('the player facade never asserts a state it cannot read', () => {
  const stream = readFileSync(
    new URL('../components/site/StreamSection.tsx', import.meta.url),
    'utf8',
  );
  const watch = readFileSync(new URL('../components/site/WatchPage.tsx', import.meta.url), 'utf8');
  /**
   * Comments are stripped before matching, and that is the point rather than a convenience.
   * This gate is about what the component SHIPS, not about what a maintainer is allowed to
   * explain. Matching raw source means the next person who documents the rule types the banned
   * string into a comment and gets a failure that looks like their code is wrong — which happened
   * twice while writing this change, and was "fixed" both times by rewording the explanation
   * instead of the code. A gate that punishes its own documentation teaches the wrong lesson.
   */
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('WatchPage ships no live claim in its facade', () => {
    const source = code(watch);
    expect(source).not.toMatch(/>LIVE</);
    expect(source).not.toMatch(/live broadcast/);
    expect(source).toContain('musterd on Twitch');
  });

  // StreamSection has no facade since ADR 428 — the still IS what shows before and without a live
  // signal, so the rule it has to keep is the same one stated differently: nothing it renders may
  // claim the channel is live unless liveness actually said so.
  it('StreamSection claims live only inside the live branch', () => {
    const source = code(stream);
    expect(source).not.toMatch(/>LIVE</);
    expect(source).not.toMatch(/live broadcast/);
    // `Live now.` is no longer inline — it is WATCH_COPY.stateLive, shared with /watch so the two
    // surfaces cannot describe one state differently. The property under test is unchanged and is
    // now checked directly: the live copy is reachable only when the player said `live`.
    const live = source.indexOf('WATCH_COPY.stateLive');
    expect(live).toBeGreaterThan(-1);
    expect(source.slice(0, live)).toMatch(/liveness === 'live'\s*\?\s*$/);
    // And the replay is a THIRD branch, never folded into the live one.
    expect(source).toContain('WATCH_COPY.stateReplay');
  });
});
