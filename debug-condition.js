require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

const STATE_FILE = 'browser-state.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// __NEXT_DATA__ Struktur analysieren um aktive Filter zu finden
const URL = 'https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse/?b_isNavigation=true&sort=1&rows=20';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'de-AT',
    storageState: fs.existsSync(STATE_FILE) ? STATE_FILE : undefined,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);

  const results = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return [];
    const data = JSON.parse(el.textContent);
    const pp = data?.props?.pageProps || {};
    const ads = pp.searchResult?.advertSummaryList?.advertSummary ||
                pp.initialSearchResult?.advertSummaryList?.advertSummary || [];

    const sr = pp.searchResult || pp.initialSearchResult || {};
    const navGroups = sr.navigatorGroups || [];
    // Alle navigatorList-Einträge aus allen Gruppen flachklopfen
    const allNavigators = navGroups.flatMap(g => g.navigatorList || []);
    // Den Zustand/Condition Navigator finden
    const condNavigator = allNavigators.find(n =>
      (n.id || '').toLowerCase().includes('condition') ||
      (n.label || '').toLowerCase().includes('zustand') ||
      (n.label || '').toLowerCase().includes('condition')
    );
    return { total: ads.length, condNavigator, allNavigatorIds: allNavigators.map(n => `${n.id}: ${n.label}`) };
  });

  await browser.close();

  console.log(`\n${results.total} Inserate geladen`);
  console.log('\n=== Alle Navigator IDs ===');
  results.allNavigatorIds.forEach(n => console.log(' ', n));
  console.log('\n=== Condition/Zustand Navigator ===');
  console.log(JSON.stringify(results.condNavigator, null, 2).slice(0, 3000));
})();
