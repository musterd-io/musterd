import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  IDLE_LINE_MAX,
  IDLE_LINE_PATTERN,
  IDLE_RING_ACK_FILE,
  IDLE_RING_ACK_TIMEOUT_MS,
  IDLE_RING_FILE,
  OPENCODE_PLUGIN_STAMP_FILE,
  OPENCODE_STAMP_EVERY_MS,
} from '@musterd/protocol';
import { isDeclined } from '../declined.js';

/**
 * The OpenCode doorbell (ADR 392): a **managed plugin file** at `.opencode/plugins/musterd.js`.
 *
 * OpenCode has no hook table (ADR 321 §8) but it does have a plugin event channel (ADR 362 corrected
 * the premise; that ADR declined to ship a *capture* plugin and its three findings stand). The
 * interrupt line is a different job from capture: it needs no `session.created`/resume event
 * (finding 1 is moot — the probe rides tool boundaries and idle, both of which fire on a resumed
 * session), and the executable-surface objection (finding 2) is met the way every other harness's
 * hook is: one marker-owned file, no dependencies (no `package.json`, so no `bun install`), a
 * generation stamp the doctor compares against what THIS build writes (ADR 168), and
 * `musterd init --refresh-hooks` as the only writer. Version coupling (finding 3) is bounded to two
 * `tool.execute.after` and `event` — and none of the `experimental.*` seams. That after-hook cannot
 * refuse a tool, so OpenCode's session-reach wall is identity-only (ADR 442).
 *
 * What it does, measured against ghost's eval (`docs/wiki/opencode-live-doorbell-eval.md`):
 * - `tool.execute.after` — at every tool boundary run `musterd inbox --interrupt-check`; a raised
 *   line is appended to the tool's `output`, which is the text the model reads next. Silent and
 *   free on the common path (the CLI prints nothing unless an interrupt-class act waits). The MCP-
 *   tool-path caveat (eval §2: mutation may not reach the model for MCP calls on 1.14.x) is the
 *   named falsifier; the idle rail below is the floor if it holds on 1.18.x.
 * - Idle-at-prompt wake (ADR 558 increment 3, generation 5). The MCP adapter decides when an idle
 *   session is pushed and writes the daemon's line to `.musterd/idle-ring.json`; this plugin watches
 *   that file, pushes the line with a reply-triggering `promptAsync` into the session it last saw,
 *   and acks in `.musterd/idle-ring-ack.json`. It refuses a session it saw go busy (concurrent
 *   `promptAsync` into a running turn orphans messages, #28202), a ring the adapter has given up on,
 *   and any line not shaped like the daemon's. Its stamp, `.musterd/opencode-plugin.json`, is how
 *   the adapter knows it is loaded. This replaces generations 1–4's own `session.idle` bell (a probe
 *   and a prompt at the turn-end transition, capped at 4 per session): the core holds an act that
 *   landed mid-turn until the turn ends, and its caps apply.
 * - The trace tap (ADR 445, generation 2). The tool-boundary probe gets the call's structural
 *   fields on stdin under `--hook opencode`, so it records `PostToolUse` in the process it already
 *   is — no second process per call. Each idle runs `musterd trace hook --kind Stop`, which records
 *   `Stop` and reads the turn's R2 records out of OpenCode's session store (`trace/opencode.ts`); each
 *   turn start runs it with `--kind UserPromptSubmit`. Both also write the ADR 558 turn markers.
 *   `MUSTERD_NO_NUDGE=1` skips the probe, and with it the `PostToolUse` tap.
 *
 * The plugin never composes text: the line is the daemon's (ADR 088), fenced so the model can tell
 * it from tool output, and the CLI keeps every gate it already has (`MUSTERD_NO_NUDGE`, explicit
 * bound seat, best-effort silence on any failure).
 *
 * Generation 4 adds the OpenCode V2 entry: V2 only loads a default export shaped `{ id, setup }`
 * and rejects the named-export shape at load (measured v2.0.20, lane 01M44W6J2). One file serves
 * both: `setup` registers the rail on V2 domain hooks, `server` on the default export serves
 * V1.18.29+, and the named export serves older V1 — see the render comment. (Generation 3 was the
 * same shape without the eslint-disable the repo's own lint needs for the default export.)
 */

export const OPENCODE_PLUGIN_MARKER = 'musterd-opencode-interrupt';
/** Bump when the rendered plugin changes: the doctor names a file stamped otherwise as STALE. */
export const OPENCODE_PLUGIN_GENERATION = 5;
export const OPENCODE_PLUGIN_SURFACE = 'opencode:plugin';
/** The V2 plugin id in the default export (stable; shown in plugin list/diagnostics). */
export const OPENCODE_PLUGIN_ID = 'musterd-interrupt';

export function opencodePluginPath(dir: string = process.cwd()): string {
  return join(dir, '.opencode', 'plugins', 'musterd.js');
}

export function opencodePluginHeader(generation: number = OPENCODE_PLUGIN_GENERATION): string {
  return `// ${OPENCODE_PLUGIN_MARKER} v${String(generation)} — managed by \`musterd init\` (ADR 392). Do not edit; \`musterd init --refresh-hooks\` rewrites it.`;
}

/**
 * The plugin source. Plain ESM JavaScript on node built-ins only, so it runs under OpenCode's
 * bundled Bun without an install step AND under node for the unit that executes it.
 *
 * Dual entry (generation 3): OpenCode V2 only loads a default export shaped `{ id, setup }`
 * and rejects the 1.18.x named-export shape at load ("Missing key at [\"default\"]", measured
 * on v2.0.20 — the whole rail silently dead). V2's own migration guide blesses one default
 * export carrying both `setup` (V2 calls it) and `server` (V1.18.29+ calls it), so this file
 * exports exactly that, plus the original named `MusterdInterrupt` for V1 older than 1.18.29
 * (object entrypoints need 1.18.29+). A module-level claim flag keeps pre-1.18.29 V1 — which
 * calls every exported function — from registering the rail twice. Deliberately no
 * `Plugin.define` import: it is a typed identity helper, and importing the plugin SDK would
 * cost the zero-dependency property (no `bun install`) this file's tests pin.
 */
export function renderOpencodePlugin(): string {
  return `${opencodePluginHeader()}
/* eslint-disable import/no-default-export -- OpenCode V2 requires a default export (ADR 521); this file is generated, never edited. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ID = ${JSON.stringify(OPENCODE_PLUGIN_ID)};
const GENERATION = ${String(OPENCODE_PLUGIN_GENERATION)};
const PROBE_ARGS = ["inbox", "--interrupt-check"];
const PROBE_TIMEOUT_MS = 5000;
const TRACE_TIMEOUT_MS = 15000;
const OPEN = "<musterd-interrupt>";
const CLOSE = "</musterd-interrupt>";
// ADR 558 increment 3: the idle ring. Values are @musterd/protocol's, rendered in.
const RING_FILE = ${JSON.stringify(IDLE_RING_FILE)};
const ACK_FILE = ${JSON.stringify(IDLE_RING_ACK_FILE)};
const STAMP_FILE = ${JSON.stringify(OPENCODE_PLUGIN_STAMP_FILE)};
const RING_MAX_AGE_MS = ${String(IDLE_RING_ACK_TIMEOUT_MS)};
const STAMP_EVERY_MS = ${String(OPENCODE_STAMP_EVERY_MS)};
const RING_POLL_MS = 1000;
const LINE_MAX = ${String(IDLE_LINE_MAX)};
const LINE_RE = new RegExp(${JSON.stringify(IDLE_LINE_PATTERN)});

// One daemon-composed line, or "" — never a throw, never a rejection (a probe on every tool call
// must never disrupt the loop, ADR 088). cwd is the seat folder so the bound seat resolves.
// With a payload, the probe also records the tool call on the trace tap (ADR 445 R1): the JSON
// goes in on stdin and \`--hook opencode\` tells the probe to read it. Structural fields only.
function probe(directory, payload) {
  return new Promise((resolve) => {
    if (process.env.MUSTERD_NO_NUDGE === "1") return resolve("");
    let settled = false;
    const finish = (line) => {
      if (settled) return;
      settled = true;
      resolve(line);
    };
    try {
      const child = execFile(
        "musterd",
        payload ? [...PROBE_ARGS, "--hook", "opencode"] : PROBE_ARGS,
        { cwd: directory, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: process.env },
        (err, stdout) => finish(err ? "" : String(stdout ?? "").trim()),
      );
      if (payload && child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(payload));
      }
    } catch {
      finish("");
    }
  });
}

// A turn boundary on the trace tap (ADR 445 R1 + R2) and the idle-wake turn markers (ADR 558):
// "Stop" when the session goes idle, "UserPromptSubmit" when it goes busy. Fire-and-forget.
function traceTurn(directory, sessionID, kind) {
  try {
    const child = execFile(
      "musterd",
      ["trace", "hook", "--stdin", "--harness", "opencode", "--kind", kind],
      { cwd: directory, timeout: TRACE_TIMEOUT_MS, env: process.env },
      () => {},
    );
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ session_id: sessionID, hook_event_name: kind }));
    }
  } catch {
    // fail-open, like every tap
  }
}

function fenced(line) {
  return OPEN + "\\n" + line + "\\n" + CLOSE;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Whole-file replace, owner-only: the adapter never reads a half-written file.
function writeJson(path, value) {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    // Fresh name, O_EXCL: a planted file or symlink at the tmp path fails the write, never
    // redirects it; rename() replaces a link at \`path\`, never its target.
    const tmp = path + "." + randomBytes(6).toString("hex") + ".tmp";
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch {
    // best-effort: no stamp reads as no plugin, which is deaf, which is honest
  }
}

function eventSession(event) {
  const p = event.properties || {};
  return p.sessionID || (p.info && p.info.id) || event.sessionID || event.session_id;
}

function eventStatus(event) {
  if (event.type === "session.idle") return "idle";
  if (event.type !== "session.status") return undefined;
  const st = (event.properties && event.properties.status) || event.status;
  const t = typeof st === "string" ? st : st && st.type;
  if (t === "idle") return "idle";
  if (t === "busy" || t === "retry") return "busy";
  return undefined;
}

// The idle ring (ADR 558 increment 3). The adapter decides when; this only pushes, and only the
// daemon's line, into a session it has not seen go busy, for a ring the adapter still waits on.
function startRing(directory, push) {
  const base = join(directory, ".musterd");
  const ringPath = join(base, RING_FILE);
  const status = new Map();
  let current;
  let lastSeq;
  let lastMtime = 0;
  const seen = readJson(ringPath);
  if (seen && seen.seq) lastSeq = seen.seq; // never replay a ring from before this load
  const stamp = () =>
    writeJson(join(base, STAMP_FILE), {
      generation: GENERATION,
      pid: process.pid,
      ...(current ? { session_id: current } : {}),
      status: current && status.get(current) === "busy" ? "busy" : "idle",
      at: Date.now(),
    });
  const ack = (seq, ok, reason) =>
    writeJson(join(base, ACK_FILE), { seq, ok, ...(reason ? { reason } : {}), at: Date.now() });
  const sessionFor = () => {
    if (current) return current;
    const markers = readJson(join(base, "idle-wake.json"));
    return markers && typeof markers.session_id === "string" ? markers.session_id : undefined;
  };
  let ringing = false;
  const look = async () => {
    if (ringing) return;
    let mtime;
    try {
      mtime = statSync(ringPath).mtimeMs;
    } catch {
      return;
    }
    if (mtime === lastMtime) return;
    lastMtime = mtime;
    const ring = readJson(ringPath);
    if (!ring || typeof ring.seq !== "string" || ring.seq === lastSeq) return;
    lastSeq = ring.seq;
    if (typeof ring.at !== "number" || Date.now() - ring.at > RING_MAX_AGE_MS) return;
    const line = typeof ring.line === "string" ? ring.line : "";
    if (line.length > LINE_MAX || !LINE_RE.test(line)) return ack(ring.seq, false, "line-shape");
    const id = sessionFor();
    if (!id) return ack(ring.seq, false, "no-session");
    if (status.get(id) === "busy") return ack(ring.seq, false, "busy");
    ringing = true;
    try {
      await push(id, line);
      ack(ring.seq, true);
    } catch {
      ack(ring.seq, false, "prompt-failed");
    } finally {
      ringing = false;
    }
  };
  stamp();
  const timers = [
    setInterval(() => void look(), RING_POLL_MS),
    setInterval(stamp, STAMP_EVERY_MS),
  ];
  for (const t of timers) if (t && t.unref) t.unref();
  return {
    // Every event: track the session and its busy/idle state; trace the turn boundaries.
    onEvent(event) {
      if (!event) return;
      const id = eventSession(event);
      const next = eventStatus(event);
      if (!id || !next) return;
      const prev = status.get(id);
      current = id;
      status.set(id, next);
      // On the transition, whichever event carries it (1.18 sends session.idle and
      // session.status for the same turn end): one Stop per turn, one start per turn.
      if (next === "idle" && prev !== "idle") traceTurn(directory, id, "Stop");
      else if (next === "busy" && prev !== "busy") traceTurn(directory, id, "UserPromptSubmit");
      if (prev !== next) stamp();
    },
    stop() {
      for (const t of timers) clearInterval(t);
    },
  };
}

// Pre-1.18.29 V1 calls every exported function, so the named export and the default export's
// server() would each register the rail. First initializer wins; the other returns no hooks.
let v1Claimed = false;

function v1Hooks(client, directory) {
  const ring = startRing(directory, (id, line) =>
    client.session.promptAsync({
      path: { id },
      body: { parts: [{ type: "text", text: line, synthetic: true }] },
    }),
  );
  return {
    "tool.execute.after": async (input, output) => {
      const line = await probe(
        directory,
        input && input.sessionID
          ? {
              session_id: input.sessionID,
              hook_event_name: "PostToolUse",
              tool_name: input.tool,
              tool_use_id: input.callID,
            }
          : undefined,
      );
      if (!line) return;
      const fencedLine = fenced(line);
      output.output = output.output ? output.output + "\\n\\n" + fencedLine : fencedLine;
    },
    event: async ({ event }) => ring.onEvent(event),
  };
}

function claimV1(client, directory) {
  if (v1Claimed) return {};
  v1Claimed = true;
  return v1Hooks(client, directory);
}

export const MusterdInterrupt = async ({ client, directory }) => claimV1(client, directory);

// eslint-disable-next-line import/no-default-export -- opencode's V2 plugin loader requires a default export
export default {
  id: PLUGIN_ID,
  // V2 calls setup(ctx): register the same rail on the V2 domain hooks. V2 merges the old
  // (input, output) pair into one mutable event: ids live top-level (call id is \`id\`), and
  // the model-visible text is result.output (string) or result.content (string). Exotic
  // result shapes get the probe (trace tap) but no fence — the falsifier on v2.0.20 watches
  // whether the fence lands at native boundaries the way §8 measured on 1.18.29.
  setup: async (ctx) => {
    const directory = ctx.location.directory;
    const ring = startRing(directory, (id, line) => ctx.session.prompt({ sessionID: id, text: line }));
    await ctx.tool.hook("execute.after", async (event) => {
      const line = await probe(
        directory,
        event && event.sessionID
          ? {
              session_id: event.sessionID,
              hook_event_name: "PostToolUse",
              tool_name: event.tool,
              tool_use_id: event.id,
            }
          : undefined,
      );
      if (!line || !event || event.status !== "completed" || !event.result) return;
      const fencedLine = fenced(line);
      const res = event.result;
      if (typeof res.output === "string") {
        res.output = res.output ? res.output + "\\n\\n" + fencedLine : fencedLine;
      } else if (typeof res.content === "string") {
        res.content = res.content ? res.content + "\\n\\n" + fencedLine : fencedLine;
      }
    });
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) ring.onEvent(event);
    })();
    return () => {
      controller.abort();
      ring.stop();
    };
  },
  // V1.18.29+ calls server(input) on the default export; older V1 calls the named export.
  // Same rail, same claim flag — exactly one registers (see claimV1).
  server: async (input) => claimV1(input.client, input.directory),
};
`;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Generation stamped in the header of an installed plugin, `undefined` for a foreign/absent file. */
export function installedPluginGeneration(raw: string): number | undefined {
  const m = raw.match(new RegExp(`^// ${OPENCODE_PLUGIN_MARKER} v(\\d+)`));
  return m ? Number(m[1]) : undefined;
}

/**
 * Write (or rewrite) the plugin. Returns warnings, never throws for the refresh driver's sake:
 * - a file at the path that is NOT ours is left alone and named (ADR 027: never clobber a user's
 *   plugin);
 * - a file stamped by a NEWER build is left alone and named (ADR 168 downgrade guard).
 */
export function installMusterdOpencodePlugin(dir: string = process.cwd()): string[] {
  if (isDeclined(dir, OPENCODE_PLUGIN_SURFACE)) return [];
  const path = opencodePluginPath(dir);
  const existing = readText(path);
  if (existing !== null) {
    const theirs = installedPluginGeneration(existing);
    if (theirs === undefined) {
      return [
        `${path} exists and is not musterd's — left untouched (ADR 027). Move it aside and run \`musterd init --refresh-hooks\` to install the doorbell plugin.`,
      ];
    }
    if (theirs > OPENCODE_PLUGIN_GENERATION) {
      return [
        `${path} was written by a newer musterd build (plugin v${String(theirs)}, this build v${String(OPENCODE_PLUGIN_GENERATION)}) — not downgrading it (ADR 168). Update this checkout instead.`,
      ];
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderOpencodePlugin(), 'utf8');
  return [];
}

/** Remove exactly our file; a foreign plugin at the path stays. */
export function removeMusterdOpencodePlugin(dir: string = process.cwd()): void {
  const path = opencodePluginPath(dir);
  const existing = readText(path);
  if (existing === null) return;
  if (installedPluginGeneration(existing) === undefined) return;
  rmSync(path, { force: true });
}

/**
 * Doctor evidence (ADR 168 for OpenCode): a missing plugin means no probe runs at all — the exact
 * state this lane was opened on ("nothing probes"). A present-but-stale one is named as stale, since
 * a plugin's value is entirely in its text.
 */
export function inspectOpencodePluginDrift(dir: string = process.cwd()): string[] {
  if (isDeclined(dir, OPENCODE_PLUGIN_SURFACE)) return [];
  const path = opencodePluginPath(dir);
  const existing = readText(path);
  if (existing === null) {
    return [
      'the OpenCode doorbell plugin is missing from .opencode/plugins/musterd.js — nothing probes the interrupt line at any tool boundary, so a busy or idle agent will not see urgent steering (ADR 088/392). Run `musterd init --refresh-hooks` here to install it.',
    ];
  }
  const theirs = installedPluginGeneration(existing);
  if (theirs === undefined) {
    return [
      ".opencode/plugins/musterd.js exists but is not musterd's plugin — the doorbell is not installed under that name (ADR 027). Move the file aside and run `musterd init --refresh-hooks`.",
    ];
  }
  if (existing !== renderOpencodePlugin()) {
    return [
      `the OpenCode doorbell plugin in .opencode/plugins/musterd.js was written by a different musterd build (v${String(theirs)}, this build v${String(OPENCODE_PLUGIN_GENERATION)}) and no longer matches this one — it is present but STALE, which no presence check can see (ADR 168). Run \`musterd init --refresh-hooks\` here to rewrite it.`,
    ];
  }
  return [];
}

export function opencodePluginPresent(dir: string = process.cwd()): boolean {
  return existsSync(opencodePluginPath(dir));
}
