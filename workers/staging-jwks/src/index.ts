/**
 * The staging console JWKS (see ../wrangler.toml). One route, one static body: `GET /jwks` answers
 * the public key set; everything else is 404. Cached briefly so a key rotation reaches servers
 * within their own refetch window (`JWKS_REFETCH_MS` in packages/server/src/cloud/consoleToken.ts).
 */
// eslint-disable-next-line import/no-default-export -- the Workers runtime requires a default export
export default {
  fetch(request: Request, env: { JWKS: string }): Response {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/jwks') {
      return new Response('not found', { status: 404 });
    }
    return new Response(env.JWKS, {
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' },
    });
  },
};
