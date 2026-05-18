require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'browser-state.json');
const OUTPUT_FILE = path.join(__dirname, 'models-data.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BRANDS = [
  'Alfa Romeo', 'Audi', 'BMW', 'Chevrolet', 'Citroen', 'Dacia', 'Fiat',
  'Ford', 'Honda', 'Hyundai', 'Jaguar', 'Jeep', 'Kia', 'Land Rover',
  'Lexus', 'Mazda', 'Mercedes-Benz', 'Mini', 'Mitsubishi', 'Nissan',
  'Opel', 'Peugeot', 'Porsche', 'Renault', 'Seat', 'Skoda', 'Smart',
  'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'VW', 'Volvo'
];

function toSlug(str) {
  return String(str)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildBrandUrl(brand) {
  const slug = toSlug(brand);
  return `https://www.willhaben.at/iad/gebrauchtwagen/auto/${slug}-gebrauchtwagen/?b_isNavigation=true&sort=1&rows=1`;
}

function extractModels(nextData) {
  // Try both possible paths
  const searchResult =
    nextData?.props?.pageProps?.searchResult ||
    nextData?.props?.pageProps?.initialSearchResult;

  if (!searchResult) return null;

  const groups = searchResult.navigatorGroups;
  if (!Array.isArray(groups)) return null;

  // Find the navigator group containing the "model" navigator
  // willhaben uses navigatorList (not navigators) as the key
  for (const group of groups) {
    const navigators = group.navigatorList || group.navigators || [];
    for (const nav of navigators) {
      if (nav.id === 'model' || nav.id === 'MODEL') {
        const results = [];

        // Collect from groupedPossibleValues (primary source)
        if (Array.isArray(nav.groupedPossibleValues)) {
          for (const gpv of nav.groupedPossibleValues) {
            const items = gpv.possibleValues || gpv.items || [];
            for (const pv of items) {
              const label = pv.label;
              if (label) results.push({ label, value: label });
            }
          }
        }

        // Fallback: collect from possibleValues
        if (results.length === 0 && Array.isArray(nav.possibleValues)) {
          for (const pv of nav.possibleValues) {
            const label = pv.label;
            if (label) results.push({ label, value: label });
          }
        }

        return results.length > 0 ? results : null;
      }
    }
  }
  return null;
}

async function fetchModelsForBrand(page, brand) {
  const url = buildBrandUrl(brand);
  console.log(`  Fetching: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Extract __NEXT_DATA__
    const nextDataText = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    if (!nextDataText) {
      console.log(`  WARNING: No __NEXT_DATA__ found for ${brand}`);
      return null;
    }

    let nextData;
    try {
      nextData = JSON.parse(nextDataText);
    } catch (e) {
      console.log(`  WARNING: Failed to parse __NEXT_DATA__ for ${brand}: ${e.message}`);
      return null;
    }

    const models = extractModels(nextData);
    if (!models) {
      console.log(`  WARNING: Could not extract models for ${brand}`);
      // Debug: dump navigatorGroups structure
      const sr = nextData?.props?.pageProps?.searchResult || nextData?.props?.pageProps?.initialSearchResult;
      if (sr?.navigatorGroups) {
        const ids = sr.navigatorGroups.flatMap(g => (g.navigatorList || g.navigators || []).map(n => n.id));
        console.log(`  Available navigator ids: ${ids.join(', ')}`);
      }
      return null;
    }

    console.log(`  Found ${models.length} models for ${brand}`);
    return models;

  } catch (e) {
    console.log(`  ERROR for ${brand}: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log('Starting model fetch for all brands...');

  const storageState = fs.existsSync(STATE_FILE) ? STATE_FILE : undefined;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    userAgent: UA,
    locale: 'de-AT',
    timezoneId: 'Europe/Vienna',
  });

  const page = await context.newPage();

  const result = {};
  let successCount = 0;
  let failCount = 0;

  for (const brand of BRANDS) {
    console.log(`\n[${BRANDS.indexOf(brand) + 1}/${BRANDS.length}] Processing: ${brand}`);
    const models = await fetchModelsForBrand(page, brand);
    if (models && models.length > 0) {
      result[brand] = models;
      successCount++;
    } else {
      result[brand] = [];
      failCount++;
    }
    // Small delay to be polite
    await page.waitForTimeout(800);
  }

  await browser.close();

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\nDone! ${successCount} brands OK, ${failCount} failed.`);
  console.log(`Output saved to: ${OUTPUT_FILE}`);

  // Print summary
  console.log('\n=== Summary ===');
  for (const [brand, models] of Object.entries(result)) {
    console.log(`${brand}: ${models.length} models`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
