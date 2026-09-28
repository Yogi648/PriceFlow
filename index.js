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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some(value => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some(value => value.trim() !== '')) rows.push(row);
  }
  return rows;
}

function mergeBackendCsv(existingText, updateText) {
  const existingRows = parseCsv(existingText);
  const updateRows = parseCsv(updateText);
  if (!updateRows.length) throw new Error('The uploaded CSV is empty');

  const normalizeHeaders = row => row.map(value => {
    const header = value.replace(/^\uFEFF/, '').trim();
    return ['ASIN', 'ASIN1', 'PRODUCT ID'].includes(header.toUpperCase()) ? 'ASIN' : header;
  });
  const existingHeaders = normalizeHeaders(existingRows[0] || []);
  const updateHeaders = normalizeHeaders(updateRows[0]);
  const findAsinIndex = headers => headers.findIndex(header =>
    ['ASIN', 'ASIN1', 'PRODUCT ID'].includes(header.toUpperCase())
  );
  const existingAsinIndex = findAsinIndex(existingHeaders);
  const updateAsinIndex = findAsinIndex(updateHeaders);
  if (updateAsinIndex < 0) throw new Error('The uploaded CSV must include an ASIN column');
  if (existingRows.length && existingAsinIndex < 0) {
    throw new Error('The saved backend CSV has no ASIN column');
  }

  const headers = [...existingHeaders];
  const headerKeys = new Map(headers.map(header => [header.toUpperCase(), header]));
  for (const header of updateHeaders) {
    if (!headerKeys.has(header.toUpperCase())) {
      headers.push(header);
      headerKeys.set(header.toUpperCase(), header);
    }
  }

  const records = new Map();
  const addRows = (rows, sourceHeaders, isUpdate) => {
    const asinIndex = findAsinIndex(sourceHeaders);
    for (const values of rows) {
      const asin = String(values[asinIndex] || '').trim().toUpperCase();
      if (!asin) continue;
      const record = isUpdate ? { ...(records.get(asin) || {}) } : {};
      sourceHeaders.forEach((header, index) => {
        record[headerKeys.get(header.toUpperCase())] = values[index] || '';
      });
      record[headerKeys.get(sourceHeaders[asinIndex].toUpperCase())] = asin;
      records.set(asin, record);
    }
  };

  if (existingRows.length) addRows(existingRows.slice(1), existingHeaders, false);
  addRows(updateRows.slice(1), updateHeaders, true);

  const escapeCsv = value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = [headers, ...[...records.values()].map(record => headers.map(header => record[header] || ''))]
    .map(row => row.map(escapeCsv).join(','))
    .join('\r\n');
  const updatedAsins = updateRows.slice(1).reduce((asins, values) => {
    const asin = String(values[updateAsinIndex] || '').trim().toUpperCase();
    if (asin) asins.add(asin);
    return asins;
  }, new Set());
  const existingAsins = new Set(existingRows.slice(1).map(values =>
    String(values[existingAsinIndex] || '').trim().toUpperCase()
  ).filter(Boolean));
  const newAsins = [...updatedAsins].filter(asin => !existingAsins.has(asin)).length;
  return { csv, count: records.size, newAsins, updatedAsins: updatedAsins.size - newAsins };
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
      try {
        const [existingObject, updateText] = await Promise.all([
          env.BACKEND_BUCKET.get(BACKEND_KEY),
          request.text()
        ]);
        const merged = mergeBackendCsv(existingObject ? await existingObject.text() : '', updateText);
        await env.BACKEND_BUCKET.put(BACKEND_KEY, merged.csv, {
          httpMetadata: { contentType: 'text/csv' },
          customMetadata: { filename: request.headers.get('X-Filename') || 'backend.csv' }
        });
        await env.BACKEND_META.put('count', String(merged.count));
        return json({ count: merged.count, newAsins: merged.newAsins, updatedAsins: merged.updatedAsins }, 200, env);
      } catch (error) {
        return json({ error: error.message || 'Unable to merge backend CSV' }, 400, env);
      }
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
