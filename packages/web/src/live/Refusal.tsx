import { LiveFetchError } from './client';
import { refusalCopy, type Refusal as RefusalCopy } from './refusalCopy';

/** The refusal for a thrown error: the person's line, with the daemon's code and words behind it. */
export function refusalOf(e: unknown): RefusalCopy {
  if (e instanceof LiveFetchError) return refusalCopy(e.message, e.code);
  if (e instanceof Error) return refusalCopy(e.message);
  return refusalCopy(String(e));
}

/**
 * A refusal, said to the person (lane 01M6EPXA6Z): one plain line, and the record (`code: message`)
 * under a "details" disclosure for seats and debugging. `role="alert"` so a screen reader hears the
 * line when it lands.
 */
export function Refusal({ refusal, className = '' }: { refusal: RefusalCopy; className?: string }) {
  return (
    <div className={`lc-refusal ${className}`.trim()} role="alert">
      <span className="lc-refusal__line">{refusal.line}</span>
      {refusal.detail && (
        <details className="lc-refusal__details">
          <summary>details</summary>
          <code>{refusal.detail}</code>
        </details>
      )}
    </div>
  );
}
