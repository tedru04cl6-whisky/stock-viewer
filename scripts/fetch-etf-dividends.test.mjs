import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDividendDataset,
  parseDividendHtml,
  parseFundDataset,
  parseRocCalendarDate,
} from './fetch-etf-dividends.mjs';

test('parseRocCalendarDate converts valid ROC dates', () => {
  assert.equal(parseRocCalendarDate('115年08月10日'), '2026-08-10');
  assert.equal(parseRocCalendarDate('115年02月30日'), null);
  assert.equal(parseRocCalendarDate('待公告'), null);
});

test('parseDividendHtml reads official ETF dividend rows', () => {
  const html = `<table><tbody>
    <tr onclick="document.location = '/zh/ETFortune/etfInfo/0050';">
      <td>0050</td><td>元大台灣50</td><td>115年07月21日</td>
      <td>115年07月27日</td><td>115年08月10日</td><td>0.6</td>
      <td><a href="#">詳細資料</a></td><td>115</td>
    </tr>
    <tr onclick="document.location = '/zh/ETFortune/etfInfo/00999';">
      <td>00999</td><td>測試ETF</td><td>日期錯誤</td>
      <td>115年07月27日</td><td>115年08月10日</td><td></td><td></td><td>115</td>
    </tr>
  </tbody></table>`;
  assert.deepEqual(parseDividendHtml(html), [{
    code: '0050',
    name: '元大台灣50',
    exDate: '2026-07-21',
    recordDate: '2026-07-27',
    paymentDate: '2026-08-10',
    amount: 0.6,
  }]);
});

test('buildDividendDataset groups and sorts records by payment date', () => {
  const records = [
    { code: '0050', name: '元大台灣50', exDate: '2025-07-18', recordDate: '2025-07-24', paymentDate: '2025-08-08', amount: 0.36 },
    { code: '0050', name: '元大台灣50', exDate: '2026-07-21', recordDate: '2026-07-27', paymentDate: '2026-08-10', amount: 0.6 },
    { code: '0050', name: '元大台灣50', exDate: '2026-07-21', recordDate: '2026-07-27', paymentDate: '2026-08-10', amount: 0.6 },
  ];
  const dataset = buildDividendDataset(records, { updatedAt: '2026-07-24', startYear: 2025, endYear: 2026 });
  assert.deepEqual(dataset.years, [2025, 2026]);
  assert.equal(dataset.dividends['0050'].records[0].paymentDate, '2026-08-10');
  assert.equal(dataset.dividends['0050'].records.length, 2, '官方清單的完全重複列需去重');
  assert.match(dataset.sourceUrl, /startDate=2025&endDate=2026/);
});

test('parseFundDataset includes ETFs without recent dividends', () => {
  const etfs = parseFundDataset([
    { 基金代號: '0057', 基金簡稱: '富邦摩台', 基金類型: '國內成分證券指數股票型基金', 上市日期: '0970227' },
    { 基金代號: '0061', 基金簡稱: '元大寶滬深', 基金類型: '連結式證券指數股票型基金', 上市日期: '0980817' },
    { 基金代號: '', 基金簡稱: '無效資料' },
  ]);
  assert.equal(etfs['0057'].name, '富邦摩台');
  assert.equal(etfs['0061'].name, '元大寶滬深');
  assert.equal(Object.keys(etfs).length, 2);
});
