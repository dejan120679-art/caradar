require('dotenv').config();
const { chromium } = require('playwright');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {
      marke: '', modell: '', preisMin: null, preisMax: null,
      kmMax: null, baujahrVon: null, baujahrBis: null,
      ort: '', radiusKm: null, zustand: [],
    };
  }
}

let CONFIG = loadConfig();

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SEEN_FILE  = path.join(__dirname, 'seen.json');
const STATE_FILE = path.join(__dirname, 'browser-state.json');
const INTERVAL   = 5 * 60 * 1000;
const MAX_SEEN   = 1000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const bot = new TelegramBot(TOKEN);

// Mapping: Config-Zustand → Teilstring im willhaben CONDITION_RESOLVED Attribut
const CONDITION_MAP = {
  gebraucht:   'gebraucht',
  neu:         'neu',
  beschaedigt: 'beschädigt',
  unfallwagen: 'unfall',
};

// ─── URL-Aufbau ───────────────────────────────────────────────────────────────

function toSlug(str) {
  return String(str)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildSearchUrl() {
  const q = new URLSearchParams();
  q.set('b_isNavigation', 'true');
  q.set('sort', '1');
  q.set('rows', '100');

  if (CONFIG.preisMin)   q.set('PRICE_FROM',     String(CONFIG.preisMin));
  if (CONFIG.preisMax)   q.set('PRICE_TO',        String(CONFIG.preisMax));
  if (CONFIG.kmMax)      q.set('MILEAGE_TO',      String(CONFIG.kmMax));
  if (CONFIG.baujahrVon) q.set('YEAR_MODEL_FROM', String(CONFIG.baujahrVon));
  if (CONFIG.baujahrBis) q.set('YEAR_MODEL_TO',   String(CONFIG.baujahrBis));

  // Pfad-basiertes Make/Model-Filtering — willhaben-Slugs folgen dem Muster
  // "{marke}-gebrauchtwagen/{marke}-{modell}-gebrauchtwagen"
  let subPath;
  if (CONFIG.marke && CONFIG.modell) {
    const ms = toSlug(CONFIG.marke);
    const mo = toSlug(CONFIG.modell);
    subPath = `${ms}-gebrauchtwagen/${ms}-${mo}-gebrauchtwagen`;
  } else if (CONFIG.marke) {
    subPath = `${toSlug(CONFIG.marke)}-gebrauchtwagen`;
  } else {
    subPath = 'gebrauchtwagenboerse';
  }

  return `https://www.willhaben.at/iad/gebrauchtwagen/auto/${subPath}/?${q.toString()}`;
}

// ─── Persistenz ───────────────────────────────────────────────────────────────

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-MAX_SEEN)));
}

// ─── Browser-State (Cookies einmalig akzeptieren) ─────────────────────────────

async function ensureBrowserState() {
  if (fs.existsSync(STATE_FILE)) return;
  console.log('Initialisiere Browser-State (Cookie-Einwilligung)...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'de-AT' });
  const page = await ctx.newPage();
  await page.goto('https://www.willhaben.at', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2000);
  const btn = page.locator('#didomi-notice-agree-button').first();
  if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(2000);
    console.log('Cookies akzeptiert.');
  }
  await ctx.storageState({ path: STATE_FILE });
  await browser.close();
  console.log('Browser-State gespeichert.\n');
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

async function scrapeListings() {
  const searchUrl = buildSearchUrl();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'de-AT',
    storageState: fs.existsSync(STATE_FILE) ? STATE_FILE : undefined,
  });
  const page = await ctx.newPage();

  try {
    await page.goto(searchUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Cookie-Dialog erneut akzeptieren falls State abgelaufen
    const btn = page.locator('#didomi-notice-agree-button').first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(2000);
      await ctx.storageState({ path: STATE_FILE });
    }

    const raw = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return [];
      const data = JSON.parse(el.textContent);
      const pp   = data?.props?.pageProps || {};
      const ads  =
        pp.searchResult?.advertSummaryList?.advertSummary ||
        pp.initialSearchResult?.advertSummaryList?.advertSummary || [];

      return ads.map(ad => {
        const attrs = ad.attributes?.attribute || [];
        const get   = n => attrs.find(a => a.name === n)?.values?.[0] ?? null;
        return {
          id:          String(ad.id),
          description: (ad.description || '').trim(),
          make:        (get('CAR_MODEL/MAKE')       || '').trim(),
          model:       (get('CAR_MODEL/MODEL')      || '').trim(),
          state:       (get('STATE')                || '').trim(),
          location:    (get('LOCATION')             || '').trim(),
          district:    (get('DISTRICT')             || '').trim(),
          price:       get('PRICE')   !== null ? Number(get('PRICE'))   : null,
          year:        get('YEAR_MODEL')             || '',
          mileage:     get('MILEAGE') !== null ? Number(get('MILEAGE')) : null,
          seoUrl:      get('SEO_URL')                || '',
          published:   get('PUBLISHED') !== null ? Number(get('PUBLISHED')) : null,
          condition:   (get('CONDITION_RESOLVED')   || '').toLowerCase(),
          fuel:        (get('ENGINE/FUEL_RESOLVED')    || '').toLowerCase(),
          transmission:(get('TRANSMISSION_RESOLVED') || '').toLowerCase(),
        };
      });
    });

    return raw.filter(matchesConfig);
  } finally {
    await browser.close();
  }
}

// ─── Client-seitige Filter ────────────────────────────────────────────────────

function matchesConfig(l) {
  if (CONFIG.marke) {
    const m = CONFIG.marke.toLowerCase();
    if (!l.make.toLowerCase().includes(m))
      return false;
  }
  if (CONFIG.modell) {
    const m = CONFIG.modell.toLowerCase();
    if (!l.model.toLowerCase().includes(m) && !l.description.toLowerCase().includes(m))
      return false;
  }
  if (CONFIG.preisMin  !== null && l.price   !== null && l.price   < CONFIG.preisMin)  return false;
  if (CONFIG.preisMax  !== null && l.price   !== null && l.price   > CONFIG.preisMax)  return false;
  if (CONFIG.kmMax     !== null && l.mileage !== null && l.mileage > CONFIG.kmMax)     return false;
  if (CONFIG.baujahrVon        && l.year && Number(l.year) < CONFIG.baujahrVon)        return false;
  if (CONFIG.baujahrBis        && l.year && Number(l.year) > CONFIG.baujahrBis)        return false;

  if (CONFIG.ort) {
    const o = CONFIG.ort.toLowerCase();
    const ortMatch =
      l.state.toLowerCase().includes(o) ||
      l.location.toLowerCase().includes(o) ||
      l.district.toLowerCase().includes(o);
    if (!ortMatch) return false;
  }

  if (CONFIG.zustand.length > 0) {
    const hit = CONFIG.zustand.some(z => {
      const target = CONDITION_MAP[z] ?? z.toLowerCase();
      return l.condition.includes(target);
    });
    if (!hit) return false;
  }

  if (CONFIG.kraftstoff && CONFIG.kraftstoff.length > 0) {
    const hit = CONFIG.kraftstoff.some(k => l.fuel.includes(k.toLowerCase()));
    if (!hit) return false;
  }

  if (CONFIG.getriebe && CONFIG.getriebe.length > 0) {
    const hit = CONFIG.getriebe.some(g => l.transmission.includes(g.toLowerCase()));
    if (!hit) return false;
  }

  if (CONFIG.maxAlterStunden) {
    if (l.published === null) return false;
    const ms = l.published > 1e12 ? l.published : l.published * 1000;
    if (Date.now() - ms > CONFIG.maxAlterStunden * 60 * 60 * 1000) return false;
  }

  return true;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function escHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPublished(published) {
  if (!published) return null;
  const ms = published > 1e12 ? published : published * 1000;
  const d  = new Date(ms);
  if (isNaN(d)) return null;
  const isNew   = Date.now() - ms < 60 * 60 * 1000;
  const dateStr = d.toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Vienna',
  });
  return { dateStr, isNew };
}

function searchLabel() {
  const vehicle  = [CONFIG.marke, CONFIG.modell].filter(Boolean).join(' ') || 'Fahrzeug';
  const location = CONFIG.ort || 'Österreich';
  const price    = CONFIG.preisMax
    ? `≤ € ${CONFIG.preisMax.toLocaleString('de-AT')}`
    : '';
  return [vehicle, location, price].filter(Boolean).join(' · ');
}

async function sendAlert(listing) {
  const url = listing.seoUrl
    ? `https://www.willhaben.at/iad/${listing.seoUrl}`
    : `https://www.willhaben.at/iad/gebrauchtwagen/d/auto/-${listing.id}/`;

  const pub      = formatPublished(listing.published);
  const priceStr = listing.price !== null
    ? `€ ${listing.price.toLocaleString('de-AT')}`
    : 'Preis auf Anfrage';

  const details = [
    listing.year             && `Baujahr ${listing.year}`,
    listing.mileage !== null && `${listing.mileage.toLocaleString('de-AT')} km`,
    listing.location,
  ].filter(Boolean).join(' · ');

  const techDetails = [
    listing.fuel         && listing.fuel.charAt(0).toUpperCase() + listing.fuel.slice(1),
    listing.transmission && listing.transmission.charAt(0).toUpperCase() + listing.transmission.slice(1),
  ].filter(Boolean).join(' · ');

  const header = pub?.isNew
    ? `🔴 NEU – <b>${escHtml(searchLabel())}!</b>`
    : `🚗 <b>Neues Inserat – ${escHtml(searchLabel())}!</b>`;

  const lines = [
    header,
    '',
    `📌 <b>${escHtml(listing.description)}</b>`,
    `💶 ${escHtml(priceStr)}`,
    details     ? `📍 ${escHtml(details)}`     : null,
    techDetails ? `⚙️ ${escHtml(techDetails)}` : null,
    pub         ? `🕐 ${escHtml(pub.dateStr)}`  : null,
    '',
    `🔗 <a href="${url}">Inserat öffnen</a>`,
  ].filter(l => l !== null);

  await bot.sendMessage(CHAT_ID, lines.join('\n'), { parse_mode: 'HTML' });
}

// ─── Haupt-Loop ───────────────────────────────────────────────────────────────

async function run() {
  CONFIG = loadConfig();
  const ts = new Date().toLocaleTimeString('de-AT');
  console.log(`[${ts}] Suche: ${searchLabel()}`);
  const seen = loadSeen();
  try {
    const listings = await scrapeListings();
    const fresh    = listings.filter(l => !seen.has(l.id));
    console.log(`  ${listings.length} Treffer | ${fresh.length} neu`);
    for (const l of fresh) {
      try {
        await sendAlert(l);
        seen.add(l.id);
        console.log(`  → Gesendet: ${l.description} (€ ${l.price})`);
      } catch (sendErr) {
        console.error(`  Telegram-Fehler: ${sendErr.message}`);
      }
    }
    saveSeen(seen);
  } catch (err) {
    console.error(`  Fehler: ${err.message}`);
  }
}

(async () => {
  if (!TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_TOKEN oder TELEGRAM_CHAT_ID fehlt in .env!');
    process.exit(1);
  }
  console.log('caradar gestartet');
  console.log(`Suche:    ${searchLabel()}`);
  console.log(`URL:      ${buildSearchUrl()}`);
  console.log('Interval: alle 5 Minuten\n');
  await ensureBrowserState();
  await run();
  setInterval(run, INTERVAL);
})();
