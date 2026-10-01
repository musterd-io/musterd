/** The outage line (cloud spec §7): the server's stable sentence, verbatim, nothing added. */
export function HealthBanner({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <div className="lc-health" role="alert">
      {reason}
    </div>
  );
}
