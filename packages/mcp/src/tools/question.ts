import { execFile } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  QUESTION_CONSEQUENCE_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_MAX_OPTIONS,
  QUESTION_TEXT_MAX,
  QUESTION_WHY_MAX,
  makeEnvelope,
  type Lane,
  type Question,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { withTraceContext } from '../otel.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

const DESCRIPTION =
  'Ask a person a question you need answered to go on (ADR 773). It returns at once: end your turn ' +
  "then — don't wait or poll. The answer arrives as your next turn, quoted after «…». Give options " +
  '(up to 9, each with its consequence) when there are clear choices, and why you are asking. Use ' +
  'this instead of ending a turn on a question in chat. Lane, PR and branch default from your claim.';

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
        to: z.string().describe("the person to ask, or '@team' for any person on the team"),
        text: z.string().min(1).max(QUESTION_TEXT_MAX).describe('the question, one line'),
        why: z
          .string()
          .max(QUESTION_WHY_MAX)
          .optional()
          .describe('why you are asking, in a line or two'),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(QUESTION_LABEL_MAX),
              consequence: z.string().min(1).max(QUESTION_CONSEQUENCE_MAX).optional(),
            }),
          )
          .max(QUESTION_MAX_OPTIONS)
          .optional()
          .describe('the choices, each with a one-line consequence'),
        blocking: z
          .boolean()
          .optional()
          .describe('true when you cannot go on without the answer (it buzzes their phone)'),
        anyone: z
          .boolean()
          .optional()
          .describe('true lets any person on the team answer, not only `to`'),
        context: z
          .object({
            lane: z.string().optional(),
            pr: z.number().int().positive().optional(),
            branch: z.string().optional(),
          })
          .optional()
          .describe('defaults to your claimed lane and current branch'),
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
      const context = args.context ?? (await defaultContext(client, deps.branchOf));
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
