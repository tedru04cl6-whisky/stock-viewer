const DATA_URL = 'data/latest.json';
const THEMES_URL = 'data/themes.json';
const DIVIDENDS_URL = 'data/etf-dividends.json';
const HOLDINGS_URL = 'data/etf-holdings.json';
const STOCK_TAGS_URL = 'data/stock-tags.json';
const WATCHLIST_KEY = 'stock-viewer:watchlist:v1';
const MONTHS_TO_LOAD = 6;
const FETCH_GAP_MS = 300;

const DEFAULT_FILTERS = {
  fundamentals: { enabled: true, pe: 20, yield: 3, pb: 2 },
  momentum: { enabled: true, streak: 3, volumeMultiple: 1.5 },
};

const state = {
  data: null,
  themes: null,
  themeLoadError: '',
  dividends: null,
  dividendLoadError: '',
  holdings: null,
  holdingsLoadError: '',
  stockTags: null,
  stockTagsLoadError: '',
  dividendDateField: 'paymentDate',
  dividendYear: String(new Date().getFullYear()),
  dividendMonth: String(new Date().getMonth() + 1),
  dividendSort: 'date',
  stockIndustry: '全部',
  stockSignal: '全部',
  loadError: '',
  filters: structuredClone(DEFAULT_FILTERS),
  themeQuery: '',
  themeCategory: '全部',
  themeApplyFilters: false,
  stockRequest: 0,
};

const number = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });

export function calculateR2(closes) {
  const values = closes.map(numericValue).filter((value) => value !== null);
  if (values.length < 2) return null;
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let ssXX = 0; let ssYY = 0; let ssXY = 0;
  values.forEach((value, index) => {
    const x = index - meanX;
    const y = value - meanY;
    ssXX += x * x; ssYY += y * y; ssXY += x * y;
  });
  if (ssYY === 0 || ssXX === 0) return null;
  const r = ssXY / Math.sqrt(ssXX * ssYY);
  return Math.max(0, Math.min(1, r * r));
}

export function annualizedVolatility(closes) {
  const values = closes.map(numericValue).filter((value) => value !== null);
  if (values.length < 3 || values.some((value) => value <= 0)) return null;
  const returns = values.slice(1).map((value, index) => Math.log(value / values[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export function maximumDrawdown(closes) {
  const values = closes.map(numericValue).filter((value) => value !== null);
  if (!values.length || values.some((value) => value <= 0)) return null;
  let peak = values[0]; let maxDrawdown = 0;
  values.forEach((value) => {
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  });
  return maxDrawdown;
}

export function riskAssessment(closes) {
  const values = closes.map(numericValue).filter((value) => value !== null);
  if (values.length >= 3 && values.every((value) => value === values[0])) {
    return { r2: null, volatility: 0, drawdown: 0, trend: '持平', label: '穩健', explanation: '過去半年收盤維持同一價位，沒有可辨識的上升或下降趨勢。' };
  }
  const r2 = calculateR2(closes);
  const volatility = annualizedVolatility(closes);
  const drawdown = maximumDrawdown(closes);
  if ([r2, volatility, drawdown].some((value) => value === null)) {
    return { r2, volatility, drawdown, trend: '資料不足', label: '資料不足', explanation: '日收盤資料不足，暫時無法完成風險分級。' };
  }
  const trend = r2 >= 0.6 ? '趨勢明確' : r2 >= 0.3 ? '混雜' : '雜訊';
  if (r2 >= 0.6 && volatility <= 0.28 && drawdown <= 0.2) {
    return { r2, volatility, drawdown, trend, label: '穩健', explanation: '過去半年趨勢較清楚，波動與回撤都相對收斂。' };
  }
  if (r2 < 0.3 && (volatility >= 0.4 || drawdown >= 0.3)) {
    return { r2, volatility, drawdown, trend, label: '賭性堅強', explanation: '過去半年走勢裡雜訊多於趨勢，漲跌更像擲硬幣。' };
  }
  return { r2, volatility, drawdown, trend, label: '波動', explanation: '過去半年有波動或回撤需要留意，走勢的可預期性有限。' };
}

export function stockMatches(stock, filters) {
  const matches = [];
  if (filters.fundamentals.enabled) {
    const revenueOk = Array.isArray(stock.revenueYoY) && stock.revenueYoY.length >= 3 && areConsecutivePeriods(stock.revenuePeriods) && stock.revenueYoY.slice(0, 3).every((value) => numericValue(value) > 0);
    const pe = numericValue(stock.pe); const yieldRate = numericValue(stock.yield); const pb = numericValue(stock.pb);
    const peOk = pe !== null && pe <= Number(filters.fundamentals.pe);
    const yieldOk = yieldRate !== null && yieldRate >= Number(filters.fundamentals.yield);
    const pbOk = pb !== null && pb <= Number(filters.fundamentals.pb);
    if (!(revenueOk && peOk && yieldOk && pbOk)) return { passes: false, matches: [] };
    matches.push('營收連3月年增', `本益比≤${filters.fundamentals.pe}`, `殖利率≥${filters.fundamentals.yield}%`, `股價淨值比≤${filters.fundamentals.pb}`);
  }
  if (filters.momentum.enabled) {
    const streak = numericValue(stock.instBuyStreak); const volume = numericValue(stock.volume); const average = numericValue(stock.avgVolume20);
    const streakOk = streak !== null && streak >= Number(filters.momentum.streak);
    const volumeOk = volume !== null && average !== null && average > 0 && volume >= average * Number(filters.momentum.volumeMultiple);
    if (!(streakOk && volumeOk)) return { passes: false, matches: [] };
    matches.push(`法人連買≥${filters.momentum.streak}日`, `量能≥${filters.momentum.volumeMultiple}×均量`);
  }
  return { passes: true, matches };
}

export function filteredStocks(stocks, filters) {
  return Object.entries(stocks || {}).filter(([id]) => /^\d{4,6}$/.test(id)).map(([id, stock]) => ({ id, ...stock, result: stockMatches(stock, filters) })).filter(({ result }) => result.passes);
}

export function findTheme(themes, query) {
  const normalized = String(query || '').trim().toLocaleLowerCase('zh-TW').replace(/\s+/g, '');
  if (normalized.length < 2 || !themes || typeof themes !== 'object') return null;
  return Object.entries(themes).map(([id, theme]) => ({ id, ...theme })).find((theme) => {
    const terms = [theme.id, theme.label, ...(Array.isArray(theme.aliases) ? theme.aliases : []), ...(Array.isArray(theme.categories) ? theme.categories : [])];
    return terms.some((term) => String(term).toLocaleLowerCase('zh-TW').replace(/\s+/g, '').includes(normalized));
  }) ?? null;
}

export function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export function themeStocks(theme, stocks, category = '全部', applyFilters = false, filters = DEFAULT_FILTERS) {
  if (!theme?.stocks || !stocks) return [];
  return Object.entries(theme.stocks).flatMap(([id, metadata]) => {
    const stock = stocks[id];
    if (!stock) return [];
    const categories = Array.isArray(metadata.categories) ? metadata.categories : [];
    if (category !== '全部' && !categories.includes(category)) return [];
    const result = stockMatches(stock, filters);
    if (applyFilters && !result.passes) return [];
    return [{ id, ...stock, ...metadata, categories, result }];
  });
}

export function dividendRecords(dataset, { dateField = 'paymentDate', year = '', month = '', sort = 'date' } = {}) {
  if (!dataset?.dividends || !['paymentDate', 'exDate'].includes(dateField)) return [];
  const records = Object.entries(dataset.dividends).flatMap(([code, item]) =>
    (Array.isArray(item?.records) ? item.records : []).flatMap((record) => {
      const date = String(record?.[dateField] ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
      if (year && date.slice(0, 4) !== String(year)) return [];
      if (month && date.slice(5, 7) !== String(month).padStart(2, '0')) return [];
      return [{ code, name: item.name, ...record }];
    }));
  if (sort === 'amount-desc' || sort === 'amount-asc') {
    const direction = sort === 'amount-desc' ? -1 : 1;
    return records.sort((a, b) => {
      const aAmount = numericValue(a.amount);
      const bAmount = numericValue(b.amount);
      if (aAmount === null && bAmount === null) return a[dateField].localeCompare(b[dateField]);
      if (aAmount === null) return 1;
      if (bAmount === null) return -1;
      return (aAmount - bAmount) * direction || a[dateField].localeCompare(b[dateField]);
    });
  }
  return records.sort((a, b) => a[dateField].localeCompare(b[dateField]) || a.code.localeCompare(b.code));
}

export function applyStockTagFilters(stocks, tagDataset, industry = '全部', signal = '全部') {
  return (stocks || []).filter((stock) => {
    const metadata = tagDataset?.tags?.[stock.id];
    if (industry !== '全部' && metadata?.industry !== industry) return false;
    if (signal !== '全部' && !metadata?.signals?.includes(signal)) return false;
    return true;
  });
}

export function excludeEtfs(stocks, etfDataset) {
  const etfs = etfDataset?.etfs ?? {};
  return (stocks || []).filter((stock) => !Object.hasOwn(etfs, stock.id));
}

export function areConsecutivePeriods(periods) {
  if (!Array.isArray(periods) || periods.length < 3) return false;
  const indexes = periods.slice(0, 3).map((period) => {
    const match = String(period).match(/^(\d{4})-(\d{2})$/);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
    return Number(match[1]) * 12 + Number(match[2]) - 1;
  });
  return indexes.every((value) => value !== null) && indexes[0] - indexes[1] === 1 && indexes[1] - indexes[2] === 1;
}

export function numericValue(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normaliseWatchlist(value) {
  return Array.isArray(value) ? [...new Set(value.filter((id) => /^\d{4,6}$/.test(String(id))).map(String))] : [];
}

function formatNumber(value, fallback = '資料不足') {
  const parsed = numericValue(value);
  return parsed === null ? fallback : number.format(parsed);
}
function formatPercent(value, digits = 1) {
  const parsed = numericValue(value);
  return parsed === null ? '資料不足' : `${parsed.toFixed(digits)}%`;
}
function signedChange(value) {
  const amount = numericValue(value);
  if (amount === null) return '資料不足';
  if (amount === 0) return '0';
  return `${amount > 0 ? '+' : '−'}${formatNumber(Math.abs(amount))}`;
}
function directionClass(value) { const amount = numericValue(value); return amount === null || amount === 0 ? 'neutral' : amount > 0 ? 'up' : 'down'; }
function directionText(value, positive = '上漲', negative = '下跌') { const amount = numericValue(value); return amount === null ? '資料不足' : amount === 0 ? '持平' : amount > 0 ? positive : negative; }
function safeText(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function formatCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return '待公告';
  return new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' })
    .format(new Date(`${value}T00:00:00+08:00`));
}
function stockById(id) {
  if (!/^\d{4,6}$/.test(String(id || '')) || !state.data?.stocks || !Object.hasOwn(state.data.stocks, id)) return null;
  return { id, ...state.data.stocks[id] };
}
function isEtfCode(id) { return Boolean(state.dividends?.etfs?.[id] || state.dividends?.dividends?.[id]); }
function detailHref(id) { return `${isEtfCode(id) ? '#etf/' : '#stock/'}${encodeURIComponent(id)}`; }
function currentRoute() {
  const raw = location.hash.replace(/^#/, '') || 'watchlist';
  const [route, id] = raw.split('/');
  return { route: ['watchlist', 'screener', 'etf', 'stock'].includes(route) ? route : 'watchlist', id };
}
function setDate() { document.querySelector('#data-date').textContent = `資料日期：${state.data?.dataDate || '資料不足'}`; }
function getWatchlist() { try { return normaliseWatchlist(JSON.parse(localStorage.getItem(WATCHLIST_KEY))); } catch { return []; } }
function saveWatchlist(ids) { localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...new Set(ids)])); }
function routeTo(route) { location.hash = route; }
function renderError(message) { return `<section class="status-panel" role="alert"><h1>資料暫時無法載入</h1><p>${safeText(message)}</p><button class="button secondary" type="button" data-action="retry">重新載入</button></section>`; }

function rowMarkup(stock, selected = false) {
  const volume = numericValue(stock.volume); const average = numericValue(stock.avgVolume20); const streak = numericValue(stock.instBuyStreak);
  const volumeRatio = volume !== null && average !== null && average > 0 ? volume / average : null;
  return `<tr>
    <th scope="row"><a class="stock-link" href="${detailHref(stock.id)}">${safeText(stock.id)} <span>${safeText(stock.name)}</span></a></th>
    <td data-label="收盤">${formatNumber(stock.close)}</td>
    <td data-label="漲跌" class="${directionClass(stock.change)}">${signedChange(stock.change)}<span class="visually-hidden">（${directionText(stock.change)}）</span></td>
    <td data-label="量／20日均量">${volumeRatio === null ? '資料不足' : `${formatNumber(volumeRatio)}×`}</td>
    <td data-label="法人連買">${streak !== null ? `${formatNumber(streak)} 日${stock.instStreakInsufficient ? '（資料不足）' : ''}` : '資料不足'}</td>
    ${selected ? `<td data-label="操作"><button class="quiet-button" type="button" data-action="remove-stock" data-id="${safeText(stock.id)}" aria-label="移除 ${safeText(stock.id)} ${safeText(stock.name)}">移除</button></td>` : ''}
  </tr>`;
}

function renderWatchlist() {
  const ids = getWatchlist();
  const stocks = ids.map(stockById).filter(Boolean);
  const unknown = ids.filter((id) => !stockById(id));
  return `<section class="view"><div class="view-heading"><p class="eyebrow">收盤後整理</p><h1>自選股</h1><p>把常看的代號放在這裡，資料會隨每日快照更新。</p></div>
    <form class="add-stock" data-form="add-stock" novalidate>
      <label for="stock-code">新增代號</label><div class="input-row"><input id="stock-code" name="code" inputmode="numeric" autocomplete="off" pattern="\\d{4,6}" maxlength="6" placeholder="例如 2330" aria-describedby="add-message" required><button class="button primary" type="submit">加入自選</button></div><p id="add-message" class="form-message" aria-live="polite"></p>
    </form>
    ${!stocks.length ? `<section class="empty-state"><h2>先加入一支有效股票</h2><p>輸入上市股票代號後，這裡會顯示收盤、量能與法人連買資料。</p><a class="button secondary" href="#screener">先看篩選結果</a></section>` : ''}
    ${unknown.length ? `<p class="inline-warning" role="status">${unknown.map(safeText).join('、')} 不在這份資料中，已暫時略過。</p>` : ''}
    ${stocks.length ? `<div class="table-wrap"><table><caption>自選股收盤資料</caption><thead><tr><th>股票</th><th>收盤</th><th>漲跌</th><th>量／20日均量</th><th>法人連買</th><th><span class="visually-hidden">操作</span></th></tr></thead><tbody>${stocks.map((stock) => rowMarkup(stock, true)).join('')}</tbody></table></div>` : ''}
  </section>`;
}

function numberInput(group, key, label, value, options = {}) {
  return `<label class="number-field">${label}<input type="number" min="${options.min ?? 0}" step="${options.step ?? 0.1}" value="${value}" data-filter-group="${group}" data-filter-key="${key}" ${state.filters[group].enabled ? '' : 'disabled'}></label>`;
}
function filterGroupMarkup(group, title, description, inputs) {
  const active = state.filters[group].enabled;
  return `<fieldset class="filter-group ${active ? '' : 'is-off'}"><legend>${title}</legend><p>${description}</p><label class="toggle"><input type="checkbox" data-filter-toggle="${group}" ${active ? 'checked' : ''}><span>${active ? '已啟用' : '已停用'}</span></label><div class="filter-inputs">${inputs}</div></fieldset>`;
}
function stockTagFilterMarkup() {
  if (state.stockTagsLoadError) {
    return `<fieldset class="filter-group"><legend>產業與近期趨勢</legend><p class="inline-warning">${safeText(state.stockTagsLoadError)}；數值條件仍可使用。</p><button class="button secondary" type="button" data-action="retry-stock-tags">重新載入分類</button></fieldset>`;
  }
  const industries = state.stockTags?.industries ?? [];
  const signals = ['全部', '成交熱門', '近期強勢', '法人連買', '放量'];
  return `<fieldset class="filter-group"><legend>產業與近期趨勢</legend><p>產業來自公司公告；趨勢標籤依目前市場資料量化計算。</p><div class="filter-inputs">
    <label class="number-field">產業<select data-stock-tag-filter="industry"><option value="全部">全部產業</option>${industries.map(({ name, count }) => `<option value="${safeText(name)}" ${state.stockIndustry === name ? 'selected' : ''}>${safeText(name)}（${count}）</option>`).join('')}</select></label>
    <label class="number-field">近期標籤<select data-stock-tag-filter="signal">${signals.map((signal) => `<option value="${signal}" ${state.stockSignal === signal ? 'selected' : ''}>${signal === '全部' ? '全部標籤' : signal}</option>`).join('')}</select></label>
  </div><p class="tag-methodology">${safeText(state.stockTags?.methodology || '')}</p></fieldset>`;
}
function renderThemeExplorer() {
  if (state.themeLoadError) {
    return `<section class="theme-explorer" aria-labelledby="theme-title"><div class="theme-intro"><div><h2 id="theme-title">題材搜尋</h2><p role="alert">${safeText(state.themeLoadError)}，其他股票功能仍可使用。</p></div></div><button class="button secondary" type="button" data-action="retry-themes">重新載入題材</button></section>`;
  }
  const themes = state.themes?.themes;
  const theme = findTheme(themes, state.themeQuery);
  const available = Object.values(themes || {});
  const suggestions = [...new Set(available.flatMap((item) => [item.label, ...(item.categories || [])]))];
  const categories = theme ? ['全部', ...(theme.categories || [])] : [];
  const matches = theme ? themeStocks(theme, state.data?.stocks, state.themeCategory, state.themeApplyFilters, state.filters) : [];
  const query = safeText(state.themeQuery);
  return `<section class="theme-explorer" aria-labelledby="theme-title">
    <div class="theme-intro"><div><h2 id="theme-title">題材搜尋</h2><p>查找經人工核對的供應鏈名單，再決定是否套用目前篩選條件。</p></div><p class="theme-date">標籤更新：${safeText(state.themes?.updatedAt || '資料不足')}</p></div>
    <form class="theme-search" data-form="theme-search" novalidate>
      <label for="theme-query">題材或供應鏈</label>
      <div class="input-row"><input id="theme-query" name="theme" type="search" autocomplete="off" placeholder="例如：AI、伺服器、晶片" value="${query}" aria-describedby="theme-message"><button class="button secondary" type="submit">查詢</button></div>
      <p id="theme-message" class="form-message" aria-live="polite">${state.themeQuery && !theme ? `目前沒有「${query}」的人工策展名單。` : ''}</p>
    </form>
    ${!state.themeQuery ? `<div class="theme-suggestions" role="group" aria-label="可查詢題材">${suggestions.map((item) => `<button type="button" data-action="theme-suggestion" data-theme="${safeText(item)}">${safeText(item)}</button>`).join('')}</div>` : ''}
    ${theme ? `<div class="theme-toolbar">
      <div class="theme-categories" role="group" aria-label="${safeText(theme.label)}細分類">${categories.map((category) => `<button type="button" data-action="theme-category" data-category="${safeText(category)}" aria-pressed="${state.themeCategory === category}">${safeText(category)}</button>`).join('')}</div>
      <label class="theme-filter-toggle"><input type="checkbox" data-theme-apply-filters ${state.themeApplyFilters ? 'checked' : ''}><span>同時符合目前條件</span></label>
    </div>
    <div class="theme-summary" role="status" aria-live="polite"><div><strong>${safeText(theme.label)}</strong><span>${matches.length} 檔</span></div><p>${safeText(state.themes.methodology)}</p></div>
    ${matches.length ? `<ol class="theme-results">${matches.map((stock) => {
      const sourceUrl = safeHttpsUrl(stock.sourceUrl);
      return `<li>
      <div class="theme-stock-heading"><a href="#stock/${encodeURIComponent(stock.id)}"><strong>${safeText(stock.id)} ${safeText(stock.name)}</strong></a><span>${stock.categories.map((category) => `<i>${safeText(category)}</i>`).join('')}</span></div>
      <p>${safeText(stock.reason)}</p>
      ${sourceUrl ? `<a class="source-link" href="${safeText(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看官方來源<span class="visually-hidden">：${safeText(stock.sourceLabel)}（另開新視窗）</span></a>` : '<span class="inline-warning">官方來源網址無效</span>'}
    </li>`;
    }).join('')}</ol>` : `<div class="empty-state compact"><h3>這個分類目前沒有結果</h3><p>${state.themeApplyFilters ? '取消「同時符合目前條件」，或調整左側條件後再看。' : '請改選其他細分類。'}</p></div>`}
    ` : ''}
  </section>`;
}

function renderDividendExplorer() {
  if (state.dividendLoadError) {
    return `<section class="dividend-explorer" aria-labelledby="dividend-title"><div class="dividend-heading"><div><h2 id="dividend-title">ETF 配息月份</h2><p role="alert">${safeText(state.dividendLoadError)}，其他股票功能仍可使用。</p></div></div><button class="button secondary" type="button" data-action="retry-dividends">重新載入配息資料</button></section>`;
  }
  const years = Array.isArray(state.dividends?.years) ? state.dividends.years : [];
  const results = dividendRecords(state.dividends, {
    dateField: state.dividendDateField,
    year: state.dividendYear,
    month: state.dividendMonth,
    sort: state.dividendSort,
  });
  const fieldLabel = state.dividendDateField === 'paymentDate' ? '入帳' : '除息';
  const sourceUrl = safeHttpsUrl(state.dividends?.sourceUrl);
  return `<section class="dividend-explorer" aria-labelledby="dividend-title">
    <div class="dividend-heading"><div><h2 id="dividend-title">ETF 配息月份</h2><p>除息與實際入帳分開查，不把兩個日期混在一起。</p></div><p class="dividend-date">資料更新：${safeText(state.dividends?.updatedAt || '資料不足')}</p></div>
    <div class="dividend-controls" aria-label="ETF 配息篩選">
      <label>查詢日期<select data-dividend-filter="dateField"><option value="paymentDate" ${state.dividendDateField === 'paymentDate' ? 'selected' : ''}>收益分配發放日（入帳）</option><option value="exDate" ${state.dividendDateField === 'exDate' ? 'selected' : ''}>除息交易日</option></select></label>
      <label>年度<select data-dividend-filter="year">${years.map((year) => `<option value="${year}" ${String(year) === state.dividendYear ? 'selected' : ''}>${year} 年</option>`).join('')}</select></label>
      <label>月份<select data-dividend-filter="month"><option value="">全部月份</option>${Array.from({ length: 12 }, (_, index) => index + 1).map((month) => `<option value="${month}" ${String(month) === state.dividendMonth ? 'selected' : ''}>${month} 月</option>`).join('')}</select></label>
      <label>排序<select data-dividend-filter="sort"><option value="date" ${state.dividendSort === 'date' ? 'selected' : ''}>依日期</option><option value="amount-desc" ${state.dividendSort === 'amount-desc' ? 'selected' : ''}>每單位金額：大到小</option><option value="amount-asc" ${state.dividendSort === 'amount-asc' ? 'selected' : ''}>每單位金額：小到大</option></select></label>
    </div>
    <div class="dividend-summary" role="status" aria-live="polite"><strong>${safeText(state.dividendYear)} 年${state.dividendMonth ? ` ${safeText(state.dividendMonth)} 月` : ''}${fieldLabel}</strong><span>${results.length} 筆</span></div>
    ${results.length ? `<ol class="dividend-results">${results.map((record) => {
      const title = `${safeText(record.code)} ${safeText(record.name)}`;
      return `<li><div><a href="#etf/${encodeURIComponent(record.code)}"><strong>${title}</strong></a><span>${record.amount === null ? '金額待公告' : `每單位 ${formatNumber(record.amount)} 元`}</span></div><dl><div><dt>除息</dt><dd>${formatCalendarDate(record.exDate)}</dd></div><div><dt>入帳</dt><dd>${formatCalendarDate(record.paymentDate)}</dd></div></dl></li>`;
    }).join('')}</ol>` : '<div class="empty-state compact"><h3>這個月份目前沒有公告</h3><p>可切換除息／入帳日期，或查看其他月份。</p></div>'}
    <p class="dividend-note">配息頻率可能調整，未來日期與金額以基金公告為準。${sourceUrl ? ` <a href="${safeText(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看證交所官方清單<span class="visually-hidden">（另開新視窗）</span></a>` : ''}</p>
  </section>`;
}

function renderScreener() {
  const equities = excludeEtfs(filteredStocks(state.data?.stocks, state.filters), state.dividends);
  const results = applyStockTagFilters(equities, state.stockTags, state.stockIndustry, state.stockSignal);
  return `<section class="view screener-view"><div class="view-heading"><p class="eyebrow">條件整理</p><h1>篩選器</h1><p>完成數值輸入後更新；同時啟用的條件組採交集。</p></div>
    <div class="screener-layout"><aside class="filters" aria-label="篩選條件">
      ${filterGroupMarkup('fundamentals', '基本面穩健', '營收、估值與殖利率同時成立。', numberInput('fundamentals', 'pe', '本益比上限', state.filters.fundamentals.pe) + numberInput('fundamentals', 'yield', '殖利率下限（%）', state.filters.fundamentals.yield) + numberInput('fundamentals', 'pb', '股價淨值比上限', state.filters.fundamentals.pb))}
      ${filterGroupMarkup('momentum', '籌碼動能', '法人連買與成交量同時成立。', numberInput('momentum', 'streak', '法人連買日數', state.filters.momentum.streak, { step: 1 }) + numberInput('momentum', 'volumeMultiple', '量能倍數', state.filters.momentum.volumeMultiple))}
      ${stockTagFilterMarkup()}
      <p class="disclaimer">符合條件 ≠ 交易指令，判斷永遠是你自己的。</p>
    </aside>
    <section class="results" aria-live="polite"><div class="results-heading"><h2>符合條件 <span>${results.length}</span></h2><p>僅呈現目前已啟用條件皆成立的資料。</p></div>
      ${results.length ? `<ol class="result-list">${results.map((stock) => {
        const metadata = state.stockTags?.tags?.[stock.id];
        const labels = [...stock.result.matches, metadata?.industry, ...(metadata?.signals ?? [])].filter(Boolean);
        return `<li><a href="${detailHref(stock.id)}"><strong>${safeText(stock.id)} ${safeText(stock.name)}</strong><span>${labels.map((match) => `<i>${safeText(match)}</i>`).join('')}</span></a></li>`;
      }).join('')}</ol>` : '<div class="empty-state compact"><h3>沒有符合目前條件的資料</h3><p>請放寬數值、產業或近期標籤後再試。</p></div>'}
    </section></div>
  </section>`;
}

function toNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (/^(--|-|X)$/i.test(cleaned)) return null;
  return numericValue(cleaned);
}
function dateKey(value) {
  const matched = String(value).match(/(\d+)\/(\d+)\/(\d+)/);
  if (!matched) return String(value);
  return `${Number(matched[1]) + 1911}-${String(matched[2]).padStart(2, '0')}-${String(matched[3]).padStart(2, '0')}`;
}
export function parseDailyK(response) {
  if (!response || response.stat !== 'OK' || !Array.isArray(response.data)) return [];
  return response.data.map((row) => ({ date: dateKey(row[0]), open: toNumber(row[3]), high: toNumber(row[4]), low: toNumber(row[5]), close: toNumber(row[6]), volume: toNumber(row[1]) })).filter((row) => Number.isFinite(row.close));
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function recentMonthStarts() {
  const now = new Date();
  return Array.from({ length: MONTHS_TO_LOAD }, (_, index) => new Date(now.getFullYear(), now.getMonth() - index, 1)).reverse();
}
async function loadHistory(id) {
  if (!/^\d{4,6}$/.test(id)) throw new Error('股票代號格式不正確');
  const chunks = [];
  const months = recentMonthStarts();
  for (const [index, date] of months.entries()) {
    const yyyymm = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}01`;
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${yyyymm}&stockNo=${encodeURIComponent(id)}&response=json`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`歷史資料請求失敗（${response.status}）`);
    chunks.push(...parseDailyK(await response.json()));
    if (index < months.length - 1) await delay(FETCH_GAP_MS);
  }
  return [...new Map(chunks.map((item) => [item.date, item])).values()].sort((a, b) => a.date.localeCompare(b.date));
}

function drawChart(canvas, items) {
  const context = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth; const height = 220;
  canvas.width = width * ratio; canvas.height = height * ratio; context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  if (!items.length || width === 0) return;
  const values = items.map((item) => item.close); const min = Math.min(...values); const max = Math.max(...values); const spread = max - min || max * 0.04 || 1;
  const pad = { top: 18, right: 12, bottom: 26, left: 48 };
  const x = (index) => pad.left + ((width - pad.left - pad.right) * index / Math.max(1, values.length - 1));
  const y = (value) => pad.top + ((max - value) / spread) * (height - pad.top - pad.bottom);
  const styles = getComputedStyle(document.documentElement);
  context.font = '12px system-ui'; context.fillStyle = styles.getPropertyValue('--muted'); context.strokeStyle = styles.getPropertyValue('--line'); context.lineWidth = 1;
  [min, (min + max) / 2, max].forEach((value) => { context.beginPath(); context.moveTo(pad.left, y(value)); context.lineTo(width - pad.right, y(value)); context.stroke(); context.fillText(formatNumber(value), 2, y(value) + 4); });
  context.beginPath(); values.forEach((value, index) => { index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value)); }); context.strokeStyle = styles.getPropertyValue('--accent'); context.lineWidth = 2; context.stroke();
  context.fillStyle = styles.getPropertyValue('--muted'); context.fillText(items[0].date.slice(5), pad.left, height - 6); context.fillText(items.at(-1).date.slice(5), width - pad.right - 32, height - 6);
}
function revenueBarsMarkup(values) {
  const recent = Array.isArray(values) ? values.slice(0, 3).map(numericValue) : [];
  if (recent.length < 3 || recent.some((value) => value === null)) return '<p class="inline-warning">近三月營收資料不足。</p>';
  const ceiling = Math.max(...recent.map(Math.abs), 1);
  return `<section class="revenue-section" aria-labelledby="revenue-title"><h2 id="revenue-title">近三月營收年增率</h2><div class="revenue-bars">${recent.map((value, index) => `<div><span class="bar-track" aria-hidden="true"><i class="${directionClass(value)}" style="--bar-size:${Math.max(8, Math.abs(value) / ceiling * 100)}%"></i></span><strong>${formatPercent(value)}</strong><small>近 ${index + 1} 月</small></div>`).join('')}</div><p class="visually-hidden">${recent.map((value, index) => `近 ${index + 1} 月 ${formatPercent(value)}`).join('，')}</p></section>`;
}
function stockInfoMarkup(stock, isEtf = false) {
  return `<dl class="metrics"><div><dt>收盤</dt><dd>${formatNumber(stock.close)}</dd></div><div><dt>漲跌</dt><dd class="${directionClass(stock.change)}">${signedChange(stock.change)}<span class="visually-hidden">（${directionText(stock.change)}）</span></dd></div><div><dt>${isEtf ? '商品類型' : '月營收 YoY'}</dt><dd>${isEtf ? 'ETF' : Array.isArray(stock.revenueYoY) ? stock.revenueYoY.map((value) => formatPercent(value)).join(' / ') : '資料不足'}</dd></div><div><dt>法人買賣超</dt><dd class="${directionClass(stock.instNetBuy)}">${signedChange(stock.instNetBuy)}<span class="visually-hidden">（${directionText(stock.instNetBuy, '買超', '賣超')}）</span></dd></div></dl>`;
}
function dividendStockMarkup(id) {
  const item = state.dividends?.dividends?.[id];
  if (!item?.records?.length) return '<section class="stock-dividends"><h2>ETF 配息紀錄</h2><p>近兩年沒有已公告的配息紀錄。</p></section>';
  const sourceUrl = safeHttpsUrl(`${state.dividends.sourceUrl}&stkNo=${encodeURIComponent(id)}`);
  return `<section class="stock-dividends" aria-labelledby="stock-dividend-title"><div class="stock-dividend-heading"><div><h2 id="stock-dividend-title">ETF 配息紀錄</h2><p>除息日不等於入帳日，請分開確認。</p></div>${sourceUrl ? `<a href="${safeText(sourceUrl)}" target="_blank" rel="noopener noreferrer">官方資料<span class="visually-hidden">（另開新視窗）</span></a>` : ''}</div><div class="stock-dividend-list">${item.records.slice(0, 6).map((record) => `<article><div><strong>${record.amount === null ? '金額待公告' : `每單位 ${formatNumber(record.amount)} 元`}</strong><span>${record.paymentDate >= state.data.dataDate ? '已公告' : '歷史紀錄'}</span></div><dl><div><dt>除息</dt><dd>${formatCalendarDate(record.exDate)}</dd></div><div><dt>入帳</dt><dd>${formatCalendarDate(record.paymentDate)}</dd></div></dl></article>`).join('')}</div></section>`;
}
function holdingsMarkup(id) {
  if (state.holdingsLoadError) {
    return `<section class="stock-holdings"><h2>主要持股</h2><p class="inline-warning">${safeText(state.holdingsLoadError)}</p><button class="button secondary" type="button" data-action="retry-holdings">重新載入持股</button></section>`;
  }
  const fund = state.holdings?.funds?.[id];
  if (!fund) {
    return `<section class="stock-holdings"><h2>主要持股</h2><div class="empty-state compact"><h3>這檔 ETF 尚未接入官方持股</h3><p>目前先支援 0050、0056；其他投信格式會逐步加入，不用推測資料補空白。</p></div></section>`;
  }
  const sourceUrl = safeHttpsUrl(fund.sourceUrl);
  const concentration = fund.holdings.reduce((sum, holding) => sum + holding.weight, 0);
  return `<section class="stock-holdings" aria-labelledby="holdings-title"><div class="stock-dividend-heading"><div><h2 id="holdings-title">官方主要持股</h2><p>資料日期：${safeText(fund.holdingsDate)}｜前五大合計 ${formatPercent(concentration)}</p></div>${sourceUrl ? `<a href="${safeText(sourceUrl)}" target="_blank" rel="noopener noreferrer">投信官方資料<span class="visually-hidden">（另開新視窗）</span></a>` : ''}</div><ol class="holding-list">${fund.holdings.slice(0, 5).map((holding) => `<li><a href="#stock/${encodeURIComponent(holding.code)}"><span><strong>${safeText(holding.code)} ${safeText(holding.name)}</strong><small>${integer.format(holding.quantity)} 股</small></span><b>${formatPercent(holding.weight, 2)}</b></a></li>`).join('')}</ol><p class="dividend-note">${safeText(state.holdings.methodology)}</p></section>`;
}
function renderEtf(id) {
  if (!id) {
    return `<section class="view etf-view"><div class="view-heading"><p class="eyebrow">ETF 工具</p><h1>ETF 查詢</h1><p>直接查代號，或按除息／入帳月份與每單位金額整理配息。</p></div><form class="stock-search" data-form="etf-search" novalidate><label for="etf-code">ETF 代號</label><div class="input-row"><input id="etf-code" name="code" inputmode="text" pattern="[0-9A-Za-z]{4,8}" maxlength="8" placeholder="例如 0050、00631L" aria-describedby="etf-message" required><button class="button secondary" type="submit">查看 ETF</button></div><p id="etf-message" class="form-message" aria-live="polite"></p></form>${renderDividendExplorer()}</section>`;
  }
  const dividendItem = state.dividends?.dividends?.[id];
  const etfItem = state.dividends?.etfs?.[id] ?? dividendItem;
  if (!etfItem) {
    return `<section class="view"><a class="back-link" href="#etf">← 回 ETF 查詢</a><div class="view-heading"><p class="eyebrow">ETF 單檔</p><h1>找不到 ${safeText(id)}</h1><p>此代號不在證交所 ETF 基本資料中。</p></div></section>`;
  }
  const stock = stockById(id);
  const chart = stock ? `<section class="chart-section"><div class="chart-heading"><div><h2>近半年收盤走勢</h2><p id="chart-status" aria-live="polite">準備讀取歷史日K…</p></div></div><canvas id="close-chart" role="img" aria-label="近半年收盤折線圖；載入後可閱讀下方風險摘要。"></canvas><div id="risk-summary"></div></section>` : '<p class="inline-warning">這檔 ETF 尚未收錄在市場價格快照，因此暫無走勢分析。</p>';
  return `<section class="view stock-view"><a class="back-link" href="#etf">← 回 ETF 查詢</a><div class="view-heading"><p class="eyebrow">ETF 單檔</p><h1>${safeText(id)} ${safeText(etfItem.name)}</h1>${stock ? stockInfoMarkup(stock, true) : ''}</div>${holdingsMarkup(id)}${dividendStockMarkup(id)}${chart}</section>`;
}
function riskMarkup(assessment) {
  return `<section class="risk-panel"><div><p class="eyebrow">半年風險觀察</p><h2>${assessment.label}</h2><p>${assessment.explanation}</p></div><dl class="risk-metrics"><div><dt>趨勢品質</dt><dd>${assessment.trend}${assessment.r2 === null ? '' : `（R² ${assessment.r2.toFixed(2)}）`}</dd></div><div><dt>年化波動率</dt><dd>${assessment.volatility === null ? '資料不足' : formatPercent(assessment.volatility * 100)}</dd></div><div><dt>最大回撤</dt><dd>${assessment.drawdown === null ? '資料不足' : `−${formatPercent(assessment.drawdown * 100)}`}</dd></div></dl></section>`;
}
function renderStock(id) {
  const stock = stockById(id);
  const chooser = `<form class="stock-search" data-form="stock-search" novalidate><label for="detail-code">個股代號</label><div class="input-row"><input id="detail-code" name="code" inputmode="numeric" pattern="\\d{4,6}" maxlength="6" placeholder="輸入 4 至 6 碼代號" value="${safeText(id || '')}" aria-describedby="detail-message" required><button class="button secondary" type="submit">查看</button></div><p id="detail-message" class="form-message" aria-live="polite"></p></form>`;
  if (!id) return `<section class="view"><div class="view-heading"><p class="eyebrow">個股分析</p><h1>查看個股</h1><p>輸入一個已收錄在每日資料中的上市股票代號。</p></div>${chooser}</section>`;
  if (!stock) return `<section class="view"><div class="view-heading"><p class="eyebrow">個股分析</p><h1>找不到 ${safeText(id)}</h1><p>此代號不在目前快照資料中。</p></div>${chooser}</section>`;
  const isEtf = isEtfCode(id);
  return `<section class="view stock-view"><a class="back-link" href="#watchlist">← 回自選股</a><div class="view-heading"><p class="eyebrow">${isEtf ? 'ETF 分析' : '個股分析'}</p><h1>${safeText(stock.id)} ${safeText(stock.name)}</h1>${stockInfoMarkup(stock, isEtf)}</div>${chooser}${isEtf ? `<p><a class="button secondary" href="#etf/${encodeURIComponent(id)}">前往 ETF 專屬頁</a></p>` : revenueBarsMarkup(stock.revenueYoY)}<section class="chart-section"><div class="chart-heading"><div><h2>近半年收盤走勢</h2><p id="chart-status" aria-live="polite">準備讀取歷史日K…</p></div></div><canvas id="close-chart" role="img" aria-label="近半年收盤折線圖；載入後可閱讀下方風險摘要。"></canvas><div id="risk-summary"></div></section></section>`;
}

function render() {
  if (!state.data) { document.querySelector('#app').innerHTML = renderError(state.loadError || '沒有可用的資料快照。'); return; }
  const { route, id } = currentRoute();
  document.querySelector('#app').innerHTML = route === 'watchlist' ? renderWatchlist() : route === 'screener' ? renderScreener() : route === 'etf' ? renderEtf(id) : renderStock(id);
  if (route === 'screener') document.querySelector('.screener-layout')?.insertAdjacentHTML('beforebegin', renderThemeExplorer());
  document.querySelectorAll('[data-route]').forEach((link) => link.classList.toggle('is-active', link.dataset.route === route));
  if ((route === 'stock' || route === 'etf') && id && stockById(id)) void hydrateStockHistory(id);
}

async function hydrateStockHistory(id) {
  const request = ++state.stockRequest;
  const status = document.querySelector('#chart-status'); const summary = document.querySelector('#risk-summary'); const canvas = document.querySelector('#close-chart');
  try {
    const records = await loadHistory(id);
    if (request !== state.stockRequest || !canvas) return;
    if (records.length < 30) { status.textContent = `僅取得 ${records.length} 筆日收盤資料，無法完成半年分析。`; summary.innerHTML = riskMarkup(riskAssessment([])); return; }
    canvas.dataset.records = JSON.stringify(records);
    drawChart(canvas, records);
    const assessment = riskAssessment(records.map((record) => record.close));
    status.textContent = `已取得 ${records.length} 筆日收盤資料（${records[0].date} 至 ${records.at(-1).date}）。`;
    summary.innerHTML = riskMarkup(assessment);
  } catch (error) {
    if (request !== state.stockRequest || !status) return;
    status.textContent = `歷史資料無法載入：${error.message}。請確認網路後重試。`;
    summary.innerHTML = riskMarkup(riskAssessment([]));
  }
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.dataset.form === 'theme-search') {
    const query = String(new FormData(form).get('theme') || '').trim();
    const message = document.querySelector('#theme-message');
    if (!query) { message.textContent = '請輸入題材，例如 AI。'; return; }
    state.themeQuery = query;
    state.themeCategory = '全部';
    render();
    return;
  }
  const code = String(new FormData(form).get('code') || '').trim();
  if (form.dataset.form === 'etf-search') {
    const normalized = code.toUpperCase();
    const message = document.querySelector('#etf-message');
    if (!/^[0-9A-Z]{4,8}$/.test(normalized)) { message.textContent = '請輸入 4 至 8 碼 ETF 代號。'; return; }
    if (!isEtfCode(normalized)) { message.textContent = '此代號不在證交所 ETF 基本資料中，請確認後再試。'; return; }
    routeTo(`etf/${normalized}`); return;
  }
  if (form.dataset.form === 'stock-search') {
    const message = document.querySelector('#detail-message');
    if (!/^\d{4,6}$/.test(code)) { message.textContent = '請輸入 4 至 6 碼上市股票代號。'; return; }
    if (!stockById(code)) { message.textContent = '此代號不在目前資料中，請確認後再試。'; return; }
    routeTo(`${isEtfCode(code) ? 'etf' : 'stock'}/${code}`); return;
  }
  if (form.dataset.form !== 'add-stock') return;
  const message = document.querySelector('#add-message');
  if (!/^\d{4,6}$/.test(code)) { message.textContent = '請輸入 4 至 6 碼上市股票代號。'; return; }
  if (!stockById(code)) { message.textContent = '此代號不在目前資料中，請確認後再試。'; return; }
  const ids = getWatchlist();
  if (ids.includes(code)) { message.textContent = '這支股票已在自選清單。'; return; }
  saveWatchlist([...ids, code]); render();
}
function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'theme-suggestion') {
    state.themeQuery = target.dataset.theme || '';
    state.themeCategory = '全部';
    render();
    document.querySelector('#theme-query')?.focus();
    return;
  }
  if (target.dataset.action === 'theme-category') {
    const category = target.dataset.category || '全部';
    state.themeCategory = category;
    render();
    [...document.querySelectorAll('[data-action="theme-category"]')].find((button) => button.dataset.category === category)?.focus();
    return;
  }
  if (target.dataset.action === 'retry-themes') { void loadThemes().then(render); return; }
  if (target.dataset.action === 'retry-dividends') { void loadDividends().then(render); return; }
  if (target.dataset.action === 'retry-holdings') { void loadHoldings().then(render); return; }
  if (target.dataset.action === 'retry-stock-tags') { void loadStockTags().then(render); return; }
  if (target.dataset.action === 'remove-stock') { saveWatchlist(getWatchlist().filter((id) => id !== target.dataset.id)); render(); }
  if (target.dataset.action === 'retry') void initialise();
}
function onChange(event) {
  const target = event.target;
  if (target.matches('[data-dividend-filter]')) {
    const key = target.dataset.dividendFilter;
    if (key === 'dateField') state.dividendDateField = target.value;
    if (key === 'year') state.dividendYear = target.value;
    if (key === 'month') state.dividendMonth = target.value;
    if (key === 'sort') state.dividendSort = target.value;
    render();
    document.querySelector(`[data-dividend-filter="${key}"]`)?.focus();
    return;
  }
  if (target.matches('[data-stock-tag-filter]')) {
    const key = target.dataset.stockTagFilter;
    if (key === 'industry') state.stockIndustry = target.value;
    if (key === 'signal') state.stockSignal = target.value;
    render();
    document.querySelector(`[data-stock-tag-filter="${key}"]`)?.focus();
    return;
  }
  if (target.matches('[data-theme-apply-filters]')) {
    state.themeApplyFilters = target.checked;
    render();
    document.querySelector('[data-theme-apply-filters]')?.focus();
    return;
  }
  if (target.matches('[data-filter-group][data-filter-key]')) {
    if (String(target.value).trim() === '') return;
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    const group = target.dataset.filterGroup;
    const key = target.dataset.filterKey;
    state.filters[group][key] = value;
    render();
    [...document.querySelectorAll('[data-filter-group][data-filter-key]')].find((input) => input.dataset.filterGroup === group && input.dataset.filterKey === key)?.focus();
    return;
  }
  if (!target.matches('[data-filter-toggle]')) return;
  const group = target.dataset.filterToggle;
  state.filters[group].enabled = target.checked;
  render();
  [...document.querySelectorAll('[data-filter-toggle]')].find((input) => input.dataset.filterToggle === group)?.focus();
}

async function loadThemes() {
  try {
    const response = await fetch(THEMES_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`題材資料載入失敗（${response.status}）`);
    const themes = await response.json();
    if (!themes?.updatedAt || !themes?.themes || typeof themes.themes !== 'object') throw new Error('題材資料格式不正確');
    state.themes = themes;
    state.themeLoadError = '';
  } catch (error) {
    state.themes = { updatedAt: '', methodology: '', themes: {} };
    state.themeLoadError = error.message;
  }
}

async function loadDividends() {
  try {
    const response = await fetch(DIVIDENDS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`ETF 配息資料載入失敗（${response.status}）`);
    const dividends = await response.json();
    if (!dividends?.updatedAt || !Array.isArray(dividends?.years) || !dividends?.dividends || typeof dividends.dividends !== 'object') {
      throw new Error('ETF 配息資料格式不正確');
    }
    state.dividends = dividends;
    if (!dividends.years.map(String).includes(state.dividendYear)) state.dividendYear = String(dividends.years.at(-1));
    state.dividendLoadError = '';
  } catch (error) {
    state.dividends = { updatedAt: '', years: [], sourceUrl: '', dividends: {} };
    state.dividendLoadError = error.message;
  }
}

async function loadHoldings() {
  try {
    const response = await fetch(HOLDINGS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`ETF 持股資料載入失敗（${response.status}）`);
    const holdings = await response.json();
    if (!holdings?.updatedAt || !holdings?.funds || typeof holdings.funds !== 'object') throw new Error('ETF 持股資料格式不正確');
    state.holdings = holdings;
    state.holdingsLoadError = '';
  } catch (error) {
    state.holdings = { updatedAt: '', methodology: '', funds: {} };
    state.holdingsLoadError = error.message;
  }
}

async function loadStockTags() {
  try {
    const response = await fetch(STOCK_TAGS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`個股分類資料載入失敗（${response.status}）`);
    const tags = await response.json();
    if (!tags?.updatedAt || !Array.isArray(tags?.industries) || !tags?.tags || typeof tags.tags !== 'object') throw new Error('個股分類資料格式不正確');
    state.stockTags = tags;
    state.stockTagsLoadError = '';
  } catch (error) {
    state.stockTags = { updatedAt: '', methodology: '', industries: [], tags: {} };
    state.stockTagsLoadError = error.message;
  }
}

async function initialise() {
  state.loadError = ''; document.querySelector('#app').innerHTML = '<section class="loading-shell" aria-label="正在載入"><span class="skeleton title-skeleton"></span><span class="skeleton line-skeleton"></span></section>';
  try {
    const response = await fetch(DATA_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`找不到資料快照（${response.status}）`);
    const data = await response.json();
    if (!data?.dataDate || !data?.stocks || typeof data.stocks !== 'object') throw new Error('資料快照格式不完整');
    state.data = data;
    await Promise.all([loadThemes(), loadDividends(), loadHoldings(), loadStockTags()]);
    setDate();
    render();
  } catch (error) { state.data = null; state.loadError = `${error.message}。離線時無法載入每日快照。`; setDate(); render(); }
}

if (typeof document !== 'undefined') {
  window.addEventListener('hashchange', render);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  window.addEventListener('resize', () => { const canvas = document.querySelector('#close-chart'); if (canvas?.dataset.records) drawChart(canvas, JSON.parse(canvas.dataset.records)); });
  void initialise();
}
