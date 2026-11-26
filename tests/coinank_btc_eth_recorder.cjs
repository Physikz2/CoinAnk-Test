const { chromium, devices } = require('playwright');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { defaultDatabase, snapshotFor, openDatabase, insertSnapshots } = require('../helpers/coinank_sqlite.cjs');

// Run `node tests\coinank_btc_eth_recorder.cjs` with Excel closed, or add --watch
// for a read-only console table. Capture immediately, then every 15 minutes.
const workbook = path.resolve(process.env.COINANK_WORKBOOK || path.join(__dirname, 'Book3.xlsx'));
const database = path.resolve(process.env.COINANK_DB || defaultDatabase);
const once = process.env.COINANK_ONCE === '1';
const watch = process.argv.includes('--watch') || process.env.COINANK_WATCH === '1';
const intervalMs = 15 * 60 * 1000;
const WINDOW_SIZE = 24;
const url = 'https://coinank.com/chart/derivatives/bubbles';
const coins = ['BTC', 'ETH'];
const execFileAsync = promisify(execFile);

function isAggregate(request) {
  const parsed = new URL(request.url());
  return parsed.hostname === 'api.coinank.com' &&
    parsed.pathname.replace(/\/+/g, '/') === '/api/instruments/agg';
}

function numeric(value, coin, field) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !value.trim()) ||
      !Number.isFinite(Number(value))) {
    throw new Error(`[${coin}] Missing or invalid ${field}.`);
  }
  return Number(value);
}

function extract(payload, coin) {
  const item = payload?.data?.list?.[0];
  if (payload?.success !== true || !item || item.baseCoin !== coin ||
      typeof item.symbol !== 'string' || !item.symbol) {
    throw new Error(`[${coin}] CoinAnk did not return the expected instrument.`);
  }
  const result = {
    symbol: item.symbol,
    topAccount: numeric(item.longShortAccount, coin, 'L/S Top Account'),
    account: numeric(item.longShortPerson, coin, 'L/S (Account)'),
    topPosition: numeric(item.longShortPosition, coin, 'L/S Top Position'),
    population: numeric(item.longShortRatio, coin, 'L/S Population ratio'),
    price: numeric(item.price, coin, 'price'),
    raw: item,
  };
  if (result.price <= 0) throw new Error(`[${coin}] Price must be positive.`);
  return result;
}

function nextCaptureAfter(previous, now) {
  return previous + (Math.floor((now - previous) / intervalMs) + 1) * intervalMs;
}

function oneHourLiquidation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entries = Object.entries(raw);
  for (const name of ['liquidationh1', 'liquidation1h', 'liq1h', 'liqh1']) {
    for (const [key, value] of entries) {
      if (key.replace(/[^a-z0-9]/gi, '').toLowerCase() !== name) continue;
      if ((typeof value === 'number' || (typeof value === 'string' && value.trim())) &&
          Number.isFinite(Number(value))) return Number(value);
    }
  }
  return null;
}

function formatLiquidation(value, delta) {
  if (!Number.isFinite(value)) return 'N/A';
  const scaleFor = amount => {
    const magnitude = Math.abs(amount);
    return magnitude >= 1e9 ? [1e9, 'B'] : magnitude >= 1e6 ? [1e6, 'M'] :
      magnitude >= 1e3 ? [1e3, 'K'] : [1, ''];
  };
  const dollars = (amount, scale, suffix) => `$${(Math.abs(amount) / scale).toFixed(2)}${suffix}`;
  const [scale, suffix] = scaleFor(value);
  const total = `${value < 0 ? '-' : ''}${dollars(value, scale, suffix)}`;
  if (!Number.isFinite(delta)) return total;
  const ratio = Math.abs(delta) / scale;
  const [deltaScale, deltaSuffix] = ratio >= 0.005 && ratio < 1000 ? [scale, suffix] : scaleFor(delta);
  const sign = delta < 0 ? '-' : delta > 0 ? '+' : '';
  return `${total} (${sign}${dollars(delta, deltaScale, deltaSuffix)})`;
}

function advanceTelemetry(current, previous) {
  const { price, population, oi } = current;
  const liq1h = Number.isFinite(current.liq1h) ? current.liq1h : null;
  const liq1hDelta = liq1h !== null && Number.isFinite(previous?.liq1h) ? liq1h - previous.liq1h : null;
  const liqExpanding = liq1hDelta !== null && liq1hDelta > 0;
  const oiDelta = previous && oi !== null && previous.oi !== null ? oi - previous.oi : null;
  const popDelta = previous ? population - previous.population : null;
  const priceDelta = previous ? price - previous.price : null;
  const recentPops = previous?.recentPops ?? [];
  const localMax = recentPops.length ? Math.max(...recentPops) : null;
  const localMin = recentPops.length ? Math.min(...recentPops) : null;
  const atLocalHigh = previous && localMax !== null && previous.population >= localMax - 0.002;
  const atLocalLow = previous && localMin !== null && previous.population <= localMin + 0.002;
  const minOiMove = oi !== null ? Math.abs(oi) * 0.001 : 0;
  const contraction = oiDelta !== null && oiDelta < 0 && oiDelta <= -minOiMove;
  const expansion = oiDelta !== null && oiDelta > 0 && oiDelta >= minOiMove;
  const previousMinOiMove = previous?.oi != null ? Math.abs(previous.oi) * 0.001 : 0;
  const previousContraction = previous?.oiDelta < 0 && previous.oiDelta <= -previousMinOiMove;
  const previousExpansion = previous?.oiDelta > 0 && previous.oiDelta >= previousMinOiMove;

  let oiState = 'N/A';
  if (!previous) oiState = 'INIT';
  else if (oiDelta !== null) {
    if (contraction && previousExpansion) oiState = 'FLIP NEG (-)';
    else if (expansion && previousContraction) oiState = 'FLIP POS (+)';
    else if (contraction) oiState = 'NEG (-)';
    else if (expansion) oiState = 'POS (+)';
    else oiState = 'CHOP / FLAT';
  }

  let popHook = 'N/A';
  if (popDelta !== null) {
    if (popDelta < 0 && Number.isFinite(previous.popDelta) && previous.popDelta >= 0) popHook = 'HOOK DOWN';
    else if (popDelta > 0 && Number.isFinite(previous.popDelta) && previous.popDelta <= 0) popHook = 'HOOK UP';
    else if (popDelta < 0) popHook = 'FALLING';
    else if (popDelta > 0) popHook = 'RISING';
    else popHook = 'FLAT';
  }

  let entry = 'WAIT';
  let lastSignal = previous?.lastSignal ?? null;
  if (previous) {
    if (recentPops.length >= 4 && popHook === 'HOOK DOWN' && atLocalHigh && contraction && priceDelta <= 0) {
      entry = 'SHORT EXHAUSTION';
      lastSignal = entry;
    } else if (recentPops.length >= 4 && popHook === 'HOOK UP' && atLocalLow && contraction && priceDelta >= 0) {
      entry = 'LONG EXHAUSTION';
      lastSignal = entry;
    } else if ((popHook === 'FALLING' && lastSignal === 'SHORT EXHAUSTION') ||
               (popHook === 'RISING' && lastSignal === 'LONG EXHAUSTION')) {
      entry = 'IN UNWIND (HOLD / NO RE-ENTRY)';
    } else if (localMax !== null && population >= localMax - 0.002 && priceDelta > 0 && expansion) {
      entry = 'WAIT (SQUEEZE/FOMO FUEL)';
      lastSignal = null;
    } else if (localMin !== null && population <= localMin + 0.002 && priceDelta < 0 && expansion) {
      entry = 'WAIT (DUMP FUEL)';
      lastSignal = null;
    } else if (popHook === 'HOOK UP' || popHook === 'HOOK DOWN') {
      lastSignal = null;
    }
  }

  const format = value => value === null ? 'N/A' :
    value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return {
    meta: {
      OI: format(oi), 'OI Δ (15m)': format(oiDelta),
      'OI State / Flip': oiState, 'Pop Hook (15m)': popHook,
      'Liq 1H': formatLiquidation(liq1h, liq1hDelta),
      'Entry Status': liqExpanding && (entry.endsWith('EXHAUSTION') || entry.startsWith('IN UNWIND'))
        ? `${entry} [liq+]` : entry,
    },
    state: {
      price, population, oi, oiDelta, popDelta, liq1h, liq1hDelta, liqExpanding,
      recentPops: [...recentPops, population].slice(-WINDOW_SIZE), lastSignal,
    },
  };
}

function getPresetState(databasePath = path.resolve(process.env.COINANK_DB || defaultDatabase), coins = ['BTC', 'ETH']) {
  let db;
  const prevByCoin = {};
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const hasLiquidation = db.prepare('PRAGMA table_info(snapshots)').all()
      .some(column => column.name === 'liquidation_1h_num');
    const latest = db.prepare(`SELECT captured_at, price_num, open_interest_num, long_short_ratio_num,
      ${hasLiquidation ? 'liquidation_1h_num' : 'NULL AS liquidation_1h_num'}
      FROM snapshots WHERE coin = ? ORDER BY captured_at DESC, id DESC LIMIT ?`);
    for (const coin of coins) {
      for (const row of latest.all(coin, WINDOW_SIZE).reverse()) {
        if (!Number.isFinite(row.price_num) || row.price_num <= 0 || !Number.isFinite(row.long_short_ratio_num)) {
          console.warn(`[${coin}] Skipping incomplete historical snapshot ${row.captured_at}; resetting telemetry history.`);
          delete prevByCoin[coin];
          continue;
        }
        const oi = Number.isFinite(row.open_interest_num) ? row.open_interest_num : null;
        const liq1h = Number.isFinite(row.liquidation_1h_num) ? row.liquidation_1h_num : null;
        prevByCoin[coin] = advanceTelemetry({
          price: row.price_num, population: row.long_short_ratio_num, oi, liq1h,
        }, prevByCoin[coin]).state;
      }
    }
    return prevByCoin;
  } catch (error) {
    console.warn(`Could not load telemetry history from SQLite; starting without history: ${error.message}`);
    return {};
  } finally {
    if (db) db.close();
  }
}

function printPresetSummary() {
  const state = getPresetState();
  console.log(`Six-hour preset (up to ${WINDOW_SIZE} snapshots per coin):`);
  console.table(Object.fromEntries(coins.map(coin => {
    const data = state[coin];
    return [coin, {
      bars: data?.recentPops.length ?? 0,
      price: data?.price ?? 'N/A',
      population: data?.population ?? 'N/A',
      oi: data?.oi?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? 'N/A',
      oiDelta: data?.oiDelta?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? 'N/A',
      popDelta: data?.popDelta?.toFixed(6) ?? 'N/A',
      lastSignal: data?.lastSignal ?? 'N/A',
    }];
  })));
}

function readingsTable(values, meta) {
  const table = {
    'L/S Top Account': { BTC: values.BTC.topAccount, ETH: values.ETH.topAccount },
    'L/S (Account)': { BTC: values.BTC.account, ETH: values.ETH.account },
    'L/S Top Position': { BTC: values.BTC.topPosition, ETH: values.ETH.topPosition },
    'L/S Population ratio': { BTC: values.BTC.population, ETH: values.ETH.population },
    Price: { BTC: values.BTC.price, ETH: values.ETH.price },
  };
  if (meta) {
    for (const field of ['OI', 'OI Δ (15m)', 'OI State / Flip', 'Pop Hook (15m)', 'Liq 1H', 'Entry Status']) {
      table[field] = { BTC: meta.BTC[field], ETH: meta.ETH[field] };
    }
  }
  return table;
}

function consoleTelemetry(values, prevByCoin) {
  const meta = {};
  const nextByCoin = { ...prevByCoin };
  for (const coin of coins) {
    const current = values[coin];
    if (!current) continue;
    let oi = null;
    for (const key of ['openInterest', 'oi', 'openInterestUsd']) {
      const value = current.raw?.[key];
      if ((typeof value === 'number' || (typeof value === 'string' && value.trim())) &&
          Number.isFinite(Number(value))) {
        oi = Number(value);
        break;
      }
    }
    const liq1h = oneHourLiquidation(current.raw);
    const result = advanceTelemetry({ price: current.price, population: current.population, oi, liq1h }, prevByCoin[coin]);
    meta[coin] = result.meta;
    nextByCoin[coin] = result.state;
  }
  return { meta, nextByCoin };
}

async function trackBubbleLabels(page) {
  // CoinAnk draws its symbols on a canvas, so capture their rendered coordinates.
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    window.coinankBubblePoints = {};
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^[A-Za-z0-9][A-Za-z0-9:_-]{0,59}$/.test(text) &&
          /[A-Za-z]/.test(text) && this.canvas.matches('.canvas-container canvas')) {
        const matrix = this.getTransform();
        window.coinankBubblePoints[text] = {
          canvas: this.canvas,
          x: matrix.a * x + matrix.c * y + matrix.e,
          y: matrix.b * x + matrix.d * y + matrix.f,
        };
      }
      if (maxWidth === undefined) fillText.call(this, text, x, y);
      else fillText.call(this, text, x, y, maxWidth);
    };
  });
}

async function bubbleFallback(page, coin) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.canvas-container canvas').waitFor({ state: 'visible', timeout: 30_000 });
  const collapse = page.locator('.community-dock').getByRole('button', { name: 'Collapse', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.waitForFunction(symbol => Object.entries(window.coinankBubblePoints ?? {}).some(
    ([label, point]) => label.trim().toUpperCase() === symbol && point.canvas.isConnected,
  ), coin, { timeout: 30_000 });
  await page.evaluate(symbol => {
    const point = Object.entries(window.coinankBubblePoints)
      .find(([label, point]) => label.trim().toUpperCase() === symbol && point.canvas.isConnected)[1];
    const rect = point.canvas.getBoundingClientRect();
    const y = rect.top + point.y * rect.height / point.canvas.height;
    if (y < 0 || y >= window.innerHeight) window.scrollBy(0, y - window.innerHeight / 2);
  }, coin);
  const point = await page.evaluate(symbol => {
    const bubble = Object.entries(window.coinankBubblePoints)
      .find(([label, point]) => label.trim().toUpperCase() === symbol && point.canvas.isConnected)[1];
    const rect = bubble.canvas.getBoundingClientRect();
    const x = rect.left + bubble.x * rect.width / bubble.canvas.width;
    const y = rect.top + bubble.y * rect.height / bubble.canvas.height;
    return { x, y, onCanvas: document.elementFromPoint(x, y) === bubble.canvas };
  }, coin);
  if (!point.onCanvas) throw new Error(`[${coin}] Bubble is covered or outside the viewport.`);
  const [request] = await Promise.all([
    page.waitForRequest(request => isAggregate(request) && request.method() === 'POST' &&
      new URL(request.url()).searchParams.get('baseCoin') === coin, { timeout: 10_000 }),
    page.mouse.click(point.x, point.y, { button: 'right' }),
  ]);
  const response = await request.response();
  if (!response || !response.ok()) {
    throw new Error(`[${coin}] Bubble request failed: ${response ? `HTTP ${response.status()}` : request.failure()?.errorText}`);
  }
  return extract(await response.json(), coin);
}

async function capture(page) {
  const [initial] = await Promise.all([
    page.waitForResponse(response => isAggregate(response.request()) &&
      response.request().method() === 'POST' &&
      new URL(response.url()).searchParams.get('type') === 'oi', { timeout: 30_000 }),
    page.goto(url, { waitUntil: 'domcontentloaded' }),
  ]);
  if (!initial.ok()) throw new Error(`Initial CoinAnk request returned HTTP ${initial.status()}.`);
  const headers = initial.request().headers();
  const requestHeaders = {
    client: headers.client ?? 'web',
    'content-type': headers['content-type'] ?? 'application/json',
  };
  for (const name of ['coinank-apikey', 'token', 'web-version']) {
    if (headers[name]) requestHeaders[name] = headers[name];
  }
  // Reuse the page's own request headers, as the faster CoinAnk test does.
  const direct = await page.evaluate(async ({ symbols, requestHeaders }) =>
    Promise.all(symbols.map(async coin => {
      try {
        const target = new URL('https://api.coinank.com/api/instruments/agg');
        target.search = new URLSearchParams({ page: '1', size: '50', baseCoin: coin, isFollow: 'false' });
        const response = await fetch(target.toString(), {
          method: 'POST', headers: requestHeaders, body: '', signal: AbortSignal.timeout(15_000),
        });
        return { coin, status: response.status, payload: await response.json() };
      } catch (error) {
        return { coin, error: String(error) };
      }
    })), { symbols: coins, requestHeaders });
  const result = {};
  for (const item of direct) {
    try {
      if (!item.status || item.status < 200 || item.status >= 300) {
        throw new Error(item.error || `HTTP ${item.status}`);
      }
      result[item.coin] = extract(item.payload, item.coin);
    } catch (error) {
      console.warn(`[${item.coin}] Direct capture failed (${error.message}); trying its bubble.`);
      result[item.coin] = await bubbleFallback(page, item.coin);
    }
  }
  return result;
}

async function writeWorkbook(values, capturedAt, meta) {
  if (process.platform !== 'win32' || process.env.COINANK_SKIP_EXCEL === '1') {
    console.table(readingsTable(values, meta));
    return;
  }
  const { raw: btcRaw, ...btc } = values.BTC;
  const { raw: ethRaw, ...eth } = values.ETH;
  const payload = JSON.stringify({ timestamp: capturedAt, BTC: btc, ETH: eth });
  const { stdout, stderr } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    path.join(__dirname, 'coinank_write_workbook.ps1'),
    '-WorkbookPath',
    workbook,
    '-Payload',
    payload,
  ], { windowsHide: true });
  if (stderr.trim()) console.warn(stderr.trim());
  console.log(stdout.trim());
  console.table(readingsTable(values, meta));
}

async function saveCapture(values, capturedAt, meta) {
  let databaseError;
  try {
    const snapshots = coins.map(coin => snapshotFor(values[coin].raw, capturedAt));
    const db = openDatabase(database);
    try {
      const result = insertSnapshots(db, snapshots);
      console.log(`SQLite: ${result.inserted} rows saved, ${result.ignored} already present.`);
    } finally {
      db.close();
    }
  } catch (error) {
    databaseError = error;
    console.error(`SQLite update failed; still attempting Excel: ${error.message}`);
  }

  try {
    await writeWorkbook(values, capturedAt, meta);
  } catch (error) {
    if (databaseError) {
      throw new AggregateError([databaseError, error],
        `SQLite and Excel updates failed: SQLite: ${databaseError.message}; Excel: ${error.message}`);
    }
    throw new Error(`Excel update failed; SQLite was saved: ${error.message}`, { cause: error });
  }
  if (databaseError) {
    throw new Error(`Excel was saved, but SQLite update failed: ${databaseError.message}`, { cause: databaseError });
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  let stopping = false;
  let wake;
  const stop = () => {
    stopping = true;
    if (wake) wake();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const { userAgent, screen, deviceScaleFactor, isMobile, hasTouch } = devices['Desktop Chrome'];
    const page = await browser.newPage({
      userAgent, screen, deviceScaleFactor, isMobile, hasTouch,
      viewport: { width: 1600, height: 1200 },
    });
    await trackBubbleLabels(page);
    console.log(watch
      ? 'Watching BTC and ETH in read-only console mode; press Ctrl+C to stop.'
      : `Recording BTC and ETH to ${workbook}. Keep Excel closed; press Ctrl+C to stop.`);
    let next = Date.now();
    let prevByCoin = getPresetState(database, coins);
    console.log(`Preloaded telemetry history (up to ${WINDOW_SIZE} bars): ` +
      coins.map(coin => `${coin}: ${prevByCoin[coin]?.recentPops.length ?? 0}`).join(', '));
    while (!stopping) {
      try {
        const values = await capture(page);
        if (!stopping) {
          const { meta, nextByCoin } = consoleTelemetry(values, prevByCoin);
          prevByCoin = nextByCoin;
          if (watch) {
            console.table(readingsTable(values, meta));
          } else {
            await saveCapture(values, new Date().toISOString(), meta);
          }
        }
      } catch (error) {
        console.error(watch
          ? `Capture failed: ${error.message}`
          : `Capture or workbook update failed: ${error.message}`);
        if (once) throw error;
        if (page.isClosed()) {
          throw new Error(`The browser was closed; ${watch ? 'watching' : 'recording'} stopped.`);
        }
      }
      if (once || stopping) break;
      next = nextCaptureAfter(next, Date.now());
      console.log(`Next capture: ${new Date(next).toLocaleString()}`);
      await new Promise(resolve => {
        const timer = setTimeout(resolve, next - Date.now());
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await browser.close();
  }
}

if (require.main === module) {
  if (process.argv.includes('--preset')) {
    printPresetSummary();
  } else {
    main().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

module.exports = { extract, nextCaptureAfter, readingsTable, consoleTelemetry, WINDOW_SIZE, advanceTelemetry, getPresetState };
