const BACKEND_KEY = 'backend.csv';
const PRICE_HISTORY_PREFIX = 'price-history/';

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
  let lineHasContent = false;
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
        if (character === '\n' && !quoted) {
          rows += 1;
          lineHasContent = false;
        } else if (character !== '\r') {
          lineHasContent = true;
        }
      }
    }
  }
  if (pendingQuote) quoted = !quoted;
  if (lineHasContent) rows += 1;
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

    if (url.pathname === '/price-history' && request.method === 'GET') {
      const snapshots = [];
      let cursor;
      do {
        const page = await env.BACKEND_BUCKET.list({ prefix: PRICE_HISTORY_PREFIX, cursor, limit: 1000 });
        for (const entry of page.objects) {
          const object = await env.BACKEND_BUCKET.get(entry.key);
          if (object) snapshots.push(await object.json());
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      snapshots.sort((a, b) => a.date.localeCompare(b.date));
      return json({ snapshots }, 200, env);
    }

    if (url.pathname === '/price-history' && request.method === 'POST') {
      let payload;
      try { payload = await request.json(); }
      catch { return json({ error: 'A JSON snapshot is required' }, 400, env); }
      const date = String(payload?.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(payload?.rows)) {
        return json({ error: 'Snapshot date and rows are required' }, 400, env);
      }
      const rows = payload.rows.filter(row => row && String(row.ASIN || '').trim() && row.PRICE !== '' && row.PRICE !== null && row.PRICE !== undefined && Number.isFinite(Number(row.PRICE)));
      if (!rows.length) return json({ error: 'Snapshot contains no valid ASIN prices' }, 400, env);
      const snapshot = { date, rows };
      await env.BACKEND_BUCKET.put(`${PRICE_HISTORY_PREFIX}${date}.json`, JSON.stringify(snapshot), {
        httpMetadata: { contentType: 'application/json' }
      });
      return json({ date, count: rows.length }, 200, env);
    }

    return json({ error: 'Not found' }, 404, env);
  }
};
