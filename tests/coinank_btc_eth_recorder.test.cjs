const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { extract, nextCaptureAfter, readingsTable, consoleTelemetry, WINDOW_SIZE, getPresetState } = require('./coinank_btc_eth_recorder.cjs');
const { snapshotFor, openDatabase, ensureSchema, insertSnapshots } = require('../helpers/coinank_sqlite.cjs');

const btc = {
  baseCoin: 'BTC', symbol: 'BTCUSDT', longShortAccount: '2.1', longShortPerson: 1.9,
  longShortPosition: 1.5, longShortRatio: 1.01, price: '60000',
};
const payload = item => ({ success: true, data: { list: [item] } });

test('extracts numeric ratios and price for the requested coin', () => {
  assert.deepEqual(extract(payload(btc), 'BTC'), {
    symbol: 'BTCUSDT', topAccount: 2.1, account: 1.9, topPosition: 1.5,
    population: 1.01, price: 60000, raw: btc,
  });
});

test('rejects missing data, invalid prices, and a different instrument', () => {
  assert.throws(() => extract(payload({ ...btc, longShortRatio: null }), 'BTC'), /Population/);
  assert.throws(() => extract(payload({ ...btc, price: 0 }), 'BTC'), /Price/);
  assert.throws(() => extract(payload(btc), 'ETH'), /instrument/);
});

test('schedules every 15 minutes without overlapping missed captures', () => {
  assert.equal(nextCaptureAfter(0, 1000), 900000);
  assert.equal(nextCaptureAfter(0, 900000), 1800000);
  assert.equal(nextCaptureAfter(0, 1900000), 2700000);
});

test('shows each saved ratio and price in BTC and ETH columns', () => {
  const values = {
    BTC: { topAccount: 1.1, account: 1.2, topPosition: 1.3, population: 1.4, price: 60000 },
    ETH: { topAccount: 2.1, account: 2.2, topPosition: 2.3, population: 2.4, price: 1600 },
  };
  assert.deepEqual(readingsTable(values), {
    'L/S Top Account': { BTC: 1.1, ETH: 2.1 },
    'L/S (Account)': { BTC: 1.2, ETH: 2.2 },
    'L/S Top Position': { BTC: 1.3, ETH: 2.3 },
    'L/S Population ratio': { BTC: 1.4, ETH: 2.4 },
    Price: { BTC: 60000, ETH: 1600 },
  });
});

function readings(btcReading, ethReading = btcReading) {
  const value = reading => ({
    topAccount: 1, account: 1, topPosition: 1, ...reading,
  });
  return { BTC: value(btcReading), ETH: value(ethReading) };
}

test('reports OI direction, flips and population hooks across captures independently', () => {
  const capture = (previous, btcOi, btcPop, ethOi, ethPop) => consoleTelemetry(readings(
    { price: 100, population: btcPop, raw: { openInterest: btcOi } },
    { price: 100, population: ethPop, raw: { oi: ethOi } },
  ), previous);
  let result = capture({}, 1000, 1, 2000, 1);
  assert.equal(result.meta.BTC['OI State / Flip'], 'INIT');
  assert.equal(result.meta.BTC['OI Δ (15m)'], 'N/A');
  assert.equal(result.meta.BTC['Pop Hook (15m)'], 'N/A');
  result = capture(result.nextByCoin, 1100, 1.1, 1900, 0.9);
  assert.equal(result.meta.BTC.OI, '1,100');
  assert.equal(result.meta.BTC['OI State / Flip'], 'POS (+)');
  assert.equal(result.meta.BTC['Pop Hook (15m)'], 'RISING');
  assert.equal(result.meta.ETH['OI State / Flip'], 'NEG (-)');
  assert.equal(result.meta.ETH['Pop Hook (15m)'], 'FALLING');
  result = capture(result.nextByCoin, 1050, 1, 2000, 1);
  assert.equal(result.meta.BTC['OI Δ (15m)'], '-50');
  assert.equal(result.meta.BTC['OI State / Flip'], 'FLIP NEG (-)');
  assert.equal(result.meta.BTC['Pop Hook (15m)'], 'HOOK DOWN');
  assert.equal(result.meta.ETH['OI State / Flip'], 'FLIP POS (+)');
  assert.equal(result.meta.ETH['Pop Hook (15m)'], 'HOOK UP');
  result = capture(result.nextByCoin, 1050, 1, 2000, 1);
  assert.equal(result.meta.BTC['OI State / Flip'], 'CHOP / FLAT');
  assert.equal(result.meta.BTC['Pop Hook (15m)'], 'FLAT');
  result = capture(result.nextByCoin, 1040, 0.9, 2010, 1.1);
  assert.equal(result.meta.BTC['Pop Hook (15m)'], 'HOOK DOWN');
  assert.equal(result.meta.ETH['Pop Hook (15m)'], 'HOOK UP');
  const table = readingsTable(readings(
    { price: 100, population: 0.9 }, { price: 100, population: 1.1 },
  ), result.meta);
  assert.deepEqual(Object.keys(table), [
    'L/S Top Account', 'L/S (Account)', 'L/S Top Position', 'L/S Population ratio', 'Price',
    'OI', 'OI Δ (15m)', 'OI State / Flip', 'Pop Hook (15m)', 'Liq 1H', 'Entry Status',
  ]);
  assert.deepEqual(table['Entry Status'], { BTC: result.meta.BTC['Entry Status'], ETH: result.meta.ETH['Entry Status'] });
});

test('handles missing and invalid OI without using stale deltas', () => {
  let result = consoleTelemetry(readings(
    { price: 100, population: 1, raw: { openInterest: 'invalid', oi: '', openInterestUsd: '1200.5' } },
    { price: 100, population: 1 },
  ), {});
  assert.equal(result.meta.BTC.OI, '1,200.5');
  assert.equal(result.meta.ETH.OI, 'N/A');
  result = consoleTelemetry(readings(
    { price: 100, population: 1, raw: { openInterest: null, oi: false } },
    { price: 100, population: 1, raw: { openInterest: 'Infinity' } },
  ), result.nextByCoin);
  assert.equal(result.meta.BTC['OI Δ (15m)'], 'N/A');
  assert.equal(result.meta.BTC['OI State / Flip'], 'N/A');
  assert.equal(result.meta.ETH.OI, 'N/A');
  result = consoleTelemetry(readings(
    { price: 100, population: 1, raw: { oi: 1400 } },
  ), result.nextByCoin);
  assert.equal(result.meta.BTC['OI Δ (15m)'], 'N/A');
  assert.equal(result.meta.BTC['OI State / Flip'], 'N/A');
  result = consoleTelemetry(readings(
    { price: 100, population: 1, raw: { oi: 1450 } },
  ), result.nextByCoin);
  assert.equal(result.meta.BTC['OI State / Flip'], 'POS (+)');
});

test('tracks 1-hour liquidation totals and ignores other periods and breakdowns', () => {
  let result = consoleTelemetry(readings(
    { price: 100, population: 1, raw: { liquidationH1: 'bad', liq1h: '100', liquidationH24: 9000 } },
    { price: 100, population: 1, raw: { liquidationH1Long: 100, liquidationH1Short: 50, liquidationH24: 9000 } },
  ), {});
  assert.equal(result.nextByCoin.BTC.liq1h, 100);
  assert.equal(result.nextByCoin.BTC.liq1hDelta, null);
  assert.equal(result.nextByCoin.ETH.liq1h, null);
  assert.equal(result.meta.BTC['Liq 1H'], '$100.00');
  assert.equal(result.meta.ETH['Liq 1H'], 'N/A');

  result = consoleTelemetry(readings(
    { price: 100, population: 1, raw: { liquidation_1h: '125.5' } },
    { price: 100, population: 1, raw: { liquidationH1: 0 } },
  ), result.nextByCoin);
  assert.equal(result.nextByCoin.BTC.liq1h, 125.5);
  assert.equal(result.nextByCoin.BTC.liq1hDelta, 25.5);
  assert.equal(result.nextByCoin.BTC.liqExpanding, true);
  assert.equal(result.nextByCoin.ETH.liq1hDelta, null);
  assert.equal(result.meta.BTC['Liq 1H'], '$125.50 (+$25.50)');
  assert.equal(result.meta.ETH['Liq 1H'], '$0.00');

  result = consoleTelemetry(readings(
    { price: 100, population: 1, raw: { liquidation1h: 120 } },
    { price: 100, population: 1, raw: { liquidationH1: false } },
  ), result.nextByCoin);
  assert.equal(result.nextByCoin.BTC.liq1hDelta, -5.5);
  assert.equal(result.nextByCoin.BTC.liqExpanding, false);
  assert.equal(result.nextByCoin.ETH.liq1h, null);
  assert.equal(result.nextByCoin.ETH.liq1hDelta, null);
  assert.equal(result.meta.BTC['Liq 1H'], '$120.00 (-$5.50)');
  assert.equal(result.meta.ETH['Liq 1H'], 'N/A');
});

test('formats liquidation totals and deltas compactly without hiding small changes', () => {
  const values = (btcLiq, ethLiq) => readings(
    { price: 100, population: 1, raw: { liquidationH1: btcLiq } },
    { price: 100, population: 1, raw: { liquidationH1: ethLiq } },
  );
  let result = consoleTelemetry(values(1760000, 1970000), {});
  assert.equal(result.meta.BTC['Liq 1H'], '$1.76M');
  result = consoleTelemetry(values(1900000, 1900000), result.nextByCoin);
  assert.equal(result.meta.BTC['Liq 1H'], '$1.90M (+$0.14M)');
  assert.equal(result.meta.ETH['Liq 1H'], '$1.90M (-$0.07M)');
  const table = readingsTable(values(1900000, 1900000), result.meta);
  assert.deepEqual(table['Liq 1H'], { BTC: '$1.90M (+$0.14M)', ETH: '$1.90M (-$0.07M)' });
  result = consoleTelemetry(values(1900005, Infinity), result.nextByCoin);
  assert.equal(result.meta.BTC['Liq 1H'], '$1.90M (+$5.00)');
  assert.equal(result.meta.ETH['Liq 1H'], 'N/A');
  result = consoleTelemetry(values(1900005, 0), result.nextByCoin);
  assert.equal(result.meta.BTC['Liq 1H'], '$1.90M ($0.00)');
  assert.equal(result.meta.ETH['Liq 1H'], '$0.00');
});

function history(populations, oi = 1000) {
  let state = {};
  for (const population of populations) {
    state = consoleTelemetry(readings({ population, price: 100, raw: { oi } }), state).nextByCoin;
  }
  return state;
}

test('signals exhaustion only on local inflections and holds throughout the unwind', () => {
  for (const [past, reversal, continuation, price, signal] of [
    [[1.01, 1.02, 1.03, 1.04], 1.035, 1.03, 99, 'SHORT EXHAUSTION'],
    [[1.04, 1.03, 1.02, 1.01], 1.015, 1.02, 101, 'LONG EXHAUSTION'],
  ]) {
    const state = history(past);
    const inflection = consoleTelemetry(readings({ population: reversal, price, raw: { oi: 990 } }), state);
    assert.equal(inflection.meta.BTC['Entry Status'], signal);
    const unwind = consoleTelemetry(readings({ population: continuation, price, raw: { oi: 980 } }), inflection.nextByCoin);
    assert.equal(unwind.meta.BTC['Entry Status'], 'IN UNWIND (HOLD / NO RE-ENTRY)');
    const further = consoleTelemetry(readings({
      population: continuation + (signal === 'SHORT EXHAUSTION' ? -0.005 : 0.005),
      price, raw: { oi: 970 },
    }), unwind.nextByCoin);
    assert.equal(further.meta.BTC['Entry Status'], 'IN UNWIND (HOLD / NO RE-ENTRY)');
    const flat = consoleTelemetry(readings({
      population: further.nextByCoin.BTC.population, price, raw: { oi: 970 },
    }), further.nextByCoin);
    assert.equal(flat.meta.BTC['Entry Status'], 'WAIT');
    assert.equal(flat.nextByCoin.BTC.lastSignal, signal);
    const reverse = consoleTelemetry(readings({
      population: flat.nextByCoin.BTC.population + (signal === 'SHORT EXHAUSTION' ? 0.001 : -0.001),
      price, raw: { oi: 970 },
    }), flat.nextByCoin);
    assert.equal(reverse.nextByCoin.BTC.lastSignal, null);
  }

  const tooShort = history([1.01, 1.02, 1.03]);
  assert.equal(consoleTelemetry(readings({ population: 1.02, price: 99, raw: { oi: 990 } }),
    tooShort).meta.BTC['Entry Status'], 'WAIT');
  const awayFromHigh = history([1.10, 1.01, 1.02, 1.03]);
  assert.equal(consoleTelemetry(readings({ population: 1.02, price: 99, raw: { oi: 990 } }),
    awayFromHigh).meta.BTC['Entry Status'], 'WAIT');
  const nearHigh = history([1.04, 1.01, 1.03, 1.0385]);
  assert.equal(consoleTelemetry(readings({ population: 1.03, price: 100, raw: { oi: 990 } }),
    nearHigh).meta.BTC['Entry Status'], 'SHORT EXHAUSTION');
});

test('annotates exhaustion and unwind on expanding liquidations without gating signals', () => {
  for (const [past, reversal, continuation, price, signal] of [
    [[1.01, 1.02, 1.03, 1.04], 1.035, 1.03, 99, 'SHORT EXHAUSTION'],
    [[1.04, 1.03, 1.02, 1.01], 1.015, 1.02, 101, 'LONG EXHAUSTION'],
  ]) {
    let state = {};
    for (const population of past) {
      state = consoleTelemetry(readings({
        population, price: 100, raw: { oi: 1000, liquidationH1: 100 },
      }), state).nextByCoin;
    }
    const inflection = consoleTelemetry(readings({
      population: reversal, price, raw: { oi: 990, liquidationH1: 120 },
    }), state);
    assert.equal(inflection.meta.BTC['Entry Status'], `${signal} [liq+]`);
    assert.equal(inflection.nextByCoin.BTC.lastSignal, signal);
    const unwind = consoleTelemetry(readings({
      population: continuation, price, raw: { oi: 980, liquidationH1: 130 },
    }), inflection.nextByCoin);
    assert.equal(unwind.meta.BTC['Entry Status'], 'IN UNWIND (HOLD / NO RE-ENTRY) [liq+]');
    for (const liq of [null, 100, 90]) {
      const noImpulse = consoleTelemetry(readings({
        population: reversal, price, raw: { oi: 990, liquidationH1: liq, liquidationH24: 999999 },
      }), state);
      assert.equal(noImpulse.meta.BTC['Entry Status'], signal);
    }
    const chop = consoleTelemetry(readings({
      population: reversal, price, raw: { oi: 999.5, liquidationH1: 120 },
    }), state);
    assert.equal(chop.meta.BTC['OI State / Flip'], 'CHOP / FLAT');
    assert.equal(chop.meta.BTC['Entry Status'], 'WAIT');
  }
});

test('filters insignificant OI moves and uses local extremes for fuel hints', () => {
  const state = history([1.01, 1.02, 1.03, 1.04], 1001);
  const chop = consoleTelemetry(readings({ population: 1.035, price: 99, raw: { oi: 1000.5 } }), state);
  assert.equal(chop.meta.BTC['OI State / Flip'], 'CHOP / FLAT');
  assert.equal(chop.meta.BTC['Entry Status'], 'WAIT');
  const exact = consoleTelemetry(readings({ population: 1.035, price: 100, raw: { oi: 1000 } }), state);
  assert.equal(exact.meta.BTC['Entry Status'], 'SHORT EXHAUSTION');
  const squeeze = consoleTelemetry(readings({ population: 1.041, price: 101, raw: { oi: 1002 } }),
    history([1.01, 1.02, 1.03, 1.04]));
  assert.equal(squeeze.meta.BTC['Entry Status'], 'WAIT (SQUEEZE/FOMO FUEL)');
  const dump = consoleTelemetry(readings({ population: 1.009, price: 99, raw: { oi: 1002 } }),
    history([1.04, 1.03, 1.02, 1.01]));
  assert.equal(dump.meta.BTC['Entry Status'], 'WAIT (DUMP FUEL)');
  const insignificant = consoleTelemetry(readings({ population: 1.041, price: 101, raw: { oi: 1000.5 } }),
    history([1.01, 1.02, 1.03, 1.04]));
  assert.equal(insignificant.meta.BTC['Entry Status'], 'WAIT');
  const afterChop = consoleTelemetry(readings({ population: 1.03, price: 100, raw: { oi: 990 } }),
    insignificant.nextByCoin);
  assert.equal(afterChop.meta.BTC['OI State / Flip'], 'NEG (-)');
  const exactExpansion = consoleTelemetry(readings({ population: 1.041, price: 101, raw: { oi: 1000 } }),
    history([1.01, 1.02, 1.03, 1.04], 999));
  assert.equal(exactExpansion.meta.BTC['Entry Status'], 'WAIT (SQUEEZE/FOMO FUEL)');
  const zero = consoleTelemetry(readings({ population: 1.035, price: 99, raw: { oi: 0 } }),
    history([1.01, 1.02, 1.03, 1.04], 0));
  assert.equal(zero.meta.BTC['OI State / Flip'], 'CHOP / FLAT');
  assert.equal(zero.meta.BTC['Entry Status'], 'WAIT');
  assert.equal(history(Array.from({ length: 30 }, (_, i) => i)).BTC.recentPops.length, WINDOW_SIZE);
});

test('seeds the latest snapshots chronologically and retains the prior signal', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinank-seed-'));
  const dbPath = path.join(directory, 'seed.db');
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE snapshots (id INTEGER PRIMARY KEY, captured_at TEXT, coin TEXT,
        price_num REAL, open_interest_num REAL, long_short_ratio_num REAL)`);
      const insert = db.prepare('INSERT INTO snapshots (captured_at, coin, price_num, open_interest_num, long_short_ratio_num) VALUES (?, ?, ?, ?, ?)');
      for (let i = 25; i >= 0; i--) {
        insert.run(`2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, 'BTC', 100, 1000 + i, 1 + i / 1000);
      }
      const ethPops = [1, 1.01, 1.02, 1.03, 1.02, 1.01];
      for (let i = 0; i < ethPops.length; i++) {
        insert.run(`2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, 'ETH', 100, i < 4 ? 1000 : 1030 - i * 10, ethPops[i]);
      }
    } finally {
      db.close();
    }
    const withoutLiquidationColumn = getPresetState(dbPath);
    assert.equal(withoutLiquidationColumn.BTC.liq1h, null);
    assert.equal(withoutLiquidationColumn.BTC.liq1hDelta, null);
    const withLiquidation = new DatabaseSync(dbPath);
    try {
      withLiquidation.exec(`ALTER TABLE snapshots ADD COLUMN liquidation_1h_num REAL;
        UPDATE snapshots SET liquidation_1h_num = CAST(substr(captured_at, 15, 2) AS INTEGER) * 10`);
    } finally {
      withLiquidation.close();
    }
    const state = getPresetState(dbPath);
    assert.equal(state.BTC.recentPops.length, 24);
    assert.equal(state.BTC.recentPops[0], 1.002);
    assert.equal(state.BTC.population, 1.025);
    assert.equal(state.BTC.oiDelta, 1);
    assert.equal(state.BTC.liq1h, 250);
    assert.equal(state.BTC.liq1hDelta, 10);
    assert.equal(state.BTC.liqExpanding, true);
    assert.equal(state.ETH.lastSignal, 'SHORT EXHAUSTION');
    const preset = spawnSync(process.execPath, [path.join(__dirname, 'coinank_btc_eth_recorder.cjs'), '--preset'], {
      encoding: 'utf8', env: { ...process.env, COINANK_DB: dbPath },
    });
    assert.equal(preset.status, 0, preset.stderr);
    assert.match(preset.stdout, /Six-hour preset/);
    assert.match(preset.stdout, /BTC/);
    assert.match(preset.stdout, /ETH/);
    assert.match(preset.stdout, /24/);
    const live = consoleTelemetry(readings(
      { population: 1.024, price: 99, raw: { oi: 1020 } },
      { population: 1, price: 99, raw: { oi: 970 } },
    ), state);
    assert.notEqual(live.meta.BTC['OI State / Flip'], 'INIT');
    assert.notEqual(live.meta.BTC['OI Δ (15m)'], 'N/A');
    assert.equal(live.meta.BTC['Pop Hook (15m)'], 'HOOK DOWN');
    assert.equal(live.meta.ETH['Entry Status'], 'IN UNWIND (HOLD / NO RE-ENTRY)');

    const updated = new DatabaseSync(dbPath);
    try {
      updated.exec(`INSERT INTO snapshots (captured_at, coin, price_num, open_interest_num, long_short_ratio_num)
        VALUES ('2026-01-01T00:06:00.000Z', 'ETH', 100, 970, NULL),
               ('2026-01-01T00:07:00.000Z', 'ETH', 100, NULL, 1.03)`);
    } finally {
      updated.close();
    }
    const afterGap = getPresetState(dbPath);
    assert.deepEqual(afterGap.ETH.recentPops, [1.03]);
    assert.equal(afterGap.ETH.oi, null);
    assert.equal(afterGap.ETH.liq1h, null);
    assert.equal(afterGap.ETH.liq1hDelta, null);
    const missingOi = consoleTelemetry(readings(
      { population: 1.024, price: 99, raw: { oi: 1020 } },
      { population: 1.02, price: 99, raw: { oi: 970 } },
    ), afterGap);
    assert.equal(missingOi.meta.ETH['OI Δ (15m)'], 'N/A');
    assert.equal(missingOi.meta.ETH['Entry Status'], 'WAIT');
    assert.deepEqual(getPresetState(path.join(directory, 'missing.db')), {});
    assert.equal(fs.existsSync(path.join(directory, 'missing.db')), false);
  } finally {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    fs.rmdirSync(directory);
  }
});

test('maps CoinAnk fields to numeric columns and BTCDetail display units', () => {
  const item = {
    ...btc, price: 59097.5, markPrice: 59101, fundingRate: 0.000066,
    openInterest: 32630000000, liquidationH1: 1530000, liquidationH4: 13220000,
    liquidationH24: 235370000, marketCap: 1188630000000, turnover24h: 59550000000,
    priceChangeM5: -0.05, openInterestChM15: -0.0005, lsPersonChg5m: 0.0014,
    oiVsMar: 0.027481, oiVsVol: 0.573347, turnoverChg15m: 0.0793,
    circulatingSupply: 20115625, updateTs: 1795217755641,
    rsiH1: 33.61, categories: ['example'], tags: ['tag'], coinImage: 'image',
    exchangeName: 'Binance', supportSpot: true, supportContract: true, show: true, follow: false,
  };
  const snapshot = snapshotFor(item, '2026-11-21T20:00:00.000Z');
  assert.equal(snapshot.funding_rate_pct, 0.0066);
  assert.equal(snapshot.extras.markPrice, 59101);
  assert.equal(snapshot.open_interest_num, 32630000000);
  assert.equal(snapshot.liquidation_24h_num, 235370000);
  assert.equal(snapshot.update_ts, 1795217755641);
  const detail = snapshot;
  assert.equal(detail.Price, '$59097.5');
  assert.equal(detail['Price(5m)'], '-0.05%');
  assert.equal(detail['Funding Rate'], '0.0066%');
  assert.equal(detail['Liquidation (1H)'], '$1.53M');
  assert.equal(detail['Market Cap'], '$1188.63B');
  assert.equal(detail['OI(15m)'], '-0.05%');
  assert.equal(detail['L/S Ratio Of Account(5m%)'], '0.14%');
  assert.equal(detail['L/S Population ratio'], '1.0100');
  assert.equal(detail['OI/Market Cap'], '0.027481');
  assert.equal(detail['Vol Chg15m'], '0.0793');
  assert.equal(snapshot.extras.rsiH1, 33.61);
  for (const field of ['categories', 'tags', 'coinImage', 'exchangeName', 'supportSpot',
    'supportContract', 'show', 'follow']) assert.equal(Object.hasOwn(snapshot.extras, field), false);
});

test('persists both coins atomically, ignores duplicates and leaves unavailable history empty', () => {
  const db = openDatabase(':memory:');
  try {
    const time = '2026-11-21T20:00:00.000Z';
    const btcSnapshot = snapshotFor({ ...btc, rsiH1: 33.61, markPrice: 59101 }, time);
    const ethSnapshot = snapshotFor({ baseCoin: 'ETH', symbol: 'ETHUSDT', price: 1600 }, time);
    assert.deepEqual(insertSnapshots(db, [btcSnapshot, ethSnapshot]), { inserted: 2, ignored: 0 });
    assert.deepEqual(insertSnapshots(db, [btcSnapshot, ethSnapshot]), { inserted: 0, ignored: 2 });
    const eth = db.prepare('SELECT * FROM snapshots WHERE coin = ?').get('ETH');
    assert.equal(eth.price_num, 1600);
    assert.equal(eth.funding_rate_pct, null);
    assert.equal(eth.long_short_ratio_num, null);
    assert.equal(eth['Funding Rate'], null);
    assert.deepEqual(db.prepare(`SELECT metric, value FROM snapshot_extra_metrics
      WHERE snapshot_id = 1 ORDER BY metric`).all().map(row => [row.metric, row.value]),
    [['markPrice', 59101], ['rsiH1', 33.61]]);
    const fresh = snapshotFor({ ...btc }, '2026-11-21T20:15:00.000Z');
    assert.throws(() => insertSnapshots(db, [fresh, { ...fresh, coin: null }]), /NOT NULL/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 2);
  } finally {
    db.close();
  }
});

const expectedColumns = [
  'id', 'captured_at', 'coin', 'symbol', 'update_ts',
  'Price', 'Price(5m)', 'Price(15m)', 'Price(30m)', 'Price(1H)', 'Price(2H)',
  'Price(4H)', 'Price(6H)', 'Price(8H)', 'Price(12H)', 'Price(24H )',
  'Circulating Supply', 'Funding Rate', 'Liquidation (1H)', 'Liquidation (4H)',
  'Liquidation (24H)', 'L/S Top Account', 'L/S (Account)', 'L/S Top Position',
  'L/S Population ratio', 'L/S Ratio Of Account(5m%)', 'L/S Ratio Of Account(15m%)',
  'L/S Ratio Of Account(30m%)', 'L/S Ratio Of Account(1H%)', 'L/S Ratio Of Account(4H%)',
  'Market Cap', 'Max Supply', 'OI/Market Cap', 'OI/Turnover 24h', 'Vol Chg15m',
  'Turnover 24h', 'OI', 'OI(5m)', 'OI(15m)', 'OI(30m)', 'OI(1H)', 'OI(4H)',
  'OI(24H )', 'OI(2D)', 'OI(3D)', 'OI(7D)', 'price_num', 'funding_rate_pct',
  'open_interest_num', 'long_short_account_num', 'long_short_person_num',
  'long_short_position_num', 'long_short_ratio_num', 'liquidation_1h_num',
  'liquidation_4h_num', 'liquidation_24h_num', 'oi_vs_mar_num', 'oi_vs_vol_num',
];

function legacyDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL, coin TEXT NOT NULL,
      symbol TEXT NOT NULL, update_ts INTEGER, price_num REAL, mark_price_num REAL,
      funding_rate_pct REAL, open_interest_num REAL, long_short_account_num REAL,
      long_short_person_num REAL, long_short_position_num REAL, long_short_ratio_num REAL,
      liquidation_1h_num REAL, liquidation_4h_num REAL, liquidation_24h_num REAL,
      oi_vs_mar_num REAL, oi_vs_vol_num REAL, btdetail_json TEXT NOT NULL,
      UNIQUE (captured_at, coin)
    );`);
  return db;
}

test('migrates existing rows in order and preserves bubble values and extra metrics', () => {
  const db = legacyDatabase();
  try {
    const insert = db.prepare(`INSERT INTO snapshots
      (id, captured_at, coin, symbol, price_num, mark_price_num, open_interest_num,
       long_short_ratio_num, btdetail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(3, '2026-11-21T20:00:00.000Z', 'BTC', 'BTCUSDT', 59097.12345678, 59101,
      32630000000.12345, 1.024612345, JSON.stringify({
        Price: '$59097.12345678', 'Funding Rate': '0.0066%', 'L/S Population ratio': '1.0246',
        rsiH1: 33.61, markPrice: 59101,
      }));
    insert.run(9, '2026-11-21T20:00:00.000Z', 'ETH', 'ETHUSDT', 1600, null,
      null, 1.01, JSON.stringify({ Price: '$1600' }));

    ensureSchema(db);
    assert.deepEqual(db.prepare('PRAGMA table_info(snapshots)').all().map(row => row.name), expectedColumns);
    const rows = db.prepare('SELECT * FROM snapshots ORDER BY id').all();
    assert.deepEqual(rows.map(row => row.id), [1, 2]);
    assert.equal(rows[0].Price, '$59097.12345678');
    assert.equal(rows[0]['Funding Rate'], '0.0066%');
    assert.equal(rows[0].price_num, 59097.123457);
    assert.equal(rows[0].open_interest_num, 32630000000.12);
    assert.equal(rows[0].long_short_ratio_num, 1.024612);
    assert.equal(rows[1]['L/S Population ratio'], '1.0100');
    assert.equal(rows[1]['Funding Rate'], null);
    const extras = db.prepare('SELECT metric, value FROM snapshot_extra_metrics WHERE snapshot_id = 1 ORDER BY metric').all();
    assert.deepEqual(extras.map(row => [row.metric, row.value]), [['markPrice', 59101], ['rsiH1', 33.61]]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM btc_snapshots').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM eth_snapshots').get().n, 1);
    ensureSchema(db);
    const duplicate = snapshotFor(btc, '2026-11-21T20:00:00.000Z');
    assert.deepEqual(insertSnapshots(db, [duplicate]), { inserted: 0, ignored: 1 });
    const fresh = snapshotFor(btc, '2026-11-21T20:15:00.000Z');
    assert.deepEqual(insertSnapshots(db, [fresh]), { inserted: 1, ignored: 0 });
    assert.equal(db.prepare('SELECT MAX(id) AS id FROM snapshots').get().id, 3);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});

test('rolls back migration without losing rows when legacy JSON is invalid', () => {
  const db = legacyDatabase();
  try {
    const insert = db.prepare(`INSERT INTO snapshots (id, captured_at, coin, symbol, btdetail_json)
      VALUES (?, ?, ?, ?, ?)`);
    insert.run(2, '2026-11-21T20:00:00.000Z', 'ETH', 'ETHUSDT', '{"Price":"$1600"}');
    insert.run(7, '2026-11-21T20:00:00.000Z', 'BTC', 'BTCUSDT', '{invalid');
    assert.throws(() => ensureSchema(db), /Invalid legacy BTCDetail JSON/);
    assert.deepEqual(db.prepare('SELECT id FROM snapshots ORDER BY id').all().map(row => row.id), [2, 7]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'snapshot_extra_metrics'").get().n, 0);
    assert.ok(db.prepare('PRAGMA table_info(snapshots)').all().some(row => row.name === 'btdetail_json'));
  } finally {
    db.close();
  }
});
