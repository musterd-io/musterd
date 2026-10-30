import { execFile } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/server';
import { makeEnvelope, type Lane, type Question } from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { withTraceContext } from '../otel.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

// Limits (280-char text, 9 options, …) are the envelope's: a send past them is refused with the
// field named, so the schema here stays small — it rides every turn's tool list (ADR 085).
const DESCRIPTION =
  'Ask a person a question (ADR 773), then end your turn: the answer arrives as your next turn. ' +
  'Not a question in chat. Options carry a one-line consequence.';

/** Where the question sits: the seat's one live claimed lane and the workspace's branch. */
export async function defaultContext(
  client: Pick<MusterdClient, 'laneBoard'>,
  branchOf: () => Promise<string | null> = currentBranch,
): Promise<Question['context']> {
  const lanes = await client
    .laneBoard({ mine: true })
    .then((b) => b.lanes)
    .catch(() => [] as Lane[]);
  const live = lanes.filter((l) => l.state !== 'done' && l.state !== 'abandoned');
  const lane = live.length === 1 ? live[0] : undefined;
  const branch = lane?.branch ?? (await branchOf());
  const ctx = {
    ...(lane ? { lane: lane.id } : {}),
    ...(branch ? { branch } : {}),
  };
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

function currentBranch(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2_000 }, (err, out) => {
      const b = err ? '' : String(out).trim();
      resolve(b && b !== 'HEAD' ? b : null);
    });
  });
}

/** `team_question` — a seat's question to a person, as a decision card (ADR 773). */
export function registerQuestion(
  server: McpServer,
  client: MusterdClient,
  config: McpConfig,
  deps: { branchOf?: () => Promise<string | null> } = {},
): void {
  server.registerTool(
    'team_question',
    {
      description: DESCRIPTION,
      inputSchema: {
        to: z.string().describe("a person, or '@team'"),
        text: z.string(),
        why: z.string().optional(),
        options: z
          .array(
            z.object({
              label: z.string(),
              consequence: z.string().optional(),
            }),
          )
          .optional(),
        blocking: z.boolean().optional().describe('you cannot go on without it'),
        anyone: z.boolean().optional().describe('any person may answer'),
      },
    },
    async (args) => {
      if (!client.holdsSeat || !config.member) {
        return textResult(notReadyMessage(client, 'ask a question'));
      }
      const toTeam = args.to === '@team';
      if (!toTeam) {
        const { members } = await client.roster();
        const person = members.find((m) => m.name === args.to);
        if (!person) return errorResult(`no member "${args.to}" on ${config.team}.`);
        if (person.kind !== 'human') {
          return errorResult(
            `${args.to} is a seat, not a person. Questions go to people; for a seat use ` +
              "team_send {act:'request_help'}.",
          );
        }
      }
      const context = await defaultContext(client, deps.branchOf);
      const question: Question = {
        text: args.text,
        ...(args.why ? { why: args.why } : {}),
        ...(args.options?.length ? { options: args.options } : {}),
        ...(context ? { context } : {}),
        blocking: args.blocking === true,
        audience: toTeam || args.anyone === true ? 'team' : 'addressee',
        inferred: false,
      };
      try {
        const envelope = makeEnvelope({
          id: ulid(),
          team: config.team,
          from: config.member,
          to: toTeam ? { kind: 'team' } : { kind: 'member', name: args.to },
          act: 'ask',
          body: args.text,
          meta: withTraceContext({ species: 'consult', question }),
        });
        await client.sendEnvelope(envelope);
        client.markSeen(envelope.id);
        return textResult(
          `Asked ${toTeam ? 'the team' : args.to} (question ${envelope.id}). End your turn now — ` +
            "don't wait or poll. The answer arrives as your next turn, quoted after «…». If you " +
            `decide on your own first, withdraw it: team_send {act:'resolve', thread:'${envelope.id}', body:'decided'}.`,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
