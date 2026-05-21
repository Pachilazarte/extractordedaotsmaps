const express = require('express');
const puppeteer = require('puppeteer');
const { Parser } = require('json2csv');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildGoogleMapsUrl(searchTerm, locationQuery) {
  const q = locationQuery ? `${searchTerm} en ${locationQuery}` : searchTerm;
  return `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
}

async function autoScroll(page, maxItems) {
  let prevCount = 0;
  let stableRounds = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (feed) feed.scrollBy(0, 1200);
    });
    await sleep(700);

    const count = await page.$$eval('a[href*="/maps/place/"]', els => {
      const seen = new Set();
      for (const el of els) seen.add(el.href);
      return seen.size;
    });

    if (count >= maxItems) break;
    if (count === prevCount) {
      stableRounds++;
      if (stableRounds >= 4) break; // no more results loading
    } else {
      stableRounds = 0;
    }
    prevCount = count;
  }
}

// ─── Per-place detail scraper ─────────────────────────────────────────────────

async function scrapePlaceDetail(page, url, skipClosed) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1200);
  } catch {
    return null;
  }

  const data = await page.evaluate(() => {
    // ── Title ──
    const title = (document.querySelector('h1.DUwDvf') || document.querySelector('h1'))?.textContent?.trim() || '';

    // ── Rating & reviews ──
    const ratingEl  = document.querySelector('div.F7nice span[aria-hidden="true"]');
    const totalScore = ratingEl ? parseFloat(ratingEl.textContent.replace(',', '.')) : null;
    const reviewsEl  = document.querySelector('div.F7nice span[aria-label]');
    let reviewsCount = null;
    if (reviewsEl) {
      const m = reviewsEl.getAttribute('aria-label').match(/[\d.,]+/);
      if (m) reviewsCount = parseInt(m[0].replace(/[.,]/g, ''));
    }

    // ── Open/Closed ──
    const closedEl = document.querySelector('.o0Svhf') || document.querySelector('[data-hide-tooltip-on-mouse-leave] span');
    const isClosed = closedEl ? /cerrado|closed|permanentemente/i.test(closedEl.textContent) : false;

    // ── Address ──
    let address = '';
    const addrBtn = document.querySelector('button[data-item-id="address"]');
    if (addrBtn) address = addrBtn.querySelector('.Io6YTe, .rogA2c')?.textContent?.trim() || '';
    // Fallback: aria-label
    if (!address) {
      const addrAria = document.querySelector('[data-item-id="address"]');
      if (addrAria) address = addrAria.getAttribute('aria-label')?.replace(/^Dirección:\s*/i, '').trim() || '';
    }

    // ── Phone ──
    let phone = '';
    const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
    if (phoneBtn) phone = phoneBtn.querySelector('.Io6YTe, .rogA2c')?.textContent?.trim() || '';

    // ── Website ──
    let website = '';
    const webBtn = document.querySelector('a[data-item-id="authority"]');
    if (webBtn) website = webBtn.href || '';

    // ── Category ──
    let category = '';
    const catEl = document.querySelector('button.DkEaL');
    if (catEl) category = catEl.textContent.trim();

    // ── Plus Code / Postal Code ──
    let postalCode = '';
    const plusEl = document.querySelector('button[data-item-id*="oloc"]');
    if (plusEl) postalCode = plusEl.querySelector('.Io6YTe')?.textContent?.trim() || '';

    // ── Email (sometimes in description) ──
    const bodyText = document.body.innerText;
    const emailMatch = bodyText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : '';

    return { title, totalScore, reviewsCount, isClosed, address, phone, website, category, postalCode, email };
  });

  if (!data) return null;
  if (skipClosed && data.isClosed) return null;

  // Parse address into parts
  const addrParts = (data.address || '').split(',').map(s => s.trim());
  const street  = addrParts[0] || '';
  const city    = addrParts[1] || '';
  const stateRaw = addrParts[2] || '';
  const country  = addrParts[3] || '';
  // Try to extract province from state string
  const state   = stateRaw.replace(/\d{4,}/g, '').trim();
  const countryCode = country.trim().toUpperCase().slice(0, 2) || '';

  return {
    title:         data.title,
    totalScore:    data.totalScore ?? '',
    reviewsCount:  data.reviewsCount ?? '',
    isClosed:      data.isClosed,
    street,
    city,
    state,
    countryCode,
    postalCode:    data.postalCode,
    website:       data.website,
    phone:         data.phone,
    email:         data.email,
    'categories/0': data.category,
  };
}

// ─── Main Scraper ─────────────────────────────────────────────────────────────

async function scrapeGoogleMaps(config, send) {
  const {
    searchStringsArray = [],
    locationQuery = '',
    maxCrawledPlaces = 20,
    skipClosedPlaces = false,
    scrapeContacts = true,
  } = config;

  const allResults = [];
  const perTerm    = Math.ceil(maxCrawledPlaces / Math.max(searchStringsArray.length, 1));
  const totalTerms = searchStringsArray.length;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=es-ES,es',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    for (let termIdx = 0; termIdx < totalTerms; termIdx++) {
      const term = searchStringsArray[termIdx];
      const url  = buildGoogleMapsUrl(term, locationQuery);

      send({
        type: 'term_start',
        termIndex: termIdx,
        totalTerms,
        term,
        message: `[${termIdx + 1}/${totalTerms}] Buscando: "${term}" en ${locationQuery}`,
      });

      // Navigate to search
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(2000);
      } catch (e) {
        send({ type: 'warning', message: `Error al navegar: ${e.message}` });
        continue;
      }

      // Accept cookies/consent
      try {
        const btn = await page.$('button[aria-label*="Aceptar"], button[aria-label*="Accept"], form[action*="consent"] button');
        if (btn) { await btn.click(); await sleep(1500); }
      } catch (_) {}

      send({ type: 'log', message: `Scrolleando resultados para "${term}"…` });
      await autoScroll(page, perTerm);
      await sleep(500);

      // Collect unique place URLs
      const placeLinks = await page.$$eval('a[href*="/maps/place/"]', (els, max) => {
        const seen = new Set();
        const out  = [];
        for (const el of els) {
          if (!seen.has(el.href)) { seen.add(el.href); out.push(el.href); }
          if (out.length >= max) break;
        }
        return out;
      }, perTerm);

      send({ type: 'log', message: `"${term}": ${placeLinks.length} lugares encontrados. Extrayendo detalles…` });

      const termResults = [];
      for (let i = 0; i < placeLinks.length; i++) {
        const detail = await scrapePlaceDetail(page, placeLinks[i], skipClosedPlaces);
        if (detail) {
          detail.searchTerm = term;
          termResults.push(detail);
          allResults.push(detail);
        }

        const globalDone  = allResults.length;
        const globalTotal = placeLinks.length + (termIdx > 0 ? allResults.length - termResults.length : 0);
        const termPct     = Math.round(((i + 1) / placeLinks.length) * 100);
        const globalPct   = Math.round(
          ((termIdx + (i + 1) / placeLinks.length) / totalTerms) * 100
        );

        send({
          type:       'progress',
          termIndex:  termIdx,
          totalTerms,
          term,
          termPct,
          globalPct,
          termDone:   i + 1,
          termTotal:  placeLinks.length,
          globalDone,
          message:    detail ? `✅ ${detail.title}` : `⏭ Omitido`,
          latest:     detail || null,
        });
      }

      send({
        type: 'term_done',
        term,
        termIndex: termIdx,
        count: termResults.length,
        message: `"${term}" completado: ${termResults.length} resultados`,
      });
    }
  } finally {
    await browser.close();
  }

  return allResults;
}

// ─── SSE Endpoint ─────────────────────────────────────────────────────────────

app.get('/api/scrape', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let config;
  try {
    config = JSON.parse(req.query.config);
  } catch {
    send({ type: 'error', message: 'Config inválida.' });
    return res.end();
  }

  try {
    const results = await scrapeGoogleMaps(config, send);
    send({ type: 'done', results, total: results.length });
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// ─── Export Endpoints ─────────────────────────────────────────────────────────

const FIELDS = [
  'title', 'totalScore', 'reviewsCount', 'isClosed',
  'street', 'city', 'state', 'countryCode', 'postalCode',
  'website', 'phone', 'email', 'categories/0', 'searchTerm',
];

app.post('/api/export/csv', (req, res) => {
  const { data } = req.body;
  if (!data?.length) return res.status(400).json({ error: 'Sin datos.' });
  try {
    const parser = new Parser({ fields: FIELDS, delimiter: '\t' });
    const csv = parser.parse(data);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="negocios.csv"');
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/export/json', (req, res) => {
  const { data } = req.body;
  if (!data?.length) return res.status(400).json({ error: 'Sin datos.' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="negocios.json"');
  res.send(JSON.stringify(data, null, 2));
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo → http://localhost:${PORT}`);
});
