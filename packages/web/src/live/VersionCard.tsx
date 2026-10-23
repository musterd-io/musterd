import { shortBuild, type DaemonInfo } from './VersionBadge';

/** The rows of the card, in the order a person asks: which release, which build, then the counters. */
function versionRows(info: DaemonInfo): { label: string; value: string; note: string }[] {
  const rows: { label: string; value: string; note: string }[] = [];
  if (info.release) rows.push({ label: 'Release', value: info.release, note: 'cli, mcp, server' });
  if (info.build) rows.push({ label: 'Daemon build', value: shortBuild(info.build), note: 'this daemon' });
  if (info.wire) rows.push({ label: 'Wire protocol', value: info.wire, note: 'breaking contract' });
  if (info.epoch !== undefined) rows.push({ label: 'Feature epoch', value: String(info.epoch), note: 'capabilities' });
  if (info.guidance !== undefined) rows.push({ label: 'Guidance', value: `v${info.guidance}`, note: 'skill and hooks text' });
  if (info.schema !== undefined) rows.push({ label: 'Schema', value: String(info.schema), note: 'database' });
  return rows;
}

/** The card behind the version badge: every counter the daemon reports, each named — there is no
 *  single musterd version, only the release the packages share and the separate counters beside it. */
export default function VersionCard({ info }: { info: DaemonInfo }) {
  return (
    <div className="lc-ver-card" id="lc-ver-card" role="dialog" aria-label="musterd versions">
      <dl>
        {versionRows(info).map((r) => (
          <div className="lc-ver-row" key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
            <small>{r.note}</small>
          </div>
        ))}
      </dl>
      <p className="lc-ver-note">The web page publishes on its own, so its build can differ from the daemon&apos;s by design.</p>
    </div>
  );
}
