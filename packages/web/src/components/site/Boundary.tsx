/**
 * The line above the footer (homepage-copy-spec §0a.7): the one sentence a security reader looks
 * for, verbatim from the retired `WhatIs` card 4. It needs no section around it. The disclaimer
 * names who DOES contain in the same breath — a bare "we do not sandbox" reads as an evasion
 * (act 01M2PH26PH, finding 1).
 */
export function Boundary() {
  return (
    <div className="shell">
      <p className="site-boundary">
        musterd does not sandbox your agents; your own host, sandbox and provider controls still do
        that. It names the work that goes through the team.
      </p>
    </div>
  );
}
