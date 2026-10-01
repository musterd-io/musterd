import { ERROR_HTTP_STATUS, type ErrorBody, type ErrorCode } from '@musterd/protocol';

/** The single server error type. Carries a protocol error code; transports serialize it. */
export class MusterdError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MusterdError';
    this.code = code;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message } };
  }

  toFrame(): { type: 'error'; code: ErrorCode; message: string } {
    return { type: 'error', code: this.code, message: this.message };
  }
}

/**
 * The server cannot serve right now, for a reason that is one of a small set of STABLE SENTENCES
 * (cloud spec §5.5 / §7: "database unreachable", "console unreachable") — a probe or a banner
 * matches the message, so it is never free text. HTTP 503. The wire `code` is `server_error`: the
 * protocol has no unavailable code, and adding one is an ADR (hard rule 1); the status and the
 * sentence carry the meaning.
 */
export class ServiceUnavailable extends MusterdError {
  constructor(sentence: string) {
    super('server_error', sentence);
    this.name = 'ServiceUnavailable';
  }

  override get httpStatus(): number {
    return 503;
  }
}

/**
 * An `unauthorized` whose seat the server had ALREADY proved (ADR 391).
 *
 * `authByAgentSeatCredential` resolves the `msac_` credential to a real Member before it looks at
 * the `msls_` session lease. When the lease is missing or dead the request is rightly refused — but
 * the plain MusterdError it used to throw discarded the Member it had just verified, so nothing
 * downstream could say WHOSE probe was refused. Measured 2026-09-05: 26 of 102 interrupt probes in
 * ten minutes were 401 and the daemon could not name one of them.
 *
 * The wire body is unchanged — same code, same generic sentence, the caller learns nothing it did
 * not already hold. `seat` and `leaseState` are server-internal, for the one route that wants them
 * (the interrupt line). They are the seat NAME and a two-word state: never the credential, never
 * the lease token.
 */
export class SessionLeaseRefused extends MusterdError {
  readonly seat: string;
  readonly leaseState: 'missing' | 'dead';
  constructor(seat: string, leaseState: 'missing' | 'dead') {
    super(
      'unauthorized',
      leaseState === 'missing'
        ? 'missing agent session lease'
        : 'invalid, expired, or revoked agent session lease',
    );
    this.name = 'SessionLeaseRefused';
    this.seat = seat;
    this.leaseState = leaseState;
  }
}

/** Coerce any thrown value into a MusterdError (unknown errors become server_error). */
export function asMusterdError(err: unknown): MusterdError {
  if (err instanceof MusterdError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new MusterdError('server_error', message);
}
