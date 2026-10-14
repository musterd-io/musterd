import { describe, expect, it } from 'vitest';
import { appendInterrupt, bridgeTools } from './nativeBridge.js';

/**
 * The native row's doorbell (clause 1 of `docs/design/daemon-doorbell-contract.md`, lane
 * 01M2GNYGEY). Before this, native was the one harness recorded **not shipped**: nothing bridged a
 * raised act into the loop's context, so a `steer` addressed to a woken native seat reached it only
 * if the model happened to read its own inbox.
 *
 * Pinned here: the seam that ships — the composed line rides out on the next tool result, which
 * every engine behind the seam inherits. The fixture that pinned WHY an `onBeforeTurn` push was
 * unsafe against the Anthropic SDK's tool runner left with that runner (ADR 588: the native row
 * runs on pi); the in-process doorbell lane (01M4VTA7Y6) delivers through pi's steering queue.
 */

const oneTool = {
  listTools: async () => ({
    tools: [{ name: 'team_next', description: 'orient', inputSchema: { type: 'object' } }],
  }),
  callTool: async () => ({ content: [{ type: 'text', text: 'next — as ryder' }] }),
};

describe('the composed line rides the tool result', () => {
  it('appends a raised line after the tool output, separated from it', async () => {
    const [tool] = await bridgeTools(oneTool, async () => 'musterd: schmidt raised a steer');
    await expect(tool!.run({})).resolves.toBe('next — as ryder\n\nmusterd: schmidt raised a steer');
  });

  it('is silent on the common path — an unraised probe leaves the result byte-identical', async () => {
    const [tool] = await bridgeTools(oneTool, async () => null);
    await expect(tool!.run({})).resolves.toBe('next — as ryder');
  });

  it('never fails the tool call it rides on: a throwing probe is swallowed', async () => {
    const [tool] = await bridgeTools(oneTool, async () => {
      throw new Error('daemon down');
    });
    await expect(tool!.run({})).resolves.toBe('next — as ryder');
  });

  it('with no probe wired, the bridge behaves exactly as it did before the doorbell', async () => {
    const [tool] = await bridgeTools(oneTool);
    await expect(tool!.run({})).resolves.toBe('next — as ryder');
  });

  it('delivers the line even when the tool returned nothing to append to', () => {
    expect(appendInterrupt('', 'musterd: a steer is waiting')).toBe('musterd: a steer is waiting');
    expect(appendInterrupt('result', null)).toBe('result');
  });
});
