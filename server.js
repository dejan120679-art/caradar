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
const LOG_ERR            = path.join(os.homedir(), '.pm2', 'logs', 'caradar-error.log');
const USER_CONFIG_FILE   = path.join(__dirname, 'user-config.json');

const PASSWORD    = 'caradar777';
const SECRET      = 'caradar-session-secret-x9k2m';
const VALID_TOKEN = crypto.createHmac('sha256', SECRET).update(PASSWORD).digest('hex');

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
    const location = cfg.ort || 'Österreich';
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
    if (!token || !chatId) return resolve();
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

app.use(express.json());

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
  const { chatId } = req.body;
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify({ chatId: chatId || null }, null, 2));
  res.json({ ok: true });
});

app.post('/api/test-alert', async (req, res) => {
  const chatId = req.body.chatId || getEffectiveChatId();
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
  const { config, resetSeen } = req.body;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  if (resetSeen) {
    try { fs.unlinkSync(SEEN_FILE); } catch {}
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
      alertsMax:   (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')).maxAlertsProTag || null; } catch { return null; } })(),
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
