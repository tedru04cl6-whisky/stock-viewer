import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const ENDPOINTS = {
  prices: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  valuation: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  revenue: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
  institutions: (date) => `https://www.twse.com.tw/rwd/zh/fund/T86?date=${date.replaceAll('-', '')}&selectType=ALL&response=json`,
};

const EMPTY_VALUES = new Set(['', '-', '--', '---', '----', '—', '－', 'N/A', 'NA', 'NULL', 'null', '無', '除權息']);

export function parseNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (EMPTY_VALUES.has(text)) return null;
  const normalized = text.replaceAll(',', '').replaceAll('−', '-').replaceAll('＋', '+');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|股)?$/.test(normalized)) return null;
  const result = Number.parseFloat(normalized);
  return Number.isFinite(result) ? result : null;
}

export function parseRocDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replaceAll('年', '/').replaceAll('月', '/').replaceAll('日', '').replace(/\/$/, '');
  let match = text.match(/^(\d{2,4})[\/.\-](\d{1,2})(?:[\/.\-](\d{1,2}))?$/);
  if (!match) {
    match = text.match(/^(\d{3})(\d{2})(\d{2})$/) ?? text.match(/^(20\d{2})(\d{2})(\d{2})$/) ??
      text.match(/^(\d{3})(\d{2})$/);
  }
  if (!match) return null;
  let year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : null;
  if (year < 1911) year += 1911;
  if (month < 1 || month > 12 || (day !== null && (day < 1 || day > 31))) return null;
  if (day !== null) {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  }
  const mm = String(month).padStart(2, '0');
  return day === null ? `${year}-${mm}` : `${year}-${mm}-${String(day).padStart(2, '0')}`;
}

function keyOf(record, names) {
  return names.map((name) => record[name]).find((value) => value !== undefined);
}

function stockCode(record) {
  const value = keyOf(record, ['Code', '公司代號', '證券代號']);
  const code = value === undefined || value === null ? '' : String(value).trim();
  return /^\d{4,6}$/.test(code) ? code : null;
}

function taipeiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function normaliseT86(payload) {
  if (!payload || payload.stat !== 'OK' || !Array.isArray(payload.fields) || !Array.isArray(payload.data)) {
    throw new Error(`T86 回應異常：${payload?.stat ?? '缺少 stat'}`);
  }
  return payload.data.map((row) => Object.fromEntries(payload.fields.map((field, index) => [field, row[index]])));
}

async function fetchPayload(fetchImpl, name, endpoint, dataDate) {
    const url = typeof endpoint === 'function' ? endpoint(dataDate) : endpoint;
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
    return response.json();
}

export function priceDataDate(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  const dates = prices.map((record) => parseRocDate(keyOf(record, ['Date', '日期']))).filter(Boolean);
  if (dates.length === 0) throw new Error('價格資料缺少可辨識的資料日期');
  const unique = [...new Set(dates)];
  if (unique.length !== 1) throw new Error(`價格資料包含多個日期：${unique.join('、')}`);
  return unique[0];
}

export async function fetchAllPayloads(fetchImpl, dataDate) {
  const prices = await fetchPayload(fetchImpl, 'prices', ENDPOINTS.prices, dataDate);
  if (!Array.isArray(prices)) throw new Error('prices 不是陣列回應');
  const publishedDate = priceDataDate(prices);
  if (prices.length === 0 || publishedDate !== dataDate) {
    return { prices, valuation: [], revenue: [], institutions: [], priceDataDate: publishedDate, marketClosed: true };
  }
  const valuation = await fetchPayload(fetchImpl, 'valuation', ENDPOINTS.valuation, dataDate);
  const revenue = await fetchPayload(fetchImpl, 'revenue', ENDPOINTS.revenue, dataDate);
  const institutionPayload = await fetchPayload(fetchImpl, 'institutions', ENDPOINTS.institutions, dataDate);
  if (!Array.isArray(valuation)) throw new Error('valuation 不是陣列回應');
  if (!Array.isArray(revenue)) throw new Error('revenue 不是陣列回應');
  return { prices, valuation, revenue, institutions: normaliseT86(institutionPayload), priceDataDate: publishedDate, marketClosed: false };
}

function byCode(rows) {
  return new Map(rows.map((row) => [stockCode(row), row]).filter(([code]) => code));
}

function revenueForStock(record) {
  if (!record) return null;
  const period = parseRocDate(keyOf(record, ['資料年月', '資料年度月', '年月']));
  const yoy = parseNumber(keyOf(record, ['營業收入-去年同月增減(%)', '去年同月增減(%)']));
  return period && yoy !== null ? { period, yoy } : null;
}

function priorRevenue(stock, current) {
  const entries = new Map();
  for (const [index, yoy] of (stock?.revenueYoY ?? []).entries()) {
    const period = stock?.revenuePeriods?.[index];
    if (period && yoy !== null) entries.set(period, yoy);
  }
  if (current) entries.set(current.period, current.yoy);
  return [...entries.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 3);
}

export function calculateHistoryMetrics(currentStocks, history, currentDataDate = '9999-12-31') {
  const dates = new Map();
  for (const snapshot of [...history, { dataDate: currentDataDate, stocks: currentStocks }]) {
    if (snapshot?.dataDate && snapshot?.stocks) dates.set(snapshot.dataDate, snapshot.stocks);
  }
  const ordered = [...dates.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [code, stock] of Object.entries(currentStocks)) {
    const observations = ordered.map(([, stocks]) => stocks[code]).filter(Boolean);
    const volumes = observations.map((item) => item.volume).filter((value) => Number.isFinite(value));
    const recentVolumes = volumes.slice(-20);
    stock.avgVolume20 = recentVolumes.length
      ? recentVolumes.reduce((sum, value) => sum + value, 0) / recentVolumes.length : null;
    stock.avgVolume20Insufficient = volumes.length < 20;
    let streak = 0;
    for (const item of [...observations].reverse()) {
      if (!Number.isFinite(item.instNetBuy)) break;
      if (item.instNetBuy <= 0) break;
      streak += 1;
    }
    stock.instBuyStreak = streak;
    stock.instStreakInsufficient = !Number.isFinite(observations.at(-1)?.instNetBuy) || observations.length === 0 ||
      (streak === observations.length && observations.length < 20);
  }
  return currentStocks;
}

export function buildSnapshot(payloads, { dataDate, fetchedAt, history = [] }) {
  if (payloads.marketClosed || payloads.prices.length === 0) return null;
  const valuations = byCode(payloads.valuation);
  const revenues = byCode(payloads.revenue);
  const institutions = byCode(payloads.institutions);
  const previous = history.sort((a, b) => b.dataDate.localeCompare(a.dataDate))[0]?.stocks ?? {};
  const stocks = {};

  for (const price of payloads.prices) {
    const code = stockCode(price);
    if (!code) continue;
    const valuation = valuations.get(code) ?? {};
    const institution = institutions.get(code) ?? {};
    const revenue = revenueForStock(revenues.get(code));
    const mergedRevenue = priorRevenue(previous[code], revenue);
    stocks[code] = {
      name: String(keyOf(price, ['Name', '證券名稱', '公司名稱']) ?? '').trim(),
      close: parseNumber(keyOf(price, ['ClosingPrice', '收盤價'])),
      change: parseNumber(keyOf(price, ['Change', '漲跌價差'])),
      volume: parseNumber(keyOf(price, ['TradeVolume', '成交股數'])),
      avgVolume20: null,
      pe: parseNumber(keyOf(valuation, ['PEratio', '本益比'])),
      yield: parseNumber(keyOf(valuation, ['DividendYield', '殖利率(%)'])),
      pb: parseNumber(keyOf(valuation, ['PBratio', '股價淨值比'])),
      revenueYoY: mergedRevenue.map(([, yoy]) => yoy),
      revenuePeriods: mergedRevenue.map(([period]) => period),
      instNetBuy: parseNumber(keyOf(institution, ['三大法人買賣超股數', '三大法人買賣超'])),
      instBuyStreak: 0,
      instStreakInsufficient: true,
    };
  }
  calculateHistoryMetrics(stocks, history, dataDate);
  return { dataDate, fetchedAt, stocks };
}

export async function readHistory(historyDir) {
  let entries = [];
  try { entries = await (await import('node:fs/promises')).readdir(historyDir); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const snapshots = await Promise.all(entries.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(async (name) => {
    try { return JSON.parse(await readFile(join(historyDir, name), 'utf8')); } catch { return null; }
  }));
  return snapshots.filter(Boolean).sort((a, b) => a.dataDate.localeCompare(b.dataDate));
}

export async function writeSnapshotAtomically(snapshot, dataDir) {
  const historyDir = join(dataDir, 'history');
  await mkdir(historyDir, { recursive: true });
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  const nonce = `${process.pid}-${Date.now()}`;
  const latest = join(dataDir, 'latest.json');
  const historical = join(historyDir, `${snapshot.dataDate}.json`);
  const latestTemp = `${latest}.${nonce}.tmp`;
  const historyTemp = `${historical}.${nonce}.tmp`;
  try {
    await Promise.all([writeFile(latestTemp, text), writeFile(historyTemp, text)]);
    await rename(historyTemp, historical);
    await rename(latestTemp, latest);
  } finally {
    await Promise.all([rm(latestTemp, { force: true }), rm(historyTemp, { force: true })]);
  }
}

async function main() {
  const dataDir = process.env.STOCK_DATA_DIR ?? join(process.cwd(), 'data');
  const requestedDate = process.env.STOCK_DATA_DATE ?? taipeiDate();
  const payloads = await fetchAllPayloads(globalThis.fetch, requestedDate);
  if (payloads.marketClosed) {
    console.log(`休市或尚未公布資料（台北日期 ${requestedDate}；價格資料 ${payloads.priceDataDate ?? '無'}），保留既有快照。`);
    return;
  }
  const history = await readHistory(join(dataDir, 'history'));
  const snapshot = buildSnapshot(payloads, { dataDate: payloads.priceDataDate, fetchedAt: new Date().toISOString(), history });
  await writeSnapshotAtomically(snapshot, dataDir);
  console.log(`已寫入 ${Object.keys(snapshot.stocks).length} 檔股票：${snapshot.dataDate}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
