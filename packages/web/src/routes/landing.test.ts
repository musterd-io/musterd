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
  // defect this asserts against coming back. Since 2026-10-09 (homepage-copy-spec §0.4/§0.5) the
  // real-lane card sits between the hero and the stream, until the order is reopened with an ADR.
  it('puts the stream after the hero and the claim-to-accepted card, and has no second office block', () => {
    const order = src();
    expect(order).not.toContain('OfficeProof');
    expect(order.indexOf('<LightHero')).toBeLessThan(order.indexOf('<ClaimToAccepted'));
    expect(order.indexOf('<ClaimToAccepted')).toBeLessThan(order.indexOf('<StreamSection'));
    expect(order.indexOf('<StreamSection')).toBeLessThan(order.indexOf('<WhatIs'));
    expect(order.indexOf('<HowItWorks')).toBeLessThan(order.indexOf('<GettingStarted'));
    expect(order.indexOf('<GettingStarted')).toBeLessThan(order.indexOf('<Teasers'));
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

  // Explicit dimensions still, but the priority INVERTED: above the fold since ADR 428, so lazy
  // would deprioritise the first picture on the page.
  it('cannot shift layout, and is eager now that it is above the fold', () => {
    expect(stream).toMatch(/width=\{1200\}/);
    expect(stream).toMatch(/height=\{630\}/);
    expect(stream).toContain('fetchPriority="high"');
    expect(rendered).not.toContain('loading="lazy"');
  });

  // The two closing sentences answer "whose office is this?" — without them a picture of OUR
  // office reads as a virtual office for the reader's agents (ADR 320 §1). They moved out of
  // OfficeProof with the picture, because they were always about the picture.
  it('keeps the sentences that say whose office this is', () => {
    expect(stream).toContain('This is our team');
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

// ADR 320 decision 5 (2026-09-16): the landing leads with names, never with containment, and the
// category noun is never bare (decision 4).
describe('landing copy under ADR 320 §5', () => {
  // Whitespace-collapsed: JSX wraps a sentence across lines, and these pins are about the words.
  const flat = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const hero = flat('../components/site/LightHero.tsx');
  const whatIs = flat('../components/site/WhatIs.tsx');
  // Scoped 2026-09-17 after big-body's cross-family security read (act 01M2PH26PH): the unscoped
  // claim reads as a promise about everything an agent does, including the shell and filesystem
  // musterd never sees. What is true is the roster: acts the daemon accepted.
  it('the hero scopes the naming claim to the roster, and puts a human on it', () => {
    // 2026-10-09 (homepage-copy-spec §0.3): the subhead carries the ADR 550 chain and names the
    // people as members. The naming claim still lives only in card 4's heading, scoped, and the
    // overclaim stays banned here.
    expect(hero).not.toMatch(/Every act has a name on it/);
    expect(hero).toContain('the people you work with join one team as named members');
    expect(hero).toContain('Every piece of work shows who claimed it, which model did it and who accepted it.');
    expect(hero).toContain('Any member can say no.');
  });
  it('the hero has no contrast frame, and says what a click leads to', () => {
    const code = hero.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/not watching from outside/);
    expect(code).not.toMatch(/Watch it live/); // a state claim in prerendered HTML
    expect(code).toContain('Watch the team work');
    expect(code).toContain('Private preview. We write to you when there is a seat for your team.');
  });
  it('the what-is heading no longer leads with "coordination layer" (ADR 550 decision 1)', () => {
    const code = whatIs.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toContain('Members who answer for their work');
    expect(code).not.toMatch(/coordination layer/i);
    expect(code).not.toMatch(/A coordination layer for agents you already run/);
  });
  it('the naming card says what is observed and disclaims sandboxing', () => {
    expect(whatIs).toContain('does not sandbox');
    // The disclaimer must name who DOES contain, in the same breath — a bare "we do not sandbox"
    // reads as an evasion to a security-minded reader (01M2PH26PH finding 1).
    expect(whatIs).toContain('your own host, sandbox and provider controls still do that');
  });
  // 2026-09-18, lane 01M2NS50HC (homepage-copy-spec §2/§4.4). #1537 scoped this card's FIRST
  // SENTENCE and left the heading and the tail standing, so the page scoped the claim in the
  // middle of a card that overclaimed at both ends. wanderer (01M2RDQYCG) and ghost (01M2RNPSF2)
  // each named this sentence family unprompted, without having read this page.
  it('the naming claim carries its scope in the HEADING, not only the body', () => {
    // Moved, not deleted: #1537's assertion was on the body clause 'Every act on the roster names
    // its member'. That clause is now the heading, in ADR 320 §5a's canonical wording.
    expect(whatIs).toContain('Every act on the roster has a name on it');
    expect(whatIs).not.toMatch(/Who did what is never a question/);
  });
  it('the card claims no containment and names the boundary instead', () => {
    expect(whatIs).not.toMatch(/nothing on the roster is anonymous/);
    expect(whatIs).not.toMatch(/no anonymous workers/);
    expect(whatIs).toContain('It names the work that goes through the team');
  });
  // Attestation is model identity at connect time (ADR 158/163), not a proof about tool calls.
  // Unscoped, "the record holds what the harness observed" reads as a tool-call transcript —
  // the weakest sentence on the page per both security reads.
  it('scopes what the harness observed to seat occupancy', () => {
    // 2026-10-09 (homepage-copy-spec §0.7): the contrast frame ("not what the agent says about
    // itself") and the "ships" claim are gone; the scope — the model at connect time — is kept.
    expect(whatIs).toContain('The model in each seat is the one its tool reported when it connected');
    expect(whatIs).not.toMatch(/the record holds what the harness observed/);
  });
  it('no surface here uses the critic\'s noun', () => {
    expect(hero + whatIs).not.toMatch(/swarm/i);
  });
});

// 2026-10-09, homepage-copy-spec §0 (ADR 550 and the first-time visitor). Comments are stripped so a
// guard against a string RENDERING does not fire on the prose explaining why it must not.
describe('landing copy under ADR 550 and the 2026-10-09 revision', () => {
  const read = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      // JSX wraps a sentence across lines; a pin is about the words, not where prettier broke them.
      .replace(/\s+/g, ' ');
  const hero = read('../components/site/LightHero.tsx');
  const whatIs = read('../components/site/WhatIs.tsx');
  const how = read('../components/HowItWorks.tsx');
  const why = read('../components/site/WhyTalk.tsx');
  const card = read('../components/site/ClaimToAccepted.tsx');
  const start = read('../components/site/GettingStarted.tsx');

  // §0.2: acceptance arrives after the merge, so it is "counts as done", never "ships on its
  // author's word". "Shipped" about CODE (WhyTalk's own-history sentence) is correct and not tested.
  it('says "counts as done", not "ships", wherever acceptance is described', () => {
    for (const code of [hero, whatIs, how, card]) {
      expect(code).not.toMatch(/Nothing ships/);
      expect(code).not.toMatch(/ships on its author/);
    }
    expect(whatIs).toContain('Nothing counts as done until a different member has looked at what landed.');
  });

  it('keeps the contrast frame out of the cards and the steps', () => {
    expect(whatIs).not.toMatch(/Most agent tools give you agents you assign work to/);
    expect(whatIs).not.toMatch(/not what the agent says about itself/);
  });

  it('keeps the scoped boundary sentence and the sandbox disclaimer, verbatim', () => {
    expect(whatIs).toContain(
      'musterd does not sandbox your agents; your own host, sandbox and provider controls still do that. It names the work that goes through the team.',
    );
  });

  it('How a team works: the second member judges what landed, and the preview note moved to the hero', () => {
    expect(how).toContain('The work lands, and is judged by a second member');
    expect(how).toContain('A second member looks at what landed, in the product');
    expect(how).toContain('An agent cannot set it for itself.');
    expect(how).not.toMatch(/musterd is in private preview/);
    expect(how).not.toMatch(/what actually shipped/);
  });

  it('Why agents talk: answers the audience, dates the proof, scopes the history to us', () => {
    expect(why).toContain('A shared file can hold a result. Talk carries what is not a result yet');
    expect(why).toContain('wasted 65 to 83 percent of their work');
    expect(why).toContain('One project, a pilot, measured in July 2026.');
    expect(why).toContain('On our own team, more than a third of the code agents wrote without coordination never shipped.');
    // The pair must not be borrowed as a transferable rate (ADR 294).
    expect(why).not.toMatch(/\bevery team\b|\byour team will\b/i);
  });

  // §0.4: a real lane, dated, with the model from the presence record, and no "who asked".
  it('the claim-to-accepted card is a dated snapshot of a real lane, and leaves "who asked" out', () => {
    expect(card).toContain('One piece of work, from claim to accepted');
    expect(card).toContain('Pull request 2240, merged 2026-10-08');
    expect(card).toContain('sloane, a different member, 2026-10-09');
    expect(card).toContain('A snapshot of the board, taken 2026-10-09.');
    expect(card).not.toMatch(/who asked|asked for it|requested by/i);
  });

  // §0.9 and watch-page-copy-spec §2: honest about what does not exist, and no state word that is
  // true in only one state.
  // The /start row links the first-ten-minutes page (dreamy's lane 01M4GQ2NR438YWWYRH7RTTYP9X).
  // It was held back while that route did not exist (nick, 2026-10-09: deploy without /start);
  // a "Today" row must never link to a page that 404s, so this pins the link it carries.
  it('Getting started links the first-ten-minutes page, and nowhere that does not exist', () => {
    expect(start).toContain('FIRST_TEN_MINUTES_PATH');
    expect(start).toContain('See your first ten minutes');
    expect(start).toContain('What the first session looks like, step by step');
  });

  it('Getting started says what exists today and what does not, without a state word or a date', () => {
    expect(start).toContain('musterd is in private preview, so there is no public install yet.');
    expect(start).toContain("status: 'Not yet'");
    expect(start).toContain('Install and connect your agents.');
    for (const code of [card, start]) {
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
