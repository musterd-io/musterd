import { describe, expect, it } from 'vitest';
import { fetchArticleText, isPublicHttpsUrl } from './content.ts';

describe('isPublicHttpsUrl', () => {
  it('accepts public HTTPS URLs and rejects unsafe schemes, credentials, and private hosts', () => {
    expect(isPublicHttpsUrl('https://example.org/paper')).toBe(true);
    for (const url of [
      'http://example.org/paper',
      'https://user:pass@example.org/paper',
      'https://localhost/paper',
      'https://service.localhost/paper',
      'https://127.0.0.1/paper',
      'https://10.0.0.2/paper',
      'https://169.254.20.1/paper',
      'https://[::1]/paper',
      'https://[fd00::1]/paper',
    ]) {
      expect(isPublicHttpsUrl(url), url).toBe(false);
    }
  });
});

describe('fetchArticleText', () => {
  const requestedUrl = 'https://example.org/research';

  it('requests full text from Exa and returns a successful non-empty extraction', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchFn = async (url: string, init?: RequestInit) => {
      requestUrl = url;
      requestInit = init;
      return new Response(
        JSON.stringify({
          results: [{ url: requestedUrl, text: 'Full article text.' }],
          statuses: [{ id: requestedUrl, status: 'success' }],
        }),
        { status: 200 },
      );
    };

    const result = await fetchArticleText(requestedUrl, 'exa-test-key', fetchFn);

    expect(requestUrl).toBe('https://api.exa.ai/contents');
    expect(new Headers(requestInit?.headers).get('x-api-key')).toBe('exa-test-key');
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      urls: [requestedUrl],
      text: true,
    });
    expect(result).toEqual({ url: requestedUrl, text: 'Full article text.' });
  });

  it('rejects failed status, empty text, and an unsafe returned URL', async () => {
    await expect(
      fetchArticleText(
        requestedUrl,
        'key',
        async () =>
          new Response(
            JSON.stringify({
              results: [{ url: requestedUrl, text: 'partial' }],
              statuses: [{ id: requestedUrl, status: 'error' }],
            }),
            { status: 200 },
          ),
      ),
    ).rejects.toThrow(/status|error/i);
    await expect(
      fetchArticleText(
        requestedUrl,
        'key',
        async () =>
          new Response(
            JSON.stringify({
              results: [{ url: requestedUrl, text: '  ' }],
              statuses: [{ id: requestedUrl, status: 'success' }],
            }),
            { status: 200 },
          ),
      ),
    ).rejects.toThrow(/empty/i);
    await expect(
      fetchArticleText(
        requestedUrl,
        'key',
        async () =>
          new Response(
            JSON.stringify({
              results: [{ url: 'http://127.0.0.1/private', text: 'text' }],
              statuses: [{ id: requestedUrl, status: 'success' }],
            }),
            { status: 200 },
          ),
      ),
    ).rejects.toThrow(/url/i);
  });

  it('rejects an unsafe submitted URL and non-success HTTP status', async () => {
    const fetchFn = async () => new Response('failure', { status: 503 });
    await expect(fetchArticleText('http://example.org', 'key', fetchFn)).rejects.toThrow(/https/i);
    await expect(fetchArticleText(requestedUrl, 'key', fetchFn)).rejects.toThrow(/503/);
  });

  it('rejects an oversized provider response before parsing it', async () => {
    await expect(
      fetchArticleText(
        requestedUrl,
        'key',
        async () => new Response('{}', { status: 200, headers: { 'content-length': '2000001' } }),
      ),
    ).rejects.toThrow(/size limit/i);
  });

  it.each([
    ['https://huggingface.co/papers/2610.07625', 'https://arxiv.org/pdf/2610.07625'],
    ['https://arxiv.org/abs/2610.13534', 'https://arxiv.org/pdf/2610.13534'],
    ['https://arxiv.org/html/2609.37226v1', 'https://arxiv.org/pdf/2609.37226v1'],
    ['https://arxiv.org/pdf/2303.08774.pdf', 'https://arxiv.org/pdf/2303.08774'],
    ['https://export.arxiv.org/abs/math.GT/0301234v2', 'https://arxiv.org/pdf/math.GT/0301234v2'],
  ])('reads the original paper for %s, retaining its extraction URL', async (landing, target) => {
    const result = await fetchArticleText(landing, 'key', async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ urls: [target], text: true });
      return new Response(
        JSON.stringify({
          results: [{ url: target, text: 'Paper body, methods and results.' }],
          statuses: [{ id: target, status: 'success' }],
        }),
      );
    });
    expect(result.url).toBe(target);
  });

  it('does not accept a provider redirect back to the paper landing page', async () => {
    await expect(
      fetchArticleText(
        'https://huggingface.co/papers/2610.07625',
        'key',
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://arxiv.org/pdf/2610.07625',
                  url: 'https://arxiv.org/abs/2610.07625',
                  text: 'Abstract only.',
                },
              ],
              statuses: [{ id: 'https://arxiv.org/pdf/2610.07625', status: 'success' }],
            }),
          ),
      ),
    ).rejects.toThrow(/landing page/);
  });
});
