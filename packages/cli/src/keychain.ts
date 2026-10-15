import { execFile } from 'node:child_process';

/**
 * macOS Keychain lookup (`security find-generic-password -s <service> -w`); null on any miss or
 * error, including any platform without `security`. The secret is returned and never logged.
 * Shared by the stream key (`musterd-stream-key`, ADR 157) and a resident seat's API key
 * (`musterd:<VAR>`, ADR 605).
 */
export function keychainLookup(service: string): Promise<string | null> {
  return new Promise((res) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], (err, stdout) => {
      res(err ? null : stdout.trim() || null);
    });
  });
}

/** The Keychain service a resident seat's key is read from when its variable is unset (ADR 605). */
export const seatKeyService = (keyEnv: string): string => `musterd:${keyEnv}`;
