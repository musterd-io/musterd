import { describe, expect, it } from 'vitest';
import {
  OAuthAuthorizationServerMetadataSchema,
  OAuthAuthorizeConfirmSchema,
  OAuthAuthorizeQuerySchema,
  OAuthClientMetadataSchema,
  OAuthClientRegistrationRequestSchema,
  OAuthTokenRequestSchema,
} from './oauth.js';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const query = {
  response_type: 'code',
  client_id: 'cid_1',
  redirect_uri: 'https://app.example/cb',
  state: 's',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
} as const;

describe('oauth schemas (ADR 446)', () => {
  it('CIMD accepts public auth in either auth-method field and strips unused metadata (ADR 470)', () => {
    const chatgpt = {
      client_id: 'https://chatgpt.com/oauth/client.json',
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
      token_endpoint_auth_signing_alg: 'RS256',
      unrecognized: 'ignored',
    };
    const parsed = OAuthClientMetadataSchema.safeParse(chatgpt);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.token_endpoint_auth_method).toBe('private_key_jwt');
      expect(parsed.data.token_endpoint_auth_methods_supported).toEqual([
        'none',
        'private_key_jwt',
      ]);
      expect(parsed.data).not.toHaveProperty('jwks_uri');
      expect(parsed.data).not.toHaveProperty('unrecognized');
    }

    const claude = {
      client_id: 'https://claude.ai/oauth/client.json',
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    expect(OAuthClientMetadataSchema.safeParse(claude).success).toBe(true);
  });

  it('CIMD requires identity, redirect, grants, code response, and public auth (ADR 470)', () => {
    const base = {
      client_id: 'https://client.example/oauth/client.json',
      client_name: 'Client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    const accepted = (patch: Record<string, unknown>) =>
      OAuthClientMetadataSchema.safeParse({ ...base, ...patch }).success;

    expect(accepted({})).toBe(true);
    expect(accepted({ client_id: '' })).toBe(false);
    expect(accepted({ client_name: '' })).toBe(false);
    expect(accepted({ client_name: 'x'.repeat(201) })).toBe(false);
    expect(accepted({ redirect_uris: [] })).toBe(false);
    expect(accepted({ redirect_uris: [''] })).toBe(false);
    expect(accepted({ grant_types: ['authorization_code'] })).toBe(false);
    expect(accepted({ response_types: ['token'] })).toBe(false);
    expect(accepted({ token_endpoint_auth_method: 'private_key_jwt' })).toBe(false);
    expect(
      accepted({
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
      }),
    ).toBe(false);
    expect(
      accepted({
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['none'],
      }),
    ).toBe(true);
  });

  it('authorization-server metadata declares CIMD support while retaining DCR (ADR 470)', () => {
    const metadata = OAuthAuthorizationServerMetadataSchema.parse({
      issuer: 'https://musterd.example/oauth/demo',
      authorization_endpoint: 'https://musterd.example/oauth/demo/authorize',
      token_endpoint: 'https://musterd.example/oauth/demo/token',
      registration_endpoint: 'https://musterd.example/oauth/demo/register',
      revocation_endpoint: 'https://musterd.example/oauth/demo/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    });
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.registration_endpoint).toBe('https://musterd.example/oauth/demo/register');
  });

  it('authorize query requires PKCE S256 — plain and none are refused', () => {
    expect(OAuthAuthorizeQuerySchema.safeParse(query).success).toBe(true);
    expect(
      OAuthAuthorizeQuerySchema.safeParse({ ...query, code_challenge_method: 'plain' }).success,
    ).toBe(false);
    expect(
      OAuthAuthorizeQuerySchema.safeParse({ ...query, code_challenge_method: 'none' }).success,
    ).toBe(false);
  });

  it('authorize confirm requires an mscr_ proof — nothing else rides the seam', () => {
    const base = {
      client_id: 'cid_1',
      redirect_uri: 'https://app.example/cb',
      state: 's',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    } as const;
    expect(
      OAuthAuthorizeConfirmSchema.safeParse({
        ...base,
        proof: { kind: 'credential', credential: 'mscr_x', member: 'nick' },
      }).success,
    ).toBe(true);
    expect(
      OAuthAuthorizeConfirmSchema.safeParse({
        ...base,
        proof: { kind: 'credential', credential: 'mskey_x' },
      }).success,
    ).toBe(false);
  });

  it('agent_connect carries a nonce only — a credential in that arm is refused (ADR 452 §1)', () => {
    const base = {
      client_id: 'cid_1',
      redirect_uri: 'https://app.example/cb',
      state: 's',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    } as const;
    const nonce = 'A'.repeat(43);
    const ok = (value: string) =>
      OAuthAuthorizeConfirmSchema.safeParse({
        ...base,
        proof: { kind: 'agent_connect', nonce: value },
      }).success;
    expect(ok(nonce)).toBe(true);
    expect(ok(`n=${nonce}`)).toBe(true);
    expect(ok(`https://host/join/dawn#n=${nonce}`)).toBe(true);
    // Every musterd secret prefix is refused, even padded past the length floor.
    for (const cred of ['mscr_', 'msac_', 'mskey_', 'msat_', 'msrt_', 'mskd_'])
      expect(ok(cred + 'x'.repeat(60))).toBe(false);
    expect(ok('short')).toBe(false);
    // A credential anywhere in a pasted link — query, fragment, or loose text — is refused too.
    expect(ok(`https://host/join/dawn?t=mscr_synthetic#n=${nonce}`)).toBe(false);
    expect(ok(`https://host/join/dawn#n=${nonce}&k=msac_synthetic`)).toBe(false);
    expect(ok(`n=${nonce} msat_synthetic`)).toBe(false);
    expect(
      OAuthAuthorizeConfirmSchema.safeParse({
        ...base,
        proof: { kind: 'agent_connect', nonce, credential: 'mscr_x' },
      }).success,
    ).toBe(false);
  });

  it('PKCE entropy (RFC 7636): short verifiers and malformed challenges refused', () => {
    expect(OAuthAuthorizeQuerySchema.safeParse({ ...query, code_challenge: 'short' }).success).toBe(
      false,
    );
    expect(
      OAuthAuthorizeQuerySchema.safeParse({ ...query, code_challenge: 'x'.repeat(44) }).success,
    ).toBe(false);
    const token = {
      grant_type: 'refresh_token',
      refresh_token: 'msrt_x',
      client_id: 'cid_1',
    };
    expect(OAuthTokenRequestSchema.safeParse(token).success).toBe(true);
    const codeGrant = (verifier: string) => ({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://app.example/cb',
      client_id: 'cid_1',
      code_verifier: verifier,
    });
    expect(OAuthTokenRequestSchema.safeParse(codeGrant('x'.repeat(43))).success).toBe(true);
    expect(OAuthTokenRequestSchema.safeParse(codeGrant('short')).success).toBe(false);
    expect(OAuthTokenRequestSchema.safeParse(codeGrant('x'.repeat(129))).success).toBe(false);
    expect(OAuthTokenRequestSchema.safeParse(codeGrant('not unreserved!')).success).toBe(false);
  });

  it('token grant is authorization_code or refresh_token — nothing else', () => {
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: 'https://app.example/cb',
        client_id: 'cid_1',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      }).success,
    ).toBe(true);
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'refresh_token',
        refresh_token: 'msrt_x',
        client_id: 'cid_1',
      }).success,
    ).toBe(true);
    expect(OAuthTokenRequestSchema.safeParse({ grant_type: 'client_credentials' }).success).toBe(
      false,
    );
  });

  it('token and authorize accept an RFC 8707 resource indicator (ADR 457)', () => {
    // MCP auth spec 2025-06-18 §2.8: clients MUST send resource=<MCP endpoint> on both requests.
    // The token arms were .strict() and refused it — sign-in succeeded, exchange 400'd (Rehearsal A).
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: 'https://app.example/cb',
        client_id: 'cid_1',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        resource: 'https://mcp.example/mcp/dawn',
      }).success,
    ).toBe(true);
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'refresh_token',
        refresh_token: 'msrt_x',
        client_id: 'cid_1',
        resource: 'https://mcp.example/mcp/dawn',
      }).success,
    ).toBe(true);
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'refresh_token',
        refresh_token: 'msrt_x',
        client_id: 'cid_1',
        resource: 'not a url',
      }).success,
    ).toBe(false);
    expect(
      OAuthAuthorizeQuerySchema.safeParse({
        response_type: 'code',
        client_id: 'cid_1',
        redirect_uri: 'https://app.example/cb',
        state: 's',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        resource: 'https://mcp.example/mcp/dawn',
      }).success,
    ).toBe(true);
  });

  it('registration requires redirect_uris and a named client', () => {
    expect(
      OAuthClientRegistrationRequestSchema.safeParse({
        redirect_uris: ['https://app.example/cb'],
        client_name: 'Claude',
      }).success,
    ).toBe(true);
    expect(
      OAuthClientRegistrationRequestSchema.safeParse({ redirect_uris: [], client_name: 'x' })
        .success,
    ).toBe(false);
  });

  it('registration accepts the Claude-shaped RFC 7591 body — grant_types/response_types ride along', () => {
    // What the real Claude connector posts (and ChatGPT likewise): the RFC 7591 §2 optional
    // members alongside the required fields. Landed code 400d this ("Unrecognized key(s)"),
    // so no real phone app could register — fifty's #1694 verdict, 2026-09-25.
    const claudeBody = {
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } as const;
    expect(OAuthClientRegistrationRequestSchema.safeParse(claudeBody).success).toBe(true);
  });

  it('registration ignores unknown RFC 7591 members and any auth method (ADR 458)', () => {
    // RFC 7591 §2: unknown metadata MUST be ignored. Rehearsal A (2026-09-26): the Claude iOS app
    // was refused at registration by the strict form — "Couldn't register with demo's sign-in".
    const parsed = OAuthClientRegistrationRequestSchema.safeParse({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude',
      token_endpoint_auth_method: 'client_secret_post',
      contacts: ['a@b.c'],
      software_id: 'x',
      tos_uri: 'https://claude.ai/tos',
      bogus_key: 1,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'bogus_key' in parsed.data).toBe(false);
    expect(parsed.success && parsed.data.token_endpoint_auth_method).toBe('client_secret_post');
  });
});
