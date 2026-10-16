import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type WakeUsage } from '@musterd/protocol';
import { z } from 'zod';
import { museDataRoot } from '../../session/enumerate.js';
import { addUsage } from './codex.js';

/**
 * The usage reader for Muse wakes (ADR 619, lane 01M52YJW). Muse writes
 * `session.jsonl` under `~/.local/share/muse/sessions/YYYY/MM/DD/<id>/`. A wake
 * mints the session id at spawn, so the reader opens that directory and no other.
 * Each `model_completed` line carries `payload.event.usage` and no dollar figure
 * (measured 2026-10-16, Muse 1.4.10). Tokens ride `WakeUsage`; cost stays unpriced.
 * A miss is undefined — never zeros, never a throw.
 *
 * Two usage keysets exist in the same store. Older lines have `cached_tokens`.
 * Fuller lines also have `cache_read_tokens` and `cache_write_tokens`, and on every
 * fuller line measured that day `cached_tokens` equalled `cache_read_tokens`. Mapping
 * both would double-count, so `cache_read_tokens` wins when it is present.
 */

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const MuseUsage = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cached_tokens: z.number().int().nonnegative().optional(),
    cache_read_tokens: z.number().int().nonnegative().optional(),
    cache_write_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const MuseModelCompleted = z
  .object({
    payload: z
      .object({
        event: z
          .object({
            kind: z.literal('model_completed'),
            usage: MuseUsage,
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

function toWakeUsage(usage: z.infer<typeof MuseUsage>): WakeUsage {
  const cacheRead = usage.cache_read_tokens ?? usage.cached_tokens;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(cacheRead !== undefined ? { cached_input_tokens: cacheRead } : {}),
    ...(usage.cache_write_tokens !== undefined
      ? { cache_write_input_tokens: usage.cache_write_tokens }
      : {}),
    ...(usage.reasoning_tokens !== undefined
      ? { reasoning_output_tokens: usage.reasoning_tokens }
      : {}),
  };
}

/** Sum every `model_completed` usage in one session log. Undefined when none parse. */
export function parseMuseSessionLog(text: string): WakeUsage | undefined {
  let total: WakeUsage | undefined;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = MuseModelCompleted.safeParse(raw);
    if (!parsed.success) continue;
    total = addUsage(total, toWakeUsage(parsed.data.payload.event.usage));
  }
  return total;
}

/**
 * `sessions/YYYY/MM/DD/<sessionId>/session.jsonl` under the Muse data root.
 * A session id with a slash, a dot, or anything outside `[A-Za-z0-9_-]` is refused
 * before it is joined onto a path. Subagent logs live beside this file and are not read.
 */
export function findMuseSessionLog(sessionId: string, root: string): string | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  const sessions = join(root, 'sessions');
  let years: string[];
  try {
    years = readdirSync(sessions);
  } catch {
    return undefined;
  }
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    let months: string[];
    try {
      months = readdirSync(join(sessions, year));
    } catch {
      continue;
    }
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue;
      let days: string[];
      try {
        days = readdirSync(join(sessions, year, month));
      } catch {
        continue;
      }
      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue;
        const log = join(sessions, year, month, day, sessionId, 'session.jsonl');
        try {
          statSync(log);
          return log;
        } catch {
          continue;
        }
      }
    }
  }
  return undefined;
}

/** The wake's own usage, or undefined when the log is missing or unreadable. Never throws. */
export function readMuseWakeUsage(
  sessionId: string,
  root: string = museDataRoot(),
): WakeUsage | undefined {
  const path = findMuseSessionLog(sessionId, root);
  if (!path) return undefined;
  try {
    return parseMuseSessionLog(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
