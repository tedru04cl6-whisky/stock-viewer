import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const SOURCE_BASE = 'https://www.twse.com.tw/zh/ETFortune/dividendList';
const FUND_SOURCE = 'https://openapi.twse.com.tw/v1/opendata/t187ap47_L';

function plainText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRocCalendarDate(value) {
  const match = String(value ?? '').trim().match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日$/);
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function amountValue(value) {
  const text = String(value ?? '').replaceAll(',', '').trim();
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

export function parseDividendHtml(html) {
  const records = [];
  for (const row of String(html ?? '').matchAll(
    /<tr\b[^>]*onclick=["']document\.location\s*=\s*['"]\/zh\/ETFortune\/etfInfo\/([^'"]+)['"];?["'][^>]*>([\s\S]*?)<\/tr>/gi,
  )) {
    const cells = [...row[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => plainText(match[1]));
    if (cells.length < 6) continue;
    const code = plainText(row[1]);
    const exDate = parseRocCalendarDate(cells[2]);
    const recordDate = parseRocCalendarDate(cells[3]);
    const paymentDate = parseRocCalendarDate(cells[4]);
    if (!/^[0-9A-Z]{4,8}$/.test(code) || !exDate || !recordDate || !paymentDate) continue;
    records.push({
      code,
      name: cells[1],
      exDate,
      recordDate,
      paymentDate,
      amount: amountValue(cells[5]),
    });
  }
  return records;
}

export function parseFundDataset(rows) {
  const etfs = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = String(row?.['基金代號'] ?? '').trim().toUpperCase();
    const name = String(row?.['基金簡稱'] ?? '').trim();
    if (!/^[0-9A-Z]{4,8}$/.test(code) || !name) continue;
    etfs[code] = {
      name,
      type: String(row?.['基金類型'] ?? '').trim(),
      listingDate: String(row?.['上市日期'] ?? '').trim(),
    };
  }
  return etfs;
}

export function buildDividendDataset(records, { updatedAt, startYear, endYear }, etfs = {}) {
  const dividends = {};
  const seen = new Map();
  for (const record of records) {
    dividends[record.code] ??= { name: record.name, records: [] };
    seen.set(record.code, seen.get(record.code) ?? new Set());
    const recordKey = [record.exDate, record.recordDate, record.paymentDate, record.amount].join('|');
    if (seen.get(record.code).has(recordKey)) continue;
    seen.get(record.code).add(recordKey);
    dividends[record.code].records.push({
      exDate: record.exDate,
      recordDate: record.recordDate,
      paymentDate: record.paymentDate,
      amount: record.amount,
    });
  }
  for (const item of Object.values(dividends)) {
    item.records.sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.exDate.localeCompare(a.exDate));
  }
  return {
    updatedAt,
    years: [startYear, endYear],
    sourceUrl: `${SOURCE_BASE}?startDate=${startYear}&endDate=${endYear}`,
    fundSourceUrl: FUND_SOURCE,
    methodology: '依臺灣證券交易所 ETF e添富公告整理；除息日與收益分配發放日分開呈現，未公告金額顯示為待公告。',
    etfs,
    dividends,
  };
}

async function writeJsonAtomically(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

function taipeiYearAndDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { year: Number(parts.year), date: `${parts.year}-${parts.month}-${parts.day}` };
}

async function main() {
  const { year, date } = taipeiYearAndDate();
  const startYear = Number(process.env.ETF_DIVIDEND_START_YEAR ?? year - 1);
  const endYear = Number(process.env.ETF_DIVIDEND_END_YEAR ?? year);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear > endYear) {
    throw new Error('ETF 配息查詢年度不正確');
  }
  const sourceUrl = `${SOURCE_BASE}?startDate=${startYear}&endDate=${endYear}`;
  const [response, fundResponse] = await Promise.all([
    fetch(sourceUrl, { headers: { accept: 'text/html', 'user-agent': 'stock-screener-dividend-fetch/1.0' } }),
    fetch(FUND_SOURCE, { headers: { accept: 'application/json', 'user-agent': 'stock-screener-dividend-fetch/1.0' } }),
  ]);
  if (!response.ok) throw new Error(`ETF 配息清單 HTTP ${response.status}`);
  if (!fundResponse.ok) throw new Error(`ETF 基本資料 HTTP ${fundResponse.status}`);
  const records = parseDividendHtml(await response.text());
  const etfs = parseFundDataset(await fundResponse.json());
  const uniqueCodes = new Set(records.map((record) => record.code)).size;
  if (records.length < 100 || uniqueCodes < 50) {
    throw new Error(`ETF 配息資料筆數異常：${records.length} 筆、${uniqueCodes} 檔`);
  }
  if (Object.keys(etfs).length < 150 || !etfs['0050'] || !etfs['0057'] || !etfs['0061']) {
    throw new Error(`ETF 基本資料筆數異常：${Object.keys(etfs).length} 檔`);
  }
  const dataset = buildDividendDataset(records, { updatedAt: date, startYear, endYear }, etfs);
  const output = resolve(process.env.ETF_DIVIDEND_OUTPUT ?? join(process.cwd(), 'data', 'etf-dividends.json'));
  if (process.env.ETF_DIVIDEND_BACKUP === '1') {
    try {
      await writeFile(`${output}.${Date.now()}.bak`, await readFile(output));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await writeJsonAtomically(output, dataset);
  console.log(JSON.stringify({ updatedAt: date, records: records.length, dividendEtfs: uniqueCodes, etfs: Object.keys(etfs).length, output }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
