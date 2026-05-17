require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

function runCmd(cmd, callback) {
  const child = spawn(cmd, [], { windowsHide: true, shell: true });
  let stdout = '';
  child.stdout.on('data', d => stdout += d);
  child.on('close', code =>
    callback(code !== 0 ? new Error(`pm2 exited with code ${code}`) : null, stdout)
  );
}

const app        = express();
const PORT       = 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const SEEN_FILE  = path.join(__dirname, 'seen.json');
const LOG_OUT    = path.join(os.homedir(), '.pm2', 'logs', 'caradar-out.log');
const LOG_ERR    = path.join(os.homedir(), '.pm2', 'logs', 'caradar-error.log');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Aktuelle Config lesen
app.get('/api/config', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    res.json(null); // keine config.json → leeres Formular
  }
});

// Config speichern + Scraper neu starten
app.post('/api/config', (req, res) => {
  const { config, resetSeen } = req.body;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  if (resetSeen) {
    try { fs.unlinkSync(SEEN_FILE); } catch {}
  }
  runCmd('pm2 restart caradar', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// pm2-Status + Log
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
      status:   proc?.pm2_env?.status   ?? 'stopped',
      restarts: proc?.pm2_env?.restart_time ?? 0,
      uptime:   proc?.pm2_env?.pm_uptime ?? null,
      memory:   proc?.monit?.memory     ?? null,
      logs,
    });
  });
});

// Scraper stoppen / starten
app.post('/api/action', (req, res) => {
  const cmd = req.body.action === 'stop' ? 'pm2 stop caradar' : 'pm2 restart caradar';
  runCmd(cmd, err => err
    ? res.status(500).json({ error: err.message })
    : res.json({ ok: true })
  );
});

app.listen(PORT, () =>
  console.log(`caradar UI → http://localhost:${PORT}`)
);
