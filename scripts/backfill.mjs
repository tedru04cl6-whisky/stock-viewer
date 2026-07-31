import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { calculateHistoryMetrics, parseNumber } from './fetch.mjs';

const MARKET_URL = (date) =>
  `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date.replaceAll('-', '')}&type=ALLBUT0999&response=json`;
const INSTITUTION_URL = (date) =>
  `https://www.twse.com.tw/rwd/zh/fund/T86?date=${date.replaceAll('-', '')}&selectType=ALL&response=json`;
const REVENUE_URL = (year, month, companyType) =>
  `https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_${year - 1911}_${month}_${companyType}.html`;

function dateShift(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isWeekday(isoDate) {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function escapeText(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .trim();
}

function rowObjects(fields, data) {
  return data.map((row) => Object.fromEntries(fields.map((field, index) => [field, row[index]])));
}

export function parseMarketPayload(payload, allowedCodes = null) {
  if (!payload || payload.stat !== 'OK' || !Array.isArray(payload.tables)) return null;
  const table = payload.tables.find((candidate) =>
    Array.isArray(candidate?.fields) &&
    candidate.fields.includes('證券代號') &&
    candidate.fields.includes('成交股數') &&
    candidate.fields.includes('收盤價') &&
    Array.isArray(candidate.data));
  if (!table) return null;

  const stocks = {};
  for (const row of rowObjects(table.fields, table.data)) {
    const code = String(row['證券代號'] ?? '').trim();
    if (!/^\d{4,6}$/.test(code) || (allowedCodes && !allowedCodes.has(code))) continue;
    const volume = parseNumber(row['成交股數']);
    if (!Number.isFinite(volume)) continue;
    stocks[code] = {
      name: String(row['證券名稱'] ?? '').trim(),
      close: parseNumber(row['收盤價']),
      volume,
      instNetBuy: null,
    };
  }
  return Object.keys(stocks).length ? stocks : null;
}

export function parseInstitutionPayload(payload, allowedCodes = null) {
  if (!payload || payload.stat !== 'OK' || !Array.isArray(payload.fields) || !Array.isArray(payload.data)) {
    throw new Error(`T86 回應無效：${payload?.stat ?? '缺少 stat'}`);
  }
  const codeIndex = payload.fields.indexOf('證券代號');
  const netIndex = payload.fields.findIndex((field) => field === '三大法人買賣超股數' || field === '三大法人買賣超股數合計');
  if (codeIndex < 0 || netIndex < 0) throw new Error('T86 缺少證券代號或三大法人買賣超欄位');

  const result = new Map();
  for (const row of payload.data) {
    const code = String(row[codeIndex] ?? '').trim();
    if (!/^\d{4,6}$/.test(code) || (allowedCodes && !allowedCodes.has(code))) continue;
    const netBuy = parseNumber(row[netIndex]);
    if (!Number.isFinite(netBuy)) continue;
    result.set(code, netBuy);
  }
  return result;
}

export function parseMonthlyRevenueHtml(html, period) {
  const result = new Map();
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => escapeText(match[1]));
    if (cells.length !== 11) continue;
    const code = cells[0];
    const yoy = parseNumber(cells[6]);
    if (!/^\d{4,6}$/.test(code) || !Number.isFinite(yoy)) continue;
    result.set(code, { period, yoy });
  }
  return result;
}

export function mergeRevenueMonths(stocks, monthlyMaps) {
  for (const [code, stock] of Object.entries(stocks)) {
    const entries = monthlyMaps
      .map((month) => month.get(code))
      .filter(Boolean)
      .sort((a, b) => b.period.localeCompare(a.period))
      .slice(0, 3);
    if (!entries.length) continue;
    stock.revenuePeriods = entries.map((entry) => entry.period);
    stock.revenueYoY = entries.map((entry) => entry.yoy);
  }
  return stocks;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'stock-screener-backfill/1.0' } });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function fetchRevenuePage(fetchImpl, year, month, companyType) {
  const response = await fetchImpl(REVENUE_URL(year, month, companyType), { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`月營收 ${year}-${String(month).padStart(2, '0')} 類型 ${companyType} HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const html = new TextDecoder('big5').decode(bytes);
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const rows = parseMonthlyRevenueHtml(html, period);
  if (rows.size === 0) throw new Error(`月營收 ${period} 類型 ${companyType} 沒有可解析資料`);
  return rows;
}

async function fetchRevenueMonth(fetchImpl, year, month) {
  const [domestic, foreign] = await Promise.all([
    fetchRevenuePage(fetchImpl, year, month, 0),
    fetchRevenuePage(fetchImpl, year, month, 1),
  ]);
  return new Map([...domestic, ...foreign]);
}

function previousMonths(period, count) {
  const [startYear, startMonth] = period.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(startYear, startMonth - 1 - index, 1));
    return [date.getUTCFullYear(), date.getUTCMonth() + 1];
  });
}

export async function collectTradingSnapshots(fetchImpl, endDate, allowedCodes, targetCount = 20, maxCalendarDays = 50) {
  const snapshots = [];
  for (let offset = 0; offset < maxCalendarDays && snapshots.length < targetCount; offset += 1) {
    const date = dateShift(endDate, -offset);
    if (!isWeekday(date)) continue;
    const marketPayload = await fetchJson(fetchImpl, MARKET_URL(date));
    const stocks = parseMarketPayload(marketPayload, allowedCodes);
    if (!stocks) continue;
    const institutionPayload = await fetchJson(fetchImpl, INSTITUTION_URL(date));
    const institutions = parseInstitutionPayload(institutionPayload, allowedCodes);
    const institutionCoverage = institutions.size / Object.keys(stocks).length;
    if (institutionCoverage < 0.9) {
      throw new Error(`T86 ${date} 覆蓋率過低：${(institutionCoverage * 100).toFixed(1)}%`);
    }
    for (const [code, stock] of Object.entries(stocks)) stock.instNetBuy = institutions.get(code) ?? null;
    snapshots.push({ dataDate: date, fetchedAt: new Date().toISOString(), stocks });
    console.log(`已取得 ${date}（${Object.keys(stocks).length} 檔）`);
  }
  if (snapshots.length < targetCount) {
    throw new Error(`只取得 ${snapshots.length}/${targetCount} 個交易日，未寫入任何資料`);
  }
  return snapshots.sort((a, b) => a.dataDate.localeCompare(b.dataDate));
}

async function writeJsonAtomically(file, value) {
  await mkdir(resolve(file, '..'), { recursive: true });
  const temp = `${file}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

async function main() {
  const dataDir = resolve(process.env.STOCK_DATA_DIR ?? join(process.cwd(), 'data'));
  const latestFile = join(dataDir, 'latest.json');
  const historyDir = join(dataDir, 'history');
  const latest = JSON.parse(await readFile(latestFile, 'utf8'));
  if (!latest?.dataDate || !latest?.stocks) throw new Error('latest.json 缺少 dataDate 或 stocks');

  const endDate = process.env.STOCK_BACKFILL_END ?? latest.dataDate;
  if (endDate !== latest.dataDate) throw new Error(`回補終點 ${endDate} 必須等於目前快照 ${latest.dataDate}`);
  const allowedCodes = new Set(Object.keys(latest.stocks));
  const snapshots = await collectTradingSnapshots(globalThis.fetch, endDate, allowedCodes);

  const newestRevenuePeriod = latest.stocks[Object.keys(latest.stocks).find((code) =>
    latest.stocks[code]?.revenuePeriods?.[0])]?.revenuePeriods?.[0];
  if (!newestRevenuePeriod) throw new Error('latest.json 找不到最新月營收月份');
  const revenueMonths = await Promise.all(previousMonths(newestRevenuePeriod, 3)
    .map(([year, month]) => fetchRevenueMonth(globalThis.fetch, year, month)));
  mergeRevenueMonths(latest.stocks, revenueMonths);

  const priorHistory = snapshots.filter((snapshot) => snapshot.dataDate !== endDate);
  calculateHistoryMetrics(latest.stocks, priorHistory, endDate);
  latest.fetchedAt = new Date().toISOString();
  const currentSnapshot = { ...latest };

  await mkdir(historyDir, { recursive: true });
  for (const snapshot of priorHistory) {
    await writeJsonAtomically(join(historyDir, `${snapshot.dataDate}.json`), snapshot);
  }
  await writeJsonAtomically(join(historyDir, `${endDate}.json`), currentSnapshot);
  await writeJsonAtomically(latestFile, currentSnapshot);

  const revenueReady = Object.values(latest.stocks).filter((stock) => stock.revenueYoY?.length >= 3).length;
  const volumeReady = Object.values(latest.stocks).filter((stock) => stock.avgVolume20Insufficient === false).length;
  console.log(JSON.stringify({
    dataDate: endDate,
    tradingDays: snapshots.length,
    stocks: allowedCodes.size,
    revenue3MonthsReady: revenueReady,
    avgVolume20Ready: volumeReady,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
