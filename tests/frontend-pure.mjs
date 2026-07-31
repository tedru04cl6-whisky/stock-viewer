import assert from 'node:assert/strict';
import { annualizedVolatility, applyStockTagFilters, areConsecutivePeriods, calculateR2, dividendRecords, excludeEtfs, filteredStocks, findTheme, maximumDrawdown, normaliseWatchlist, numericValue, riskAssessment, safeHttpsUrl, themeStocks } from '../app.js';

assert.equal(calculateR2([10, 20, 30, 40]), 1, '線性收盤價 R² 應為 1');
assert.equal(maximumDrawdown([100, 120, 90, 110, 80]), 1 / 3, '應找出峰值 120 至 80 的最大回撤');
assert.equal(annualizedVolatility([100, 100, 100, 100]), 0, '固定收盤價波動率為 0');
assert.equal(riskAssessment([100, 101, 102, 103, 104, 105]).label, '穩健');
assert.equal(riskAssessment([100, 150, 75, 150, 75, 150, 75, 150]).label, '賭性堅強');
assert.equal(riskAssessment([100, 101]).label, '資料不足');
assert.equal(riskAssessment(Array(30).fill(100)).trend, '持平', '常數序列不可宣稱趨勢明確');
assert.equal(calculateR2(Array(30).fill(100)), null, '常數序列 R² 未定義');
assert.equal(areConsecutivePeriods(['2026-06', '2026-05', '2026-04']), true);
assert.equal(areConsecutivePeriods(['2026-06', '2026-04', '2026-03']), false, '缺月不可視為連續三月');
assert.equal(numericValue(null), null, 'null 不可被當成 0');
assert.equal(numericValue(''), null, '空字串不可被當成 0');
assert.deepEqual(normaliseWatchlist('2330'), [], 'localStorage 非陣列資料需回復空清單');
assert.deepEqual(normaliseWatchlist(['2330', '2330', 'bad']), ['2330'], '自選清單需去重並濾除無效代號');

const stocks = {
  '1111': { revenueYoY: [1, 2, 3], revenuePeriods: ['2026-06', '2026-05', '2026-04'], pe: 15, yield: 4, pb: 1.5, instBuyStreak: 4, volume: 160, avgVolume20: 100 },
  '2222': { revenueYoY: [1, 2, 3], revenuePeriods: ['2026-06', '2026-05', '2026-04'], pe: 15, yield: 4, pb: 1.5, instBuyStreak: 1, volume: 160, avgVolume20: 100 },
  '3333': { revenueYoY: [1, 2, 3], revenuePeriods: ['2026-06', '2026-05', '2026-04'], pe: 15, yield: 4, pb: 1.5, instBuyStreak: 4, volume: 80, avgVolume20: 100 },
  '4444': { revenueYoY: [1, 2, 3], revenuePeriods: ['2026-06', '2026-05', '2026-04'], pe: 15, yield: null, pb: null, instBuyStreak: 4, volume: 160, avgVolume20: 100 },
  '5555': { revenueYoY: [1, 2, 3], revenuePeriods: ['2026-06', '2026-05', '2026-04'], pe: 15, yield: 4, pb: 1.5, instBuyStreak: 4, volume: 160, avgVolume20: null },
  '6666': { revenueYoY: [1, 2, 3], revenuePeriods: ['2026-06', '2026-04', '2026-03'], pe: 15, yield: 4, pb: 1.5, instBuyStreak: 4, volume: 160, avgVolume20: 100 },
};
const filters = { fundamentals: { enabled: true, pe: 20, yield: 3, pb: 2 }, momentum: { enabled: true, streak: 3, volumeMultiple: 1.5 } };
assert.deepEqual(filteredStocks(stocks, filters).map(({ id }) => id), ['1111'], '兩個條件組需取交集');
filters.momentum.enabled = false;
assert.deepEqual(filteredStocks(stocks, filters).map(({ id }) => id), ['1111', '2222', '3333', '5555'], '停用條件組後只依另一組篩選，缺值不得誤入選');
const themes = {
  ai: {
    label: 'AI 人工智慧',
    aliases: ['AI', '人工智慧', 'AI 相關股票'],
    categories: ['晶片與 ASIC', 'AI 伺服器'],
    stocks: {
      '1111': { categories: ['晶片與 ASIC'], reason: '測試晶片' },
      '2222': { categories: ['AI 伺服器'], reason: '測試伺服器' },
      '9999': { categories: ['AI 伺服器'], reason: '市場快照沒有此股票' },
    },
  },
};
assert.equal(findTheme(themes, '人工智慧').id, 'ai', '可用題材別名找到 AI 名單');
assert.equal(findTheme(themes, '伺服器').id, 'ai', '可用細分類找到 AI 名單');
assert.equal(findTheme(themes, 'AI相關股票').id, 'ai', '可辨識自然語句中的題材關鍵字');
assert.equal(findTheme(themes, '生技'), null, '未知題材不應猜測名單');
assert.equal(findTheme(themes, 'I'), null, '單一英文字母不得誤命中題材');
assert.equal(findTheme(themes, '片'), null, '單一中文字不得誤命中題材');
assert.deepEqual(themeStocks(themes.ai, stocks).map(({ id }) => id), ['1111', '2222'], '只顯示市場快照中存在的題材股');
assert.deepEqual(themeStocks(themes.ai, stocks, 'AI 伺服器').map(({ id }) => id), ['2222'], '可依供應鏈細分類');
filters.momentum.enabled = true;
assert.deepEqual(themeStocks(themes.ai, stocks, '全部', true, filters).map(({ id }) => id), ['1111'], '可疊加目前篩選條件');
assert.equal(safeHttpsUrl('https://example.com/source'), 'https://example.com/source', '只允許 HTTPS 官方來源');
assert.equal(safeHttpsUrl('javascript:alert(1)'), '', '不得渲染可執行的來源網址');
assert.equal(safeHttpsUrl('http://example.com/source'), '', '不得降級為未加密來源網址');
const dividendDataset = {
  dividends: {
    '0050': {
      name: '元大台灣50',
      records: [
        { exDate: '2026-07-21', recordDate: '2026-07-27', paymentDate: '2026-08-10', amount: 0.6 },
        { exDate: '2026-01-22', recordDate: '2026-01-28', paymentDate: '2026-02-11', amount: 1 },
      ],
    },
    '0056': {
      name: '元大高股息',
      records: [
        { exDate: '2026-07-21', recordDate: '2026-07-27', paymentDate: '2026-08-10', amount: null },
        { exDate: '2026-03-20', recordDate: '2026-03-26', paymentDate: '2026-04-15' },
      ],
    },
  },
};
assert.deepEqual(
  dividendRecords(dividendDataset, { dateField: 'paymentDate', year: '2026', month: '8' }).map(({ code }) => code),
  ['0050', '0056'],
  '可依實際入帳月份查 ETF',
);
assert.deepEqual(
  dividendRecords(dividendDataset, { dateField: 'exDate', year: '2026', month: '1' }).map(({ code }) => code),
  ['0050'],
  '除息月份與入帳月份必須分開查',
);
assert.deepEqual(dividendRecords(dividendDataset, { dateField: 'bad' }), [], '不接受未知日期欄位');
assert.deepEqual(
  dividendRecords(dividendDataset, { dateField: 'paymentDate', year: '2026', sort: 'amount-desc' }).map(({ amount }) => amount),
  [1, 0.6, undefined, null],
  '每單位配息金額可由大到小排序，未公告金額置底',
);
assert.deepEqual(
  dividendRecords(dividendDataset, { dateField: 'paymentDate', year: '2026', sort: 'amount-asc' }).map(({ amount }) => amount),
  [0.6, 1, undefined, null],
  '每單位配息金額可由小到大排序，未公告金額仍置底',
);
assert.deepEqual(
  excludeEtfs([{ id: '2330' }, { id: '0050' }, { id: '0061' }], { etfs: { '0050': {}, '0061': {} } }).map(({ id }) => id),
  ['2330'],
  '個股篩選必須排除完整 ETF 名單，包含近期沒有配息的 ETF',
);
const taggedStocks = [{ id: '1111' }, { id: '2222' }, { id: '3333' }];
const tagDataset = {
  tags: {
    '1111': { industry: '金融保險業', signals: ['成交熱門'] },
    '2222': { industry: '半導體業', signals: ['近期強勢', '放量'] },
    '3333': { industry: '金融保險業', signals: [] },
  },
};
assert.deepEqual(applyStockTagFilters(taggedStocks, tagDataset, '金融保險業', '全部').map(({ id }) => id), ['1111', '3333'], '可依產業分類');
assert.deepEqual(applyStockTagFilters(taggedStocks, tagDataset, '全部', '近期強勢').map(({ id }) => id), ['2222'], '可依量化趨勢標籤分類');
console.log('frontend pure tests passed');
