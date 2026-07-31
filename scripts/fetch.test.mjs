import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildSnapshot, calculateHistoryMetrics, fetchAllPayloads, parseNumber, parseRocDate, priceDataDate, writeSnapshotAtomically,
} from './fetch.mjs';

test('民國日期與空值數字會正確解析', () => {
  assert.equal(parseRocDate('115/07/19'), '2026-07-19');
  assert.equal(parseRocDate('115年6月'), '2026-06');
  assert.equal(parseNumber('1,234.50'), 1234.5);
  assert.equal(parseNumber('--'), null);
  assert.equal(parseNumber('除權息'), null);
  assert.equal(parseNumber('-42'), -42);
  assert.equal(parseRocDate('115/02/31'), null);
  assert.equal(priceDataDate([{ Date: '1150717' }]), '2026-07-17');
});

test('休市的空價格資料不建立快照', () => {
  assert.equal(buildSnapshot({ prices: [], valuation: [], revenue: [], institutions: [] }, {
    dataDate: '2026-07-19', fetchedAt: '2026-07-19T00:00:00.000Z', history: [],
  }), null);
});

test('休市時價格端點仍有前一交易日資料也會正常結束', async () => {
  const calls = [];
  const payloads = await fetchAllPayloads(async (url) => {
    calls.push(url);
    return ({
    ok: true,
    status: 200,
    json: async () => [{ Date: '1150717', Code: '2330' }],
  });
  }, '2026-07-19');
  assert.equal(payloads.marketClosed, true);
  assert.equal(payloads.priceDataDate, '2026-07-17');
  assert.deepEqual(payloads.institutions, []);
  assert.equal(calls.length, 1, '確認休市後不再呼叫其餘端點');
});

test('history 計算二十日均量與連買，資料不足會標記', () => {
  const history = Array.from({ length: 19 }, (_, index) => ({
    dataDate: `2026-06-${String(index + 1).padStart(2, '0')}`,
    stocks: { '2330': { volume: 100 + index, instNetBuy: index < 16 ? -1 : 1 } },
  }));
  const stocks = { '2330': { volume: 200, instNetBuy: 1 }, '2317': { volume: 5, instNetBuy: 2 } };
  calculateHistoryMetrics(stocks, history, '2026-06-20');
  assert.equal(stocks['2330'].avgVolume20, 113.55);
  assert.equal(stocks['2330'].avgVolume20Insufficient, false);
  assert.equal(stocks['2330'].instBuyStreak, 4);
  assert.equal(stocks['2317'].avgVolume20, 5);
  assert.equal(stocks['2317'].avgVolume20Insufficient, true);
  assert.equal(stocks['2317'].instStreakInsufficient, true);
});

test('同日重跑會覆蓋當日觀察，不重複計算均量與連買', () => {
  const history = [
    { dataDate: '2026-07-16', stocks: { '2330': { volume: 50, instNetBuy: -1 } } },
    { dataDate: '2026-07-17', stocks: { '2330': { volume: 100, instNetBuy: 1 } } },
  ];
  const stocks = { '2330': { volume: 200, instNetBuy: 1 } };
  calculateHistoryMetrics(stocks, history, '2026-07-17');
  assert.equal(stocks['2330'].avgVolume20, 125);
  assert.equal(stocks['2330'].instBuyStreak, 1);
});

test('月營收依資料年月去重後，保留最近三個月', () => {
  const history = [{ dataDate: '2026-07-18', stocks: {
    '2330': { revenueYoY: [8.1, 15.2, 4], revenuePeriods: ['2026-05', '2026-04', '2026-03'] },
  } }];
  const snapshot = buildSnapshot({
    prices: [{ Code: '2330', Name: '台積電', ClosingPrice: '100', TradeVolume: '1,000', Change: '1' }],
    valuation: [{ Code: '2330', PEratio: '20', DividendYield: '1.0', PBratio: '3' }],
    revenue: [{ 公司代號: '2330', 資料年月: '115年6月', '營業收入-去年同月增減(%)': '12.3' }],
    institutions: [{ 證券代號: '2330', 三大法人買賣超股數: '99' }],
  }, { dataDate: '2026-07-19', fetchedAt: '2026-07-19T00:00:00.000Z', history });
  assert.deepEqual(snapshot.stocks['2330'].revenuePeriods, ['2026-06', '2026-05', '2026-04']);
  assert.deepEqual(snapshot.stocks['2330'].revenueYoY, [12.3, 8.1, 15.2]);
});

test('任一端點失敗時，不會進入寫檔前的合併流程', async () => {
  const fetchImpl = async (url) => url.includes('BWIBBU')
    ? { ok: false, status: 503, json: async () => [] }
    : { ok: true, status: 200, json: async () => url.includes('STOCK_DAY_ALL') ? [{ Date: '1150719', Code: '2330' }] : url.includes('T86') ? { stat: 'OK', fields: [], data: [] } : [] };
  await assert.rejects(fetchAllPayloads(fetchImpl, '2026-07-19'), /valuation HTTP 503/);
});

test('快照以暫存檔完成後才取代 latest 與 history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twse-fetch-'));
  const dataDir = join(root, 'data');
  const snapshot = { dataDate: '2026-07-19', fetchedAt: '2026-07-19T00:00:00.000Z', stocks: {} };
  await writeSnapshotAtomically(snapshot, dataDir);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'latest.json'), 'utf8')), snapshot);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'history', '2026-07-19.json'), 'utf8')), snapshot);
  await writeFile(join(dataDir, 'latest.json'), '{"old":true}\n');
  await assert.rejects(fetchAllPayloads(async () => ({ ok: false, status: 500 }), '2026-07-20'));
  assert.equal(await readFile(join(dataDir, 'latest.json'), 'utf8'), '{"old":true}\n');
});
