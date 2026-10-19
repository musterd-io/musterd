import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Binding, LocalServing } from '@musterd/protocol';

/**
 * ADR 663: is this OpenCode wake about to run a model served on the host itself? Three things must
 * agree, read once at spawn:
 *
 * 1. the seat's binding declares `local: true` (a human's hand-set claim);
 * 2. the workspace's pinned `model` resolves to a provider in {@link LOCAL_SERVING_PROVIDERS};
 * 3. that provider's `options.baseURL` is a loopback address.
 *
 * Any disagreement, any unreadable or ambiguous config, answers `null`, and the wake keeps today's
 * `harness_price_unverified`. The answer is a configuration claim, not proof of where inference
 * ran (a loopback listener can forward to a paid API), which is why ADR 663 counts a `local` wake
 * against the unpriced-wake cap rather than exempting it.
 *
 * Only the workspace's own files are read (`.opencode/opencode.json`, then `opencode.json`), never
 * the global `~/.config/opencode` one: a host runs several seats, and a global pin would relabel
 * every one of them. A `jsonc` beside either file makes the answer `null` — musterd reads plain
 * JSON only (ADR 321 §3), and guessing which file OpenCode merges first is not a claim it can make.
 */

/** Provider ids that name a server on the host: Ollama, and llama.cpp's `llama-server` (the only
 *  path for models that ship llama.cpp-first, e.g. NVIDIA's Dory 1.0, 2026-10-19). */
export const LOCAL_SERVING_PROVIDERS: readonly string[] = ['ollama', 'llama.cpp'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True for an http(s) URL whose host is loopback (any 127.0.0.0/8 address counts). */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export interface LocalServingIo {
  exists: (path: string) => boolean;
  read: (path: string) => string;
}

const defaultIo: LocalServingIo = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
};

type Config = { model?: unknown; provider?: unknown };

function providerBaseUrl(cfg: Config, id: string): string | undefined {
  if (typeof cfg.provider !== 'object' || cfg.provider === null) return undefined;
  const block = (cfg.provider as Record<string, unknown>)[id];
  if (typeof block !== 'object' || block === null) return undefined;
  const options = (block as { options?: unknown }).options;
  if (typeof options !== 'object' || options === null) return undefined;
  const baseUrl = (options as { baseURL?: unknown }).baseURL;
  return typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined;
}

/** The snapshot a `local` wake carries, or `null` when the three signals do not all agree. */
export function readLocalServing(
  workspace: string,
  binding: Pick<Binding, 'local'> | null | undefined,
  io: LocalServingIo = defaultIo,
): LocalServing | null {
  if (binding?.local !== true) return null;
  const paths = [join(workspace, '.opencode', 'opencode.json'), join(workspace, 'opencode.json')];
  if (paths.some((p) => io.exists(`${p}c`))) return null;
  const configs: Config[] = [];
  for (const p of paths) {
    if (!io.exists(p)) continue;
    try {
      const parsed: unknown = JSON.parse(io.read(p));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      configs.push(parsed as Config);
    } catch {
      return null;
    }
  }
  const models = new Set(
    configs.flatMap((c) => (typeof c.model === 'string' && c.model.length > 0 ? [c.model] : [])),
  );
  if (models.size !== 1) return null;
  const pinned = [...models][0]!;
  const slash = pinned.indexOf('/');
  if (slash <= 0 || slash === pinned.length - 1) return null;
  const provider = pinned.slice(0, slash);
  const model = pinned.slice(slash + 1);
  if (!LOCAL_SERVING_PROVIDERS.includes(provider)) return null;
  const urls = new Set(configs.flatMap((c) => providerBaseUrl(c, provider) ?? []));
  if (urls.size !== 1) return null;
  const baseUrl = [...urls][0]!;
  if (!isLoopbackUrl(baseUrl)) return null;
  if (provider.length > 64 || model.length > 120 || baseUrl.length > 200) return null;
  return { provider, model, base_url: baseUrl };
}
