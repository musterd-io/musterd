import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * `musterd insight save|search` — the team-memory surface (ADR 327). Save writes an `insight`
 * act: a reusable finding the whole team can find, attributed and dated like every act. Search is
 * pull-only retrieval over a derived FTS fold of the log (a rebuildable cache — never a source of
 * truth, ADR 259). The fast tier: when a finding proves durable, promote it into docs/wiki/.
 */
export async function insightCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  const { team, http, identity } = resolve(parsed.flags);

  if (sub === 'save') {
    const headline = flagStr(parsed.flags, 'headline');
    if (!headline) {
      throw new CliError(
        'usage: musterd insight save --headline "<subject>" [body...] [--tags a,b] [--repo slug]',
        2,
      );
    }
    if (!identity) throw new CliError('no identity — run: musterd claim <name> --team <slug>', 4);
    const body = parsed.positionals.slice(1).join(' ');
    if (Buffer.byteLength(body, 'utf8') > 2048) {
      throw new CliError('insight body is limited to 2048 bytes', 2);
    }
    if (body.trim().length === 0) {
      throw new CliError('insight body must not be empty — the finding, not just the subject', 2);
    }
    const tags = flagStr(parsed.flags, 'tags')
      ?.split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const repo = flagStr(parsed.flags, 'repo');
    // ADR 526: the earlier findings this one replaces (yours, or any if you are human, are then hidden).
    const supersedes = flagStr(parsed.flags, 'supersedes')
      ?.split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    await http.send(
      team,
      makeEnvelope({
        id: ulid(),
        team,
        from: identity.name,
        to: { kind: 'team' },
        act: 'insight',
        body,
        meta: {
          headline,
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(repo ? { repo } : {}),
          ...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
        },
      }),
    );
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify({ ok: true, headline }) + '\n');
      return 0;
    }
    process.stdout.write(
      success(`insight saved — findable via ${theme.accent('musterd insight search')}`, {
        next: 'musterd insight search "<keywords>"',
      }) + '\n',
    );
    return 0;
  }

  if (sub === 'search') {
    const query = parsed.positionals.slice(1).join(' ');
    if (!query) {
      throw new CliError('usage: musterd insight search "<keywords>"', 2);
    }
    const limitRaw = Number(flagStr(parsed.flags, 'limit') ?? '');
    const { results } = await http.searchTeamMemory(
      team,
      query,
      Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    );
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify({ results }) + '\n');
      return 0;
    }
    if (results.length === 0) {
      process.stdout.write(
        `no matching insights — nothing saved under those words yet; if you learn it, ` +
          `${theme.accent('musterd insight save --headline "<subject>"')} records it for the next seat\n`,
      );
      return 0;
    }
    for (const r of results) {
      const age = Math.max(0, Math.round((Date.now() - r.ts) / 60000));
      const ageLabel =
        age >= 1440
          ? `${Math.floor(age / 1440)}d`
          : age >= 60
            ? `${Math.floor(age / 60)}h`
            : `${age}m`;
      process.stdout.write(`${theme.accent(r.headline)}\n`);
      process.stdout.write(
        `  by ${r.from} · ${ageLabel} ago${r.tags.length ? ` · ${r.tags.join(', ')}` : ''}\n`,
      );
      process.stdout.write(`  ${r.body}\n`);
      for (const s of r.status?.superseded_by ?? [])
        process.stdout.write(
          theme.warn(`  ⚠ superseded by ${s.from}'s [${s.id}] ${s.headline}`) + '\n',
        );
      process.stdout.write('\n');
    }
    process.stdout.write(`${results.length} insight(s)\n`);
    return 0;
  }

  // ADR 526: withdraw a finding. A `resolve` on the insight's own id — honoured as a retraction when
  // it comes from the insight's author or a human; from anyone else the daemon treats it as an
  // ordinary resolve (contest a teammate's finding with a challenge, ADR 505).
  if (sub === 'retract') {
    const id = parsed.positionals[1];
    const reason = flagStr(parsed.flags, 'reason')?.trim();
    if (!id || !reason)
      throw new CliError('usage: musterd insight retract <id> --reason "<why>"', 2);
    if (!identity) throw new CliError('no identity — run: musterd claim <name> --team <slug>', 4);
    await http.send(
      team,
      makeEnvelope({
        id: ulid(),
        team,
        from: identity.name,
        to: { kind: 'team' },
        act: 'resolve',
        thread: id,
        body: reason,
      }),
    );
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify({ ok: true, retracted: id }) + '\n');
      return 0;
    }
    process.stdout.write(
      success(`retracted ${id} — search, dreams and the digest stop carrying it`, {
        next: 'musterd insight search "<keywords>"',
      }) + '\n',
    );
    return 0;
  }

  throw new CliError(
    'usage: musterd insight save --headline "<subject>" [body...] [--supersedes id,id] | search "<keywords>" | retract <id> --reason "<why>"',
    2,
  );
}
