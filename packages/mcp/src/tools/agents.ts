import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { errorResult, textResult } from './format.js';

/**
 * The phone's agent tools (ADR 449 §3, ADR 456 §2), registered on the remote rail only (ADR 630):
 * sponsoring an agent is a human's act, and a human at a desk does it with `musterd agent`. Each
 * calls the daemon's own route, so the mint and the policy are the route's — and the connect link
 * names the phone's public host, because the remote client presents the phone's edge headers.
 */
export function registerAgents(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool(
    'team_agent_create',
    {
      description:
        'Create an agent on this team that you sponsor. Returns a one-time connect link (15 minutes) ' +
        'to open on the device that will run it. It expires when you do, and removing you removes it. ' +
        'At most 3 live agents each.',
      inputSchema: {
        name: z.string().min(1).max(64).describe("the agent's member name (no spaces)"),
        role: z.string().max(64).optional().describe('optional role, e.g. research'),
      },
    },
    async (args) => {
      try {
        const minted = await client.createSponsoredAgent(args);
        // ADR 463 §2: lead with whichever happened — the sponsor's host is standing it up, or here
        // is the link to open on the device that will run it.
        return textResult(
          minted.hosting === 'sponsor_host'
            ? `Created agent "${minted.member.name}" on ${config.team}, sponsored by you. The team has been told.\n` +
                `Your host ${minted.host} is setting it up; it will greet you shortly. ` +
                "(If it doesn't within 15 minutes you'll get a connect link.)"
            : `Created agent "${minted.member.name}" on ${config.team}, sponsored by you. The team has been told.\n` +
                `Open this link on the device that will run it (expires in 15 minutes, works once):\n` +
                `${minted.connect_url}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'team_agent_connect',
    {
      description:
        "Get a one-time connect link (15 minutes) for one of the team's member-created agents, to open " +
        'on the device that will run it. Connecting takes the agent over from whatever device ' +
        "held it; the agent's sponsor is told. Who may is team policy.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("the agent's member name"),
      },
    },
    async (args) => {
      try {
        const issued = await client.connectSponsoredAgent(args.name);
        return textResult(
          `Connect link for "${issued.member}" (expires in 15 minutes, works once):\n` +
            `${issued.connect_url}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
