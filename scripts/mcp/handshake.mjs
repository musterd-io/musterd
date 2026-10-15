/**
 * One cold launch of the stdio adapter, timed: spawn → legacy `initialize` → `tools/list`. Shared by
 * the by-hand bench (`bench.mjs`) and the CI gate (`check-startup.mjs`, lane 01M4VNTQFW).
 *
 * Besides wall time it reads the adapter's OWN CPU time at the moment it answers `tools/list`: a
 * preload (`--import`, below) wraps the child's `process.stdout.write` and, on the write that
 * carries the `tools/list` result, writes `process.cpuUsage()` to stderr. CPU time is what the gate
 * budgets, because wall time swings 2–4x on a shared runner (ADR 574) and CPU time does not. It
 * counts Node's own bootstrap too, which a harness pays on every launch.
 *
 * Speaks the wire current harnesses speak (`initialize`), never a tool call, so it never claims a
 * seat. A credential-shaped token in stderr is redacted.
 */
import { spawn } from 'node:child_process';

const CPU_TAG = 'MUSTERD_BENCH_CPU ';

// Runs inside the adapter process. `writeSync(2, …)` so the line is out before the bench kills it.
const PRELOAD = `
import { writeSync } from 'node:fs';
const out = process.stdout;
const write = out.write.bind(out);
let done = false;
out.write = (chunk, ...rest) => {
  if (!done) {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (s.includes('"id":2') && s.includes('"tools"')) {
      done = true;
      const u = process.cpuUsage();
      writeSync(2, ${JSON.stringify(CPU_TAG)} + JSON.stringify({ user_us: u.user, system_us: u.system }) + '\\n');
    }
  }
  return write(chunk, ...rest);
};
`;
const PRELOAD_URL = `data:text/javascript,${encodeURIComponent(PRELOAD)}`;

export function scrub(text) {
  return text.replace(/ms(?:key|gr|cr|ac)_[A-Za-z0-9_-]+/g, '[redacted]');
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {string} entry the adapter's launched path (dist/index.js)
 * @param {{ env: NodeJS.ProcessEnv, cwd?: string, timeoutMs?: number }} opts
 */
export function handshake(entry, opts) {
  const { env } = opts;
  const started = performance.now();
  const child = spawn(process.execPath, ['--import', PRELOAD_URL, entry], {
    env,
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let cpu = null;
  let listed = null;
  let initMs = null;
  let listMs = null;
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'musterd-mcp-bench', version: '0' },
    },
  });

  return new Promise((resolveHs, rejectHs) => {
    let buf = '';
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      fn();
    };
    // Both halves land in either order: the tools/list reply on stdout, the CPU line on stderr.
    const maybeDone = () => {
      if (!listed || !cpu) return;
      finish(() =>
        resolveHs({
          surface: env.MUSTERD_LAUNCH_SURFACE,
          spawn_to_initialize_ms: round1(initMs),
          spawn_to_tools_list_ms: round1(listMs),
          cpu_ms: round1((cpu.user_us + cpu.system_us) / 1000),
          cpu_user_ms: round1(cpu.user_us / 1000),
          cpu_system_ms: round1(cpu.system_us / 1000),
          tools: listed.tools.length,
          tools_list_bytes: Buffer.byteLength(JSON.stringify(listed.tools)),
          tools_list_has_ttl: typeof listed.ttlMs === 'number',
        }),
      );
    };
    const timer = setTimeout(() => {
      finish(() => rejectHs(new Error(`timed out: ${scrub(stderr).slice(-400)}`)));
    }, opts.timeoutMs ?? 20_000);
    child.on('error', (err) => finish(() => rejectHs(err)));
    // An adapter that fails to start exits at once; say why instead of waiting out the timer.
    child.on('exit', (code, signal) =>
      finish(() =>
        rejectHs(
          new Error(`adapter exited (${signal ?? code}) first: ${scrub(stderr).slice(-400)}`),
        ),
      ),
    );
    child.stderr.on('data', (d) => {
      stderr += d;
      if (cpu) return;
      const at = stderr.indexOf(CPU_TAG);
      const nl = at >= 0 ? stderr.indexOf('\n', at) : -1;
      if (nl < 0) return;
      cpu = JSON.parse(stderr.slice(at + CPU_TAG.length, nl));
      maybeDone();
    });
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          initMs = performance.now() - started;
          if (msg.error) {
            finish(() =>
              rejectHs(new Error(scrub(String(msg.error.message ?? 'initialize failed')))),
            );
            return;
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (!msg.result || !Array.isArray(msg.result.tools)) {
            finish(() => rejectHs(new Error(`no tools/list result: ${scrub(stderr).slice(-400)}`)));
            return;
          }
          listMs = performance.now() - started;
          listed = msg.result;
          maybeDone();
        }
      }
    });
  });
}
