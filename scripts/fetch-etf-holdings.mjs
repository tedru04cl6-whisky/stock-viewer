import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const FUNDS = {
  '0050': { name: '元大台灣50', url: 'https://www.yuantaetfs.com/product/detail/0050/ratio' },
  '0056': { name: '元大高股息', url: 'https://www.yuantaetfs.com/product/detail/0056/ratio' },
};

function text(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseYuantaHoldingsHtml(html) {
  const date = [...String(html).matchAll(/20\d{2}\/\d{2}\/\d{2}/g)].map((match) => match[0].replaceAll('/', '-'))[0] ?? null;
  const holdings = [];
  const pattern = /商品代碼<\/span>\s*<span[^>]*>([^<]+)<\/span>[\s\S]*?商品名稱<\/span>\s*<span[^>]*>([^<]+)<\/span>[\s\S]*?商品數量<\/span>\s*<span[^>]*>([^<]+)<\/span>[\s\S]*?商品權重<\/span>\s*<span[^>]*>([^<]+)<\/span>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const code = text(match[1]);
    const quantity = Number(text(match[3]).replaceAll(',', ''));
    const weight = Number(text(match[4]).replace('%', ''));
    if (!/^\d{4,6}$/.test(code) || !Number.isFinite(quantity) || !Number.isFinite(weight)) continue;
    holdings.push({ code, name: text(match[2]), quantity, weight });
  }
  return { date, holdings: holdings.sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code)) };
}

export function buildHoldingsDataset(results, updatedAt) {
  const funds = {};
  for (const result of results) {
    funds[result.code] = {
      name: result.name,
      holdingsDate: result.date,
      sourceUrl: result.url,
      holdings: result.holdings,
    };
  }
  return {
    updatedAt,
    methodology: '主要持股與權重取自投信官方持股比重頁；目前先支援可穩定自動更新的元大台股 ETF，顯示官方頁公開的前五大持股。',
    funds,
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

function taipeiDate(now = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function main() {
  const results = [];
  for (const [code, fund] of Object.entries(FUNDS)) {
    const response = await fetch(fund.url, { headers: { 'user-agent': 'stock-screener-holdings-fetch/1.0' } });
    if (!response.ok) throw new Error(`${code} 持股資料 HTTP ${response.status}`);
    const parsed = parseYuantaHoldingsHtml(await response.text());
    if (!parsed.date || parsed.holdings.length < 5) throw new Error(`${code} 持股資料格式異常`);
    results.push({ code, ...fund, ...parsed });
  }
  const dataset = buildHoldingsDataset(results, taipeiDate());
  const output = resolve(process.env.ETF_HOLDINGS_OUTPUT ?? join(process.cwd(), 'data', 'etf-holdings.json'));
  await writeJsonAtomically(output, dataset);
  console.log(JSON.stringify({
    funds: Object.keys(dataset.funds).length,
    holdings: Object.values(dataset.funds).reduce((sum, fund) => sum + fund.holdings.length, 0),
    output,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
