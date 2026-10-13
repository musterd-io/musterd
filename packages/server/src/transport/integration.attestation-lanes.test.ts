import { PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { listAudit } from '../store/audit.js';
import { openDirectedLedger } from '../store/delivery.js';
import { getMemberByName } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

withDrivers('integration · attestation-lanes', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, authHeaders, get, post, req, resolveAuth, standingGrant } = h;
  type TestWs = InstanceType<typeof TestWs>;

  describe('model attestation (ADR 101)', () => {
    it('the act stamp carries WHICH TIER attested it — observed vs declared, server-controlled, never defaulted', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, tok);

      const a = new TestWs();
      const l = new TestWs();
      const b = new TestWs();
      await Promise.all([a.open(), l.open(), b.open()]);
      // Ada: a harness probe SAW this model. Bo: only a provisioning snapshot DECLARED it.
      // Same id, same confidence on the wire today — the tier is the only thing separating them.
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(tok, 'Ada'),
        'claude-opus-4-8',
        undefined,
        'observed',
      );
      await b.claim(
        'dawn',
        team.json.agent_key,
        'Bo',
        'cursor',
        await standingGrant(tok, 'Bo'),
        'grok-4.6',
        undefined,
        'binding',
      );
      // Lin attests a model but NO tier — an older client. Absence must stay absence.
      await l.claim(
        'dawn',
        team.json.agent_key,
        'Lin',
        'codex',
        await standingGrant(tok, 'Lin'),
        'gpt-5.6',
      );

      // `waitFor` returns the FIRST buffered frame of a type and never consumes it, so three delivers
      // to one socket would all read as the first. Key on the envelope id instead.
      const deliverOf = async (ws: TestWs, id: string): Promise<any> => {
        const deadline = Date.now() + 1000;
        for (;;) {
          const f = (ws as unknown as { frames: any[] }).frames.find(
            (x) => x.type === 'deliver' && x.envelope?.id === id,
          );
          if (f) return f;
          if (Date.now() > deadline) throw new Error(`timeout waiting for deliver ${id}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      };

      const say = (ws: TestWs, from: string, id: string) =>
        ws.send({
          type: 'send',
          envelope: {
            id,
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from,
            to: { kind: 'member', name: 'Lin' },
            act: 'status_update',
            body: 'x',
            ts: Date.now(),
          },
        });

      say(a, 'Ada', 'ada1');
      const observed = await deliverOf(l, 'ada1');
      expect(observed.envelope.meta.model).toBe('claude-opus-4-8');
      expect(observed.envelope.meta.model_source).toBe('observed');

      say(b, 'Bo', 'bo1');
      const declared = await deliverOf(l, 'bo1');
      expect(declared.envelope.meta.model).toBe('grok-4.6');
      expect(declared.envelope.meta.model_source).toBe('binding');

      // The old client's act keeps its model and carries NO tier — never defaulted to `binding`,
      // because "we do not know which tier" is a different fact from "it was a declaration".
      //
      // AND it spoofs one, which is the case that actually needs the strip. Where the occupancy HAS a
      // tier the server's value overwrites the client's by spread order, so a missing strip is
      // invisible; here there is nothing to overwrite with, so an unstripped client tier would ride
      // out untouched and an UNKNOWN tier would arrive downstream labelled `observed`. Found by
      // mutation: deleting the strip left the earlier spoof assertion green.
      l.send({
        type: 'send',
        envelope: {
          id: 'lin1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Lin',
          to: { kind: 'member', name: 'Ada' },
          act: 'status_update',
          body: 'x',
          meta: { model_source: 'observed' },
          ts: Date.now(),
        },
      });
      const untiered = await deliverOf(a, 'lin1');
      expect(untiered.envelope.meta.model).toBe('gpt-5.6');
      expect(untiered.envelope.meta.model_source).toBeUndefined();

      // A seat cannot launder its own declaration into an observation: client-supplied tier is
      // stripped exactly like a client-supplied model, and the occupancy's real tier is stamped.
      b.send({
        type: 'send',
        envelope: {
          id: 'bo2',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Bo',
          to: { kind: 'member', name: 'Lin' },
          act: 'status_update',
          body: 'x',
          meta: { model: 'claude-opus-4-8', model_source: 'observed' },
          ts: Date.now(),
        },
      });
      const spoofed = await deliverOf(l, 'bo2');
      expect(spoofed.envelope.meta.model).toBe('grok-4.6');
      expect(spoofed.envelope.meta.model_source).toBe('binding');

      await Promise.all([a.close(), l.close(), b.close()]);
    });

    it('the tier SURVIVES the heartbeat — re-affirming the same model must not erase model_source', async () => {
      // Measured on revive, 2026-09-03: every live presence row had a model and a NULL tier, and 100
      // of 113 `observed` acts were sent within 16s of a claim. The claim stored the pair; the first
      // heartbeat (15s) re-attested the id alone and wrote the tier back to NULL. The ADR 301 commit
      // updated both claim sites and missed the heartbeat re-attest.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      const a = new TestWs();
      const l = new TestWs();
      await Promise.all([a.open(), l.open()]);
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(tok, 'Ada'),
        'claude-opus-5',
        undefined,
        'observed',
      );
      await l.claim('dawn', team.json.agent_key, 'Lin', 'codex', await standingGrant(tok, 'Lin'));

      const deliverOf = async (ws: TestWs, id: string): Promise<any> => {
        const deadline = Date.now() + 1000;
        for (;;) {
          const f = (ws as unknown as { frames: any[] }).frames.find(
            (x) => x.type === 'deliver' && x.envelope?.id === id,
          );
          if (f) return f;
          if (Date.now() > deadline) throw new Error(`timeout waiting for deliver ${id}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      const say = (id: string) =>
        a.send({
          type: 'send',
          envelope: {
            id,
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'member', name: 'Lin' },
            act: 'status_update',
            body: 'x',
            ts: Date.now(),
          },
        });
      const teamRow = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const attestAudits = async () =>
        (await listAudit(h.server.store, teamRow.id)).filter(
          (r) => r.action === 'occupancy.model_attested',
        );

      // 1. The steady-state heartbeat: same id, same tier. Nothing changed, so nothing is written
      //    and nothing audits — and the tier is still on the next act.
      a.send({ type: 'heartbeat', model: 'claude-opus-5', model_source: 'observed' });
      await new Promise((r) => setTimeout(r, 50));
      expect((await attestAudits()).length).toBe(1); // claim-time only
      say('hb1');
      const afterSteady = await deliverOf(l, 'hb1');
      expect(afterSteady.envelope.meta.model).toBe('claude-opus-5');
      expect(afterSteady.envelope.meta.model_source).toBe('observed');

      // 2. An older client re-affirms the id with no tier. Absent means "no change", never a clear
      //    (the HeartbeatFrame contract) — the claim-time observation stands.
      a.send({ type: 'heartbeat', model: 'claude-opus-5' });
      await new Promise((r) => setTimeout(r, 50));
      say('hb2');
      const afterBare = await deliverOf(l, 'hb2');
      expect(afterBare.envelope.meta.model_source).toBe('observed');

      // 3. A real switch carries its own tier, and the stamp follows the pair.
      a.send({ type: 'heartbeat', model: 'claude-fable-5-1', model_source: 'environment' });
      await new Promise((r) => setTimeout(r, 50));
      say('hb3');
      const afterSwitch = await deliverOf(l, 'hb3');
      expect(afterSwitch.envelope.meta.model).toBe('claude-fable-5-1');
      expect(afterSwitch.envelope.meta.model_source).toBe('environment');

      // 4. A switch with NO tier cannot inherit the old one — that tier described a different id.
      a.send({ type: 'heartbeat', model: 'claude-sonnet-5' });
      await new Promise((r) => setTimeout(r, 50));
      say('hb4');
      const afterBlindSwitch = await deliverOf(l, 'hb4');
      expect(afterBlindSwitch.envelope.meta.model).toBe('claude-sonnet-5');
      expect(afterBlindSwitch.envelope.meta.model_source).toBeUndefined();

      // 5. A heal that only corrects the tier (same id, now observed) is a real change and is written.
      a.send({ type: 'heartbeat', model: 'claude-sonnet-5', model_source: 'observed' });
      await new Promise((r) => setTimeout(r, 50));
      say('hb5');
      const afterHeal = await deliverOf(l, 'hb5');
      expect(afterHeal.envelope.meta.model_source).toBe('observed');
    });

    it('the roster ANSWERS the currency census — guidance_epoch reaches a reader (ADR 417)', async () => {
      // The amended acceptance for this lane is that the nine-worktree census is answerable as a
      // QUERY rather than a shell loop over nine checkouts. Tasks 1-5 make the data exist; this is the
      // assertion that a reader can actually ask, and it is what the acceptance is checked against.
      //
      // The field rides `presences[]`, not the member: it is a property of an OCCUPANCY. Files carry
      // the stamp, and one seat holding two workspaces attests two different epochs — a member-level
      // field would have to pick one and would be lying about the other (agreed with dolly,
      // 01M2SB9C3Z; the same reasoning that put `model` there).
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      const a = new TestWs();
      const l = new TestWs();
      await Promise.all([a.open(), l.open()]);
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(tok, 'Ada'),
        surface: 'claude-code',
        guidance_epoch: 24,
      });
      await a.waitFor('occupied');
      // Lin claims from an unprovisioned workspace: nothing to attest, so nothing is said.
      await l.claim('dawn', team.json.agent_key, 'Lin', 'codex', await standingGrant(tok, 'Lin'));

      const roster = await get('/teams/dawn/members');
      const epochOf = (name: string) =>
        roster.json.members.find((m: any) => m.name === name).presences[0].guidance_epoch;

      // A stale seat is legible as stale, and an unstamped one as UNKNOWN — null, never 0, which
      // would sort it below every real answer and report it as the most out-of-date seat on the team.
      expect(epochOf('Ada')).toBe(24);
      expect(epochOf('Lin')).toBeNull();
      a.close();
      l.close();
    });

    it('the style epoch rides the WS claim, the heartbeat and the HTTP claim, and silence never clears it (ADR 514)', async () => {
      // Review Focus 4 of the inc-2 plan, pinned at the transport: deleting any of the four wiring
      // lines (ws claim, ws heartbeat, http claim schema, http claim ctx) must fail here, not only
      // in the store test that calls reattestStyleEpoch directly.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      const a = new TestWs();
      await a.open();
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(tok, 'Ada'),
        surface: 'claude-code',
        style_epoch: 'a1b2c3d4',
      });
      const occupied = await a.waitFor('occupied');
      const presenceId = occupied.presence_id as string;
      const stored = async () =>
        (await h.server.store.get('SELECT style_epoch FROM presence WHERE id = ?', [presenceId]))!
          .style_epoch;
      expect(await stored()).toBe('a1b2c3d4');
      // ADR 514 inc 3: the occupied frame hands the seat its style envelope. This claim named no
      // driver and the team has one human (nick), so nick is the driver.
      const style = occupied.style as { block: string; epoch: string; driver: string | null };
      expect(style.epoch).toMatch(/^[0-9a-f]{8}$/);
      expect(style.driver).toBe('nick');
      expect(style.block).toContain('Style (epoch ');
      expect(style.block).toContain('For nick (in chat, and in any act addressed to nick)');

      a.send({ type: 'heartbeat', style_epoch: 'ffffffff' });
      await new Promise((r) => setTimeout(r, 50));
      expect(await stored()).toBe('ffffffff');

      a.send({ type: 'heartbeat' });
      await new Promise((r) => setTimeout(r, 50));
      expect(await stored()).toBe('ffffffff');

      // The HTTP claim mirror carries it too (the schema that "drops it green on both sides" if not).
      const lin = await post('/teams/dawn/claim', {
        key: team.json.agent_key,
        target: { seat: 'Lin' },
        grant: await standingGrant(tok, 'Lin'),
        surface: 'cli',
        style_epoch: '0badf00d',
      });
      expect(lin.status, JSON.stringify(lin.json)).toBeLessThan(300);

      const roster = await get('/teams/dawn/members');
      const epochOf = (name: string) =>
        roster.json.members.find((m: any) => m.name === name).presences[0].style_epoch;
      expect(epochOf('Ada')).toBe('ffffffff');
      expect(epochOf('Lin')).toBe('0badf00d');
      a.close();
    });

    it('the guidance epoch rides the claim AND every heartbeat, and silence never clears it (ADR 417)', async () => {
      // The other half of the seam `client.guidanceEpoch.e2e.test.ts` closes on the HTTP mirror. Self-
      // heal fires once, at session start, so a long session outlives the rule it started under: a
      // refresh rewrites the seat's guidance files while its socket stays open, and the roster has to
      // follow. That is the ONE behaviour `epoch` never needs — a compiled-in constant cannot change
      // mid-occupancy — so it gets its own case rather than riding the model's.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      const grant = await standingGrant(tok, 'Ada');
      const a = new TestWs();
      await a.open();
      // Raw frame rather than the `claim` helper: its parameters are positional, and the comment on
      // `modelSource` records what inserting one in the middle already cost once.
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        guidance_epoch: 24,
      });
      const occupied = await a.waitFor('occupied');
      const presenceId = occupied.presence_id as string;
      const stored = async () =>
        (await h.server.store.get('SELECT guidance_epoch FROM presence WHERE id = ?', [
          presenceId,
        ]))!.guidance_epoch;

      // 1. The claim's attestation lands on the row.
      expect(await stored()).toBe(24);

      // 2. A heartbeat carrying a NEWER epoch moves it — the seat refreshed mid-session and said so.
      a.send({ type: 'heartbeat', guidance_epoch: 26 });
      await new Promise((r) => setTimeout(r, 50));
      expect(await stored()).toBe(26);

      // 3. A heartbeat carrying NONE leaves it standing. Absence is not an assertion (ADR 236) — and
      //    this is the exact shape that erased `model_source` every 15 seconds before ADR 301.
      a.send({ type: 'heartbeat' });
      await new Promise((r) => setTimeout(r, 50));
      expect(await stored()).toBe(26);

      // 4. No audit row, by design (ADR 417 §Observability): a guidance epoch is occupancy state, not
      //    an event. `presence` is where occupancy state lives, and the roster is its instrument.
      const teamRow = (await getTeamBySlug(h.server.store, 'dawn'))!;
      expect(
        (await listAudit(h.server.store, teamRow.id)).filter((r) =>
          r.action.startsWith('occupancy.guidance'),
        ),
      ).toEqual([]);
      a.close();
    });

    it('claim attests, acts carry the server-side meta.model stamp, heartbeat re-attests + audits', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);

      const a = new TestWs();
      const l = new TestWs();
      await Promise.all([a.open(), l.open()]);
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(tok, 'Ada'),
        'claude-opus-4-8',
      );
      // Lin attests nothing — legal, never blocks.
      await l.claim('dawn', team.json.agent_key, 'Lin', 'codex', await standingGrant(tok, 'Lin'));

      // Ada's act carries the stamp from her occupancy — server-side, not client meta.
      a.send({
        type: 'send',
        envelope: {
          id: 'am1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'handoff',
          body: 'take this',
          ts: Date.now(),
        },
      });
      const deliver = (await l.waitFor('deliver')) as any;
      expect(deliver.envelope.meta.model).toBe('claude-opus-4-8');

      // Lin is unattested AND tries to spoof a model in client meta — the server strips it, so the
      // act carries no stamp (the integrity claim the diversity flag rests on).
      l.send({
        type: 'send',
        envelope: {
          id: 'lm1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Lin',
          to: { kind: 'member', name: 'Ada' },
          act: 'accept',
          body: 'ok',
          meta: { in_reply_to: 'am1', model: 'claude-opus-4-8' },
          ts: Date.now(),
        },
      });
      const back = (await a.waitFor('deliver')) as any;
      expect(back.envelope.meta.model).toBeUndefined();

      // Re-attestation rides the heartbeat; only a real change audits (old → new).
      a.send({ type: 'heartbeat', model: 'claude-fable-5' });
      await new Promise((r) => setTimeout(r, 50));
      const teamRow = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const attests = (await listAudit(h.server.store, teamRow.id)).filter(
        (r) => r.action === 'occupancy.model_attested',
      );
      expect(attests.length).toBe(2); // claim-time initial + the heartbeat switch
      const details = attests.map(
        (r) => JSON.parse(r.detail!) as { old: string | null; new: string; source: string },
      );
      expect(details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ old: null, new: 'claude-opus-4-8', source: 'claim' }),
          expect.objectContaining({
            old: 'claude-opus-4-8',
            new: 'claude-fable-5',
            source: 'heartbeat',
          }),
        ]),
      );

      a.close();
      l.close();
    });

    it('HTTP claim + later one-shot with x-musterd-model stamps after the claim presence is reaped (ADR 119 / #172)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      const grant = await standingGrant(tok, 'Ada');

      // Stateless claim with a harness-attested model (the thin-CLI path).
      const claimed = await post('/teams/dawn/claim', {
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'cli',
        model: 'qwen2.5:3b-instruct',
      });
      expect(claimed.status).toBe(200);
      expect(claimed.json.type).toBe('occupied');
      const ada = {
        key: claimed.json.seat_credential as string,
        seat: 'Ada',
        sessionLease: claimed.json.session_lease as string,
      };

      // First one-shot while the claim occupancy is still live — stamp from newest-attested.
      const first = await fetch(h.base + '/teams/dawn/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(ada),
          'x-musterd-model': 'qwen2.5:3b-instruct',
        },
        body: JSON.stringify({
          envelope: {
            id: 'ada-1',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'member', name: 'Lin' },
            act: 'status_update',
            body: 'first',
            ts: Date.now(),
          },
        }),
      });
      expect(first.status).toBe(201);
      expect(((await first.json()) as any).ack.meta.model).toBe('qwen2.5:3b-instruct');

      // Reap the claim occupancy — the fire-and-exit gap in finding 003 / issue #172.
      const adaId = (await getMemberByName(
        h.server.store,
        (await getTeamBySlug(h.server.store, 'dawn'))!.id,
        'Ada',
      ))!.id;
      const removed = await h.server.store.run('DELETE FROM presence WHERE member_id = ?', [adaId]);
      expect(removed.changes).toBeGreaterThan(0);
      const renewed = await post('/teams/dawn/claim', {
        key: ada.key,
        target: { seat: ada.seat },
        surface: 'cli',
      });
      Object.assign(ada, { sessionLease: renewed.json.session_lease });

      // Without the header: ambient attaches a bare row → stamp drops (the #172 hole).
      const bare = await fetch(h.base + '/teams/dawn/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(ada),
        },
        body: JSON.stringify({
          envelope: {
            id: 'ada-bare',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'member', name: 'Lin' },
            act: 'status_update',
            body: 'bare ambient',
            ts: Date.now(),
          },
        }),
      });
      expect(bare.status).toBe(201);
      expect(((await bare.json()) as any).ack.meta?.model).toBeUndefined();

      // Clear again so the next touch is a fresh attach (not COALESCE onto the bare row).
      await h.server.store.run('DELETE FROM presence WHERE member_id = ?', [adaId]);
      const renewedAgain = await post('/teams/dawn/claim', {
        key: ada.key,
        target: { seat: ada.seat },
        surface: 'cli',
        model: 'qwen2.5:3b-instruct',
      });
      Object.assign(ada, { sessionLease: renewedAgain.json.session_lease });

      // With x-musterd-model the ambient touch re-attests, so the act keeps the stamp.
      const later = await fetch(h.base + '/teams/dawn/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(ada),
          'x-musterd-model': 'qwen2.5:3b-instruct',
        },
        body: JSON.stringify({
          envelope: {
            id: 'ada-2',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'member', name: 'Lin' },
            act: 'status_update',
            body: 'reattest',
            ts: Date.now(),
          },
        }),
      });
      expect(later.status).toBe(201);
      expect(((await later.json()) as any).ack.meta.model).toBe('qwen2.5:3b-instruct');

      const teamRow = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const renewedClaim = (await listAudit(h.server.store, teamRow.id)).filter((r) => {
        if (r.action !== 'occupancy.model_attested') return false;
        const d = JSON.parse(r.detail!) as { source: string };
        return d.source === 'claim';
      });
      expect(renewedClaim.length).toBeGreaterThanOrEqual(1);
    });

    it('human credential + x-musterd-model does not attest the human occupancy (ADR 121)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // A human one-shot carrying the header (e.g. MUSTERD_MODEL leaked into Nick's shell) must
      // still flip present for liveness, but must NOT write model onto the occupancy or stamp acts.
      const sent = await fetch(h.base + '/teams/dawn/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${nickTok}`,
          'x-musterd-model': 'claude-opus-4-8',
        },
        body: JSON.stringify({
          envelope: {
            id: 'nick-1',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'member', name: 'Ada' },
            act: 'status_update',
            body: 'human send',
            ts: Date.now(),
          },
        }),
      });
      expect(sent.status).toBe(201);
      const ack = (await sent.json()) as { ack: { meta?: { model?: string } } };
      expect(ack.ack.meta?.model).toBeUndefined();

      const roster = await get('/teams/dawn/members', nickTok);
      const nickRow = roster.json.members.find((m: { name: string }) => m.name === 'nick');
      expect(nickRow?.presence).toBe('online');
      expect(nickRow?.presences?.[0]?.model ?? null).toBeNull();

      const teamRow = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const ambient = (await listAudit(h.server.store, teamRow.id)).filter((r) => {
        if (r.action !== 'occupancy.model_attested') return false;
        const d = JSON.parse(r.detail!) as { source: string };
        return d.source === 'ambient';
      });
      expect(ambient).toHaveLength(0);
    });
  });

  describe('build attestation (ADR 135)', () => {
    it('WS claim attests the client build onto the presence row; absent stays null', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);

      const sha = 'a'.repeat(40);
      const a = new TestWs();
      const l = new TestWs();
      await Promise.all([a.open(), l.open()]);
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(tok, 'Ada'),
        surface: 'claude-code',
        build: sha,
      });
      await a.waitFor('occupied');
      // Lin attests nothing — legal (unstamped/older client), never blocks.
      await l.claim('dawn', team.json.agent_key, 'Lin', 'codex', await standingGrant(tok, 'Lin'));

      const roster = await get('/teams/dawn/members', tok);
      const ada = roster.json.members.find((m: any) => m.name === 'Ada');
      const lin = roster.json.members.find((m: any) => m.name === 'Lin');
      expect(ada.presences[0].build).toBe(sha);
      expect(lin.presences[0].build).toBeNull();

      a.close();
      l.close();
    });

    it('x-musterd-build re-attests on the ambient touch, sticky across build-less requests, ALL credentials', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      const sha = 'b'.repeat(40) + '-dirty'; // a dirty build is attestable — display keeps the suffix

      // Unlike model (ADR 121 agent-key gate), build rides a HUMAN credential too: it attests the
      // binary the caller runs, which a human's stale CLI genuinely has. Reads never touch (ADR 057),
      // so drive the ambient touch through a touching call (POST /messages), like the ADR 119 test.
      const sendAsNick = (id: string, headers: Record<string, string>) =>
        fetch(h.base + '/teams/dawn/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tok}`,
            ...headers,
          },
          body: JSON.stringify({
            envelope: {
              id,
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from: 'nick',
              to: { kind: 'team' },
              act: 'status_update',
              body: 'hello',
              ts: Date.now(),
            },
          }),
        });

      expect((await sendAsNick('n1', { 'x-musterd-build': sha })).status).toBe(201);
      let roster = await get('/teams/dawn/members', tok);
      let nickRow = roster.json.members.find((m: any) => m.name === 'nick');
      expect(nickRow.presences[0].build).toBe(sha);

      // A later touching request WITHOUT the header keeps the attested value (sticky COALESCE).
      expect((await sendAsNick('n2', {})).status).toBe(201);
      roster = await get('/teams/dawn/members', tok);
      nickRow = roster.json.members.find((m: any) => m.name === 'nick');
      expect(nickRow.presences[0].build).toBe(sha);
    });

    it('HTTP claim: the team agent key cannot occupy a HUMAN seat, and leaves no request row', async () => {
      // The team agent key is SHARED across every agent harness. authByAgentKey already refuses to
      // *act* as a human seat (privilege escalation into admin ops), but the claim path resolves its
      // target separately and never applied the same rule — so any agent could OCCUPY the human seat
      // and inherit it. The refusal must land before the grant/request branches: an admin must never
      // be asked to approve a poisoned claim, and no pending row may leak.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;

      const r = await post('/teams/dawn/claim', {
        key: team.json.agent_key, // an agent key…
        target: { seat: 'nick' }, // …aimed at the human admin seat
        surface: 'cli',
      });
      expect(r.status).toBe(403);
      expect(r.json.code).toBe('forbidden');
      expect(r.json.message).toMatch(/human seat "nick" is not reachable/i);
      expect(r.json.hint).toMatch(/mscr_/); // points at the human's own credential

      // …and nothing was queued for an admin to approve.
      const reqs = await get('/teams/dawn/requests', tok);
      expect((reqs.json.requests ?? []).length).toBe(0);
    });

    it('HTTP claim: a ROLE target that resolves to a human seat is refused too', async () => {
      // The guard has to sit after target resolution, not beside the seat-name branch — otherwise
      // `--role` is an unguarded back door to the same seat.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      // Give the human seat a role an agent might legitimately ask for.
      const nickRow = (await getMemberByName(
        h.server.store,
        (await getTeamBySlug(h.server.store, 'dawn'))!.id,
        'nick',
      ))!;
      await h.server.store.run('UPDATE members SET role = ? WHERE id = ?', ['steward', nickRow.id]);

      const r = await post('/teams/dawn/claim', {
        key: team.json.agent_key,
        target: { role: 'steward' },
        surface: 'cli',
      });
      expect(r.status).toBe(403);
      expect(r.json.message).toMatch(/human seat "nick" is not reachable/i);
    });

    it('HTTP claim: an agent key claiming an AGENT seat still works (the guard must not over-block)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      const r = await post('/teams/dawn/claim', {
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(tok, 'Ada'),
        surface: 'cli',
      });
      expect(r.status).toBe(200);
    });

    it('HTTP claim: a human claiming their OWN seat with their credential still works (ADR 077)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const r = await post('/teams/dawn/claim', {
        key: team.json.human_credential, // the human's own mscr_, not the agent key
        target: { seat: 'nick' },
        surface: 'cli',
      });
      expect(r.status).toBe(200);
    });

    it('HTTP claim carries the build onto the stateless occupancy', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      const sha = 'c'.repeat(40);

      const r = await post('/teams/dawn/claim', {
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(tok, 'Ada'),
        surface: 'cli',
        build: sha,
      });
      expect(r.status).toBe(200);
      const roster = await get('/teams/dawn/members', tok);
      const ada = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(ada.presences[0].build).toBe(sha);
    });
  });

  describe('coordination lanes, Phase 1 (ADR 083)', () => {
    // "Never build in a lane a teammate owns" is the board's whole promise, and nothing enforced it:
    // lane_claim is a bare PATCH of owner_seat, so a second claimant silently took the lane and got a
    // success back. Two seats built the same lane ~6 minutes apart (2026-08-01).
    it('refuses to claim a lane a LIVE teammate owns, and says who holds it', async () => {
      const team = await post('/teams', { slug: 'race', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bo = await post('/teams/race/members', { name: 'bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential;

      const lane = await post('/teams/race/lanes', { title: 'contested', claim: true }, nickTok);
      expect(lane.json.lane.owner_seat).toBe('nick');

      // bo authenticates (authTouch marks presence), then tries to take it for himself.
      const grab = await fetch(h.base + `/teams/race/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(boTok) },
        body: JSON.stringify({ owner_seat: 'bo' }),
      });
      expect(grab.status).toBe(409);
      const err = (await grab.json()) as { error?: { message?: string } };
      expect(JSON.stringify(err)).toContain('nick'); // names the incumbent, not just "conflict"

      // and the lane is untouched — a refused claim must not half-apply.
      const after = await get(`/teams/race/lanes`, nickTok);
      const row = (after.json.lanes as { id: string; owner_seat: string }[]).find(
        (l) => l.id === lane.json.lane.id,
      );
      expect(row?.owner_seat).toBe('nick');
    });

    // A handoff is the sanctioned transfer and must keep working — it is distinguishable from a
    // takeover by the one signal the server holds: a claim names YOURSELF, a handoff names someone else.
    it('still allows a handoff to another seat while the owner is live', async () => {
      const team = await post('/teams', { slug: 'hand', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/hand/members', { name: 'bo', kind: 'human' }, nickTok);
      const lane = await post('/teams/hand/lanes', { title: 'passed', claim: true }, nickTok);

      const res = await fetch(h.base + `/teams/hand/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
        body: JSON.stringify({ owner_seat: 'bo' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { lane: { owner_seat: string } }).lane.owner_seat).toBe('bo');
    });

    // The acquisition ledger (ADR 203) exists because the collision could not be reconstructed from
    // the audit log. These pin the rows themselves — the kind/previous_owner shape was previously held
    // only by the code, and the most common acquisition (a lane born owned via {claim:true}) wrote no
    // row at all, so a ledger reconstruction would still have missed the ordinary case.
    it('audits every acquisition edge: open-with-claim, PATCH claim, and handoff', async () => {
      const team = await post('/teams', {
        slug: 'ledger',
        creator: { name: 'nick', kind: 'human' },
      });
      const nickTok = team.json.human_credential;
      await post('/teams/ledger/members', { name: 'bo', kind: 'human' }, nickTok);
      const teamId = (await getTeamBySlug(h.server.store, 'ledger'))!.id;
      const claimedRows = async () =>
        (await listAudit(h.server.store, teamId))
          .filter((r) => r.action === 'lane.claimed')
          .map((r) => ({
            actor: r.actor,
            target: r.target,
            detail: JSON.parse(r.detail!) as {
              kind?: string;
              owner?: string;
              previous_owner?: string | null;
              at_open?: boolean;
            },
          }));

      // Edge 1: born owned — lane_open {claim:true}.
      const born = await post('/teams/ledger/lanes', { title: 'born owned', claim: true }, nickTok);
      const atOpen = (await claimedRows()).find((r) => r.target === born.json.lane.id);
      expect(atOpen).toBeDefined();
      expect(atOpen!.actor).toBe('nick');
      expect(atOpen!.detail.kind).toBe('claim');
      expect(atOpen!.detail.owner).toBe('nick');
      expect(atOpen!.detail.previous_owner ?? null).toBeNull();
      expect(atOpen!.detail.at_open).toBe(true);

      // Edge 2: a PATCH claim of an open lane. First, the non-edge it pairs with: a lane opened
      // WITHOUT claim is not an acquisition and must write nothing — asserted here beside its
      // sibling because a guard tested on one path and not the other is how the birth-edge gap
      // survived #574 in the first place.
      const open = await post('/teams/ledger/lanes', { title: 'left open' }, nickTok);
      expect((await claimedRows()).find((r) => r.target === open.json.lane.id)).toBeUndefined();
      await fetch(h.base + `/teams/ledger/lanes/${open.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
        body: JSON.stringify({ owner_seat: 'nick' }),
      });
      const patchClaim = (await claimedRows()).find((r) => r.target === open.json.lane.id);
      expect(patchClaim?.detail.kind).toBe('claim');
      expect(patchClaim?.detail.previous_owner ?? null).toBeNull();
      expect(patchClaim?.detail.at_open).toBeUndefined();

      // Edge 3: a handoff — same PATCH, distinguished (and recorded) by who the new owner is.
      await fetch(h.base + `/teams/ledger/lanes/${born.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
        body: JSON.stringify({ owner_seat: 'bo' }),
      });
      const handoff = (await claimedRows()).find(
        (r) => r.target === born.json.lane.id && r.detail.kind === 'handoff',
      );
      expect(handoff).toBeDefined();
      expect(handoff!.detail.owner).toBe('bo');
      expect(handoff!.detail.previous_owner).toBe('nick');
      // …and the birth row is still the only OTHER acquisition of that lane — no double-write.
      expect((await claimedRows()).filter((r) => r.target === born.json.lane.id)).toHaveLength(2);
    });

    // ADR 325 prereq: EVERY lane transition leaves a durable row, not just the ownership edges. A
    // branch/scope/title edit wrote nothing at all, and a non-terminal state move (active↔blocked)
    // broadcast to the live stream but left no record — so a lane's history could not be folded
    // back out of the logs, which is exactly what a replicating daemon has to do.
    it('audits field edits and non-terminal state moves (ADR 325 prereq)', async () => {
      const team = await post('/teams', {
        slug: 'ledgr2',
        creator: { name: 'nick', kind: 'human' },
      });
      const nickTok = team.json.human_credential;
      const teamId = (await getTeamBySlug(h.server.store, 'ledgr2'))!.id;
      const rows = async (action: string) =>
        (await listAudit(h.server.store, teamId))
          .filter((r) => r.action === action)
          .map((r) => ({
            target: r.target,
            detail: JSON.parse(r.detail!) as {
              fields?: string[];
              changes?: Record<string, { from: unknown; to: unknown }>;
              from?: string;
              to?: string;
            },
          }));
      const patch = (laneId: string, body: unknown) =>
        fetch(h.base + `/teams/ledgr2/lanes/${laneId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
          body: JSON.stringify(body),
        });

      const lane = await post('/teams/ledgr2/lanes', { title: 'edited', claim: true }, nickTok);
      const id = lane.json.lane.id as string;

      // A field edit writes lane.updated naming exactly what changed.
      await patch(id, { branch: 'nick/branch', detail: 'now with detail' });
      const edit = (await rows('lane.updated')).find((r) => r.target === id);
      expect(edit).toBeDefined();
      expect(edit!.detail.fields?.sort()).toEqual(['branch', 'detail']);
      // …and the values, so a replicating peer can fold the edit rather than only know it happened
      // (lane-replication spec §Finding 3, hole 2).
      expect(edit!.detail.changes).toEqual({
        branch: { from: null, to: 'nick/branch' },
        detail: { from: null, to: 'now with detail' },
      });

      // A no-change patch writes nothing.
      await patch(id, { branch: 'nick/branch' });
      expect((await rows('lane.updated')).filter((r) => r.target === id)).toHaveLength(1);

      // A non-terminal state move writes lane.state_changed with the edge.
      await patch(id, { state: 'active' });
      const move = (await rows('lane.state_changed')).find((r) => r.target === id);
      expect(move).toBeDefined();
      expect(move!.detail.from).toBe('claimed');
      expect(move!.detail.to).toBe('active');

      // The already-audited edges stay single-rowed: a claim is lane.claimed (no state_changed
      // double-write), a release is lane.released only.
      const open = await post('/teams/ledgr2/lanes', { title: 'claim edge' }, nickTok);
      const openId = open.json.lane.id as string;
      await patch(openId, { owner_seat: 'nick' });
      expect((await rows('lane.state_changed')).filter((r) => r.target === openId)).toHaveLength(0);
      await patch(openId, { state: 'open' }); // the release verb
      expect((await rows('lane.state_changed')).filter((r) => r.target === openId)).toHaveLength(0);
      expect(
        (await listAudit(h.server.store, teamId)).filter(
          (r) => r.action === 'lane.released' && r.target === openId,
        ),
      ).toHaveLength(1);
    });

    it('warns inline + wakes the affected owner exactly once; board reflects live state', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential;

      // nick opens + activates a schema lane.
      const l1 = await post(
        '/teams/dawn/lanes',
        {
          title: 'P3.1 schema',
          project: 'musterd',
          scope: ['packages/server/src/store/**'],
          claim: true,
        },
        nickTok,
      );
      expect(l1.status).toBe(201);
      expect(l1.json.warnings).toHaveLength(0);
      await fetch(h.base + `/teams/dawn/lanes/${l1.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
        body: JSON.stringify({ state: 'active' }),
      });

      // bo opens a lane that depends on nick's AND overlaps its surface → two inline warnings.
      const l2 = await post(
        '/teams/dawn/lanes',
        {
          title: 'P3.2 handshake',
          project: 'musterd',
          scope: ['packages/server/**'],
          depends_on: [l1.json.lane.id],
          claim: true,
        },
        boTok,
      );
      expect(l2.status).toBe(201);
      const kinds = l2.json.warnings.map((w: { kind: string }) => w.kind).sort();
      expect(kinds).toEqual(['surface_overlap', 'unmet_dependency']);

      // nick (the affected owner) got a directed [lane] wake for the dependency only — plus bo's
      // lane-open broadcast to the team (ADR 083 §4 extended: open/resolve are board-shape changes).
      // The overlap stays inline and on the board (ADR 575). nick's own l1 open never appears here —
      // the inbox excludes the sender's own acts.
      const inbox = await get('/teams/dawn/inbox?unread=1', nickTok);
      const laneMsgs = inbox.json.messages.filter((m: { body: string }) =>
        m.body.startsWith('[lane]'),
      );
      expect(laneMsgs).toHaveLength(2);
      // Order-independent: the [lane] messages are emitted in one request and can share a millisecond
      // `ts`, so their inbox order falls to the ulid-`id` tiebreak (non-deterministic under load).
      // Assert the multiset instead: one directed dependency warning to nick + one lane-open broadcast.
      const directed = laneMsgs.filter(
        (m: { meta: { lane_warning?: { kind: string } } }) => m.meta.lane_warning,
      );
      expect(
        directed.map((m: { meta: { lane_warning: { kind: string } } }) => m.meta.lane_warning.kind),
      ).toEqual(['unmet_dependency']);
      expect(
        laneMsgs.filter((m: { meta: Record<string, unknown> }) => m.meta.lane_open),
      ).toHaveLength(1);

      // Dedup: an unrelated update to bo's lane does NOT re-send the standing warnings (or a fresh
      // open broadcast — that's a one-time event).
      await fetch(h.base + `/teams/dawn/lanes/${l2.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(boTok) },
        body: JSON.stringify({ detail: 'progress note' }),
      });
      const inbox2 = await get('/teams/dawn/inbox?unread=1', nickTok);
      expect(
        inbox2.json.messages.filter((m: { body: string }) => m.body.startsWith('[lane]')),
      ).toHaveLength(2);

      // Board: both lanes, the pair of warnings annotated (overlap deduped to one).
      const board = await get('/teams/dawn/lanes?project=musterd', boTok);
      expect(board.json.lanes).toHaveLength(2);
      expect(board.json.warnings.length).toBe(2);

      // nick resolves his lane → bo's dependency warning clears from the board.
      await fetch(h.base + `/teams/dawn/lanes/${l1.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
        body: JSON.stringify({ state: 'done' }),
      });
      const board2 = await get('/teams/dawn/lanes', boTok);
      expect(
        board2.json.warnings.filter((w: { kind: string }) => w.kind === 'unmet_dependency'),
      ).toHaveLength(0);
    });

    it('handoff carries the branch to the recipient as a directed act', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential;

      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'BindingSchema', branch: 'agent/riley', claim: true },
        nickTok,
      );
      const handed = await fetch(h.base + `/teams/dawn/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
        body: JSON.stringify({ owner_seat: 'bo' }),
      });
      const handedJson = (await handed.json()) as { lane: { owner_seat: string; branch: string } };
      expect(handedJson.lane.owner_seat).toBe('bo');
      expect(handedJson.lane.branch).toBe('agent/riley');

      // bo's inbox also has nick's lane-open broadcast ahead of the handoff — pick the handoff
      // specifically by its meta rather than the first `[lane]`-prefixed body.
      const inbox = await get('/teams/dawn/inbox?unread=1', boTok);
      const msg = inbox.json.messages.find(
        (m: { meta?: { lane_handoff?: unknown } }) => m.meta?.lane_handoff,
      );
      expect(msg.body).toContain('handed to you');
      expect(msg.body).toContain('agent/riley');
      expect(msg.meta.lane_handoff.branch).toBe('agent/riley');

      // The act NAMES the transfer. This is load-bearing, not cosmetic: `openDirectedLedger` (and so
      // every wake candidate derived from it) matches on `act IN ('request_help','handoff')`, so a
      // handoff that rides as a plain `message` reaches an offline recipient never — which is exactly
      // what the tool description promised and did not deliver (measured 2026-07-29: 10 minutes of
      // host polling, zero leases).
      expect(msg.act).toBe('handoff');
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const ledger = await openDirectedLedger(h.server.store, teamId);
      const entry = ledger.find((d) => d.id === msg.id);
      expect(entry).toBeDefined();
      expect(entry!.recipients.map((r) => r.seat)).toContain('bo');
    });

    // ADR 243. The transfer's own act already names the right lane; what it could not carry was the
    // sender's reason, which is why explaining a handoff took a second act that then mis-derived.
    it('a handoff note rides the transfer act, with the correct lane, and is never stored on the lane', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential;

      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'the attestation gap', branch: 'nick/attestation', claim: true },
        nickTok,
      );
      const handed = await fetch(h.base + `/teams/dawn/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
        body: JSON.stringify({
          owner_seat: 'bo',
          handoff_note: 'the platform half of what I shipped on the surface today',
        }),
      });
      expect(handed.status).toBe(200);
      const handedJson = (await handed.json()) as { lane: { detail: string | null } };
      // The note is a message, not lane state: nothing about the lane's own record changed.
      expect(handedJson.lane.detail).toBeNull();

      const inbox = await get('/teams/dawn/inbox?unread=1', boTok);
      const msg = inbox.json.messages.find(
        (m: { meta?: { lane_handoff?: unknown } }) => m.meta?.lane_handoff,
      );
      expect(msg.act).toBe('handoff');
      expect(msg.body).toContain('the platform half of what I shipped on the surface today');
      // Load-bearing pairing: the why and the lane it is about are in ONE act, which is the whole
      // point — the second act that used to carry the why is the one that derived the wrong lane.
      expect(msg.meta.lane_handoff.lane).toBe(lane.json.lane.id);
    });

    it('a lane-less handoff act after a transfer names the handed lane, not an unrelated held one (ADR 243)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential;

      // The live 2026-08-05 shape: hand one lane over, keep exactly one other. The kept lane is what
      // the old rule attached — confidently, with no warning, because it was the only candidate left.
      const handedLane = await post(
        '/teams/dawn/lanes',
        { title: 'the lane actually handed over', branch: 'nick/handed', claim: true },
        nickTok,
      );
      const keptLane = await post(
        '/teams/dawn/lanes',
        { title: 'my unrelated lane in acceptance', claim: true },
        nickTok,
      );
      await fetch(h.base + `/teams/dawn/lanes/${handedLane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
        body: JSON.stringify({ owner_seat: 'bo' }),
      });

      const sent = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: 'h-241a',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'member', name: 'bo' },
            act: 'handoff',
            body: 'context for the lane I just gave you',
            ts: Date.now(),
          },
        },
        nickTok,
      );
      expect(sent.status).toBe(201);
      expect(sent.json.handoff_lane).toMatchObject({
        lane: handedLane.json.lane.id,
        branch: 'nick/handed',
        source: 'derived',
      });
      expect(sent.json.handoff_lane.lane).not.toBe(keptLane.json.lane.id);
      // Persisted, not just acked — the durable env.meta is what the orientation `why` reads.
      const inbox = await get('/teams/dawn/inbox', boTok);
      const got = inbox.json.messages.find((m: { id: string }) => m.id === 'h-241a');
      expect(got.meta.lane_handoff.lane).toBe(handedLane.json.lane.id);
    });

    it('a surface overlap is not sent to the other owner (ADR 575)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential;
      await post(
        '/teams/dawn/lanes',
        { title: 'store', scope: ['packages/server/src/store/**'], claim: true },
        nickTok,
      );
      const opened = await post(
        '/teams/dawn/lanes',
        { title: 'store too', scope: ['packages/server/src/store/delivery.ts'], claim: true },
        boTok,
      );
      // The actor still sees it inline, and the board still shows it.
      expect(opened.json.warnings.map((w: { kind: string }) => w.kind)).toContain(
        'surface_overlap',
      );
      const inbox = await get('/teams/dawn/inbox?unread=1', nickTok);
      expect(
        inbox.json.messages.filter(
          (m: { meta?: { lane_warning?: { kind?: string } } }) =>
            m.meta?.lane_warning?.kind === 'surface_overlap',
        ),
      ).toHaveLength(0);
    });

    it('a directed lane warning stays a plain message — advisories must never spend a wake', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential;

      // nick claims a lane; bo claims one that builds on it → nick gets the dependency advisory.
      const base = await post('/teams/dawn/lanes', { title: 'store', claim: true }, nickTok);
      await post(
        '/teams/dawn/lanes',
        { title: 'store too', depends_on: [base.json.lane.id], claim: true },
        boTok,
      );

      const inbox = await get('/teams/dawn/inbox?unread=1', nickTok);
      const warn = inbox.json.messages.find(
        (m: { meta?: { lane_warning?: unknown } }) => m.meta?.lane_warning,
      );
      expect(warn).toBeDefined();
      // The regression guard for the two-caller trap: `deliverLaneAct` serves both the handoff and this
      // advisory. Naming the act on the shared helper instead of at the handoff call site would make
      // "someone builds on your lane" wake offline seats — strictly worse than the bug it fixes.
      expect(warn.act).toBe('message');
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      expect((await openDirectedLedger(h.server.store, teamId)).map((d) => d.id)).not.toContain(
        warn.id,
      );
    });

    it('resolving a branch-carrying lane audits git.pr_merged with the attested merge detail (ADR 109)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'ada', kind: 'agent' }, nickTok);
      const ada = { key: team.json.agent_key, seat: 'ada' };

      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'seat attribution', branch: 'feat/seat-git-attribution', claim: true },
        ada,
      );
      await fetch(h.base + `/teams/dawn/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({
          state: 'done',
          merged: { pr: 167, sha: 'abc1234', authorized_by: 'nick', extra: 'stripped-by-schema' },
        }),
      });

      const audit = await get('/teams/dawn/audit', nickTok);
      const row = audit.json.audit.find((r: { action: string }) => r.action === 'git.pr_merged');
      expect(row).toBeDefined();
      expect(row.actor).toBe('ada');
      expect(row.target).toBe('feat/seat-git-attribution');
      const detail = row.detail; // GET /audit returns detail already parsed
      expect(detail).toMatchObject({ pr: 167, sha: 'abc1234', authorized_by: 'nick' });
      expect(detail.extra).toBeUndefined();

      // An abandoned branch-carrying lane does NOT attest a merge.
      const lane2 = await post(
        '/teams/dawn/lanes',
        { title: 'dead end', branch: 'feat/dead-end', claim: true },
        ada,
      );
      await fetch(h.base + `/teams/dawn/lanes/${lane2.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'abandoned' }),
      });
      const audit2 = await get('/teams/dawn/audit', nickTok);
      expect(
        audit2.json.audit.filter((r: { action: string }) => r.action === 'git.pr_merged'),
      ).toHaveLength(1);
    });

    it('surfaces noteless lane transitions: self-claim + non-terminal state move (ADR 102)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const ada = { key: team.json.agent_key, seat: 'ada' };
      await post('/teams/dawn/members', { name: 'ada', kind: 'agent' }, nickTok);
      await get('/teams/dawn/inbox', ada);

      // Open unowned (no claim), then ada claims it — the self-claim is a team-visible transition.
      const lane = await post('/teams/dawn/lanes', { title: 'eviction fix' }, nickTok);
      const laneId = lane.json.lane.id;
      await fetch(h.base + `/teams/dawn/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ owner_seat: 'ada' }),
      });
      // A non-terminal move (active → blocked) is a transition; a terminal move (→ done) is a resolve.
      await fetch(h.base + `/teams/dawn/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'blocked' }),
      });
      await fetch(h.base + `/teams/dawn/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'done' }),
      });

      const stream = await get('/teams/dawn/messages', nickTok);
      const metas = stream.json.messages.map(
        (m: { meta?: Record<string, unknown> }) => m.meta ?? {},
      );
      const claim = metas.find((m: Record<string, unknown>) => m['lane_claim']) as
        | { lane_claim: { lane: string; title: string } }
        | undefined;
      const stateMove = metas.find((m: Record<string, unknown>) => m['lane_state']) as
        | { lane_state: { state: string } }
        | undefined;
      expect(claim?.lane_claim.title).toBe('eviction fix');
      // Only the non-terminal move emits lane_state; the → done move rides lane_resolve, not lane_state.
      expect(stateMove?.lane_state.state).toBe('blocked');
      expect(metas.filter((m: Record<string, unknown>) => m['lane_state']).length).toBe(1);
      expect(metas.some((m: Record<string, unknown>) => m['lane_resolve'])).toBe(true);
    });

    it('goal_id join + GET /next: the orientation brief over lanes + the handoff why (ADR 049/084)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // Ada opens two lanes on one Goal — one active (carrying), one done (shipped).
      const carrying = await post(
        '/teams/dawn/lanes',
        { title: 'spine command', goal_id: 'orientation-spine', claim: true },
        ada,
      );
      expect(carrying.status).toBe(201);
      expect(carrying.json.lane.goal_id).toBe('orientation-spine');
      await fetch(h.base + `/teams/dawn/lanes/${carrying.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'active' }),
      });
      const shipped = await post(
        '/teams/dawn/lanes',
        { title: 'spine migration', goal_id: 'orientation-spine', claim: true },
        ada,
      );
      await fetch(h.base + `/teams/dawn/lanes/${shipped.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'done' }),
      });
      // An unowned lane anyone could pick up.
      await post('/teams/dawn/lanes', { title: 'backlog item' }, nickTok);

      // The goal filter returns only the two joined lanes.
      const byGoal = await get('/teams/dawn/lanes?goal=orientation-spine', ada);
      expect(byGoal.json.lanes).toHaveLength(2);

      // nick hands off to the team with a goal pointer — the brief's why.
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: 'ho1',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'team' },
            act: 'handoff',
            body: 'pick up the orientation spine',
            meta: { goal_id: 'orientation-spine' },
            ts: Date.now(),
          },
        },
        nickTok,
      );

      const brief = await get('/teams/dawn/next', ada);
      expect(brief.status).toBe(200);
      expect(brief.json.member).toBe('Ada');
      expect(brief.json.in_flight.map((l: { id: string }) => l.id)).toEqual([
        carrying.json.lane.id,
      ]);
      expect(brief.json.shipped.map((l: { id: string }) => l.id)).toEqual([shipped.json.lane.id]);
      expect(brief.json.up_next).toHaveLength(1);
      expect(brief.json.why.from).toBe('nick');
      expect(brief.json.why.goal_id).toBe('orientation-spine');
    });

    it('board ?state= filters by lane state; unknown state is a 400 naming the value (lane 01M2R988GK)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      const live = await post('/teams/dawn/lanes', { title: 'live work', claim: true }, ada);
      await req('PATCH', `/teams/dawn/lanes/${live.json.lane.id}`, { state: 'active' }, ada);
      const old = await post('/teams/dawn/lanes', { title: 'old work', claim: true }, ada);
      await req('PATCH', `/teams/dawn/lanes/${old.json.lane.id}`, { state: 'done' }, ada);

      // mine alone returns both — the overflow this lane fixes.
      const mine = await get('/teams/dawn/lanes?mine=1', ada);
      expect(mine.json.lanes).toHaveLength(2);
      // mine + state returns only the live one.
      const filtered = await get('/teams/dawn/lanes?mine=1&state=claimed&state=active', ada);
      expect(filtered.json.lanes.map((l: { id: string }) => l.id)).toEqual([live.json.lane.id]);
      // Unknown state is a 400 naming the value, never a silent empty board.
      const bad = await get('/teams/dawn/lanes?state=bogus', ada);
      expect(bad.status).toBe(400);
      expect(bad.json.error.message).toMatch(/bogus/);
    });

    it('board ?history= accepts only `all`; a just-closed lane is inside the default window (ADR 534)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const closed = await post('/teams/dawn/lanes', { title: 'just shipped', claim: true }, ada);
      await req('PATCH', `/teams/dawn/lanes/${closed.json.lane.id}`, { state: 'done' }, ada);

      const windowed = await get('/teams/dawn/lanes', ada);
      expect(windowed.json.lanes.map((l: { id: string }) => l.id)).toEqual([closed.json.lane.id]);
      const all = await get('/teams/dawn/lanes?history=all', ada);
      expect(all.json.lanes.map((l: { id: string }) => l.id)).toEqual([closed.json.lane.id]);
      const bad = await get('/teams/dawn/lanes?history=forever', ada);
      expect(bad.status).toBe(400);
      expect(bad.json.error.message).toMatch(/forever/);
    });
  });

  describe('source_ref (ADR 561)', () => {
    it('?source_ref= is an exact filter, and a second live lane on one ref is a 409', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const held = await post(
        '/teams/dawn/lanes',
        { title: 'from Linear', source_ref: 'ENG-1' },
        ada,
      );
      expect(held.json.lane.source_ref).toBe('ENG-1');
      await post('/teams/dawn/lanes', { title: 'other', source_ref: 'ENG-10' }, ada);
      await post('/teams/dawn/lanes', { title: 'plain' }, ada);

      const byRef = await get('/teams/dawn/lanes?source_ref=ENG-1', ada);
      expect(byRef.json.lanes.map((l: { id: string }) => l.id)).toEqual([held.json.lane.id]);

      const dup = await post('/teams/dawn/lanes', { title: 'again', source_ref: 'ENG-1' }, ada);
      expect(dup.status).toBe(409);
      expect(dup.json.error.code).toBe('conflict');
      expect(dup.json.error.message).toBe(
        `source_ref "ENG-1" already belongs to lane ${held.json.lane.id}`,
      );
    });
  });

  describe('releasing a lane — open ⟺ unowned', () => {
    async function setup() {
      const team = await post('/teams', { slug: 'dusk', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      await post('/teams/dusk/members', { name: 'ada', kind: 'agent' }, nickTok);
      await post('/teams/dusk/members', { name: 'gee', kind: 'agent' }, nickTok);
      return {
        nickTok,
        ada: { key: team.json.agent_key, seat: 'ada' } as Auth,
        gee: { key: team.json.agent_key, seat: 'gee' } as Auth,
      };
    }
    async function patchLane(id: string, body: unknown, auth: Auth) {
      const resolvedAuth = await resolveAuth('/teams/dusk/lanes', auth);
      const r = await fetch(h.base + `/teams/dusk/lanes/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(resolvedAuth) },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    }

    it('parking an owned lane releases it, audits who let go, and stops it contending', async () => {
      const { nickTok, ada, gee } = await setup();
      // gee holds an overlapping surface, so the board has something to contend with.
      await post(
        '/teams/dusk/lanes',
        { title: 'geeʼs work', scope: ['packages/server/**'], claim: true },
        gee,
      );
      const mine = await post(
        '/teams/dusk/lanes',
        { title: 'parked work', scope: ['packages/server/src/store/**'], claim: true },
        ada,
      );
      const id = mine.json.lane.id as string;
      expect(mine.json.warnings.some((w: any) => w.kind === 'surface_overlap')).toBe(true);

      const released = await patchLane(id, { state: 'open' }, ada);
      expect(released.json.lane.state).toBe('open');
      expect(released.json.lane.owner_seat).toBeNull();
      expect(released.json.lane.claimed_at).toBeNull();
      expect(released.json.warnings).toHaveLength(0); // open lanes do not contend

      const audit = await get('/teams/dusk/audit', nickTok);
      const rows = (audit.json.audit as { action: string; detail: any; actor: string }[]).filter(
        (a) => a.action === 'lane.released',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe('ada');
      expect(rows[0].detail.owner_before).toBe('ada');
    });

    it('a released lane is claimable by another seat — release never fences it off', async () => {
      const { ada, gee } = await setup();
      const mine = await post('/teams/dusk/lanes', { title: 'up for grabs', claim: true }, ada);
      const id = mine.json.lane.id as string;
      await patchLane(id, { state: 'open' }, ada);

      const taken = await patchLane(id, { owner_seat: 'gee' }, gee);
      expect(taken.status).toBe(200);
      expect(taken.json.lane.state).toBe('claimed');
      expect(taken.json.lane.owner_seat).toBe('gee');
      expect(taken.json.lane.claimed_at).not.toBeNull();
    });

    it('an already-open lane is untouched — no spurious release audit', async () => {
      const { nickTok, ada } = await setup();
      const lane = await post('/teams/dusk/lanes', { title: 'never claimed' }, ada);
      expect(lane.json.lane.owner_seat).toBeNull();
      await patchLane(lane.json.lane.id, { detail: 'just a note' }, ada);

      const audit = await get('/teams/dusk/audit', nickTok);
      const rows = (audit.json.audit as { action: string }[]).filter(
        (a) => a.action === 'lane.released',
      );
      expect(rows).toHaveLength(0);
    });
  });
});
