import type { McpServer } from '@modelcontextprotocol/server';
import {
  STYLE_BLUNTNESS,
  STYLE_FORMAT,
  STYLE_LENGTH,
  STYLE_PUSHBACK,
  type StylePrefs,
} from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

/**
 * `team_style` / `team_style_set` (ADR 514 inc 3): a human in a chat folder reads and sets how
 * seats talk to them. Self-only by construction — the route is `/members/me/style` and the daemon
 * answers 403 for an agent seat, which these tools surface verbatim. A set is read-merge-write: the
 * route replaces prefs whole, so one dial must not wipe the others; `clear: true` is the one way to
 * empty them.
 */

const READ_DESCRIPTION =
  'Humans only: how seats talk to you — your dials, the resolved result, the block your seats read.';

const SET_DESCRIPTION =
  'Humans only: set a dial or your prose (≤5 lines); others keep their value. clear:true empties all.';

function renderRead(r: {
  member: string;
  prefs: StylePrefs;
  resolved: { dials: Record<string, string> };
  block: string;
}): string {
  const set = Object.entries(r.prefs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${k === 'prose' ? JSON.stringify(v) : String(v)}`);
  const dials = Object.entries(r.resolved.dials)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
  return (
    `${r.member}'s style — set: ${set.length ? set.join(', ') : 'nothing (team defaults)'}; ` +
    `resolved: ${dials}.\n\n${r.block}`
  );
}

export function registerStyle(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_style',
    { description: READ_DESCRIPTION, inputSchema: {} },
    async () => {
      if (!client.holdsSeat) return textResult(notReadyMessage(client, 'read style'));
      try {
        return textResult(renderRead(await client.styleRead()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_style_set',
    {
      description: SET_DESCRIPTION,
      inputSchema: {
        pushback: z.enum(STYLE_PUSHBACK).optional(),
        bluntness: z.enum(STYLE_BLUNTNESS).optional(),
        length: z.enum(STYLE_LENGTH).optional(),
        format: z.enum(STYLE_FORMAT).optional(),
        prose: z.string().optional(),
        clear: z.boolean().optional(),
      },
    },
    async (args) => {
      if (!client.holdsSeat) return textResult(notReadyMessage(client, 'set style'));
      try {
        let next: StylePrefs = {};
        if (!args.clear) {
          const current = (await client.styleRead()).prefs;
          next = { ...current };
          for (const k of ['pushback', 'bluntness', 'length', 'format'] as const) {
            if (args[k] !== undefined) (next as Record<string, unknown>)[k] = args[k];
          }
          if (args.prose !== undefined) {
            if (args.prose === '') delete next.prose;
            else next.prose = args.prose;
          }
        }
        return textResult(renderRead(await client.styleWrite(next)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
