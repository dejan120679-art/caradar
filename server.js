require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');

function runCmd(cmd, callback) {
  const child = spawn(cmd, [], { windowsHide: true, shell: true });
  let stdout = '';
  child.stdout.on('data', d => stdout += d);
  child.on('close', code =>
    callback(code !== 0 ? new Error(`pm2 exited with code ${code}`) : null, stdout)
  );
}

const app             = express();
const PORT            = 3000;
const CONFIG_FILE     = path.join(__dirname, 'config.json');
const SEEN_FILE       = path.join(__dirname, 'seen.json');
const MODE_FILE       = path.join(__dirname, 'scraper-mode.json');
const LAST_ALERT_FILE    = path.join(__dirname, 'lastAlert.json');
const ALERT_HISTORY_FILE = path.join(__dirname, 'alertHistory.json');
const LOG_OUT            = path.join(os.homedir(), '.pm2', 'logs', 'caradar-out.log');
const USER_CONFIG_FILE   = path.join(__dirname, 'user-config.json');
const SENT_FILE          = path.join(__dirname, 'sent.json');

const PASSWORD = process.env.CARADAR_PASSWORD;
const SECRET   = process.env.CARADAR_SECRET;
if (!PASSWORD || !SECRET) {
  console.error('FEHLER: CARADAR_PASSWORD und CARADAR_SECRET müssen in .env gesetzt sein.');
  process.exit(1);
}
const VALID_TOKEN = crypto.createHmac('sha256', SECRET).update(PASSWORD).digest('hex');

const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= 5) return false;
    entry.count++;
    return true;
  }
  loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt < now) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function getCookie(req, name) {
  const cookieStr = req.headers.cookie || '';
  const cookie = cookieStr.split(';').find(c => c.trim().startsWith(name + '='));
  return cookie ? cookie.trim().slice(name.length + 1) : null;
}

function isAuthenticated(req) {
  return getCookie(req, 'crsid') === VALID_TOKEN;
}

function getMode() {
  try { return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode || 'stopped'; }
  catch { return 'stopped'; }
}

function setMode(mode) {
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode }));
}

function getLastAlert() {
  try { return JSON.parse(fs.readFileSync(LAST_ALERT_FILE, 'utf8')); }
  catch { return null; }
}

function getSearchLabel() {
  try {
    const cfg      = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const vehicle  = [cfg.marke, cfg.modell, cfg.zusatz].filter(Boolean).join(' ') || 'Fahrzeug';
    const location = (cfg.plz && cfg.radiusKm)
      ? `${cfg.plz} +${cfg.radiusKm} km`
      : (cfg.ort || 'Österreich');
    const price    = cfg.preisMax ? `≤ € ${cfg.preisMax.toLocaleString('de-AT')}` : '';
    return [vehicle, location, price].filter(Boolean).join(' · ');
  } catch { return ''; }
}

function getAlertsToday() {
  try {
    const raw   = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(new Date());
    return raw.alertsDate === today ? (raw.alertsToday || 0) : 0;
  } catch { return 0; }
}

function getEffectiveChatId() {
  try {
    const uc = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'));
    if (uc.chatId) return uc.chatId;
  } catch {}
  return process.env.TELEGRAM_CHAT_ID || null;
}

function sendTelegram(text, chatIdOverride) {
  return new Promise((resolve, reject) => {
    const token  = process.env.TELEGRAM_TOKEN;
    const chatId = chatIdOverride || getEffectiveChatId();
    if (!token)  return reject(new Error('TELEGRAM_TOKEN fehlt in .env'));
    if (!chatId) return reject(new Error('Keine Chat-ID konfiguriert'));
    const body = JSON.stringify({ chat_id: chatId, text });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.use(express.json({ limit: '32kb' }));

// ── Input-Validierung ─────────────────────────────────────────────────────────

function validateChatId(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^-?\d{1,20}$/.test(s)) return undefined;
  return s;
}

function clampStr(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max);
}

function intOrNull(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < min || n > max) return undefined;
  return n;
}

function strArray(v, allowed, maxItems) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(x => String(x)).filter(x => allowed.includes(x)))].slice(0, maxItems);
}

const ALLOWED_ZUSTAND    = ['gebraucht','neu','beschaedigt','unfallwagen','jahreswagen','oldtimer','tageszulassung','vorführwagen'];
const ALLOWED_KRAFTSTOFF = ['benzin','diesel','elektro','hybrid'];
const ALLOWED_GETRIEBE   = ['automatik','schaltgetriebe'];
const ALLOWED_ALTER      = ['egal','new','1','24','168','min168'];

function validateConfig(input) {
  if (!input || typeof input !== 'object') return null;
  const c = {
    marke:      clampStr(input.marke,      40),
    modell:     clampStr(input.modell,     40),
    zusatz:     clampStr(input.zusatz,     60),
    ort:        clampStr(input.ort,        40),
    plz:        clampStr(input.plz,        10),
    preisMin:   intOrNull(input.preisMin,   0, 10_000_000),
    preisMax:   intOrNull(input.preisMax,   0, 10_000_000),
    kmMax:      intOrNull(input.kmMax,      0,  9_999_999),
    baujahrVon: intOrNull(input.baujahrVon, 1900, 2100),
    baujahrBis: intOrNull(input.baujahrBis, 1900, 2100),
    radiusKm:   intOrNull(input.radiusKm,   0, 1000),
    zustand:    strArray(input.zustand,    ALLOWED_ZUSTAND,    ALLOWED_ZUSTAND.length),
    kraftstoff: strArray(input.kraftstoff, ALLOWED_KRAFTSTOFF, ALLOWED_KRAFTSTOFF.length),
    getriebe:   strArray(input.getriebe,   ALLOWED_GETRIEBE,   ALLOWED_GETRIEBE.length),
    maxAlterStunden: intOrNull(input.maxAlterStunden, 0, 100_000),
    minAlterStunden: intOrNull(input.minAlterStunden, 0, 100_000),
    alterFilter: ALLOWED_ALTER.includes(input.alterFilter) ? input.alterFilter : 'egal',
  };
  for (const v of Object.values(c)) if (v === undefined) return null;
  return c;
}

// ── Unprotected routes ────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/impressum', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'impressum.html'));
});

app.get('/datenschutz', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'datenschutz.html'));
});

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte warte 60 Sekunden.' });
  }
  const { password } = req.body;
  if (password !== PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const maxAge = 7 * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `crsid=${VALID_TOKEN}; HttpOnly; Max-Age=${maxAge}; Path=/; SameSite=Strict`);
  res.json({ ok: true });
});

// ── Auth middleware ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (!isAuthenticated(req)) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nicht angemeldet' });
    return res.redirect('/login');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Protected API routes ──────────────────────────────────────────────────────

app.get('/api/user-config', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'))); }
  catch { res.json({ chatId: null }); }
});

app.post('/api/user-config', (req, res) => {
  const chatId = validateChatId(req.body?.chatId);
  if (chatId === undefined) return res.status(400).json({ error: 'Ungültige Chat-ID (nur Ziffern, optional führendes Minus)' });
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify({ chatId }, null, 2));
  res.json({ ok: true });
});

app.post('/api/test-alert', async (req, res) => {
  const override = validateChatId(req.body?.chatId);
  if (override === undefined) return res.status(400).json({ error: 'Ungültige Chat-ID' });
  const chatId = override || getEffectiveChatId();
  if (!chatId) return res.status(400).json({ error: 'Keine Chat-ID konfiguriert' });
  try {
    await sendTelegram('✅ CaRadar Test — Verbindung erfolgreich!', chatId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    res.json(null);
  }
});

app.post('/api/config', (req, res) => {
  const config = validateConfig(req.body?.config);
  if (!config) return res.status(400).json({ error: 'Ungültige Konfiguration' });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  if (req.body?.resetSeen) {
    try { fs.unlinkSync(SEEN_FILE); } catch {}
    try { fs.unlinkSync(SENT_FILE); } catch {}
  }
  setMode('running');
  runCmd('pm2 restart caradar', err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.get('/api/status', (req, res) => {
  runCmd('pm2 jlist', (err, stdout) => {
    let proc = null;
    try { proc = JSON.parse(stdout || '[]').find(p => p.name === 'caradar'); } catch {}

    let logs = [];
    try {
      const raw = fs.readFileSync(LOG_OUT, 'utf8');
      logs = raw.split('\n')
        .filter(Boolean)
        .slice(-30)
        .map(l => l.replace(/^0\|caradar\s+\|\s?/, '').trim())
        .filter(Boolean);
    } catch {}

    res.json({
      status:      proc?.pm2_env?.status      ?? 'stopped',
      restarts:    proc?.pm2_env?.restart_time ?? 0,
      uptime:      proc?.pm2_env?.pm_uptime    ?? null,
      memory:      proc?.monit?.memory         ?? null,
      logs,
      mode:        getMode(),
      lastAlert:   getLastAlert(),
      searchLabel: getSearchLabel(),
      alertsToday: getAlertsToday(),
    });
  });
});

app.post('/api/action', async (req, res) => {
  const { action } = req.body;

  if (action === 'stop') {
    setMode('stopped');
    runCmd('pm2 stop caradar', async err => {
      if (err) return res.status(500).json({ error: err.message });
      try { await sendTelegram('⏹️ CaRadar gestoppt — keine weiteren Alerts bis du die Suche neu startest.'); } catch {}
      res.json({ ok: true });
    });
  } else if (action === 'pause') {
    setMode('paused');
    runCmd('pm2 stop caradar', err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  } else if (action === 'resume') {
    setMode('resuming');
    runCmd('pm2 restart caradar', err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  } else {
    runCmd('pm2 restart caradar', err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  }
});

app.get('/api/lastalertes', (req, res) => {
  try {
    const history = JSON.parse(fs.readFileSync(ALERT_HISTORY_FILE, 'utf8'));
    res.json(Array.isArray(history) ? history : []);
  } catch {
    res.json([]);
  }
});

app.listen(PORT, () =>
  console.log(`caradar UI → http://localhost:${PORT}`)
);
