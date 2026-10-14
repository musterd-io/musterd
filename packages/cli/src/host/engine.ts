/**
 * The loop-engine seam (ADR 251 §3): the native backend drives this interface and knows nothing
 * about which provider thinks inside it. The shipping implementation is `engines/pi.ts` (ADR 588:
 * pi-agent-core runs the turn, pi-ai speaks to the vendors); the phase-1 SDK runner it replaced was
 * the seam's first proof that the backend never has to change when the engine does. Provider- and
 * library-specific code (model ids, event shapes, error classification) lives only inside the
 * engine file, never here and never in the backend.
 */

/** Token usage for one turn, or summed for a run — provider-neutral field names. */
export interface EngineUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** One tool the loop may call. The backend bridges the seat's rendered MCP tools into these 1:1
 *  (ADR 251 §4) — the engine never knows it is talking to musterd; the bridge does. */
export interface EngineTool {
  name: string;
  description: string;
  /** JSON schema of the input (`type: "object"`), exactly as the MCP render published it. */
  input_schema: Record<string, unknown>;
  run(input: unknown): Promise<string>;
}

/** One completed turn, reported as it happens — the substrate for daemon-owned transcript capture
 *  and per-turn telemetry (ADR 251 §7). */
export interface EngineTurn {
  /** 1-based turn index. */
  index: number;
  usage: EngineUsage;
  /** This turn's usage priced by the engine; undefined when the model cannot be priced. */
  cost_usd?: number | undefined;
  stop_reason: string | null;
  /** Structured record of the turn (assistant content + tool results) for capture. */
  transcript: unknown;
}

/** How a run ended. `auth` is the deferral signal — missing/invalid credentials are a property of
 *  the machine, not of the work (the same posture as a missing CLI binary, ADR 221). */
export type EngineEndReason = 'completed' | 'max_turns' | 'aborted' | 'auth' | 'error';

/**
 * ADR 588 §6, the in-process doorbell: a source of daemon-composed lines for acts raised at the seat
 * while the loop runs. The engine subscribes for the run and queues each line as the next user turn,
 * delivered between tool calls; it unsubscribes when the run ends. The lines are the same ones the
 * tool-result path appends (`appendInterrupt`), so the seat hears an act whether or not it is calling
 * a musterd tool right now. The backend builds the source; the engine knows nothing about musterd.
 */
export interface SteerSource {
  subscribe(deliver: (line: string) => void): () => void;
}

export interface EngineRunSpec {
  /** Resolved via the ADR 101 env > binding ladder by the backend — the engine never defaults it. */
  model: string;
  /** The daemon-composed wake line, verbatim (ADR 131 §6). */
  prompt: string;
  tools: EngineTool[];
  /** `max_turns` from the wake bounds → the runner's iteration cap. */
  maxTurns?: number | undefined;
  /** The mandatory watchdog's abort signal (ADR 131 §6). */
  signal?: AbortSignal | undefined;
  /** Per-turn observer (capture + telemetry). Best-effort: a throwing observer never kills the loop. */
  onTurn?: ((turn: EngineTurn) => void) | undefined;
  /** ADR 588 §6: raised acts, delivered into the running loop between tool calls. */
  steer?: SteerSource | undefined;
}

/**
 * The seam is deliberately output-only, and the doorbell contract's clause 1 does NOT change that.
 *
 * A raised act reaches the native loop's model through the **tool result** (`appendInterrupt` in
 * `backends/nativeBridge.ts`), not through an inbound hook on this interface: the tool boundary is
 * the same place every hooked harness delivers at, and keeping the injection in the bridge keeps it
 * where it belongs — the engine still knows nothing about musterd, and every engine inherits the
 * doorbell for free. The in-process steer (ADR 588 §6, `steer` on the run spec) is an addition on
 * top of this, not a replacement: it reaches a loop that is not calling a musterd tool right now, and
 * the bridge suppresses the tool-result copy of a line it has already steered.
 */

export interface EngineRunResult {
  turns: number;
  end: EngineEndReason;
  /** Summed cost across turns, computed by the harness from per-turn usage (ADR 251 §6) —
   *  undefined when the model cannot be priced, never a guess. */
  cost_usd?: number | undefined;
  usage: EngineUsage;
  /** Bounded failure detail for `auth`/`error` ends. */
  reason?: string | undefined;
}

/** The seam: given a prompt, a tool set, and bounds, run a loop; report turns, usage, and how it
 *  ended. */
export interface AgentLoopEngine {
  /** Provider label for logs/attestation context (e.g. `anthropic`). */
  readonly provider: string;
  run(spec: EngineRunSpec): Promise<EngineRunResult>;
}
