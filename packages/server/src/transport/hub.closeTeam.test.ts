import { describe, expect, it } from 'vitest';
import { Hub, type Connection } from './hub.js';

/** ADR 608: losing a team closes every socket on it and forgets them; other teams are untouched. */
describe('Hub.closeTeam', () => {
  const conn = (connId: string, teamId: string, memberId: string, closed: string[]): Connection =>
    ({
      connId,
      memberId,
      memberName: memberId,
      teamId,
      presenceId: `p-${connId}`,
      observer: false,
      send: () => undefined,
      close: () => closed.push(connId),
    }) as unknown as Connection;

  it("closes and removes the lost team's connections only", () => {
    const hub = new Hub();
    const closed: string[] = [];
    hub.add(conn('c1', 'T1', 'ada', closed));
    hub.add(conn('c2', 'T1', 'bo', closed));
    hub.add(conn('c3', 'T2', 'cy', closed));
    expect(hub.closeTeam('T1')).toBe(2);
    expect(closed.sort()).toEqual(['c1', 'c2']);
    expect(hub.connsForMember('ada')).toEqual([]);
    expect(hub.connsForMember('cy')).toHaveLength(1);
    expect(hub.closeTeam('T1')).toBe(0);
  });
});
