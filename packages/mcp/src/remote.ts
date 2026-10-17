import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  type Capabilities,
  type ClaimEvidence,
  type ClaimRefs,
  claimsFromEvidence,
  DEFAULT_PROJECT,
  FEATURE_EPOCH,
  type LaneClaim,
} from '@musterd/protocol';
import { resolveProject } from '@musterd/protocol/project';
import type { McpConfig } from './config.js';
import type { Landed } from './landed.js';
import type { VerifyOutcome } from './mergeVerify.js';

/**
 * The remote-bearer mode of the adapter (ADR 630 §3): what one remote MCP request carries in — the
 * daemon to call (its own loopback URL), and the seat the phone's `msat_` bearer authenticated.
 * `capabilities` are the seat's effective ones, read by the caller, and scope `tools/list` (§6).
 */
export interface RemoteSeat {
  server: string;
  team: string;
  member: string;
  bearer: string;
  capabilities?: Capabilities | undefined;
  /**
   * The phone's edge headers the daemon handed over (`host`, `x-forwarded-proto`,
   * `cf-connecting-ip`), presented on every loopback call so the daemon's routes see the request
   * the phone made: the Cloud host gate passes, a connect link names the public host, and the
   * per-client budget charges the phone (ADR 630, 2026-10-17 note).
   */
  headers?: Record<string, string> | undefined;
}

/**
 * A `fetch` for the remote client's loopback calls that keeps the edge headers — `Host` included,
 * which the global `fetch` silently replaces with the URL's authority. Over native TLS the
 * certificate is checked against the edge host, the name it was issued for. Only what
 * `MusterdClient.request` uses is supported: a string URL, method, headers, a string body, a
 * signal. A failure to connect rejects the way `fetch` does (`cause.code`), so the client's retry
 * on a refused connection still applies.
 */
export function edgeFetch(edge: Record<string, string> = {}): typeof fetch {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      Object.assign(headers, edge);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
      const tls = url.protocol === 'https:';
      const servername = edge['host']?.replace(/:\d+$/, '');
      const req = (tls ? httpsRequest : httpRequest)(
        url,
        {
          method: init?.method ?? 'GET',
          headers,
          ...(tls && servername ? { servername } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const out = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : v);
            }
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers: out }),
            );
          });
        },
      );
      req.on('error', (err) =>
        reject(Object.assign(new TypeError('fetch failed'), { cause: err })),
      );
      if (body !== undefined) req.write(body);
      req.end();
    });
}

/**
 * The config a remote request runs on. Built from the request alone, never from a file or the
 * environment: the daemon process's folder and env belong to nobody's seat.
 *
 * The bearer rides as `seatCredential` because that is the field `request()` presents as
 * `Authorization` — `authMember` dispatches on the token's prefix, and an `msat_` is
 * self-identifying, so the seat header the client adds can only agree with it. No agent key, grant
 * or session lease: the phone's seat holds no Presence for a lease to bind to (ADR 446 §2), and
 * nothing here claims. The surface is `other`, which is what the daemon already stamps for a remote
 * call (`mcpHttp.ts`); the enum has no remote surface.
 */
export function remoteConfig(seat: RemoteSeat): McpConfig {
  return {
    server: seat.server,
    team: seat.team,
    member: seat.member,
    seatCredential: seat.bearer,
    surface: 'other',
    markerGeneration: 'remote',
    provenance: 'session',
    workspace: 'remote',
    workspaceKey: 'remote',
    autojoin: false,
    modelSource: 'unknown',
    ...(seat.capabilities ? { capabilities: seat.capabilities } : {}),
    epoch: FEATURE_EPOCH,
    claim: { mode: 'seat', name: seat.member },
    connId: 'remote',
    claimCode: 'REMOTE',
    // Never read: a remote client reports no workspace (`MusterdClient.workspaceDir`), and every
    // path that would read or write a binding belongs to the socket and the claim it never opens.
    bindingDir: '',
  };
}

// The git and gh checks (ADR 585, ADR 612, lane 01M2XAXRP3) run in the seat's own clone. A remote
// request has none — the daemon's folder is some other checkout, or no repo at all — so each check
// abstains exactly as it does when git cannot run: a SHA is `fetch_failed`, a branch or PR is
// unread, and nothing is reconciled. The daemon records the claims `unverifiable`.

export async function abstainVerify(input: { sha?: string | undefined }): Promise<VerifyOutcome> {
  return input.sha === undefined ? 'unattested' : 'fetch_failed';
}

export async function abstainEvidence(refs: ClaimRefs): Promise<ClaimEvidence> {
  return {
    ...(refs.sha !== undefined ? { ancestry: 'fetch_failed' as const } : {}),
    ...(refs.branch !== undefined ? { branch_on_remote: null } : {}),
    ...(refs.pr !== undefined ? { pr: null, ci_green: null } : {}),
  };
}

export async function abstainClaims(
  refs: ClaimRefs,
  _cwd: string,
  checkedBy: string,
): Promise<LaneClaim[]> {
  return claimsFromEvidence(refs, await abstainEvidence(refs), checkedBy, Date.now());
}

export async function abstainChangeLabel(): Promise<null> {
  return null;
}

export async function abstainReconcile(): Promise<Map<string, Landed>> {
  return new Map();
}

/** A remote lane's project: the explicit argument, else the team default — never the daemon's repo. */
export function remoteProject(explicit: string | undefined): string {
  return explicit?.trim() ? resolveProject({ explicit, env: {} }) : DEFAULT_PROJECT;
}
