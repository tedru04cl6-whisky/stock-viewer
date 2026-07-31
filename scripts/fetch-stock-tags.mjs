import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const REVENUE_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L';

function percentile(values, fraction) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

export function buildStockTags(latest, history, industries, etfCodes = new Set()) {
  const snapshots = new Map(history.map((snapshot) => [snapshot.dataDate, snapshot.stocks]));
  snapshots.set(latest.dataDate, latest.stocks);
  const ordered = [...snapshots.entries()].sort(([a], [b]) => a.localeCompare(b));
  const metrics = Object.entries(latest.stocks).flatMap(([code, stock]) => {
    if (etfCodes.has(code) || !/^\d{4}$/.test(code)) return [];
    const observations = ordered.map(([, stocks]) => stocks[code]).filter(Boolean);
    const closes = observations.map((item) => item.close).filter(Number.isFinite).slice(-20);
    const return20 = closes.length >= 2 && closes[0] > 0 ? (closes.at(-1) / closes[0] - 1) * 100 : null;
    const turnover = Number.isFinite(stock.close) && Number.isFinite(stock.volume) ? stock.close * stock.volume : null;
    const volumeRatio = Number.isFinite(stock.avgVolume20) && stock.avgVolume20 > 0 ? stock.volume / stock.avgVolume20 : null;
    return [{ code, industry: industries.get(code) ?? '', return20, turnover, volumeRatio, instBuyStreak: stock.instBuyStreak }];
  });
  const strongThreshold = percentile(metrics.map((item) => item.return20), 0.9);
  const hotCodes = new Set(metrics.filter((item) => Number.isFinite(item.turnover)).sort((a, b) => b.turnover - a.turnover).slice(0, 30).map((item) => item.code));
  const tags = {};
  for (const item of metrics) {
    const signals = [];
    if (hotCodes.has(item.code)) signals.push('成交熱門');
    if (strongThreshold !== null && item.return20 > 0 && item.return20 >= strongThreshold) signals.push('近期強勢');
    if (Number(item.instBuyStreak) >= 3) signals.push('法人連買');
    if (Number(item.volumeRatio) >= 1.5) signals.push('放量');
    tags[item.code] = {
      industry: item.industry,
      signals,
      return20: Number.isFinite(item.return20) ? Number(item.return20.toFixed(2)) : null,
    };
  }
  return { tags, strongThreshold };
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

async function main() {
  const dataDir = resolve(process.env.STOCK_DATA_DIR ?? join(process.cwd(), 'data'));
  const latest = JSON.parse(await readFile(join(dataDir, 'latest.json'), 'utf8'));
  const historyFiles = (await readdir(join(dataDir, 'history'))).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name));
  const history = await Promise.all(historyFiles.map(async (name) => JSON.parse(await readFile(join(dataDir, 'history', name), 'utf8'))));
  const revenueResponse = await fetch(REVENUE_URL, { headers: { accept: 'application/json' } });
  if (!revenueResponse.ok) throw new Error(`產業資料 HTTP ${revenueResponse.status}`);
  const revenue = await revenueResponse.json();
  if (!Array.isArray(revenue) || revenue.length < 500) throw new Error('產業資料筆數異常');
  const industries = new Map(revenue.map((row) => [String(row['公司代號'] ?? '').trim(), String(row['產業別'] ?? '').trim()]).filter(([code, industry]) => /^\d{4}$/.test(code) && industry));
  const dividends = JSON.parse(await readFile(join(dataDir, 'etf-dividends.json'), 'utf8'));
  const etfCodes = new Set(Object.keys(dividends.etfs ?? dividends.dividends ?? {}));
  const { tags, strongThreshold } = buildStockTags(latest, history, industries, etfCodes);
  const industryCounts = {};
  for (const item of Object.values(tags)) if (item.industry) industryCounts[item.industry] = (industryCounts[item.industry] ?? 0) + 1;
  const dataset = {
    updatedAt: latest.dataDate,
    methodology: `成交熱門＝當日成交金額估算前 30；近期強勢＝近 20 個交易日報酬前 10% 且為正；法人連買＝至少 3 日；放量＝當日量達 20 日均量 1.5 倍。`,
    strongThreshold,
    industries: Object.entries(industryCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    tags,
  };
  const output = resolve(process.env.STOCK_TAGS_OUTPUT ?? join(dataDir, 'stock-tags.json'));
  await writeJsonAtomically(output, dataset);
  console.log(JSON.stringify({ stocks: Object.keys(tags).length, industries: dataset.industries.length, output }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
