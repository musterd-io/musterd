import type { IncomingMessage } from 'node:http';
import { PORTRAIT_MAX_BYTES, PortraitUploadSchema } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { appendAudit } from '../store/audit.js';
import { getMemberByName } from '../store/members.js';
import { portraitProblem, portraitsOf } from '../store/portraits.js';
import { resolveObserverScope, type MemberRow, type TeamRow } from '../store/rows.js';

/** The JSON body's ceiling: the base64url PNG at the cap, plus the envelope around it. */
const BODY_MAX_BYTES = Math.ceil((PORTRAIT_MAX_BYTES * 4) / 3) + 64;

/** Read the body, refusing it the moment it passes `max` bytes (declared or streamed). */
async function readCapped(req: IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max)
    throw new MusterdError('payload_too_large', `a portrait upload is at most ${max} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max)
      throw new MusterdError('payload_too_large', `a portrait upload is at most ${max} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MusterdError('bad_request', 'invalid JSON body');
  }
}

/**
 * `PUT /teams/:slug/members/:name/portrait` (ADR 797): keep the member's 64×64 portrait, painted by
 * /live from their rendered figure, so the phone can show it. A person's session writes it — a human,
 * or a full-scope observer (a person's hidden /live watch seat). Agent seats are refused: they do not
 * paint portraits, and must not be able to set the face another seat shows on a person's phone.
 */
export async function putPortrait(
  ctx: Ctx,
  auth: { team: TeamRow; member: MemberRow },
  targetName: string,
  req: IncomingMessage,
): Promise<{ digest: string }> {
  const { team, member } = auth;
  const person =
    member.observer === 1 ? resolveObserverScope(member) === 'full' : member.kind === 'human';
  if (!person)
    throw new MusterdError('forbidden', 'only a person’s session may set a member portrait');
  const body = PortraitUploadSchema.safeParse(await readCapped(req, BODY_MAX_BYTES));
  if (!body.success) throw new MusterdError('bad_request', 'a portrait upload is {png: base64url}');
  const png = Buffer.from(body.data.png, 'base64url');
  const problem = portraitProblem(png);
  if (problem) throw new MusterdError('bad_request', problem);
  const target = await getMemberByName(ctx.db, team.id, targetName);
  if (!target || target.left_at !== null)
    throw new MusterdError('not_found', `no member "${targetName}" in "${team.slug}"`);
  const cache = portraitsOf(ctx.config.dbPath);
  const before = cache.digests(team.id).get(target.name);
  const digest = cache.put(team.id, target.name, png);
  if (before !== digest)
    await appendAudit(ctx.db, team.id, {
      actor: member.name,
      action: 'member.portrait',
      target: target.name,
      result: 'allow',
      detail: { digest },
    });
  return { digest };
}
