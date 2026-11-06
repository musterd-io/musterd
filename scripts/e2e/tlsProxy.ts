/**
 * HTTPS in front of plain-HTTP test servers, for the hosted sign-in e2e (lane 01M6S7DKXH).
 *
 * The flow under test only exists on https: `__Host-` cookies need Secure, the team origin is
 * `https://<slug>.<suffix>` (liveSession.ts `teamOriginOf`), and the console builds the callback as
 * `https://…`. Chrome reaches this proxy through `--host-resolver-rules` and accepts the throwaway
 * certificate through `--ignore-certificate-errors`; nothing here touches the machine's trust store.
 *
 * One listener, routed by Host. Requests and WebSocket upgrades are both forwarded, with
 * `x-forwarded-proto: https` so the team server sees the request as TLS-terminated, as on Cloud.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A self-signed certificate for exactly these names, made with the system's openssl. */
export function throwawayCert(names: string[]): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-e2e-cert-'));
  try {
    const san = names.map((n) => `DNS:${n}`).join(',');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        `/CN=${names[0]}`,
        '-addext',
        `subjectAltName=${san}`,
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hostOf = (req: IncomingMessage): string =>
  (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();

/**
 * Listen on `port` (0 = any) and forward each Host in `routes` to `127.0.0.1:<its port>`. An
 * unknown Host is a 421, never a guess.
 */
export async function startTlsProxy(opts: {
  port: number;
  routes: Record<string, number>;
  tls: { key: string; cert: string };
}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createHttpsServer(opts.tls, (req, res) => {
    const target = opts.routes[hostOf(req)];
    if (!target) {
      res.writeHead(421).end();
      return;
    }
    const up = request(
      {
        host: '127.0.0.1',
        port: target,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, 'x-forwarded-proto': 'https' },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', () => res.headersSent || res.writeHead(502).end());
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const target = opts.routes[hostOf(req)];
    if (!target) return socket.destroy();
    const up = connect(target, '127.0.0.1', () => {
      const headers = { ...req.headers, 'x-forwarded-proto': 'https' };
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers))
        for (const one of Array.isArray(v) ? v : [v])
          if (one !== undefined) lines.push(`${k}: ${one}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const kill = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', kill);
    socket.on('error', kill);
  });
  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return {
    server,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
