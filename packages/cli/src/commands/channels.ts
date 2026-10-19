import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

const USAGE =
  'usage: musterd channels pair --channel <name>\\n' +
  '       musterd channels pairings [--json]\\n' +
  '       musterd channels confirm <pairing-id> | reject <pairing-id>\\n' +
  '       musterd channels bindings [--json]\\n' +
  '       musterd channels revoke <binding-id>\\n' +
  '       musterd channels kill-switch';

/**
 * ADR 618 §7 — away-channel pairing from the terminal, one of the two original surfaces (the
 * other is /live). `pair` mints a single-use nonce (shown once — it is stored only as sha256)
 * and a two-digit check code that is a UX check, never the secret. The provider identity is
 * staged by the relay path; `confirm` shows it exactly as the daemon holds it and only that
 * confirmation creates the binding. `kill-switch` revokes every binding generation and
 * outstanding token and disconnects the relay, with no relay cooperation.
 */
export async function channelsCommand(parsed: Parsed): Promise<number> {
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
