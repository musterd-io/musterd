/**
 * A seat's address (ADR 491): `team/project/member`, or `team@host/project/member` when two servers
 * on this machine host a team with the same name.
 */
export function seatAddress(team: string, project: string, member: string, host?: string): string {
  return `${host ? `${team}@${host}` : team}/${project}/${member}`;
}

/** The host part of a server URL (`127.0.0.1:4849`, `musterd.io`), or the input when it is not a URL. */
export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}
