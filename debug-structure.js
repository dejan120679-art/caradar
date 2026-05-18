require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'browser-state.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function main() {
  const storageState = fs.existsSync(STATE_FILE) ? STATE_FILE : undefined;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    userAgent: UA,
    locale: 'de-AT',
    timezoneId: 'Europe/Vienna',
  });
  const page = await context.newPage();

  const url = 'https://www.willhaben.at/iad/gebrauchtwagen/auto/audi-gebrauchtwagen/?b_isNavigation=true&sort=1&rows=1';
  console.log('Fetching:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const nextDataText = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
  });

  if (!nextDataText) {
    console.log('No __NEXT_DATA__ found!');
    // Check page title and content
    const title = await page.title();
    console.log('Page title:', title);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('Body text preview:', bodyText);
    await browser.close();
    return;
  }

  const nextData = JSON.parse(nextDataText);

  // Save full structure for inspection
  fs.writeFileSync(path.join(__dirname, 'debug-nextdata.json'), JSON.stringify(nextData, null, 2));
  console.log('Full __NEXT_DATA__ saved to debug-nextdata.json');

  // Explore the structure
  console.log('\nTop-level keys:', Object.keys(nextData));
  console.log('props keys:', Object.keys(nextData.props || {}));
  console.log('pageProps keys:', Object.keys(nextData.props?.pageProps || {}));

  const pageProps = nextData.props?.pageProps || {};

  // Check all possible locations for search result
  const candidates = [
    'searchResult', 'initialSearchResult', 'data', 'result',
    'searchData', 'cars', 'listings', 'initialData'
  ];

  for (const key of candidates) {
    if (pageProps[key]) {
      console.log(`\nFound pageProps.${key}:`, typeof pageProps[key]);
      if (typeof pageProps[key] === 'object') {
        console.log(`  Keys:`, Object.keys(pageProps[key]).slice(0, 20));
      }
    }
  }

  // Deep search for navigatorGroups or model navigator
  function deepFind(obj, targetKey, path = '', depth = 0) {
    if (depth > 8) return;
    if (!obj || typeof obj !== 'object') return;

    for (const [k, v] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${k}` : k;
      if (k === targetKey) {
        console.log(`Found "${targetKey}" at: ${currentPath}`);
        if (Array.isArray(v)) console.log(`  (array of ${v.length})`);
      }
      if (typeof v === 'object' && v !== null) {
        deepFind(v, targetKey, currentPath, depth + 1);
      }
    }
  }

  console.log('\n--- Searching for navigatorGroups ---');
  deepFind(nextData, 'navigatorGroups');

  console.log('\n--- Searching for navigators ---');
  deepFind(nextData, 'navigators');

  console.log('\n--- Searching for possibleValues ---');
  deepFind(nextData, 'possibleValues');

  console.log('\n--- Searching for "model" id ---');
  // Search for any object with id === "model"
  function findById(obj, targetId, path = '', depth = 0) {
    if (depth > 10) return;
    if (!obj || typeof obj !== 'object') return;
    if (obj.id === targetId) {
      console.log(`Found object with id="${targetId}" at path: ${path}`);
      console.log('  Keys:', Object.keys(obj).slice(0, 15));
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      findById(v, targetId, path ? `${path}.${k}` : k, depth + 1);
    }
  }
  findById(nextData, 'model');
  findById(nextData, 'MODEL');

  await browser.close();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
