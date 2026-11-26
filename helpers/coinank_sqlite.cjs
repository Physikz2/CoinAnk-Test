const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const defaultDatabase = path.join(__dirname, '..', 'coinank.db');
const excluded = new Set([
  'categories', 'tags', 'coinImage', 'exchangeName', 'supportSpot',
  'supportContract', 'show', 'follow', 'baseCoin', 'symbol',
]);

function optionalNumber(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) {
    throw new Error(`Invalid numeric value for ${field}.`);
  }
  return Number(value);
}

const displayFields = [
  ['price', 'Price', 'price'],
  ['priceChangeM5', 'Price(5m)', 'percent'],
  ['priceChangeM15', 'Price(15m)', 'percent'],
  ['priceChangeM30', 'Price(30m)', 'percent'],
  ['priceChangeH1', 'Price(1H)', 'percent'],
  ['priceChangeH2', 'Price(2H)', 'percent'],
  ['priceChangeH4', 'Price(4H)', 'percent'],
  ['priceChangeH6', 'Price(6H)', 'percent'],
  ['priceChangeH8', 'Price(8H)', 'percent'],
  ['priceChangeH12', 'Price(12H)', 'percent'],
  ['priceChangeH24', 'Price(24H )', 'percent'],
  ['circulatingSupply', 'Circulating Supply', 'plain'],
  ['fundingRate', 'Funding Rate', 'funding'],
  ['liquidationH1', 'Liquidation (1H)', 'currency'],
  ['liquidationH4', 'Liquidation (4H)', 'currency'],
  ['liquidationH24', 'Liquidation (24H)', 'currency'],
  ['longShortAccount', 'L/S Top Account', 'ratio'],
  ['longShortPerson', 'L/S (Account)', 'ratio'],
  ['longShortPosition', 'L/S Top Position', 'ratio'],
  ['longShortRatio', 'L/S Population ratio', 'ratio'],
  ['lsPersonChg5m', 'L/S Ratio Of Account(5m%)', 'fractionPercent'],
  ['lsPersonChg15m', 'L/S Ratio Of Account(15m%)', 'fractionPercent'],
  ['lsPersonChg30m', 'L/S Ratio Of Account(30m%)', 'fractionPercent'],
  ['lsPersonChg1h', 'L/S Ratio Of Account(1H%)', 'fractionPercent'],
  ['lsPersonChg4h', 'L/S Ratio Of Account(4H%)', 'fractionPercent'],
  ['marketCap', 'Market Cap', 'currency'],
  ['maxSupply', 'Max Supply', 'plain'],
  ['oiVsMar', 'OI/Market Cap', 'plain'],
  ['oiVsVol', 'OI/Turnover 24h', 'plain'],
  ['turnoverChg15m', 'Vol Chg15m', 'plain'],
  ['turnover24h', 'Turnover 24h', 'currency'],
  ['openInterest', 'OI', 'currency'],
  ['openInterestChM5', 'OI(5m)', 'fractionPercent'],
  ['openInterestChM15', 'OI(15m)', 'fractionPercent'],
  ['openInterestChM30', 'OI(30m)', 'fractionPercent'],
  ['openInterestCh1', 'OI(1H)', 'fractionPercent'],
  ['openInterestCh4', 'OI(4H)', 'fractionPercent'],
  ['openInterestCh24', 'OI(24H )', 'fractionPercent'],
  ['openInterestCh2D', 'OI(2D)', 'fractionPercent'],
  ['openInterestCh3D', 'OI(3D)', 'fractionPercent'],
  ['openInterestCh7D', 'OI(7D)', 'fractionPercent'],
];
const displayNames = displayFields.map(([, label]) => label);
const displayNameSet = new Set(displayNames);
const numericColumns = [
  'price_num', 'funding_rate_pct', 'open_interest_num', 'long_short_account_num',
  'long_short_person_num', 'long_short_position_num', 'long_short_ratio_num',
  'liquidation_1h_num', 'liquidation_4h_num', 'liquidation_24h_num',
  'oi_vs_mar_num', 'oi_vs_vol_num',
];
const columns = ['captured_at', 'coin', 'symbol', 'update_ts', ...displayNames, ...numericColumns];
const legacyColumns = [
  'id', 'captured_at', 'coin', 'symbol', 'update_ts', 'price_num', 'mark_price_num',
  'funding_rate_pct', 'open_interest_num', 'long_short_account_num',
  'long_short_person_num', 'long_short_position_num', 'long_short_ratio_num',
  'liquidation_1h_num', 'liquidation_4h_num', 'liquidation_24h_num',
  'oi_vs_mar_num', 'oi_vs_vol_num', 'btdetail_json',
];
const amountColumns = new Set([
  'open_interest_num', 'liquidation_1h_num', 'liquidation_4h_num', 'liquidation_24h_num',
]);

function rounded(value, field) {
  const number = optionalNumber(value, field);
  return number === null ? null : Number(number.toFixed(amountColumns.has(field) ? 2 : 6));
}

function quote(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function formatValue(value, kind) {
  if (kind === 'price') return `$${value}`;
  if (kind === 'percent') return `${value.toFixed(2)}%`;
  if (kind === 'funding') return `${(value * 100).toFixed(4)}%`;
  if (kind === 'fractionPercent') return `${(value * 100).toFixed(2)}%`;
  if (kind === 'ratio') return value.toFixed(4);
  if (kind === 'currency') {
    const magnitude = Math.abs(value);
    const [divisor, suffix] = magnitude >= 1e9 ? [1e9, 'B'] :
      magnitude >= 1e6 ? [1e6, 'M'] : magnitude >= 1e3 ? [1e3, 'K'] : [1, ''];
    return `$${(value / divisor).toFixed(2)}${suffix}`;
  }
  return String(value);
}

function detailFor(item) {
  const detail = {};
  const mapped = new Set();
  for (const [field, label, kind] of displayFields) {
    mapped.add(field);
    const value = optionalNumber(item[field], field);
    if (value !== null) detail[label] = formatValue(value, kind);
  }
  for (const [field, value] of Object.entries(item)) {
    if (excluded.has(field) || mapped.has(field) || value === null || value === undefined) continue;
    if (typeof value === 'number' || (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))) {
      detail[field] = optionalNumber(value, field);
    }
  }
  return detail;
}

function snapshotFor(item, capturedAt) {
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.baseCoin !== 'string' || !item.baseCoin ||
      typeof item.symbol !== 'string' || !item.symbol) {
    throw new Error('Snapshot must identify a coin and symbol.');
  }
  const date = new Date(capturedAt);
  if (!capturedAt || Number.isNaN(date.getTime())) throw new Error('Invalid capture timestamp.');
  const updateTs = optionalNumber(item.updateTs, 'updateTs');
  if (updateTs !== null && !Number.isSafeInteger(updateTs)) throw new Error('Invalid integer updateTs.');
  const fundingRate = optionalNumber(item.fundingRate, 'fundingRate');
  const detail = detailFor(item);
  const extras = Object.fromEntries(Object.entries(detail).filter(([key]) => !displayNameSet.has(key)));
  return {
    captured_at: date.toISOString(),
    coin: item.baseCoin,
    symbol: item.symbol,
    update_ts: updateTs,
    ...Object.fromEntries(displayNames.map(name => [name, detail[name] ?? null])),
    price_num: rounded(item.price, 'price_num'),
    funding_rate_pct: rounded(fundingRate === null ? null : fundingRate * 100, 'funding_rate_pct'),
    open_interest_num: rounded(item.openInterest, 'open_interest_num'),
    long_short_account_num: rounded(item.longShortAccount, 'long_short_account_num'),
    long_short_person_num: rounded(item.longShortPerson, 'long_short_person_num'),
    long_short_position_num: rounded(item.longShortPosition, 'long_short_position_num'),
    long_short_ratio_num: rounded(item.longShortRatio, 'long_short_ratio_num'),
    liquidation_1h_num: rounded(item.liquidationH1, 'liquidation_1h_num'),
    liquidation_4h_num: rounded(item.liquidationH4, 'liquidation_4h_num'),
    liquidation_24h_num: rounded(item.liquidationH24, 'liquidation_24h_num'),
    oi_vs_mar_num: rounded(item.oiVsMar, 'oi_vs_mar_num'),
    oi_vs_vol_num: rounded(item.oiVsVol, 'oi_vs_vol_num'),
    extras,
  };
}

function createSnapshots(db, name) {
  db.exec(`CREATE TABLE ${quote(name)} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    coin TEXT NOT NULL,
    symbol TEXT NOT NULL,
    update_ts INTEGER,
    ${displayNames.map(name => `${quote(name)} TEXT`).join(',\n    ')},
    ${numericColumns.map(name => `${quote(name)} REAL`).join(',\n    ')},
    UNIQUE (captured_at, coin)
  )`);
}

function createExtras(db, parent) {
  db.exec(`CREATE TABLE IF NOT EXISTS snapshot_extra_metrics (
    snapshot_id INTEGER NOT NULL REFERENCES ${quote(parent)}(id) ON DELETE CASCADE,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (snapshot_id, metric)
  )`);
}

function prepareInsert(db, table, ignoreDuplicates) {
  return db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})${ignoreDuplicates ? ' ON CONFLICT (captured_at, coin) DO NOTHING' : ''}`);
}

function insertOne(statement, extraStatement, snapshot) {
  const result = statement.run(...columns.map(column => snapshot[column]));
  if (result.changes) {
    for (const [metric, value] of Object.entries(snapshot.extras ?? {})) {
      extraStatement.run(result.lastInsertRowid, metric, value);
    }
  }
  return Number(result.changes);
}

function legacySnapshot(row) {
  let detail;
  try {
    detail = JSON.parse(row.btdetail_json);
  } catch (error) {
    throw new Error(`Invalid legacy BTCDetail JSON for snapshot ${row.id}.`, { cause: error });
  }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new Error(`Invalid legacy BTCDetail object for snapshot ${row.id}.`);
  }
  const fallback = [
    ['Price', 'price_num', 'price'],
    ['L/S Top Account', 'long_short_account_num', 'ratio'],
    ['L/S (Account)', 'long_short_person_num', 'ratio'],
    ['L/S Top Position', 'long_short_position_num', 'ratio'],
    ['L/S Population ratio', 'long_short_ratio_num', 'ratio'],
  ];
  for (const [label, column, kind] of fallback) {
    if (detail[label] === undefined && row[column] !== null) {
      detail[label] = formatValue(optionalNumber(row[column], column), kind);
    }
  }
  const bubble = {};
  const extras = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === null) continue;
    if (displayNameSet.has(key)) {
      if (typeof value !== 'string') throw new Error(`Invalid ${key} for legacy snapshot ${row.id}.`);
      bubble[key] = value;
    } else {
      const number = optionalNumber(value, key);
      if (number === null) throw new Error(`Invalid ${key} for legacy snapshot ${row.id}.`);
      extras[key] = number;
    }
  }
  if (row.mark_price_num !== null) {
    const markPrice = optionalNumber(row.mark_price_num, 'mark_price_num');
    if (extras.markPrice === undefined) extras.markPrice = markPrice;
    else if (extras.markPrice !== markPrice) extras.legacy_mark_price_num = markPrice;
  }
  return {
    captured_at: row.captured_at,
    coin: row.coin,
    symbol: row.symbol,
    update_ts: row.update_ts,
    ...Object.fromEntries(displayNames.map(name => [name, bubble[name] ?? null])),
    ...Object.fromEntries(numericColumns.map(name => [name, rounded(row[name], name)])),
    extras,
  };
}

function ensureSchema(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'").get();
    if (!existing) {
      createSnapshots(db, 'snapshots');
      createExtras(db, 'snapshots');
    } else {
      const actual = db.prepare('PRAGMA table_info(snapshots)').all().map(row => row.name);
      if (JSON.stringify(actual) === JSON.stringify(legacyColumns)) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE name IN ('snapshots_new', 'snapshot_extra_metrics')").get()) {
          throw new Error('Migration target already exists; refusing to overwrite it.');
        }
        createSnapshots(db, 'snapshots_new');
        createExtras(db, 'snapshots_new');
        const insert = prepareInsert(db, 'snapshots_new', false);
        const extra = db.prepare('INSERT INTO snapshot_extra_metrics (snapshot_id, metric, value) VALUES (?, ?, ?)');
        for (const row of db.prepare('SELECT * FROM snapshots ORDER BY id').iterate()) {
          insertOne(insert, extra, legacySnapshot(row));
        }
        db.exec('DROP TABLE snapshots; ALTER TABLE snapshots_new RENAME TO snapshots;');
      } else if (JSON.stringify(actual) !== JSON.stringify(['id', ...columns])) {
        throw new Error('Unrecognized snapshots schema; no migration was performed.');
      } else {
        createExtras(db, 'snapshots');
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS snapshots_coin_captured_at ON snapshots (coin, captured_at);
      CREATE VIEW IF NOT EXISTS btc_snapshots AS SELECT * FROM snapshots WHERE coin = 'BTC';
      CREATE VIEW IF NOT EXISTS eth_snapshots AS SELECT * FROM snapshots WHERE coin = 'ETH';
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function openDatabase(databasePath = defaultDatabase) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
    ensureSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function insertSnapshots(db, snapshots) {
  const statement = prepareInsert(db, 'snapshots', true);
  const extra = db.prepare('INSERT INTO snapshot_extra_metrics (snapshot_id, metric, value) VALUES (?, ?, ?)');
  const existing = db.prepare('SELECT id FROM snapshots WHERE captured_at = ? AND coin = ?');
  let inserted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const snapshot of snapshots) {
      if (existing.get(snapshot.captured_at, snapshot.coin)) continue;
      inserted += insertOne(statement, extra, snapshot);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { inserted, ignored: snapshots.length - inserted };
}

module.exports = { defaultDatabase, detailFor, snapshotFor, openDatabase, ensureSchema, insertSnapshots };
