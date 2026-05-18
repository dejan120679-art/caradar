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
      marke: '', modell: '', zusatz: '', preisMin: null, preisMax: null,
      kmMax: null, baujahrVon: null, baujahrBis: null,
      ort: '', radiusKm: null, zustand: [],
    };
  }
}

let CONFIG = loadConfig();

const TOKEN = process.env.TELEGRAM_TOKEN;
const USER_CONFIG_FILE   = path.join(__dirname, 'user-config.json');
const SEEN_FILE       = path.join(__dirname, 'seen.json');
const SENT_FILE       = path.join(__dirname, 'sent.json');
const LAST_ALERT_FILE    = path.join(__dirname, 'lastAlert.json');
const ALERT_HISTORY_FILE = path.join(__dirname, 'alertHistory.json');
const MODE_FILE          = path.join(__dirname, 'scraper-mode.json');
const STATE_FILE      = path.join(__dirname, 'browser-state.json');
const MAX_SEEN   = 1000;

function getChatId() {
  try {
    const uc = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'));
    if (uc.chatId) return uc.chatId;
  } catch {}
  return process.env.TELEGRAM_CHAT_ID || null;
}

const UA = 'CaRadar-Bot/1.0 (alert-service; contact: support@caradar.at)';

function randomInterval() {
  return Math.round((4 + Math.random() * 3) * 60 * 1000); // 4–7 min
}

const bot = new TelegramBot(TOKEN);

// Mapping: Config-Zustand → Teilstring im willhaben CONDITION_RESOLVED Attribut
const CONDITION_MAP = {
  gebraucht:     'gebraucht',
  jahreswagen:   'jahreswagen',
  neu:           'neu',
  oldtimer:      'oldtimer',
  tageszulassung:'tageszulassung',
  beschaedigt:   'unfall',   // CONDITION_RESOLVED liefert "Unfallwagen" für beide
  unfallwagen:   'unfall',
  vorführwagen:  'vorführwagen',
};

// Mapping: Config-Zustand → MOTOR_CONDITION URL-Parameter (willhaben-Codes)
const CONDITION_CODE_MAP = {
  gebraucht:     '20',
  jahreswagen:   '50',
  neu:           '10',
  oldtimer:      '93',
  tageszulassung:'91',
  beschaedigt:   '30',
  unfallwagen:   '30',
  vorführwagen:  '40',
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

  if (CONFIG.zustand && CONFIG.zustand.length > 0) {
    const codes = [...new Set(CONFIG.zustand.map(z => CONDITION_CODE_MAP[z]).filter(Boolean))];
    codes.forEach(c => q.append('MOTOR_CONDITION', c));
  }

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

// ─── Zeitzone ────────────────────────────────────────────────────────────────

function viennaDateHour() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vienna',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return {
    date:   `${p.year}-${p.month}-${p.day}`,
    hour:   parseInt(p.hour),
    minute: parseInt(p.minute),
  };
}

// ─── Persistenz ───────────────────────────────────────────────────────────────


function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    const ids = Array.isArray(raw) ? raw : (raw.ids || []);
    return {
      ids:                new Set(ids),
      lastAlertDate:      raw.lastAlertDate      || null,
      lastHeartbeatDate:  raw.lastHeartbeatDate  || null,
      alertsToday:        raw.alertsToday        || 0,
      alertsDate:         raw.alertsDate         || null,
      limitAlertSentDate: raw.limitAlertSentDate || null,
    };
  } catch {
    return { ids: new Set(), lastAlertDate: null, lastHeartbeatDate: null, alertsToday: 0, alertsDate: null, limitAlertSentDate: null };
  }
}

function saveSeen(ids, lastAlertDate, lastHeartbeatDate, alertsToday, alertsDate, limitAlertSentDate) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify({
    ids: [...ids].slice(-MAX_SEEN),
    lastAlertDate,
    lastHeartbeatDate,
    alertsToday,
    alertsDate,
    limitAlertSentDate,
  }));
}

function loadSent() {
  try {
    const raw = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8'));
    const ids = Array.isArray(raw) ? raw : (raw.ids || []);
    return new Set(ids);
  } catch { return new Set(); }
}

function saveSent(sentIds) {
  fs.writeFileSync(SENT_FILE, JSON.stringify({ ids: [...sentIds] }));
}

function saveLastAlert(vehicle, price, dateStr, ort) {
  const entry = { vehicle, price, dateStr, ort: ort || '' };
  fs.writeFileSync(LAST_ALERT_FILE, JSON.stringify(entry));
  let history = [];
  try { history = JSON.parse(fs.readFileSync(ALERT_HISTORY_FILE, 'utf8')); } catch {}
  if (!Array.isArray(history)) history = [];
  history.unshift(entry);
  fs.writeFileSync(ALERT_HISTORY_FILE, JSON.stringify(history.slice(0, 5)));
}

function getMode() {
  try { return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode || 'running'; }
  catch { return 'running'; }
}

function setMode(mode) {
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode }));
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
  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: 'de-AT',
      storageState: fs.existsSync(STATE_FILE) ? STATE_FILE : undefined,
    });
    const page = await ctx.newPage();
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
        const info  = ad.advertiserInfo || {};

        const sellerTypeRaw = get('SELLER_TYPE_RESOLVED') || get('SELLER_TYPE') || null;
        let sellerType = null;
        if (sellerTypeRaw !== null) {
          sellerType = sellerTypeRaw.toLowerCase().includes('privat') ? 'privat' : 'händler';
        } else if (info.isPrivate !== undefined) {
          sellerType = info.isPrivate ? 'privat' : 'händler';
        }

        return {
          id:          String(ad.id),
          description: (ad.description || '').trim(),
          body:        (ad.body || '').trim(),
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
          sellerType,
          phone:       info.phone || info.phoneNumber || (ad.contactData || {}).phone || null,
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
    const m = CONFIG.marke.toLowerCase().replace(/[-\s]+/g, '');
    if (!l.make.toLowerCase().replace(/[-\s]+/g, '').includes(m))
      return false;
  }
  if (CONFIG.modell) {
    const m = CONFIG.modell.toLowerCase().replace(/[-\s]+/g, '');
    if (!l.model.toLowerCase().replace(/[-\s]+/g, '').includes(m) &&
        !l.description.toLowerCase().replace(/[-\s]+/g, '').includes(m))
      return false;
  }
  if (CONFIG.zusatz && CONFIG.zusatz.trim()) {
    const z = CONFIG.zusatz.trim().toLowerCase();
    const hay = (l.description + ' ' + (l.body || '')).toLowerCase();
    if (!hay.includes(z)) return false;
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

  if ((CONFIG.zustand || []).length > 0) {
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

function isFresh(listing) {
  if (!CONFIG.maxAlterStunden) return true; // kein Limit gesetzt → immer senden
  if (!listing.published) return true;
  const ms = listing.published > 1e12 ? listing.published : listing.published * 1000;
  return Date.now() - ms < CONFIG.maxAlterStunden * 60 * 60 * 1000;
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
  const vehicle  = [CONFIG.marke, CONFIG.modell, CONFIG.zusatz].filter(Boolean).join(' ') || 'Fahrzeug';
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
  ].filter(Boolean).join(' · ');

  const techDetails = [
    listing.fuel         && listing.fuel.charAt(0).toUpperCase() + listing.fuel.slice(1),
    listing.transmission && listing.transmission.charAt(0).toUpperCase() + listing.transmission.slice(1),
  ].filter(Boolean).join(' · ');

  const locationStr = listing.district || listing.location || null;

  const sellerLine = listing.sellerType === 'privat'
    ? '👤 Privat'
    : listing.sellerType === 'händler'
      ? '🏢 Händler'
      : null;

  const header = pub?.isNew
    ? `🔴 NEU – <b>${escHtml(searchLabel())}!</b>`
    : `🚗 <b>Neues Inserat – ${escHtml(searchLabel())}!</b>`;

  const lines = [
    header,
    '',
    `📌 <b>${escHtml(listing.description)}</b>`,
    `💶 ${escHtml(priceStr)}`,
    details       ? `🔧 ${escHtml(details)}`      : null,
    techDetails   ? `⚙️ ${escHtml(techDetails)}`  : null,
    locationStr   ? `📍 ${escHtml(locationStr)}`  : null,
    sellerLine,
    listing.phone ? `📞 ${escHtml(listing.phone)}` : null,
    pub           ? `🕐 ${escHtml(pub.dateStr)}`   : null,
    '',
    `🔗 <a href="${url}">Inserat öffnen</a>`,
    '',
    '⚠️ Bitte Inserat und Verkäufer vor dem Kauf sorgfältig prüfen. CaRadar haftet nicht für Inseratsinhalte.',
  ].filter(l => l !== null);

  await bot.sendMessage(getChatId(), lines.join('\n'), { parse_mode: 'HTML' });
}

async function sendConfirmationAlert() {
  const vehicle  = [CONFIG.marke, CONFIG.modell].filter(Boolean).join(' ') || 'Alle Fahrzeuge';
  const location = CONFIG.ort || 'Österreich';
  const price    = CONFIG.preisMax
    ? `Preis bis ${CONFIG.preisMax.toLocaleString('de-AT')} €`
    : '';
  const parts = [vehicle, location, price].filter(Boolean).join(' · ');
  await bot.sendMessage(getChatId(),
    `✅ CaRadar aktiv — Suche läuft nach ${parts}. Ich benachrichtige dich sofort wenn ein passendes Inserat erscheint.`
  );
}

// ─── Haupt-Loop ───────────────────────────────────────────────────────────────

async function run() {
  CONFIG = loadConfig();
  const ts = new Date().toLocaleTimeString('de-AT');
  console.log(`[${ts}] Suche: ${searchLabel()} | URL: ${buildSearchUrl()}`);

  const { ids: seen, lastAlertDate, lastHeartbeatDate, alertsToday: _alertsToday, alertsDate, limitAlertSentDate } = loadSeen();
  const sent = loadSent();
  let newLastAlertDate      = lastAlertDate;
  let newLastHeartbeatDate  = lastHeartbeatDate;
  let newLimitAlertSentDate = limitAlertSentDate;

  const { date: today, hour, minute } = viennaDateHour();
  let alertsToday = (alertsDate === today) ? _alertsToday : 0;
  const maxDaily  = CONFIG.maxAlertsProTag || null;

  const listings = await scrapeListings();
  const unseen   = listings.filter(l => !seen.has(l.id) && !sent.has(l.id));
  const toAlert  = unseen.filter(isFresh);
  const tooOld   = unseen.filter(l => !isFresh(l));
  console.log(`  ${listings.length} Treffer | ${unseen.length} neu | ${toAlert.length} Alerts${tooOld.length ? ` | ${tooOld.length} zu alt` : ''}`);

  for (const l of toAlert) {
    if (maxDaily !== null && alertsToday >= maxDaily) {
      if (newLimitAlertSentDate !== today) {
        try {
          await bot.sendMessage(getChatId(),
            `⚠️ Tageslimit von ${maxDaily} Alerts erreicht — weitere Alerts erst wieder morgen.`
          );
          newLimitAlertSentDate = today;
          console.log('  Tageslimit erreicht.');
        } catch {}
      }
      seen.add(l.id);
      continue;
    }
    try {
      await sendAlert(l);
      seen.add(l.id);
      sent.add(l.id);
      alertsToday++;
      newLastAlertDate = today;
      const { date: ad, hour: ah, minute: am } = viennaDateHour();
      const dateStr = `${ad} ${String(ah).padStart(2,'0')}:${String(am).padStart(2,'0')}`;
      const vehicle = [l.make, l.model].filter(Boolean).join(' ') || l.description;
      const price   = l.price !== null ? `€ ${l.price.toLocaleString('de-AT')}` : 'Preis auf Anfrage';
      saveLastAlert(vehicle, price, dateStr, l.district || l.location || '');
      console.log(`  → Gesendet: ${l.description} (€ ${l.price})`);
    } catch (sendErr) {
      console.error(`  Telegram-Fehler: ${sendErr.message}`);
    }
  }
  tooOld.forEach(l => seen.add(l.id));

  // Tages-Heartbeat um 09:00 Uhr — nur wenn heute noch kein Alert und noch kein Heartbeat
  if (hour === 9 && minute < 5 && newLastAlertDate !== today && newLastHeartbeatDate !== today) {
    try {
      await bot.sendMessage(getChatId(),
        '✅ CaRadar läuft — heute noch keine neuen Inserate gefunden die deinen Kriterien entsprechen.'
      );
      newLastHeartbeatDate = today;
      console.log('  Tages-Heartbeat gesendet.');
    } catch (hbErr) {
      console.error(`  Heartbeat Telegram-Fehler: ${hbErr.message}`);
    }
  }

  saveSeen(seen, newLastAlertDate, newLastHeartbeatDate, alertsToday, today, newLimitAlertSentDate);
  saveSent(sent);
}

let errorCount = 0;

async function schedule() {
  try {
    await run();
    errorCount = 0;
    const delay = randomInterval();
    console.log(`  Nächster Lauf in ${Math.round(delay / 60000 * 10) / 10} Min`);
    setTimeout(schedule, delay);
  } catch (err) {
    errorCount++;
    const backoffMs = [60000, 120000, 240000][Math.min(errorCount - 1, 2)];
    console.error(`  Scraping-Fehler (Backoff ${backoffMs / 1000}s, Fehler #${errorCount}): ${err.message}`);
    if (errorCount >= 3) errorCount = 0;
    setTimeout(schedule, backoffMs);
  }
}

(async () => {
  if (!TOKEN || !getChatId()) {
    console.error('TELEGRAM_TOKEN fehlt in .env oder keine Telegram Chat-ID konfiguriert!');
    process.exit(1);
  }
  console.log('caradar gestartet');
  console.log(`Suche:    ${searchLabel()}`);
  console.log(`URL:      ${buildSearchUrl()}`);
  console.log('Interval: 4–7 Minuten (zufällig)\n');
  await ensureBrowserState();
  const mode = getMode();
  if (mode === 'resuming') {
    setMode('running');
    try {
      await bot.sendMessage(getChatId(), `▶️ CaRadar fortgesetzt — Suche läuft wieder nach ${searchLabel()}.`);
      console.log('Resume-Alert gesendet.');
    } catch (err) {
      console.error(`Resume-Alert fehlgeschlagen: ${err.message}`);
    }
  } else {
    try {
      await sendConfirmationAlert();
      console.log('Bestätigungs-Alert gesendet.');
    } catch (err) {
      console.error(`Bestätigungs-Alert fehlgeschlagen: ${err.message}`);
    }
  }
  await schedule();
})();
