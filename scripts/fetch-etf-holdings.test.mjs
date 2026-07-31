import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHoldingsDataset, parseYuantaHoldingsHtml } from './fetch-etf-holdings.mjs';

test('parseYuantaHoldingsHtml reads date, stock code and weight', () => {
  const html = `<div>交易日期: 2026/07/23</div><div class="tr">
    <span>商品代碼</span><span>2330</span>
    <span>商品名稱</span><span>台積電</span>
    <span>商品數量</span><span>549052981</span>
    <span>商品權重</span><span>58.69</span>
  </div>`;
  assert.deepEqual(parseYuantaHoldingsHtml(html), {
    date: '2026-07-23',
    holdings: [{ code: '2330', name: '台積電', quantity: 549052981, weight: 58.69 }],
  });
});

test('buildHoldingsDataset keeps source and data date', () => {
  const dataset = buildHoldingsDataset([{
    code: '0050',
    name: '元大台灣50',
    url: 'https://example.com/0050',
    date: '2026-07-23',
    holdings: [{ code: '2330', name: '台積電', quantity: 1, weight: 58.69 }],
  }], '2026-07-24');
  assert.equal(dataset.funds['0050'].holdingsDate, '2026-07-23');
  assert.equal(dataset.funds['0050'].holdings[0].weight, 58.69);
});
