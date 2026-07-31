import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStockTags } from './fetch-stock-tags.mjs';

test('buildStockTags adds measurable industry and trend labels', () => {
  const latest = {
    dataDate: '2026-01-20',
    stocks: {
      '1111': { close: 20, volume: 200, avgVolume20: 100, instBuyStreak: 3 },
      '2222': { close: 10, volume: 50, avgVolume20: 100, instBuyStreak: 0 },
      '0050': { close: 100, volume: 9999, avgVolume20: 100, instBuyStreak: 9 },
      '0061': { close: 20, volume: 9999, avgVolume20: 100, instBuyStreak: 9 },
    },
  };
  const history = Array.from({ length: 19 }, (_, index) => ({
    dataDate: `2026-01-${String(index + 1).padStart(2, '0')}`,
    stocks: { '1111': { close: index + 1 }, '2222': { close: 10 }, '0050': { close: 90 }, '0061': { close: 10 } },
  }));
  const result = buildStockTags(latest, history, new Map([['1111', '金融業'], ['2222', '電子工業']]), new Set(['0050', '0061']));
  assert.equal(result.tags['1111'].industry, '金融業');
  assert.ok(result.tags['1111'].signals.includes('法人連買'));
  assert.ok(result.tags['1111'].signals.includes('放量'));
  assert.equal(result.tags['0050'], undefined, 'ETF 不可混入個股產業與趨勢標籤');
  assert.equal(result.tags['0061'], undefined, '沒有近期配息的 ETF 也不可混入個股標籤');
});
