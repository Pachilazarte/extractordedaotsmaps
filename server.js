const express    = require('express');
const puppeteer  = require('puppeteer');
const { Parser } = require('json2csv');
const ExcelJS    = require('exceljs');
const cors       = require('cors');
const path       = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Active scrape sessions (for stop support) ───────────────────────────────
const sessions = new Map(); // sessionId → { stopped: bool, browser }

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildUrl(term, location) {
  const q = location ? `${term} en ${location}` : term;
  return `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
}

/**
 * Detect if a phone number is a mobile or landline.
 * Handles Argentina (+54) conventions and generic international rules.
 * Returns: 'mobile' | 'landline' | ''
 */
function detectPhoneType(raw) {
  if (!raw || raw.trim() === '') return '';

  // Strip everything except digits and leading +
  const clean = raw.replace(/[\s\-().]/g, '');
  const digits = clean.replace(/^\+/, '');

  // ── Argentina-specific rules ──────────────────────────────────────────
  // 1. Contains "15" (Argentine mobile prefix) anywhere after first 2 digits
  //    e.g. 0261-15-123456 / (261) 15 123456
  if (/15/.test(raw.replace(/^(\+54|0054|54)?/, ''))) {
    // Make sure "15" is really a mobile prefix, not part of an area code like 1500
    const withoutCountry = raw.replace(/^(\+54\s?|0054|54)/, '');
    if (/\b15\b|[-\s(]15[-\s)]|^15/.test(withoutCountry)) return 'mobile';
  }

  // 2. International format +549XXXXXXXXXX  (+54 9 = Argentina mobile)
  if (/^\+?549/.test(clean)) return 'mobile';

  // 3. 10-digit number starting with 9 (national mobile without country code)
  //    e.g. 9 261 XXXXXXX  →  9261XXXXXXX
  if (/^9\d{9}$/.test(digits)) return 'mobile';

  // 4. WhatsApp-style numbers often written as 11XXXXXXXX (Buenos Aires mobile)
  if (/^(011|11)\d{8}$/.test(digits.replace(/^54/, ''))) return 'mobile';

  // ── Generic international rules ───────────────────────────────────────
  // 5. Starts with +1 and 10 digits → US/CA, treat as landline (can't tell)
  // 6. Starts with +34 6/7 → Spain mobile
  if (/^\+?346/.test(clean) || /^\+?347/.test(clean)) return 'mobile';
  // 7. Starts with +55 (Brazil): 9 after area code = mobile
  if (/^\+?55\d{2}9/.test(clean)) return 'mobile';

  // ── Short numbers / unable to determine → landline by default ─────────
  return 'landline';
}

async function autoScroll(page, maxItems) {
  let prev = -1, stable = 0;
  for (let i = 0; i < 50; i++) {
    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (feed) feed.scrollBy(0, 1200);
    });
    await sleep(600);
    const count = await page.$$eval('a[href*="/maps/place/"]', els => {
      const s = new Set(els.map(e => e.href)); return s.size;
    });
    if (count >= maxItems) break;
    if (count === prev) { if (++stable >= 4) break; }
    else stable = 0;
    prev = count;
  }
}

// ─── Scrape a single place detail page ───────────────────────────────────────
async function scrapePlaceDetail(page, url, skipClosed) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1000);
  } catch { return null; }

  const data = await page.evaluate(() => {
    const title = (document.querySelector('h1.DUwDvf') || document.querySelector('h1'))?.textContent?.trim() || '';

    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
    const totalScore = ratingEl ? parseFloat(ratingEl.textContent.replace(',', '.')) : null;

    const reviewsEl = document.querySelector('div.F7nice span[aria-label]');
    let reviewsCount = null;
    if (reviewsEl) {
      const m = reviewsEl.getAttribute('aria-label').match(/[\d.,]+/);
      if (m) reviewsCount = parseInt(m[0].replace(/[.,]/g, ''));
    }

    const closedEl = document.querySelector('.o0Svhf, [jsaction*="pane.openhours"]');
    const isClosed = closedEl ? /cerrado permanentemente|permanently closed/i.test(closedEl.textContent) : false;

    let address = '';
    const addrBtn = document.querySelector('button[data-item-id="address"]');
    if (addrBtn) address = addrBtn.querySelector('.Io6YTe,.rogA2c')?.textContent?.trim() || '';

    let phone = '';
    const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
    if (phoneBtn) phone = phoneBtn.querySelector('.Io6YTe,.rogA2c')?.textContent?.trim() || '';

    let website = '';
    const webBtn = document.querySelector('a[data-item-id="authority"]');
    if (webBtn) website = webBtn.href || '';

    let category = '';
    const catEl = document.querySelector('button.DkEaL');
    if (catEl) category = catEl.textContent.trim();

    // email in page text
    const emailMatch = document.body.innerText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : '';

    return { title, totalScore, reviewsCount, isClosed, address, phone, website, category, email };
  });

  if (!data) return null;
  if (skipClosed && data.isClosed) return null;

  // Strip Google Plus Codes (e.g. "BKX+QM", "9Q4W+X2") from address parts
  const isPlusCode = s => /^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,3}$/i.test(s.trim());
  const rawParts  = (data.address || '').split(',').map(s => s.trim()).filter(s => s && !isPlusCode(s));

  // Also strip standalone postal codes like "M5500" that sometimes appear as a part
  const isPostalOnly = s => /^[A-Z]?\d{4,5}([A-Z]{3})?$/.test(s.trim());
  const addrParts = rawParts.filter(s => !isPostalOnly(s));

  // Extract postal code if present inside any part
  let postalCode = '';
  rawParts.forEach(p => {
    const m = p.match(/\b([A-Z]?\d{4,5}[A-Z]{0,3})\b/);
    if (m && !postalCode) postalCode = m[1];
  });

  const street = addrParts[0] || '';
  const city   = addrParts[1] || '';
  const state  = addrParts[2] || '';
  const country = addrParts[3] || '';

  const phoneType = detectPhoneType(data.phone);

  return {
    title:          data.title,
    totalScore:     data.totalScore ?? '',
    reviewsCount:   data.reviewsCount ?? '',
    isClosed:       data.isClosed,
    street, city, state, country, postalCode,
    website:        data.website,
    phone:          data.phone,
    phoneType,
    email:          data.email,
    'categories/0': data.category,
    sourceUrl:      url,
  };
}

// ─── Deduplication key ────────────────────────────────────────────────────────
function dedupKey(item) {
  // Primary: phone number (normalised). Secondary: title+city
  const phone = (item.phone || '').replace(/\D/g, '');
  if (phone.length >= 7) return `phone:${phone}`;
  const t = (item.title || '').toLowerCase().trim();
  const c = (item.city  || '').toLowerCase().trim();
  return `name:${t}|${c}`;
}

// ─── Main scraper ─────────────────────────────────────────────────────────────
async function scrapeGoogleMaps(config, send, sessionId) {
  const {
    searchStringsArray = [],
    locationQuery      = '',
    maxCrawledPlaces   = 50,
    skipClosedPlaces   = false,
  } = config;

  const perTerm    = Math.ceil(maxCrawledPlaces / Math.max(searchStringsArray.length, 1));
  const totalTerms = searchStringsArray.length;
  const allResults = [];
  const seenKeys   = new Set();

  // ── Launch browser ──────────────────────────────────────────────────────────
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--lang=es-ES,es',
        '--window-size=1280,900',
      ],
      defaultViewport: { width: 1280, height: 900 },
      timeout: 30000,
    });
  } catch (launchErr) {
    send({ type: 'error', message: `No se pudo iniciar el navegador: ${launchErr.message}` });
    return [];
  }

  const session = sessions.get(sessionId);
  if (session) session.browser = browser;

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    for (let ti = 0; ti < totalTerms; ti++) {
      // Check if stopped
      if (sessions.get(sessionId)?.stopped) {
        send({ type: 'stopped', message: 'Búsqueda detenida por el usuario.' });
        break;
      }

      const term = searchStringsArray[ti];
      send({ type: 'term_start', termIndex: ti, totalTerms, term,
             message: `[${ti+1}/${totalTerms}] Buscando: "${term}" en ${locationQuery}` });

      try {
        await page.goto(buildUrl(term, locationQuery), { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(2000);
      } catch (e) {
        send({ type: 'warning', message: `No se pudo navegar: ${e.message}` });
        continue;
      }

      // Dismiss consent
      try {
        const btn = await page.$('button[aria-label*="Aceptar"], button[aria-label*="Accept"], form[action*="consent"] button');
        if (btn) { await btn.click(); await sleep(1500); }
      } catch (_) {}

      await autoScroll(page, perTerm);
      await sleep(400);

      const placeLinks = await page.$$eval('a[href*="/maps/place/"]', (els, max) => {
        const seen = new Set(), out = [];
        for (const el of els) {
          if (!seen.has(el.href)) { seen.add(el.href); out.push(el.href); }
          if (out.length >= max) break;
        }
        return out;
      }, perTerm);

      send({ type: 'log', message: `"${term}": ${placeLinks.length} lugares encontrados` });

      let termCount = 0;
      for (let i = 0; i < placeLinks.length; i++) {
        if (sessions.get(sessionId)?.stopped) break;

        const detail = await scrapePlaceDetail(page, placeLinks[i], skipClosedPlaces);

        let isDuplicate = false;
        if (detail) {
          const key = dedupKey(detail);
          if (seenKeys.has(key)) {
            isDuplicate = true;
          } else {
            seenKeys.add(key);
            detail.searchTerm = term;
            allResults.push(detail);
            termCount++;
          }
        }

        const globalPct = Math.round(((ti + (i + 1) / placeLinks.length) / totalTerms) * 100);
        const termPct   = Math.round(((i + 1) / placeLinks.length) * 100);

        send({
          type: 'progress',
          termIndex: ti, totalTerms, term,
          termPct, globalPct,
          termDone: i + 1, termTotal: placeLinks.length,
          globalDone: allResults.length,
          isDuplicate,
          message: isDuplicate
            ? `⏭ Duplicado omitido: ${detail?.title || ''}`
            : detail ? `✅ ${detail.title}` : `⚠ Sin datos`,
          latest: (!isDuplicate && detail) ? detail : null,
        });
      }

      send({ type: 'term_done', term, termIndex: ti, count: termCount,
             message: `"${term}" completado: ${termCount} únicos` });
    }
  } finally {
    await browser.close();
    sessions.delete(sessionId);
  }

  return allResults;
}

// ─── SSE scrape endpoint ──────────────────────────────────────────────
app.get('/api/scrape', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // Disable Nginx buffering if any
  res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  // Keepalive ping every 20 s to prevent ERR_CONNECTION_RESET
  const keepalive = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 20000);

  const send = d => {
    if (!closed) res.write(`data: ${JSON.stringify(d)}\n\n`);
  };

  let config;
  try { config = JSON.parse(req.query.config); }
  catch {
    send({ type: 'error', message: 'Config inválida.' });
    clearInterval(keepalive);
    return res.end();
  }

  const sessionId = req.query.sid || Date.now().toString();
  sessions.set(sessionId, { stopped: false, browser: null });

  try {
    const results = await scrapeGoogleMaps(config, send, sessionId);
    send({ type: 'done', results, total: results.length });
  } catch (err) {
    console.error('[scrape error]', err);
    send({ type: 'error', message: err.message });
  } finally {
    clearInterval(keepalive);
    sessions.delete(sessionId);
    res.end();
  }
});

// ─── Stop endpoint ────────────────────────────────────────────────────────────
app.post('/api/stop/:sid', (req, res) => {
  const session = sessions.get(req.params.sid);
  if (session) {
    session.stopped = true;
    res.json({ ok: true });
  } else {
    res.json({ ok: false, message: 'Sin sesión activa' });
  }
});

// ─── Export: CSV ──────────────────────────────────────────────────────────────
const FIELDS = [
  'title','totalScore','reviewsCount','isClosed',
  'street','city','state',
  'website','phone','phoneType','email','categories/0','searchTerm',
];

app.post('/api/export/csv', (req, res) => {
  const { data } = req.body;
  if (!data?.length) return res.status(400).json({ error: 'Sin datos.' });
  try {
    const parser = new Parser({ fields: FIELDS, delimiter: '\t' });
    const csv    = parser.parse(data);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="negocios.csv"');
    res.send('\uFEFF' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Export: JSON ─────────────────────────────────────────────────────────────
app.post('/api/export/json', (req, res) => {
  const { data } = req.body;
  if (!data?.length) return res.status(400).json({ error: 'Sin datos.' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="negocios.json"');
  res.send(JSON.stringify(data, null, 2));
});

// ─── Export: Excel ────────────────────────────────────────────────────────────
app.post('/api/export/excel', async (req, res) => {
  const { data } = req.body;
  if (!data?.length) return res.status(400).json({ error: 'Sin datos.' });

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Google Maps Scraper';
    const ws = wb.addWorksheet('Negocios', { views: [{ state: 'frozen', ySplit: 1 }] });

    // Columns
    ws.columns = [
      { header: 'Nombre',       key: 'title',          width: 35 },
      { header: 'Puntuación',   key: 'totalScore',     width: 12 },
      { header: 'Reseñas',      key: 'reviewsCount',   width: 12 },
      { header: 'Cerrado',      key: 'isClosed',       width: 10 },
      { header: 'Dirección',    key: 'street',         width: 30 },
      { header: 'Ciudad',       key: 'city',           width: 20 },
      { header: 'Provincia',    key: 'state',          width: 20 },
      { header: 'Teléfono',     key: 'phone',          width: 20 },
      { header: 'Tipo Tel.',    key: 'phoneType',      width: 13 },
      { header: 'Email',        key: 'email',          width: 28 },
      { header: 'Sitio Web',    key: 'website',        width: 35 },
      { header: 'Categoría',    key: 'categories/0',   width: 22 },
      { header: 'Término',      key: 'searchTerm',     width: 22 },
    ];

    // Header style
    ws.getRow(1).eachCell(cell => {
      cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A73E8' } };
      cell.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFcccccc' } },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    ws.getRow(1).height = 22;

    // Data rows
    data.forEach((item, idx) => {
      const row = ws.addRow({
        title:          item.title         || '',
        totalScore:     item.totalScore    !== '' ? Number(item.totalScore) : '',
        reviewsCount:   item.reviewsCount  !== '' ? Number(item.reviewsCount) : '',
        isClosed:       item.isClosed ? 'Sí' : 'No',
        street:         item.street        || '',
        city:           item.city          || '',
        state:          item.state         || '',
        phone:          item.phone         || '',
        phoneType:      item.phoneType     || '',
        email:          item.email         || '',
        website:        item.website       || '',
        'categories/0': item['categories/0'] || '',
        searchTerm:     item.searchTerm    || '',
      });

      // Colour mobile vs landline
      const ptCell = row.getCell('phoneType');
      if (item.phoneType === 'mobile')   { ptCell.font = { color: { argb: 'FF16A34A' }, bold: true }; ptCell.value = '📱 celular'; }
      if (item.phoneType === 'landline') { ptCell.font = { color: { argb: 'FF64748B' } };              ptCell.value = '☎ fijo'; }

      // Zebra stripe
      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F8FF' } };
        });
      }

      // Website as hyperlink
      const webCell = row.getCell('website');
      if (item.website) {
        webCell.value = { text: item.website, hyperlink: item.website };
        webCell.font  = { color: { argb: 'FF1A73E8' }, underline: true };
      }

      // isClosed colouring
      const closedCell = row.getCell('isClosed');
      if (item.isClosed) {
        closedCell.font = { color: { argb: 'FFD93025' }, bold: true };
      }

      row.eachCell(cell => { cell.alignment = { vertical: 'middle' }; });
    });

    // Auto-filter
    ws.autoFilter = { from: 'A1', to: ws.getRow(1).getCell(ws.columns.length) };

    // Send file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="negocios.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor → http://localhost:${PORT}`));
