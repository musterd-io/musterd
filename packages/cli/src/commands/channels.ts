import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

const USAGE =
  'usage: musterd channels pair --channel <name>\\n' +
  '       musterd channels pairings [--json]\\n' +
  '       musterd channels confirm <pairing-id> | reject <pairing-id>\\n' +
  '       musterd channels bindings [--json]\\n' +
  '       musterd channels revoke <binding-id>\\n' +
  '       musterd channels slack-install\\n' +
  '       musterd channels slack-installs [--json]\\n' +
  '       musterd channels slack-revoke <slack-team-id>\\n' +
  '       musterd channels kill-switch';

/**
 * ADR 618 §7 — away-channel pairing from the terminal, one of the two original surfaces (the
 * other is /live). `pair` mints a single-use nonce (shown once — it is stored only as sha256)
 * and a two-digit check code that is a UX check, never the secret. The provider identity is
 * staged by the relay path; `confirm` shows it exactly as the daemon holds it and only that
 * confirmation creates the binding. `kill-switch` revokes every binding generation and
 * outstanding token and disconnects the relay, with no relay cooperation.
 */
/**
 * The flags `musterd channels` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
/**
 * The flags `musterd channels` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const CHANNELS_FLAGS = ['channel'] as const;

export async function channelsCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...CHANNELS_FLAGS],
    'the flags `musterd channels` takes are listed by `musterd help channels`',
  );
  const sub = parsed.positionals[0] ?? 'bindings';
  const { team, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;

  if (sub === 'pair') {
    const channel = flagStr(parsed.flags, 'channel');
    if (!channel) throw new CliError(USAGE, 2);
    const started = await http.startChannelPairing(team, channel);
    if (json) return printJson(started);
    process.stdout.write(
      success(`pairing started for ${channel} — check code ${started.check_code}`, {
        next: 'complete the provider sign-in, then: musterd channels pairings',
      }) + '\n',
    );
    process.stdout.write(`  nonce (shown once): ${started.nonce}\n`);
    process.stdout.write(`  pairing: ${started.pairing_id}\n`);
    return 0;
  }

  if (sub === 'pairings') {
    const { pairings } = await http.listChannelPairings(team);
    if (json) return printJson(pairings);
    if (pairings.length === 0) {
      process.stdout.write('no pairings waiting for confirmation\n');
      return 0;
    }
    for (const p of pairings) {
      process.stdout.write(
        `${p.id}  ${p.channel}  tenant ${p.provider_tenant_id}  user ${p.provider_user_id}  check ${p.check_code}\n`,
      );
    }
    process.stdout.write('confirm with: musterd channels confirm <pairing-id>\n');
    return 0;
  }

  if (sub === 'confirm' || sub === 'reject') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    if (sub === 'confirm') {
      const { binding } = await http.confirmChannelPairing(team, id);
      process.stdout.write(
        success(
          `bound ${binding.channel} tenant ${binding.provider_tenant_id} user ${binding.provider_user_id} (generation ${binding.generation})`,
        ) + '\n',
      );
    } else {
      await http.rejectChannelPairing(team, id);
      process.stdout.write(success('pairing rejected — nothing bound') + '\n');
    }
    return 0;
  }

  if (sub === 'bindings') {
    const { bindings } = await http.listChannelBindings(team);
    if (json) return printJson(bindings);
    if (bindings.length === 0) {
      process.stdout.write('no channel bindings\n');
      return 0;
    }
    for (const b of bindings) {
      process.stdout.write(
        `${b.id}  ${b.channel}  tenant ${b.provider_tenant_id}  user ${b.provider_user_id}  gen ${b.generation}  ${b.status}\n`,
      );
    }
    return 0;
  }

  if (sub === 'revoke') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    const result = await http.revokeChannelBinding(team, id);
    process.stdout.write(
      success(`binding revoked — ${result.tokensRevoked} outstanding token(s) consumed`) + '\n',
    );
    return 0;
  }

  if (sub === 'slack-install') {
    const started = await http.startSlackInstall(team);
    if (json) return printJson(started);
    process.stdout.write(
      success('Slack install link minted — open it and authorize in your workspace', {
        next: 'after authorizing, each person pairs: musterd channels pair --channel slack',
      }) + '\n',
    );
    process.stdout.write(`  install: ${started.install_url}\n`);
    return 0;
  }

  if (sub === 'slack-installs') {
    const { installs } = await http.listSlackInstalls(team);
    if (json) return printJson(installs);
    if (installs.length === 0) {
      process.stdout.write('no Slack installs\n');
      return 0;
    }
    for (const i of installs) {
      process.stdout.write(
        `${i.slack_team_id}  installer ${i.installer_slack_id}  ${i.revoked_at ? 'revoked' : 'active'}\n`,
      );
    }
    return 0;
  }

  if (sub === 'slack-revoke') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    await http.revokeSlackInstall(team, id);
    process.stdout.write(
      success(`Slack install ${id} revoked — its token no longer works here`) + '\n',
    );
    return 0;
  }

  if (sub === 'kill-switch') {
    const result = await http.killChannelSwitch(team);
    process.stdout.write(
      success(
        `channels off — ${result.bindingsRevoked} binding(s) revoked, ${result.tokensRevoked} token(s) consumed, relay disconnected`,
      ) + '\n',
    );
    return 0;
  }

  throw new CliError(USAGE, 2);
}

function printJson(value: unknown): number {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  return 0;
}
