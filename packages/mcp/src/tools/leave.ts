import type { McpServer } from '@modelcontextprotocol/server';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { textResult } from './format.js';

const DESCRIPTION =
  'Goes offline and releases your seat. Use when wrapping a session, not mid-task. The seat ' +
  'is held ~45s for a quick rejoin; team_join brings you back.';

export function registerLeave(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool('team_leave', { description: DESCRIPTION, inputSchema: {} }, async () => {
    // ADR 630 §3: a remote connector's seat is its token; there is no session here to end.
    if (client.remote) {
      return textResult(
        `You are ${config.member} on ${config.team} through a remote connector — your seat is ` +
          `the connector's sign-in, so there is nothing to leave. Disconnect the connector to go offline.`,
      );
    }
    if (!client.joined) {
      return textResult(
        `Not joined to ${config.team} — nothing to leave. team_join brings you online.`,
      );
    }
    client.leave();
    return textResult(
      `Left ${config.team}. Your seat is free (held ~45s in case you rejoin). Call team_join to come back online.`,
    );
  });
}
