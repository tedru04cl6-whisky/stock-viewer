import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeRevenueMonths,
  parseInstitutionPayload,
  parseMarketPayload,
  parseMonthlyRevenueHtml,
} from './backfill.mjs';

test('parseMarketPayload locates the security table and filters codes', () => {
  const payload = {
    stat: 'OK',
    tables: [
      { fields: ['指數', '收盤指數'], data: [['TAIEX', '20,000']] },
      {
        fields: ['證券代號', '證券名稱', '成交股數', '收盤價'],
        data: [['2330', '台積電', '12,345', '1,000'], ['0050', '元大台灣50', '9,876', '200']],
      },
    ],
  };
  assert.deepEqual(parseMarketPayload(payload, new Set(['2330'])), {
    2330: { name: '台積電', close: 1000, volume: 12345, instNetBuy: null },
  });
});

test('parseInstitutionPayload reads the total net-buy column', () => {
  const payload = {
    stat: 'OK',
    fields: ['證券代號', '證券名稱', '三大法人買賣超股數'],
    data: [['2330', '台積電', '-1,234'], ['0050', '元大台灣50', '2,000']],
  };
  assert.deepEqual([...parseInstitutionPayload(payload, new Set(['2330']))], [['2330', -1234]]);
});

test('parseInstitutionPayload rejects failed or incomplete T86 responses', () => {
  assert.throws(() => parseInstitutionPayload({ stat: 'FAIL' }), /T86 回應無效/);
  assert.throws(() => parseInstitutionPayload({ stat: 'OK', fields: ['證券代號'], data: [] }), /缺少證券代號或三大法人/);
});

test('parseInstitutionPayload excludes malformed net-buy values from coverage', () => {
  const payload = {
    stat: 'OK',
    fields: ['證券代號', '三大法人買賣超股數'],
    data: [['2330', 'BROKEN'], ['0050', '1,000']],
  };
  assert.deepEqual([...parseInstitutionPayload(payload)], [['0050', 1000]]);
});

test('parseMonthlyRevenueHtml reads 11-column MOPS rows', () => {
  const html = `<table><tr align="right">
    <td align="center">2330</td><td>台積電</td><td>100</td><td>90</td><td>80</td>
    <td>11.11</td><td>25.00</td><td>600</td><td>500</td><td>20.00</td><td>-</td>
  </tr></table>`;
  assert.deepEqual([...parseMonthlyRevenueHtml(html, '2026-06')], [
    ['2330', { period: '2026-06', yoy: 25 }],
  ]);
});

test('mergeRevenueMonths stores newest three values in period order', () => {
  const stocks = { '2330': { revenuePeriods: ['2026-06'], revenueYoY: [1] }, '0050': {} };
  const months = [
    new Map([['2330', { period: '2026-05', yoy: 5 }]]),
    new Map([['2330', { period: '2026-06', yoy: 6 }]]),
    new Map([['2330', { period: '2026-04', yoy: 4 }]]),
  ];
  mergeRevenueMonths(stocks, months);
  assert.deepEqual(stocks['2330'].revenuePeriods, ['2026-06', '2026-05', '2026-04']);
  assert.deepEqual(stocks['2330'].revenueYoY, [6, 5, 4]);
  assert.deepEqual(stocks['0050'], {});
});
