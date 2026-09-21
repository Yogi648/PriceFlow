/* PriceFlow daily processor.
   Processing order:
   1) All Listings -> FBA / Local Shops
   2) Price Update -> FBA Removed
   3) Remaining -> Local Shops Removed
   4) Remaining Migrated ASINs -> Warehouse Qty > 0 Removed
   5) Remaining -> 48-hour last-update check
   6) Eligible rows -> pricing formula
*/
const TARGET_PROFIT = 150;
const SPECIAL_RATE = 0.10;
const STANDARD_RATE = 0.05;
const SPECIAL_WORDS = [
  'ssd','solid state drive','nvme','m.2','motherboard','mainboard',
  ' ram ','memory','ddr3','ddr4','ddr5'
];


/* ------------------------------------------------------------------
   SHARED BACKEND STORAGE
   PriceFlow keeps IndexedDB as a local fallback, but uses Supabase
   when a public anon key is configured. Never put a service-role key
   in this file.
------------------------------------------------------------------- */
const SUPABASE_URL = window.PRICEFLOW_SUPABASE_URL || 'https://fbeizcukqclltfclzi.supabase.co';
const SUPABASE_ANON_KEY = window.PRICEFLOW_SUPABASE_ANON_KEY || '';

let supabaseClient = null;
let supabaseReady = false;

async function initSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) return false;
  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { error } = await supabaseClient.from('backend_asins').select('asin', { count: 'exact', head: true });
    if (error) throw error;
    supabaseReady = true;
    return true;
  } catch (e) {
    console.warn('Supabase connection failed:', e);
    supabaseClient = null;
    supabaseReady = false;
    return false;
  }
}

async function loadBackendFromSupabase() {
  if (!supabaseReady) return null;
  const { data, error } = await supabaseClient
    .from('backend_asins')
    .select('asin,sku,weight,ref_fee,brand,restriction_type,updated_at')
    .order('asin', { ascending: true });
  if (error) throw error;
  return (data || []).map(r => ({
    Asin: asin(r.asin), Sku: clean(r.sku), Weight: num(r.weight), RefFee: num(r.ref_fee),
    Brand: clean(r.brand), RestrictionType: clean(r.restriction_type),
    updatedAt: r.updated_at || new Date().toISOString()
  }));
}

async function saveBackendToSupabase(records) {
  if (!supabaseReady) return false;
  const rows = records.map(r => ({
    asin: asin(r.Asin || r.ASIN || r.asin),
    sku: clean(r.Sku || r.SKU || r.sku),
    weight: num(r.Weight ?? r.weight),
    ref_fee: num(r.RefFee ?? r.ref_fee ?? r['Ref fee'] ?? r['Ref Fee']),
    brand: clean(r.Brand || r.brand),
    restriction_type: clean(r.RestrictionType || r.restriction_type),
    updated_at: new Date().toISOString()
  })).filter(r => r.asin);
  for (let i=0; i<rows.length; i+=500) {
    const chunk=rows.slice(i,i+500);
    const {error}=await supabaseClient.from('backend_asins').upsert(chunk,{onConflict:'asin'});
    if(error) throw error;
    const history=chunk.map(r=>({asin:r.asin,sku:r.sku,weight:r.weight,ref_fee:r.ref_fee,brand:r.brand,restriction_type:r.restriction_type}));
    const {error:he}=await supabaseClient.from('backend_history').insert(history);
    if(he) throw he;
  }
  return true;
}

async function savePriceHistoryToSupabase(history) {
  if (!supabaseReady) return false;
  const rows=Object.entries(history).filter(([a,r])=>a&&r&&Number.isFinite(Number(r.price))).map(([a,r])=>({asin:a,observed_price:Number(r.price),recorded_at:r.updatedAt||new Date().toISOString()}));
  for(let i=0;i<rows.length;i+=500){ const {error}=await supabaseClient.from('price_history').insert(rows.slice(i,i+500)); if(error) throw error; }
  return true;
}
function backendStorageLabel(){ return supabaseReady ? 'Supabase shared storage' : 'Browser storage'; }
function updateBackendUI(message) {
  const badge = document.querySelector('#backend .backend-actions em');
  const note = document.querySelector('#backend .backend-note');
  const count = document.querySelector('#backendCountValue');
  if (count) count.textContent = state.backend.length.toLocaleString();
  if (badge) badge.textContent = supabaseReady ? '● Supabase Synced' : '● Local Backup';
  if (note) note.textContent = message || (state.backend.length
    ? `${state.backend.length.toLocaleString()} ASINs available · ${backendStorageLabel()}.`
    : 'No backend data is saved yet. Upload the backend database first.');
}

const state = {
  listings: [],
  pricing: [],
  warehouse: [],
  backend: [],
  history: {},
  results: {},
  hydrated: false
};

const $ = id => document.getElementById(id);
const clean = v => String(v ?? '').trim();
const asin = v => clean(v).toUpperCase();
const num = v => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('priceflow-store', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('data');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function getSaved(key, fallback) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('data', 'readonly').objectStore('data').get(key);
    r.onsuccess = () => resolve(r.result ?? fallback);
    r.onerror = () => reject(r.error);
  });
}

async function saveSaved(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('data', 'readwrite').objectStore('data').put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function hydrate() {
  if (state.hydrated) return;
  state.backend = await getSaved('backend', []);
  state.history = await getSaved('history', {});
  await initSupabase();
  if (supabaseReady) {
    try {
      const remoteBackend = await loadBackendFromSupabase();
      if (Array.isArray(remoteBackend)) {
        // Supabase is authoritative only when it actually contains records.
        // This prevents a temporary/empty remote response from wiping a valid local backup.
        if (remoteBackend.length > 0 || state.backend.length === 0) {
          state.backend = remoteBackend;
          await saveSaved('backend', state.backend);
        }
      }
    } catch (e) { console.warn('Could not hydrate backend from Supabase:', e); }
  }
  state.hydrated = true;
}

function parseDelimited(text, delim = ',') {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && q && n === '"') { cell += '"'; i++; }
    else if (c === '"') q = !q;
    else if (c === delim && !q) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !q) {
      if (c === '\r' && n === '\n') i++;
      row.push(cell);
      if (row.some(x => clean(x))) rows.push(row);
      row = []; cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => clean(x))) rows.push(row);
  return rows;
}

function objects(rows, headerAt = 0) {
  if (!rows.length || !rows[headerAt]) return [];
  const h = rows[headerAt].map(clean);
  return rows.slice(headerAt + 1)
    .filter(r => r.some(x => clean(x)))
    .map(r => Object.fromEntries(h.map((k, i) => [k, clean(r[i])])));
}

async function readFile(file, type) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  }

  const text = await file.text();
  const delim = lower.endsWith('.txt') || lower.endsWith('.tsv') ? '\t' : ',';
  const rows = parseDelimited(text, delim);
  const headerAt = type === 'pricing'
    ? Math.max(0, rows.findIndex(r =>
        r.map(x => clean(x).toLowerCase()).includes('asin')
      ))
    : 0;
  return objects(rows, headerAt);
}

function fileName(id) {
  const f = $(id).files[0];
  return f ? f.name : 'No file chosen';
}

['listingsFile','pricingFile','warehouseFile','backendFile'].forEach(id => {
  $(id).addEventListener('change', () => {
    $('status').textContent =
      `Ready: ${fileName('listingsFile')} | ${fileName('pricingFile')} | ` +
      `${fileName('warehouseFile')} | ${fileName('backendFile')}`;
  });
});

function latestBackend(records) {
  const map = new Map();
  records.forEach(r => {
    const key = asin(r.Asin || r.ASIN || r.asin);
    if (!key) return;
    map.set(key, {
      Asin: key,
      Sku: clean(r.Sku || r.SKU || r.sku),
      Weight: num(r.Weight || r.weight),
      RefFee: num(r['Ref fee'] || r['Ref Fee'] || r['ref fee%'] || r.refFee),
      Brand: clean(r.Brand || r.brand),
      RestrictionType: clean(r.RestrictionType || r.restrictionType),
      updatedAt: clean(r.updatedAt) || new Date().toISOString()
    });
  });
  return map;
}

function special(title) {
  const s = ` ${clean(title).toLowerCase()} `;
  return SPECIAL_WORDS.some(w => s.includes(w));
}

/* Convert common date formats to a real Date.
   Supports:
   dd/mm/yyyy [hh:mm:ss]
   dd-mm-yyyy [hh:mm:ss]
   yyyy-mm-dd [hh:mm:ss]
   ISO date/time strings
*/
function parseDateTime(value) {
  const s = clean(value);
  if (!s) return null;

  let m = s.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const d = new Date(
      Number(m[3]),
      Number(m[2]) - 1,
      Number(m[1]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0)
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }

  m = s.match(
    /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0)
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* TRUE only when the last update is at least 48 hours old. */
function olderThan48Hours(value) {
  const updated = parseDateTime(value);
  if (!updated) return false;
  return (Date.now() - updated.getTime()) >= 48 * 60 * 60 * 1000;
}

function formatAgeHours(value) {
  const updated = parseDateTime(value);
  if (!updated) return '';
  return Math.max(0, (Date.now() - updated.getTime()) / 3600000).toFixed(1);
}

function getListingASIN(l) {
  return asin(l.asin1 || l.ASIN || l.Asin || l.asin);
}

function getListingSKU(l) {
  return clean(l['seller-sku'] || l.SKU || l.sku || l.SellerSKU);
}

function isFBAListing(l) {
  return clean(l['fulfillment-channel']).toUpperCase() === 'AMAZON_IN';
}

function isLocalShopListing(l) {
  /* In the Amazon All Listings report, non-AMAZON_IN listings are treated
     as Local Shops for this workflow. */
  return !isFBAListing(l);
}

function getPricingASIN(p) {
  return asin(p.Asin || p.ASIN || p.asin);
}

function getPricingLastUpdate(p) {
  return clean(
    p['Last Update'] ||
    p['LastUpdate'] ||
    p['Last update'] ||
    p.last_update ||
    p.lastUpdate ||
    p.updatedAt ||
    p['Updated At']
  );
}

function getPricingNewPrice(p) {
  return num(p.new_price ?? p.NewPrice ?? p['New Price'] ?? p.price ?? p.Price);
}

function getWarehouseASIN(r) {
  return asin(r.ASIN || r.Asin || r.asin);
}

function getWarehouseSKU(r) {
  return clean(r.SKU || r.Sku || r.sku || r['seller-sku']);
}

function getWarehouseQty(r) {
  return num(r.Qty ?? r.qty ?? r.Quantity ?? r.quantity);
}

function priceRow(p, l, b) {
  const cost = Math.round(getPricingNewPrice(p));
  const weight = b?.Weight;
  const ref = b?.RefFee;
  const rate = special(l['item-name']) ? SPECIAL_RATE : STANDARD_RATE;

  if (cost === null || weight === null || ref === null) return null;

  const denominator = 1 / 1.18 - ref / 100 - rate;
  if (denominator <= 0) return null;

  // Existing PriceFlow formula retained:
  // profit = sale/1.18 - Amazon fees - US price*97*1.2
  //          - weight*5*97 - weight*200 - sale*rate
  const min = (
    TARGET_PROFIT +
    cost * 97 * 1.2 +
    weight * 5 * 97 +
    weight * 200
  ) / denominator;

  const sale = min * 1.06;
  const max = sale * 1.07;
  const mrp = sale * 1.35;

  return {
    sku: getListingSKU(l),
    qty: clean(l.quantity),
    lead_time_to_ship: '10',
    sale_price: sale.toFixed(2),
    mrp: mrp.toFixed(2),
    min: min.toFixed(2),
    max: max.toFixed(2),
    b2b_price: '',
    Asin: getPricingASIN(p),
    title: clean(l['item-name']),
    rule: rate === SPECIAL_RATE ? '10% category' : '5% standard',
    profit: TARGET_PROFIT.toFixed(2),
    LastUpdate: getPricingLastUpdate(p)
  };
}

async function process() {
  /* ---------------------------------------------------------------
     1) ALL LISTINGS
        FBA = fulfillment-channel AMAZON_IN.
        Local Shops = the ASINs that have ACTIVE warehouse stock.
        We still retain the All Listings non-FBA rows as listing
        reference so warehouse stock can be validated against them.
     --------------------------------------------------------------- */
  const fbaByAsin = new Map();
  const allNonFbaByAsin = new Map();
  const fba = [];

  state.listings.forEach(l => {
    const a = getListingASIN(l);
    if (!a) return;

    const row = { ...l, Asin: a, Sku: getListingSKU(l) };

    if (isFBAListing(l)) {
      fba.push(row);
      if (!fbaByAsin.has(a)) fbaByAsin.set(a, row);
    } else if (!allNonFbaByAsin.has(a)) {
      allNonFbaByAsin.set(a, row);
    }
  });

  /* ---------------------------------------------------------------
     2) WAREHOUSE
        Qty = 0 / blank / invalid => completely ignored.
        Qty > 0 => ACTIVE LOCAL SHOP ASIN.
     --------------------------------------------------------------- */
  const warehouseByAsin = new Map();

  state.warehouse.forEach(r => {
    const a = getWarehouseASIN(r);
    const q = getWarehouseQty(r);

    if (!a || q === null || q <= 0) return;

    warehouseByAsin.set(a, {
      ...r,
      Asin: a,
      Sku: getWarehouseSKU(r),
      Qty: q
    });
  });

  /* LOCAL SHOP ASINS = active warehouse ASINs.
     Show listing details when available and warehouse details always. */
  const local = [...warehouseByAsin.entries()].map(([a, w]) => {
    const l = allNonFbaByAsin.get(a);
    return {
      Asin: a,
      Sku: w.Sku || (l ? getListingSKU(l) : ''),
      Qty: w.Qty,
      FulfillmentChannel: l ? clean(l['fulfillment-channel']) : '',
      ListingFound: l ? 'Yes' : 'No',
      Status: l ? 'Local Shop / Warehouse Stock' : 'Warehouse Stock - Missing from All Listings'
    };
  });

  /* ---------------------------------------------------------------
     3) WAREHOUSE EXCEPTIONS
        Warehouse Qty > 0 but ASIN is not present in All Listings
        as a non-FBA / Local Shops listing.
     --------------------------------------------------------------- */
  const warehouseEx = [];

  warehouseByAsin.forEach((r, a) => {
    if (!allNonFbaByAsin.has(a)) {
      warehouseEx.push({
        Asin: a,
        Sku: r.Sku,
        Qty: r.Qty,
        Reason: 'Warehouse stock > 0 but ASIN not found in Local Shops / non-FBA All Listings',
        DetectedDate: new Date().toLocaleString()
      });
    }
  });

  const backendMap = latestBackend(state.backend);

  const fbaRemoved = [];
  const localRemoved = [];
  const warehouseRemoved = [];
  const skipped48 = [];
  const unrun = [];
  const missing = [];
  const alerts = [];
  const output = [];

  /* ---------------------------------------------------------------
     4) PRICE UPDATE PROCESSING
        A. FBA -> remove
        B. Active Warehouse/Local Shop -> remove
        C. Remaining migrated ASINs -> 48-hour check
        D. >=48 hours -> calculate/update
     --------------------------------------------------------------- */
  state.pricing.forEach(p => {
    const a = getPricingASIN(p);
    if (!a) return;

    const pricingSku = clean(
      p.SKU || p.sku || p['seller-sku'] || p.SellerSKU
    );

    // A) FBA first.
    if (fbaByAsin.has(a)) {
      const l = fbaByAsin.get(a);
      fbaRemoved.push({
        Asin: a,
        Sku: getListingSKU(l) || pricingSku,
        Reason: 'Matched FBA ASIN - removed from price update'
      });
      return;
    }

    // B) Active warehouse ASIN = Local Shop ASIN.
    //    It must not be price-updated from the migrated template.
    if (warehouseByAsin.has(a)) {
      const w = warehouseByAsin.get(a);
      const l = allNonFbaByAsin.get(a);

      localRemoved.push({
        Asin: a,
        Sku: w.Sku || (l ? getListingSKU(l) : pricingSku),
        Qty: w.Qty,
        Reason: 'Warehouse stock > 0 - treated as Local Shop ASIN and removed from price update'
      });
      return;
    }

    /* -------------------------------------------------------------
       C) Remaining ASIN = migrated ASIN.
          Only these reach the 48-hour rule.
       ------------------------------------------------------------- */
    const lastUpdate = getPricingLastUpdate(p);

    if (!lastUpdate) {
      skipped48.push({
        Asin: a,
        Sku: pricingSku,
        LastUpdate: '',
        AgeHours: '',
        Reason: 'Last Update date/time is missing - not processed'
      });
      return;
    }

    // IMPORTANT: 48 hours is an elapsed-time rule.
    // An ASIN becomes eligible only when age >= 48 hours.
    if (!olderThan48Hours(lastUpdate)) {
      skipped48.push({
        Asin: a,
        Sku: pricingSku,
        LastUpdate: lastUpdate,
        AgeHours: formatAgeHours(lastUpdate),
        Reason: 'Last Update is less than 48 hours old'
      });
      return;
    }

    /* Remaining migrated ASINs may not exist in Local Shops.
       Match SKU from the price file first; if the listing exists,
       use its seller SKU/title. */
    const l = allNonFbaByAsin.get(a) || {
      'seller-sku': pricingSku,
      'item-name': clean(p['item-name'] || p.Title || p.title)
    };

    const b = backendMap.get(a);
    const cost = getPricingNewPrice(p);

    if (cost === null) {
      unrun.push({
        Asin: a,
        Sku: getListingSKU(l) || pricingSku,
        Reason: 'No valid new price',
        NewPrice: p.new_price ?? p['New Price'] ?? ''
      });
      return;
    }

    if (!b || b.Weight === null || b.RefFee === null) {
      missing.push({
        Asin: a,
        Sku: getListingSKU(l) || pricingSku,
        Title: clean(l['item-name']),
        Weight: b?.Weight ?? '',
        RefFee: b?.RefFee ?? '',
        Reason: !b ? 'ASIN missing from backend' : 'Weight or referral fee missing'
      });
      return;
    }

    const row = priceRow(p, l, b);

    if (!row) {
      unrun.push({
        Asin: a,
        Sku: getListingSKU(l) || pricingSku,
        Reason: 'Pricing formula could not be calculated'
      });
      return;
    }

    /* Price alert against saved historical US/new price. */
    const old = state.history[a];

    if (old && Number.isFinite(Number(old.price))) {
      const change = cost - Number(old.price);
      const pct = Number(old.price)
        ? Math.abs(change) / Number(old.price)
        : 0;

      if (Math.abs(change) >= 500 || pct >= 0.10) {
        alerts.push({
          Asin: a,
          Sku: getListingSKU(l) || pricingSku,
          PreviousPrice: Number(old.price).toFixed(2),
          NewPrice: cost.toFixed(2),
          Change: change.toFixed(2),
          ChangePercent: (pct * 100).toFixed(2) + '%',
          Type: change >= 0 ? 'Increase' : 'Decrease'
        });
      }
    }

    /* Save this run's source price only after the row is actually
       eligible for processing. */
    state.history[a] = {
      price: cost,
      updatedAt: new Date().toISOString(),
      sourceLastUpdate: lastUpdate
    };

    output.push(row);
  });

  await saveSaved('history', state.history);
  if (supabaseReady) { try { await savePriceHistoryToSupabase(state.history); } catch (e) { console.warn('Price history sync failed:', e); } }

  state.results = {
    final: output,
    fba,
    local,
    fbaRemoved,
    localRemoved,
    warehouseRemoved,
    skipped48,
    unrun,
    backend: missing,
    warehouse: warehouseEx,
    alerts
  };

  render();
}

function headers(key) {
  const r = state.results[key] || [];
  return r.length ? Object.keys(r[0]) : [];
}

function render() {
  const r = state.results;
  const set = (id, v) => $(id).textContent = v;

  $('metrics').children[0].querySelector('b').textContent =
    state.listings.length.toLocaleString();

  $('metrics').children[1].querySelector('b').textContent =
    (r.fba || []).length.toLocaleString();

  $('metrics').children[2].querySelector('b').textContent =
    (r.local || []).length.toLocaleString();

  $('metrics').children[3].querySelector('b').textContent =
    (r.final || []).length.toLocaleString();

  $('metrics').children[4].querySelector('b').textContent =
    (r.alerts || []).length.toLocaleString();

  [
    ['final','finalCount'],
    ['fba','fbaCount'],
    ['local','localCount'],
    ['fbaRemoved','fbaRemovedCount'],
    ['localRemoved','localRemovedCount'],
    ['warehouseRemoved','warehouseRemovedCount'],
    ['skipped48','skipped48Count'],
    ['unrun','unrunCount'],
    ['backend','backendCount'],
    ['warehouse','warehouseCount'],
    ['alerts','alertCount']
  ].forEach(([k,id]) => {
    if ($(id)) set(id, (r[k] || []).length.toLocaleString());
  });

  $('downloadFinal').disabled = !(r.final || []).length;
  $('downloadTab').disabled = !(r[currentTab] || []).length;

  showTab(currentTab);

  $('status').textContent =
    `Processed ${state.listings.length.toLocaleString()} listings. ` +
    `FBA removed: ${(r.fbaRemoved || []).length.toLocaleString()} | ` +
    `Local Shops removed: ${(r.localRemoved || []).length.toLocaleString()} | ` +
    `Warehouse removed: ${(r.warehouseRemoved || []).length.toLocaleString()} | ` +
    `Final updates: ${(r.final || []).length.toLocaleString()}.`;
}

let currentTab = 'final';

function showTab(key) {
  currentTab = key;

  document.querySelectorAll('[data-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === key)
  );

  const rows = state.results[key] || [];
  const h = headers(key);

  const labels = {
    final: 'Final Amazon upload data',
    fba: 'FBA ASINs from All Listings',
    local: 'Local Shops ASINs from All Listings',
    fbaRemoved: 'FBA records removed from price update',
    localRemoved: 'Local Shops records removed from price update',
    warehouseRemoved: 'Warehouse records removed from price update',
    skipped48: 'Skipped - last update is less than 48 hours old',
    unrun: 'Un Run ASINs',
    backend: 'Backend Data required',
    warehouse: 'Warehouse Exceptions - stock > 0 but not in Local Shops',
    alerts: 'Price Alerts'
  };

  $('tableLabel').textContent = labels[key] || key;

  $('thead').innerHTML = h.length
    ? '<tr>' + h.map(x => `<th>${esc(x)}</th>`).join('') + '</tr>'
    : '';

  $('tbody').innerHTML = rows.length
    ? rows.slice(0, 2000).map(r =>
        '<tr>' +
        h.map(x => {
          const exception =
            key === 'warehouse' ||
            key === 'skipped48' ||
            key === 'fbaRemoved' ||
            key === 'localRemoved' ||
            key === 'warehouseRemoved';

          const cls = [
            x.toLowerCase().includes('title') ? 'title' : '',
            exception ? 'process-row' : ''
          ].filter(Boolean).join(' ');

          return `<td class="${cls}">${esc(r[x])}</td>`;
        }).join('') +
        '</tr>'
      ).join('')
    : `<tr><td class="empty">No records in this tab.</td></tr>`;

  $('downloadTab').disabled = !rows.length;
}

function esc(v) {
  return clean(v).replace(/[&<>"']/g, c => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

function csv(rows, final = false) {
  const cols = final
    ? ['sku','qty','lead_time_to_ship','sale_price','mrp','min','max','b2b_price']
    : headers(currentTab);

  const quote = v => '"' + String(v ?? '').replaceAll('"','""') + '"';

  return [
    cols.join(','),
    ...rows.map(r => cols.map(c => quote(r[c])).join(','))
  ].join('\r\n');
}

function download(text, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([text], { type: 'text/csv;charset=utf-8' })
  );
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('tabs').addEventListener('click', e => {
  const btn = e.target.closest('[data-tab]');
  if (btn) showTab(btn.dataset.tab);
});

$('downloadFinal').onclick = () => download(csv(state.results.final, true), 'amazon_price_upload.csv');
$('downloadTab').onclick = () => download(csv(state.results[currentTab]), `${currentTab}_asins.csv`);

const backendButtons = document.querySelectorAll('#backend button');
const uploadBackendButton = backendButtons[0];
const downloadBackendButton = backendButtons[1];

uploadBackendButton.onclick = async () => {
  try {
    await hydrate();
    const file = $('backendFile').files[0];
    if (!file) { $('backendFile').click(); return; }
    uploadBackendButton.disabled = true;
    uploadBackendButton.textContent = 'Saving…';
    $('status').textContent = 'Reading backend file and saving ASIN records…';
    const update = await readFile(file, 'backend');
    if (!update.length) throw new Error('No backend records were found in the selected file.');
    const map = latestBackend([...state.backend, ...update]);
    state.backend = [...map.values()];
    await saveSaved('backend', state.backend);
    if (supabaseReady) {
      await saveBackendToSupabase(update);
      const remote = await loadBackendFromSupabase();
      if (remote) { state.backend = remote; await saveSaved('backend', remote); }
    }
    if (state.results && Object.keys(state.results).length) render();
    $('status').textContent = `Backend saved successfully: ${state.backend.length.toLocaleString()} ASINs · ${backendStorageLabel()}.`;
    updateBackendUI(`✓ Backend updated successfully · ${state.backend.length.toLocaleString()} ASINs · ${backendStorageLabel()}.`);
  } catch(e) {
    console.error(e);
    $('status').textContent=`Backend save failed: ${e.message || 'unknown error'}. `+(supabaseReady?'Check Supabase table policies.':'The local backup is still available; configure the Supabase anon key for shared storage.');
    updateBackendUI();
  } finally { uploadBackendButton.disabled=false; uploadBackendButton.textContent='Upload / Update Backend'; }
};

downloadBackendButton.onclick = async () => {
  try {
    await hydrate();
    let records=state.backend;
    if(supabaseReady){ const remote=await loadBackendFromSupabase(); if(remote && (remote.length || !state.backend.length)){records=remote;state.backend=remote;await saveSaved('backend',remote);updateBackendUI();} }
    if(!records.length){ $('status').textContent='No backend ASIN records are stored yet.'; return; }
    const rows=records.map(r=>({ASIN:r.Asin,SKU:r.Sku,Weight:r.Weight??'','Ref Fee':r.RefFee??'',Brand:r.Brand||'',RestrictionType:r.RestrictionType||'',UpdatedAt:r.updatedAt||''}));
    download(csv(rows,false),'priceflow_backend_database.csv');
    $('status').textContent=`Downloaded ${records.length.toLocaleString()} backend ASINs from ${backendStorageLabel()}.`;
  }catch(e){ console.error(e); $('status').textContent=`Backend download failed: ${e.message||'unknown error'}.`; }
};

$('backendFile').addEventListener('change', () => {
  const file=$('backendFile').files[0];
  if(file) $('status').textContent=`Backend file selected: ${file.name}. Click “Upload / Update Backend” to save it.`;
});

$('run').onclick = async () => {
  const lf=$('listingsFile').files[0], pf=$('pricingFile').files[0], wf=$('warehouseFile').files[0], bf=$('backendFile').files[0];
  if(!lf||!pf||!wf){ $('status').textContent='Please choose Amazon listings, daily price data, and warehouse stock files.'; return; }
  try{
    $('run').disabled=true;
    $('status').textContent='Reading files, matching FBA → Local Shops → Warehouse, checking 48 hours, and calculating prices…';
    await hydrate();
    [state.listings,state.pricing,state.warehouse]=await Promise.all([readFile(lf,'listings'),readFile(pf,'pricing'),readFile(wf,'warehouse')]);
    if(bf){
      const update=await readFile(bf,'backend');
      const map=latestBackend([...state.backend,...update]);
      state.backend=[...map.values()];
      await saveSaved('backend',state.backend);
      if(supabaseReady){ await saveBackendToSupabase(update); const remote=await loadBackendFromSupabase(); if(remote){state.backend=remote;await saveSaved('backend',remote);} }
    }
    await process();
  }catch(e){ console.error(e); $('status').textContent=`Unable to read/process a file: ${e.message||'unknown error'}. Check the file format and column names.`; }
  finally{$('run').disabled=false;}
};

(async()=>{
  await hydrate();
  updateBackendUI();
  if($('status')) $('status').textContent=state.backend.length
    ? `Backend ready: ${state.backend.length.toLocaleString()} ASINs · ${backendStorageLabel()}.`
    : (supabaseReady ? 'Supabase connected. No backend ASINs are stored yet.' : 'No backend data is saved yet. Upload the backend database first.');
})();
