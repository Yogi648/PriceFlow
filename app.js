/* PriceFlow daily processor.
   Processing order:
   1) All Listings -> FBA / Local Shops
   2) Price Update -> FBA Removed
   3) Remaining -> Local Shops Removed
   4) Remaining Migrated ASINs -> Warehouse Qty > 0 Removed
   5) Remaining -> 48-hour last-update check (LESS than 48 hours = update)
   6) Eligible rows -> pricing formula
*/
const TARGET_PROFIT = 150;
const SPECIAL_RATE = 0.10;
const STANDARD_RATE = 0.05;
const SPECIAL_WORDS = [
  'ssd','solid state drive','nvme','m.2','motherboard','mainboard',
  ' ram ','memory','ddr3','ddr4','ddr5','graphic card','graphics card','gpu','video card'
];

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

['listingsFile','pricingFile','warehouseFile'].forEach(id => {
  $(id).addEventListener('change', () => {
    if ($('status')) $('status').textContent =
      `Ready: ${fileName('listingsFile')} | ${fileName('pricingFile')} | ` +
      `${fileName('warehouseFile')}`;
  });
});

/* Backend is a separate persistent ASIN database.
   Upload it once (or upload an updated backend file later).
   It is saved automatically and matched to every daily price row by ASIN.
   Daily processing does NOT require the backend file to be selected again. */
$('backendFile').addEventListener('change', async () => {
  const bf = $('backendFile').files[0];
  if (!bf) return;

  try {
    if ($('backendStatus')) $('backendStatus').textContent =
      `Importing backend database: ${bf.name}…`;

    await hydrate();
    const update = await readFile(bf, 'backend');
    const map = latestBackend([...state.backend, ...update]);
    state.backend = [...map.values()];
    await saveSaved('backend', state.backend);

    if ($('status')) $('status').textContent =
      `Backend database connected automatically: ${state.backend.length.toLocaleString()} ASINs saved. ` +
      `Weight and Ref Fee will be matched by ASIN during pricing.`;
  } catch (e) {
    console.error(e);
    if ($('backendStatus')) $('backendStatus').textContent =
      `Backend upload failed: ${e.message || 'unknown error'}.`;
  }
});

function calculateLeadTime(isPrime, rawLeadTime) {
  const prime = clean(isPrime).toLowerCase();
  const raw = clean(rawLeadTime).toLowerCase();

  // Prime = 10 days.
  if (prime === 'yes' || prime === 'true' || prime === '1' || prime === 'prime') {
    return '10';
  }

  // Non-prime with no/None value = 15 days.
  if (!raw || ['none', 'null', 'n/a', 'na', 'not available'].includes(raw)) {
    return '15';
  }

  // Any numeric lead time = existing value + 7, capped at 30.
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
  if (Number.isFinite(n)) {
    return String(Math.min(30, n + 7));
  }

  // Non-prime invalid/empty text also defaults to 15.
  return '15';
}

function roundPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function backendNumber(v) {
  const raw = clean(v);
  if (!raw || ['none','no data','not available','n/a','#n/a','nil','na','null','-'].includes(raw.toLowerCase())) {
    return null;
  }
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function latestBackend(records) {
  const map = new Map();

  const getField = (r, names) => {
    const keys = Object.keys(r || {});
    for (const wanted of names) {
      const exact = keys.find(k => clean(k).toLowerCase() === wanted.toLowerCase());
      if (exact !== undefined && clean(r[exact]) !== '') return r[exact];
    }
    // Also allow punctuation/space differences in uploaded template headers.
    const norm = x => clean(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const wanted of names) {
      const nw = norm(wanted);
      const key = keys.find(k => norm(k) === nw);
      if (key !== undefined && clean(r[key]) !== '') return r[key];
    }
    return '';
  };

  records.forEach(r => {
    // IMPORTANT: Backend Weight and Ref Fee are matched ONLY by ASIN.
    const key = asin(getField(r, ['Asin', 'ASIN', 'asin']));
    if (!key) return;

    const weightRaw = getField(r, ['Weight', 'weight']);
    const refRaw = getField(r, [
      'Ref Fee', 'Ref fee', 'Ref Fee %', 'ref fee%', 'Referral Fee',
      'Referral Fee %', 'referral fee', 'referral fee %', 'RefFee', 'refFee'
    ]);

    map.set(key, {
      Asin: key,
      Weight: backendNumber(weightRaw),
      RefFee: backendNumber(refRaw),
      Brand: clean(getField(r, ['Brand', 'brand'])),
      RestrictionType: clean(getField(r, ['RestrictionType', 'restrictionType'])),
      updatedAt: new Date().toISOString()
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

  // The Amazon report can display LastUpdate as DD-MM-YY, e.g.
  // 17-09-26 22:18. Interpret 26 as 2026.
  m = s.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const d = new Date(
      2000 + Number(m[3]),
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

/* TRUE when the last update is LESS than 48 hours old.
   These ASINs are eligible for the price update. */
function within48Hours(value) {
  const updated = parseDateTime(value);
  if (!updated) return false;
  const age = Date.now() - updated.getTime();
  return age >= 0 && age < 48 * 60 * 60 * 1000;
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
  const fc = clean(l['fulfillment-channel']).toUpperCase().replace(/\s+/g, ' ');
  return fc === 'AMAZON_IN' || fc === 'AMAZON.IN' || fc === 'AMAZON IN' || fc.includes('AMAZON_IN');
}

function isLocalShopListing(l) {
  /* In the Amazon All Listings report, non-AMAZON_IN listings are treated
     as Local Shops for this workflow. */
  return !isFBAListing(l);
}

function getPricingASIN(p) {
  return asin(p.Asin || p.ASIN || p.asin);
}


function normalizedValue(v) {
  const x = clean(v).toLowerCase();
  if (!x || ['no data','none','not available','n/a','#n/a','nil','na'].includes(x)) return '';
  return clean(v);
}

function getCommonFields(p, b, l) {
  const newPrice =
    normalizedValue(p?.new_price ?? p?.NewPrice ?? p?.['New Price'] ?? p?.price ?? p?.Price);

  const weight = b?.Weight ?? '';

  const refFee = b?.RefFee ?? '';

  let prime = p?.['Is Prime'] ?? p?.IsPrime ?? p?.Prime ?? p?.['is prime'];
  if (prime === undefined || prime === null || prime === '') {
    prime = l?.['Is Prime'] ?? l?.IsPrime ?? l?.Prime ?? l?.['is prime'];
  }

  return {
    NewPrice: newPrice,
    Weight: normalizedValue(weight),
    'Ref Fee%': normalizedValue(refFee),
    'Is Prime': normalizedValue(prime)
  };
}

function inactivePrice(p) {
  const raw = clean(
    p?.new_price ?? p?.NewPrice ?? p?.['New Price'] ??
    p?.['NEW PRICE'] ?? p?.price ?? p?.Price
  ).trim().toLowerCase();

  // Any of these values mean there is no usable new price.
  return !raw || [
    'none',
    'no data',
    'not available',
    'n/a',
    'na',
    '#n/a',
    'nil',
    'null',
    'undefined',
    'error',
    '#error',
    '#value!',
    '#ref!',
    '#name?',
    '#num!',
    '#div/0!',
    '-',
    '--'
  ].includes(raw);
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
  const raw = clean(
    p?.new_price ?? p?.NewPrice ?? p?.['New Price'] ??
    p?.['NEW PRICE'] ?? p?.price ?? p?.Price
  ).trim().toLowerCase();

  // Never convert invalid source values such as None/No data/Error
  // into 0.00. They must be treated as inactive.
  if (
    !raw ||
    ['none','no data','not available','n/a','na','#n/a','nil','null',
     'undefined','error','#error','#value!','#ref!','#name?','#num!',
     '#div/0!','-','--'].includes(raw)
  ) {
    return null;
  }

  const value = num(raw);
  if (value === null || value <= 0) return null;
  return value;
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
  const usPrice = getPricingNewPrice(p);
  const weight = b?.Weight;
  const ref = b?.RefFee;

  // User's fixed exchange rate for this pricing formula.
  const exchangeRate = 97;

  if (usPrice === null || weight === null || ref === null) return null;

  const title = clean(l?.['item-name'] || p?.title || p?.Title || p?.['item-name']);
  const specialCategory = special(title);
  const saleChargeRate = specialCategory ? 0.10 : 0.05;

  /*
    Required pricing structure:
      sale_price = minimum_price + minimum_price*0.06
                 = minimum_price*1.06

      max = sale_price + sale_price*0.07
          = sale_price*1.07

      mrp = sale_price + sale_price*0.35
          = sale_price*1.35

    Profit target:
      minimum_price/1.18
      - (ref fee% * sale_price / 100)
      - (new price * 97 * 1.2)
      - (weight * 5 * 97)
      - (weight * 200)
      - (minimum_price * 0.05 for standard / 0.10 for SSD-Motherboard-RAM)

    The minimum price is solved directly so the result reaches ₹150.
    This is mathematically equivalent to adjusting the amount repeatedly
    until profit reaches the target, but avoids rounding drift.
  */
  const fixedCosts =
    usPrice * exchangeRate * 1.2 +
    weight * 5 * exchangeRate +
    weight * 200;

  const saleMultiplier = 1.06;

  // Profit = min*(1/1.18 - ref/100*1.06 - saleChargeRate) - fixedCosts
  const denominator =
    (1 / 1.18) -
    ((ref / 100) * saleMultiplier) -
    saleChargeRate;

  if (denominator <= 0) return null;

  let minPrice = (TARGET_PROFIT + fixedCosts) / denominator;
  if (!Number.isFinite(minPrice) || minPrice <= 0) return null;

  let sale = minPrice * saleMultiplier;
  let max = sale * 1.07;
  let mrp = sale * 1.35;

  // Recalculate once using unrounded values. This keeps displayed profit
  // at/very close to ₹150 despite the dependent sale/minimum-price values.
  const actualProfit =
    minPrice / 1.18 -
    (ref * sale / 100) -
    usPrice * exchangeRate * 1.2 -
    weight * 5 * exchangeRate -
    weight * 200 -
    minPrice * saleChargeRate;

  const b2b = sale - (sale * 0.015);

  const primeRaw = clean(
    p?.['Is Prime'] ?? p?.IsPrime ?? p?.Prime ?? p?.['is prime'] ??
    l?.['Is Prime'] ?? l?.IsPrime ?? l?.Prime ?? l?.['is prime']
  ).toLowerCase();

  const isPrime = ['yes','true','1','prime'].includes(primeRaw) ? 'Yes' : clean(
    p?.['Is Prime'] ?? p?.IsPrime ?? p?.Prime ?? p?.['is prime'] ??
    l?.['Is Prime'] ?? l?.IsPrime ?? l?.Prime ?? l?.['is prime']
  );

  return {
    Asin: getPricingASIN(p),
    sku: getListingSKU(l) || clean(p.SKU || p.sku || p['seller-sku'] || p.SellerSKU),
    title,
    'new price': roundPrice(usPrice),
    weight: weight,
    'ref fee': ref,
    'is prime': isPrime,
    qty: clean(l?.quantity || l?.Qty || p?.qty || p?.Qty),
    'lead time to ship': calculateLeadTime(isPrime, l?.['lead time to ship'] ?? l?.['Lead Time to Ship'] ?? l?.lead_time_to_ship ?? l?.['lead-time-to-ship'] ?? p?.['lead time to ship'] ?? p?.['Lead Time to Ship'] ?? p?.lead_time_to_ship),
    sale_price: roundPrice(sale),
    mrp: roundPrice(mrp),
    min: roundPrice(minPrice),
    max: roundPrice(max),
    b2b_price: b2b.toFixed(2),
    rule: specialCategory
      ? '₹150 target profit; SSD/Motherboard/RAM/Graphic Card =  Graphic Card 10%; Ref Fee from Backend; Exchange Rate 97'
      : '₹150 target profit; Standard = 5%; Ref Fee from Backend; Exchange Rate 97',
    profit: actualProfit.toFixed(2),
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
    row.NewPrice = '';
    row.Weight = '';
    row['Ref Fee%'] = '';
    row['Is Prime'] = clean(l['Is Prime'] || l.IsPrime || l.Prime || l['is prime']);

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
  const inactive = [];
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
        ...getCommonFields(p, backendMap.get(a), l),
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
       Invalid New Price is inactive and never enters the 48-hour rule.
       ------------------------------------------------------------- */
    const b = backendMap.get(a);
    const cost = getPricingNewPrice(p);

    if (cost === null) {
      inactive.push({
        Asin: a,
        Sku: pricingSku,
        ...getCommonFields(p, b, allNonFbaByAsin.get(a)),
        Reason: 'New Price is blank / None / No data / Error / Not Available - inactive'
      });
      return;
    }

    const lastUpdate = getPricingLastUpdate(p);

    if (!lastUpdate) {
      skipped48.push({
        Asin: a,
        Sku: pricingSku,
        ...getCommonFields(p, backendMap.get(a), null),
        LastUpdate: '',
        AgeHours: '',
        Reason: 'Last Update date/time is missing - not processed'
      });
      return;
    }

    // IMPORTANT: 48 hours is an elapsed-time rule.
    // An ASIN becomes eligible only when age >= 48 hours.
    if (!within48Hours(lastUpdate)) {
      skipped48.push({
        Asin: a,
        Sku: pricingSku,
        ...getCommonFields(p, backendMap.get(a), null),
        LastUpdate: lastUpdate,
        AgeHours: formatAgeHours(lastUpdate),
        Reason: 'Last Update is 48 hours or older'
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

    if (!b || b.Weight === null || b.Weight === undefined || b.RefFee === null || b.RefFee === undefined) {
      missing.push({
        Asin: a,
        Sku: getListingSKU(l) || pricingSku,
        ...getCommonFields(p, b, l),
        Title: clean(l['item-name']),
        Reason: !b ? 'ASIN missing from backend' : (b.Weight === null || b.Weight === undefined) && (b.RefFee === null || b.RefFee === undefined) ? 'Weight and Ref Fee are blank in backend' : (b.Weight === null || b.Weight === undefined) ? 'Weight is blank in backend' : 'Ref Fee is blank in backend'
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

  state.results = {
    final: output,
    inactive,
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
  if (key === 'final') return ['Asin','sku','title','new price','weight','ref fee','is prime','qty','lead time to ship','sale_price','mrp','min','max','b2b_price','rule','profit','LastUpdate'];
  if (!r.length) return ['Asin','Sku','NewPrice','Weight','Ref Fee%','Is Prime'];
  const base = Object.keys(r[0]);
  const common = ['NewPrice','Weight','Ref Fee%','Is Prime'];
  return [...common.filter(x => base.includes(x)), ...base.filter(x => !common.includes(x))];
}

function render() {
  const r = state.results;
  const set = (id, v) => $(id).textContent = v;

  const metricCards = $('metrics') ? $('metrics').children : [];
  const metricValues = [
    state.listings.length,
    (r.final || []).length,
    (r.alerts || []).length
  ];
  metricValues.forEach((value, i) => {
    const card = metricCards[i];
    const valueEl = card ? card.querySelector('b') : null;
    if (valueEl) valueEl.textContent = value.toLocaleString();
  });

  [
    ['final','finalCount'],
    ['inactive','inactiveCount'],
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

  if ($('downloadFinal')) $('downloadFinal').disabled = !(r.final || []).length;
  if ($('downloadAllExcel')) $('downloadAllExcel').disabled = !Object.values(r).some(v => (v || []).length);
  if ($('downloadTab')) $('downloadTab').disabled = !(r[currentTab] || []).length;

  showTab(currentTab);

  if ($('status')) $('status').textContent =
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

  const rows = (state.results[key] || []).map(r => {
    const x = { ...r };
    if (!Object.prototype.hasOwnProperty.call(x, 'NewPrice')) x.NewPrice = '';
    if (!Object.prototype.hasOwnProperty.call(x, 'Weight')) x.Weight = '';
    if (!Object.prototype.hasOwnProperty.call(x, 'Ref Fee%')) x['Ref Fee%'] = '';
    if (!Object.prototype.hasOwnProperty.call(x, 'Is Prime')) x['Is Prime'] = '';
    return x;
  });
  const h = headers(key);

  const labels = {
    final: 'Final Amazon upload data',
    fba: 'FBA ASINs from All Listings',
    local: 'Local Shops ASINs from All Listings',
    fbaRemoved: 'FBA records removed from price update',
    localRemoved: 'Local Shops records removed from price update',
    warehouseRemoved: 'Warehouse records removed from price update',
    skipped48: 'Skipped - last update is 48 hours or older',
    unrun: 'Un Run ASINs',
    inactive: 'Inactive ASINs - No Data / None / Not Available',
    backend: 'Backend Data required',
    warehouse: 'Warehouse Exceptions - stock > 0 but not in Local Shops',
    alerts: 'Price Alerts'
  };

  if ($('tableLabel')) $('tableLabel').textContent = labels[key] || key;

  if ($('thead')) $('thead').innerHTML = h.length
    ? '<tr>' + h.map(x => `<th>${esc(x)}</th>`).join('') + '</tr>'
    : '';

  if ($('tbody')) $('tbody').innerHTML = rows.length
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
    ? ['Asin','sku','title','new price','weight','ref fee','is prime','qty','lead time to ship','sale_price','mrp','min','max','b2b_price','rule','profit','LastUpdate']
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


function downloadAllExcel() {
  if (typeof XLSX === 'undefined') {
    if ($('status')) $('status').textContent = 'Excel library is not available. Please refresh the page.';
    return;
  }

  const wb = XLSX.utils.book_new();

  const sheets = [
    ['Final Upload', 'final'],
    ['Inactive', 'inactive'],
    ['FBA ASINs', 'fba'],
    ['Local Shops', 'local'],
    ['FBA Removed', 'fbaRemoved'],
    ['Local Shops Removed', 'localRemoved'],
    ['Warehouse Removed', 'warehouseRemoved'],
    ['Skipped Less 48h', 'skipped48'],
    ['Un Run ASINs', 'unrun'],
    ['Backend Data', 'backend'],
    ['Warehouse Exceptions', 'warehouse'],
    ['Price Alerts', 'alerts']
  ];

  sheets.forEach(([name, key]) => {
    const rows = state.results[key] || [];
    const headersForSheet = headers(key);
    const data = rows.length
      ? [headersForSheet, ...rows.map(r => headersForSheet.map(c => r[c] ?? ''))]
      : [['No records']];

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };

    // Reasonable column widths.
    if (headersForSheet.length) {
      ws['!cols'] = headersForSheet.map(c => ({
        wch: Math.min(Math.max(String(c).length + 2, 12), 35)
      }));
    }

    XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
  });

  // Add a Summary worksheet first.
  const r = state.results;
  const summary = [
    ['PriceFlow Processing Summary', ''],
    ['Processed Date', new Date().toLocaleString()],
    ['Listings', state.listings.length],
    ['FBA ASINs', (r.fba || []).length],
    ['Local Shops ASINs', (r.local || []).length],
    ['Final Upload', (r.final || []).length],
    ['FBA Removed', (r.fbaRemoved || []).length],
    ['Local Shops Removed', (r.localRemoved || []).length],
    ['Warehouse Removed', (r.warehouseRemoved || []).length],
    ['Skipped ≥48 Hours', (r.skipped48 || []).length],
    ['Un Run ASINs', (r.unrun || []).length],
    ['Backend Data Required', (r.backend || []).length],
    ['Warehouse Exceptions', (r.warehouse || []).length],
    ['Price Alerts', (r.alerts || []).length],
    ['Rule', 'Last Update less than 48 hours = eligible for price update'],
    ['Warehouse Rule', 'Qty = 0 ignored; Qty > 0 treated as Local Shop warehouse stock']
  ];

  const summaryWs = XLSX.utils.aoa_to_sheet(summary);
  summaryWs['!cols'] = [{ wch: 34 }, { wch: 75 }];
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

  // Put Summary first.
  const summarySheet = wb.Sheets['Summary'];
  wb.SheetNames = ['Summary', ...wb.SheetNames.filter(n => n !== 'Summary')];
  wb.Sheets['Summary'] = summarySheet;

  XLSX.writeFile(wb, 'PriceFlow_All_Results.xlsx');
  if ($('status')) $('status').textContent = 'Excel workbook downloaded with all result tabs and Summary.';
}

$('downloadFinal').onclick = () =>
  download(csv(state.results.final, true), 'amazon_price_upload.csv');
$('downloadAllExcel').onclick = downloadAllExcel;

$('downloadTab').onclick = () =>
  download(csv(state.results[currentTab]), `${currentTab}_asins.csv`);

$('run').onclick = async () => {
  const lf = $('listingsFile').files[0];
  const pf = $('pricingFile').files[0];
  const wf = $('warehouseFile').files[0];
  const bf = $('backendFile').files[0];

  if (!lf || !pf || !wf) {
    if ($('status')) $('status').textContent =
      'Please choose Amazon listings, daily price data, and warehouse stock files.';
    return;
  }

  try {
    $('run').disabled = true;
    if ($('status')) $('status').textContent =
      'Reading files, matching FBA → Local Shops → Warehouse, checking 48 hours, and calculating prices…';

    await hydrate();

    [state.listings, state.pricing, state.warehouse] = await Promise.all([
      readFile(lf, 'listings'),
      readFile(pf, 'pricing'),
      readFile(wf, 'warehouse')
    ]);

    // Backend is already stored separately and is automatically matched by ASIN.
    // If a new backend file was selected, the change handler has already saved it.
    // This fallback also handles a backend file selected immediately before Run.
    if (bf) {
      const update = await readFile(bf, 'backend');
      const map = latestBackend([...state.backend, ...update]);
      state.backend = [...map.values()];
      await saveSaved('backend', state.backend);
    }

    await process();
  } catch (e) {
    console.error(e);
    if ($('status')) $('status').textContent =
      `Unable to read/process a file: ${e.message || 'unknown error'}. ` +
      'Check the file format and column names.';
  } finally {
    $('run').disabled = false;
  }
};


function downloadBackendDatabase_() {
  const rows = Array.isArray(state.backend) ? state.backend : [];
  if (!rows.length) {
    if ($('backendStatus')) $('backendStatus').textContent =
      'No backend data is saved yet. Upload the backend database first.';
    return;
  }

  const headers = Array.from(new Set(rows.flatMap(r => Object.keys(r || {}))));
  const csv = [
    headers.map(v => csvCell_(v)).join(','),
    ...rows.map(r => headers.map(h => csvCell_(r[h] ?? '')).join(','))
  ].join('\r\n');

  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backend_asin_database_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  if ($('backendStatus')) $('backendStatus').textContent =
    `Backend database downloaded: ${rows.length.toLocaleString()} ASINs.`;
}

function csvCell_(v) {
  const text = String(v ?? '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}



document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('downloadBackend');
  if (btn) {
    btn.addEventListener('click', downloadBackendDatabase_);
  }
});


// Local Shops Removed: ASINs removed because they are present in Local Shops.
if (!Array.isArray(state.localRemoved)) {
  state.localRemoved = Array.isArray(state.localShopsRemoved)
    ? state.localShopsRemoved
    : (Array.isArray(state.localRemovedRows) ? state.localRemovedRows : []);
}
