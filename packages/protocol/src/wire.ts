/**
 * `@musterd/protocol/wire` — the protocol without a validator.
 *
 * One import for every consumer that reads the contract rather than enforcing it. The browser is
 * the reason it exists: `@musterd/protocol` builds its schemas at module scope, so importing a
 * single value from the barrel pulls zod and the whole `z.object(...)` graph into the bundle
 * (~20 KB gzipped on /live, measured 2026-09-04). Everything re-exported here is plain TypeScript —
 * the closed sets, the pure derivations built on them, and the read guards in `guards.ts`.
 *
 * The vocabularies are not copies. Each `*.wire.ts` module DEFINES its tuple and the zod module
 * beside it builds its enum from that tuple and re-exports the name, so `@musterd/protocol` and
 * `@musterd/protocol/wire` cannot disagree about what the wire allows. Adding a value here that
 * duplicates rather than re-homes a schema's list would reintroduce exactly the drift this avoids.
 */
export * from './acts.wire.js';
export * from './ask.wire.js';
export * from './capabilities.wire.js';
// The doorbell's ring rule (ADR 443): /live asks "does this act ring me?" without zod.
export * from './doorbell.wire.js';
export * from './envelope.wire.js';
export * from './goals.wire.js';
export * from './guards.js';
// ADR 516: the hold line /live's banner renders — no zod behind it.
export * from './holds.wire.js';
// ADR 519: the calendar's kinds, statuses and ordering — no zod behind them.
export * from './calendar.wire.js';
// The huddle fold (ADR 378): a pure read of the timeline, no schema — and the browser's only way to
// read a room without pulling zod in behind it.
export * from './huddleView.js';
export * from './lanes.wire.js';
// ADR 629: the five-link lane read. Pure, so /live and the CLI share one derivation.
export * from './laneChain.js';
// ADR 624's picker list: pure, type-only imports, so the browser can render it (the /live lane picker).
export * from './picker.js';
export * from './model.js';
export * from './offline.wire.js';
export * from './posture.wire.js';
export * from './seeds.wire.js';
// ADR 514: the dial vocabularies and prose cap /board's style sheet picks from — no zod behind them.
export * from './style.wire.js';
export * from './version.js';
export * from './working-hours.wire.js';
