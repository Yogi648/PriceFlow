const BACKEND_KEY = 'backend.csv';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Filename, X-Backend-Count',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

function authorized(request, env) {
  if (!env.STORAGE_API_KEY) return true;
  return request.headers.get('Authorization') === `Bearer ${env.STORAGE_API_KEY}`;
}

async function countCsvRows(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let quoted = false;
  let rows = 0;
  let pendingQuote = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const character of value) {
      if (character === '"') {
        if (pendingQuote) pendingQuote = false;
        else pendingQuote = true;
      } else {
        if (pendingQuote) {
          quoted = !quoted;
          pendingQuote = false;
        }
        if (character === '\n' && !quoted) rows++;
      }
    }
  }
  if (pendingQuote) quoted = !quoted;
  return Math.max(0, rows - 1);
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401, env);

    const url = new URL(request.url);
    if (url.pathname === '/backend/count' && request.method === 'GET') {
      const count = await env.BACKEND_META.get('count');
      return json({ count: Number(count || 0) }, 200, env);
    }

    if (url.pathname === '/backend/import' && request.method === 'POST') {
      if (!request.body) return json({ error: 'Request body is required' }, 400, env);
      const [uploadStream, scanStream] = request.body.tee();
      const countPromise = countCsvRows(scanStream);
      const [count] = await Promise.all([
        countPromise,
        env.BACKEND_BUCKET.put(BACKEND_KEY, uploadStream, {
        httpMetadata: { contentType: request.headers.get('Content-Type') || 'text/csv' },
        customMetadata: { filename: request.headers.get('X-Filename') || 'backend.csv' }
        })
      ]);
      await env.BACKEND_META.put('count', String(count));
      return json({ count }, 200, env);
    }

    if (url.pathname === '/backend/export' && request.method === 'GET') {
      const object = await env.BACKEND_BUCKET.get(BACKEND_KEY);
      if (!object) return json({ error: 'No backend file has been uploaded' }, 404, env);
      const responseHeaders = new Headers(headers);
      responseHeaders.set('Content-Type', object.httpMetadata?.contentType || 'text/csv');
      responseHeaders.set('Content-Disposition', 'attachment; filename="PriceFlow_Backend_Database.csv"');
      return new Response(object.body, { headers: responseHeaders });
    }

    return json({ error: 'Not found' }, 404, env);
  }
};
