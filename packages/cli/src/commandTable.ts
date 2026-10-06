import type { Parsed } from './args.js';

/** A command's entry point: every command takes the parsed argv and returns its exit code. */
export type CommandFn = (parsed: Parsed) => Promise<number> | number;

/**
 * Every command word → a lazy loader (ADR 491). `bin.ts` used to import all 53 command modules
 * before it dispatched one; loading on demand keeps `musterd --version`, help and the launcher off
 * that graph. Adding a command is one line here plus its catalog entry (`help/catalog.ts`);
 * `commandTable.test.ts` keeps the two in step.
 */
export const COMMANDS: Readonly<Record<string, () => Promise<CommandFn>>> = {
  agent: async () => (await import('./commands/agent.js')).agentCommand,
  archaeology: async () => (await import('./commands/archaeology.js')).archaeologyCommand,
  audit: async () => (await import('./commands/audit.js')).auditCommand,
  availability: async () => (await import('./commands/availability.js')).availabilityCommand,
  board: async () => (await import('./commands/board.js')).boardCommand,
  broadcast: async () => (await import('./commands/broadcast.js')).broadcastCommand,
  calendar: async () => (await import('./commands/calendar.js')).calendarCommand,
  claim: async () => (await import('./commands/claim.js')).claimCommand,
  'codex-hook': async () => (await import('./commands/codexHook.js')).codexHookCommand,
  done: async () => (await import('./commands/done.js')).doneCommand,
  doorbell: async () => (await import('./commands/doorbell.js')).doorbellCommand,
  dream: async () => (await import('./commands/dream.js')).dreamCommand,
  fmt: async () => (await import('./commands/fmt.js')).fmtCommand,
  gate: async () => (await import('./commands/gate.js')).gateCommand,
  goal: async () => (await import('./commands/goal.js')).goalCommand,
  halt: async () => (await import('./commands/halt.js')).haltCommand,
  harness: async () => (await import('./commands/harness.js')).harnessCommand,
  hold: async () => (await import('./commands/hold.js')).holdCommand,
  host: async () => (await import('./commands/host.js')).hostCommand,
  huddle: async () => (await import('./commands/huddle.js')).huddleCommand,
  human: async () => (await import('./commands/human.js')).humanCommand,
  inbox: async () => (await import('./commands/inbox.js')).inboxCommand,
  init: async () => (await import('./commands/init.js')).initCommand,
  insight: async () => (await import('./commands/insight.js')).insightCommand,
  integration: async () => (await import('./commands/integration.js')).integrationCommand,
  lane: async () => (await import('./commands/lane.js')).laneCommand,
  lanes: async () => (await import('./commands/lane.js')).lanesCommand,
  live: async () => (await import('./commands/live.js')).liveCommand,
  memory: async () => (await import('./commands/memory.js')).memoryCommand,
  next: async () => (await import('./commands/next.js')).nextCommand,
  node: async () => (await import('./commands/node.js')).nodeCommand,
  notify: async () => (await import('./commands/notify.js')).notifyCommand,
  policy: async () => (await import('./commands/policy.js')).policyCommand,
  nudge: async () => (await import('./commands/nudge.js')).nudgeCommand,
  reap: async () => (await import('./commands/reap.js')).reapCommand,
  reclaim: async () => (await import('./commands/reclaim.js')).reclaimCommand,
  reload: async () => (await import('./commands/reload.js')).reloadCommand,
  report: async () => (await import('./commands/report.js')).reportCommand,
  requests: async () => (await import('./commands/requests.js')).requestsCommand,
  reset: async () => (await import('./commands/reset.js')).resetCommand,
  resume: async () => (await import('./commands/halt.js')).resumeCommand,
  residency: async () => (await import('./commands/residency.js')).residencyCommand,
  role: async () => (await import('./commands/role.js')).roleCommand,
  seats: async () => (await import('./commands/seats.js')).seatsCommand,
  seed: async () => (await import('./commands/seed.js')).seedCommand,
  send: async () => (await import('./commands/send.js')).sendCommand,
  serve: async () => (await import('./commands/serve.js')).serveCommand,
  service: async () => (await import('./commands/service.js')).serviceCommand,
  session: async () => (await import('./commands/session.js')).sessionCommand,
  status: async () => (await import('./commands/status.js')).statusCommand,
  store: async () => (await import('./commands/store.js')).storeCommand,
  stream: async () => (await import('./commands/stream.js')).streamCommand,
  style: async () => (await import('./commands/style.js')).styleCommand,
  surface: async () => (await import('./commands/surface.js')).surfaceCommand,
  team: async () => (await import('./commands/team.js')).teamCommand,
  toolkit: async () => (await import('./commands/toolkit.js')).toolkitCommand,
  trace: async () => (await import('./commands/trace.js')).traceCommand,
  unbind: async () => (await import('./commands/unbind.js')).unbindCommand,
  uninstall: async () => (await import('./commands/uninstall.js')).uninstallCommand,
  'wake-context': async () => (await import('./commands/wake-context.js')).wakeContextCommand,
  whoami: async () => (await import('./commands/whoami.js')).whoamiCommand,
  wire: async () => (await import('./commands/wire.js')).wireCommand,
};

/** A command word this CLI dispatches — own keys only, so `toString` is never a command. */
export function isCommand(word: string | undefined): word is string {
  return word !== undefined && Object.hasOwn(COMMANDS, word);
}
