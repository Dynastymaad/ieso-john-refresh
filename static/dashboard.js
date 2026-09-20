/* Ontario Forward Desk — v3 single-table dashboard
   Adds: recommendation banner, Cal-27 strip column, HR 1w/2w-ago trend rows,
         compact columns, $0.25 rounding for $/MWh, 0.1 for HR,
         gold percentile cells (≤P5 / ≥P95),
         month picker + 4 drill-down charts with P5/P50/P95 reference lines
         and a percentile-over-time sub-chart.
*/

// In the published build there is no backend — we load the static JSON snapshot directly.
// Locally (port 5000 static server) the same path works because data/latest.json is colocated.
// API_BASE is only used by the optional upload handler when a backend is available on :8000.
const API_BASE = 'http://localhost:8000';
const STATIC_DATA_URL = 'data/latest.json';

const MONTHS_TO_SHOW = 18;
const TARGET_HR = 7.0;
const STRONG_BUY = 0.05;
const BUY_PCTL   = 0.10;
const SELL_PCTL  = 0.90;
const STRONG_SELL = 0.95;

// ------- Rounding -------
const roundQuarter = v => v == null ? null : Math.round(v * 4) / 4;       // $0.25
const roundTenth   = v => v == null ? null : Math.round(v * 10) / 10;     // 0.1

const fmt = {
  power: v => v == null ? '—' : roundQuarter(v).toFixed(2),
  gas:   v => v == null ? '—' : v.toFixed(3),
  hr:    v => v == null ? '—' : roundTenth(v).toFixed(1),
  spark: v => v == null ? '—' : roundQuarter(v).toFixed(2),
  pct:   v => v == null ? '—' : `${Math.round(v * 100)}%`,
  cad:   v => v == null ? '—' : `$${roundQuarter(v).toFixed(2)}`,
};

// ------- DOM refs -------
const elAsof = document.getElementById('meta-asof');
const elFx   = document.getElementById('meta-fx');
const elLookback = document.getElementById('meta-lookback');
const elTarget = document.getElementById('legend-target');
const elHead = document.getElementById('desk-head');
const elBody = document.getElementById('desk-body');
const elReco = document.getElementById('reco-banner');
const elMonthPicker = document.getElementById('month-picker');
const elDrilldown = document.getElementById('drilldown-charts');

let DATA = null;
let PREV_DATA = null;        // previous snapshot for change-vs-last commentary
let SELECTED_MONTH = null;   // contract_month string
let AGG_PERIODS = [];        // [{ contract_month, contract_label, ...month-like }, ...]
let SELECTED_LEG = 'HL';     // 'HL' or 'LL' for consensus view
let DESK_LEG = 'HL';         // 'HL' | 'LL' | 'FLAT' — which leg the Desk tab is showing
let CURRENT_VIEW = 'summary';

// ----------------------------------------------------------------------------
// NERC hour counting + FLAT hours-weighted blend
// ----------------------------------------------------------------------------
// NERC on-peak (HL) = Mon–Fri, hours ending 8–23 (16 hrs/day), less NERC holidays.
// NERC holidays: New Year's, Memorial (last Mon May), Independence Day, Labor Day
// (1st Mon Sep), Thanksgiving (4th Thu Nov), Christmas. All holiday hours count LL.
// Sunday-falling holidays observed Monday per NERC; Saturday-falling not shifted.
function _nercHolidays(year) {
  const out = new Set();
  const iso = d => d.toISOString().slice(0, 10);
  const nyd = new Date(Date.UTC(year, 0, 1));
  const nydShift = nyd.getUTCDay() === 0 ? new Date(Date.UTC(year, 0, 2)) : nyd;
  out.add(iso(nydShift));
  // Memorial Day
  let d = new Date(Date.UTC(year, 4, 31));
  while (d.getUTCDay() !== 1) d = new Date(d.getTime() - 86400000);
  out.add(iso(d));
  // Independence Day
  const ind = new Date(Date.UTC(year, 6, 4));
  const indShift = ind.getUTCDay() === 0 ? new Date(Date.UTC(year, 6, 5)) : ind;
  out.add(iso(indShift));
  // Labor Day
  d = new Date(Date.UTC(year, 8, 1));
  while (d.getUTCDay() !== 1) d = new Date(d.getTime() + 86400000);
  out.add(iso(d));
  // Thanksgiving = 4th Thursday of November
  d = new Date(Date.UTC(year, 10, 1));
  while (d.getUTCDay() !== 4) d = new Date(d.getTime() + 86400000);
  d = new Date(d.getTime() + 21 * 86400000);
  out.add(iso(d));
  // Christmas
  const xm = new Date(Date.UTC(year, 11, 25));
  const xmShift = xm.getUTCDay() === 0 ? new Date(Date.UTC(year, 11, 26)) : xm;
  out.add(iso(xmShift));
  return out;
}

// Cache of contract_month -> {hlHours, llHours, total, wHL, wLL}
const _hoursCache = new Map();
function hoursBlendForMonth(contractMonth) {
  if (!contractMonth) return { wHL: 0.5, wLL: 0.5, hlHours: 0, llHours: 0, total: 0 };
  if (_hoursCache.has(contractMonth)) return _hoursCache.get(contractMonth);

  // Strip periods like '2027-CAL' or '2027-WINTER' — blend hours across their component months.
  if (contractMonth.endsWith('-CAL')) {
    const year = parseInt(contractMonth.slice(0, 4), 10);
    return _blendMultipleMonths(contractMonth, Array.from({ length: 12 }, (_, i) => [year, i + 1]));
  }
  if (contractMonth.endsWith('-WINTER')) {
    const year = parseInt(contractMonth.slice(0, 4), 10);
    return _blendMultipleMonths(contractMonth, [[year, 1], [year, 2]]);
  }

  const [yStr, mStr] = contractMonth.split('-');
  const year = parseInt(yStr, 10), month = parseInt(mStr, 10);
  if (!year || !month || month < 1 || month > 12) {
    return { wHL: 0.5, wLL: 0.5, hlHours: 0, llHours: 0, total: 0 };
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const hols = _nercHolidays(year);
  let hl = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    const iso = d.toISOString().slice(0, 10);
    if (dow >= 1 && dow <= 5 && !hols.has(iso)) hl += 16;
  }
  const total = daysInMonth * 24;
  const ll = total - hl;
  const out = { hlHours: hl, llHours: ll, total, wHL: hl / total, wLL: ll / total };
  _hoursCache.set(contractMonth, out);
  return out;
}
function _blendMultipleMonths(key, yms) {
  let hl = 0, ll = 0, total = 0;
  yms.forEach(([y, m]) => {
    const sub = hoursBlendForMonth(`${y}-${String(m).padStart(2, '0')}`);
    hl += sub.hlHours; ll += sub.llHours; total += sub.total;
  });
  const out = { hlHours: hl, llHours: ll, total, wHL: total ? hl / total : 0.5, wLL: total ? ll / total : 0.5 };
  _hoursCache.set(key, out);
  return out;
}

// Build synthetic HR_FLAT / Spark_FLAT metrics + flat history series for a month.
// FLAT power = wHL*ONT_HL + wLL*ONT_LL. FLAT heat rate = FLAT power / dawn_cad.
// FLAT spark = FLAT power - target * dawn_cad.
// Percentiles for FLAT are derived from the actual flat history (recomputed per month).
function _percentile(sortedVals, p) {
  if (!sortedVals.length) return null;
  const i = (sortedVals.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sortedVals[lo] + (sortedVals[hi] - sortedVals[lo]) * (i - lo);
}
function _rank(sortedVals, v) {
  if (v == null || !sortedVals.length) return null;
  let n = 0;
  for (const s of sortedVals) if (s <= v) n++;
  return n / sortedVals.length;
}
function ensureFlatOnMonth(m) {
  if (!m || m._flatReady) return m;
  const w = hoursBlendForMonth(m.contract_month);
  const target = (DATA && DATA.target_heat_rate) || TARGET_HR;

  // Enrich each history row with flat power / flat HR / flat spark.
  const hist = (m.history || []).map(d => {
    const ontFlat = (d.ont_hl != null && d.ont_ll != null)
      ? w.wHL * d.ont_hl + w.wLL * d.ont_ll
      : null;
    const hrFlat  = (ontFlat != null && d.dawn_cad) ? ontFlat / d.dawn_cad : null;
    const spFlat  = (ontFlat != null && d.dawn_cad != null) ? ontFlat - target * d.dawn_cad : null;
    return { ...d, ont_flat: ontFlat, hr_flat: hrFlat, spark_flat: spFlat };
  });
  m.history = hist;

  // Current-day levels (last row that has both HL and LL).
  const last = hist.slice().reverse().find(d => d.ont_hl != null && d.ont_ll != null);
  const ontFlatCur = last ? last.ont_flat : (
    (m.ont_hl != null && m.ont_ll != null) ? w.wHL * m.ont_hl + w.wLL * m.ont_ll : null
  );
  const dawnCur = m.dawn_cad;
  const hrFlatCur = (ontFlatCur != null && dawnCur) ? ontFlatCur / dawnCur : null;
  const spFlatCur = (ontFlatCur != null && dawnCur != null) ? ontFlatCur - target * dawnCur : null;

  const hrHist = hist.map(d => d.hr_flat).filter(v => v != null && Number.isFinite(v));
  const spHist = hist.map(d => d.spark_flat).filter(v => v != null && Number.isFinite(v));
  const hrSorted = hrHist.slice().sort((a, b) => a - b);
  const spSorted = spHist.slice().sort((a, b) => a - b);
  const mkMetric = (cur, sorted) => sorted.length ? ({
    current: cur,
    p5:  _percentile(sorted, 0.05),
    p10: _percentile(sorted, 0.10),
    p25: _percentile(sorted, 0.25),
    p50: _percentile(sorted, 0.50),
    p75: _percentile(sorted, 0.75),
    p90: _percentile(sorted, 0.90),
    p95: _percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sorted.reduce((a,b) => a+b, 0) / sorted.length,
    pct: _rank(sorted, cur),
  }) : null;

  m.metrics = m.metrics || {};
  m.metrics.HR_FLAT    = mkMetric(hrFlatCur, hrSorted);
  m.metrics.Spark_FLAT = mkMetric(spFlatCur, spSorted);
  m.ont_flat = ontFlatCur;


  // Blend trend (last week / two weeks): use HR_HL and HR_LL trend fields with same weights.
  const t = m.trend || {};
  const wblend = (a, b) => (a == null || b == null) ? null : w.wHL * a + w.wLL * b;
  m.trend = {
    ...t,
    hr_flat_1w_ago:    wblend(t.hr_hl_1w_ago,    t.hr_ll_1w_ago),
    hr_flat_2w_ago:    wblend(t.hr_hl_2w_ago,    t.hr_ll_2w_ago),
  };

  // Trade levels for FLAT (HR-based buy/sell) derived from HR_FLAT percentiles.
  if (m.metrics.HR_FLAT) {
    const tl = m.trade_levels || {};
    m.trade_levels = {
      ...tl,
      hr_flat_buy_strong:  m.metrics.HR_FLAT.p5,
      hr_flat_buy_watch:   m.metrics.HR_FLAT.p10,
      hr_flat_sell_watch:  m.metrics.HR_FLAT.p90,
      hr_flat_sell_strong: m.metrics.HR_FLAT.p95,
    };
  }

  // FLAT recommendation from HR percentile.
  m.recommendations = m.recommendations || {};
  m.recommendations.HR_FLAT = _recoFromPct(m.metrics.HR_FLAT?.pct);

  m._flatReady = true;
  m.w_hl = w.wHL; m.w_ll = w.wLL; m.hl_hours = w.hlHours; m.ll_hours = w.llHours;
  return m;
}
function _recoFromPct(p) {
  if (p == null) return { action: 'HOLD', reason: 'no data' };
  if (p <= STRONG_BUY)  return { action: 'STRONG BUY',  reason: `HR at P${Math.round(p*100)} — rare low` };
  if (p <= BUY_PCTL)    return { action: 'BUY',         reason: `HR at P${Math.round(p*100)} — attractive entry` };
  if (p >= STRONG_SELL) return { action: 'STRONG SELL', reason: `HR at P${Math.round(p*100)} — rare high` };
  if (p >= SELL_PCTL)   return { action: 'SELL',        reason: `HR at P${Math.round(p*100)} — rich entry` };
  return { action: 'HOLD', reason: `HR at P${Math.round(p*100)}` };
}

// Central map: DESK_LEG -> field/metric key set. Everything leg-aware reads from here.
function legConfig() {
  switch (DESK_LEG) {
    case 'LL':   return {
      legLabel: 'Off-Peak (LL)', legShort: 'OFF-PEAK', legTag: 'LL',
      hrKey: 'HR_LL', sparkKey: 'Spark_LL',
      ontKey: 'ont_ll', hrHistKey: 'hr_ll', sparkHistKey: 'spark_ll',
      hrTrend1w: 'hr_ll_1w_ago', hrTrend2w: 'hr_ll_2w_ago',
      sparkTrend1w: 'spark_ll_1w_ago', sparkTrend2w: 'spark_ll_2w_ago',
      sectionHR: 'ONT LL — Heat Rate', sectionSpark: 'ONT LL — Spark Spread',
      hrTitle: 'Heat Rate (LL)', sparkTitle: 'Spark Spread (LL)', powerTitle: 'Off-Peak Power',
      gasNormTitle: `Power @ Today's Gas (LL)`,
      caption: 'Off-Peak: all hours not in the On-Peak block (weekends, overnights, NERC holidays)',
    };
    case 'FLAT': return {
      legLabel: 'FLAT (7×24)', legShort: 'FLAT', legTag: 'FLAT',
      hrKey: 'HR_FLAT', sparkKey: 'Spark_FLAT',
      ontKey: 'ont_flat', hrHistKey: 'hr_flat', sparkHistKey: 'spark_flat',
      hrTrend1w: 'hr_flat_1w_ago', hrTrend2w: 'hr_flat_2w_ago',
      sparkTrend1w: null, sparkTrend2w: null, // no trend for FLAT spark yet
      sectionHR: 'ONT FLAT — Heat Rate', sectionSpark: 'ONT FLAT — Spark Spread',
      hrTitle: 'Heat Rate (FLAT)', sparkTitle: 'Spark Spread (FLAT)', powerTitle: 'Power (FLAT)',
      gasNormTitle: `Power @ Today's Gas (FLAT)`,
      caption: 'FLAT: hours-weighted blend of On-Peak and Off-Peak using this month’s actual NERC hour counts',
    };
    default: return {
      legLabel: 'On-Peak (HL)', legShort: 'ON-PEAK', legTag: 'HL',
      hrKey: 'HR_HL', sparkKey: 'Spark_HL',
      ontKey: 'ont_hl', hrHistKey: 'hr_hl', sparkHistKey: 'spark_hl',
      hrTrend1w: 'hr_hl_1w_ago', hrTrend2w: 'hr_hl_2w_ago',
      sparkTrend1w: 'spark_hl_1w_ago', sparkTrend2w: 'spark_hl_2w_ago',
      sectionHR: 'ONT HL — Heat Rate', sectionSpark: 'ONT HL — Spark Spread',
      hrTitle: 'Heat Rate (HL)', sparkTitle: 'Spark Spread (HL)', powerTitle: 'On-Peak Power',
      gasNormTitle: `Power @ Today's Gas (HL)`,
      caption: 'On-Peak: Mon–Fri, hours ending 8–23, less NERC holidays',
    };
  }
}

// ------- Data loading -------
// Try the static snapshot first (works both locally on :5000 and on pplx.app).
// If that fails AND a local backend is reachable, fall back to /api/data.
async function loadData() {
  // Load previous.json in parallel (best-effort, silent on 404)
  const prevPromise = fetch('data/previous.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  try {
    const r = await fetch(STATIC_DATA_URL, { cache: 'no-store' });
    if (r.ok) {
      DATA = await r.json();
      PREV_DATA = await prevPromise;
      render();
      return;
    }
  } catch (e) { /* fall through to backend */ }
  try {
    const r2 = await fetch(`${API_BASE}/api/data`);
    if (!r2.ok) { renderEmpty(); return; }
    DATA = await r2.json();
    PREV_DATA = await prevPromise;
    render();
  } catch (e) {
    console.error(e);
    renderEmpty();
  }
}

function renderEmpty() {
  elHead.innerHTML = '';
  elBody.innerHTML = '<tr><td class="empty">No dashboard data is currently available.</td></tr>';
  if (elReco) elReco.innerHTML = '';
  if (elMonthPicker) elMonthPicker.innerHTML = '';
  if (elDrilldown) elDrilldown.innerHTML = '';
}

// ------- Render -------
function render() {
  const fx = DATA.fx_latest;
  const target = DATA.target_heat_rate || TARGET_HR;
  elAsof.textContent = DATA.as_of;
  elFx.textContent = fx.toFixed(4);
  elLookback.textContent = `${DATA.lookback_days} days`;
  elTarget.textContent = target.toFixed(1);

  // Enrich every month with FLAT metrics + history (idempotent).
  DATA.months.forEach(ensureFlatOnMonth);
  if (DATA.cal27) ensureFlatOnMonth(DATA.cal27);

  // Filter to forward months
  const asOf = new Date(DATA.as_of + 'T00:00:00');
  const nextFull = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1);
  const months = DATA.months
    .filter(m => {
      const [y, mo] = m.contract_month.split('-').map(Number);
      return new Date(y, mo - 1, 1) >= nextFull;
    })
    .slice(0, MONTHS_TO_SHOW);

  // Build list of displayed columns (months + Cal-27 strip if available)
  const cols = months.slice();
  if (DATA.cal27) cols.push(DATA.cal27);

  // ---- Recommendation banner ----
  renderRecoBanner(months);

  // ---- Header ----
  let head = '<tr><th class="section-label"></th><th class="metric-col">Metric</th>';
  cols.forEach(m => {
    const isStrip = m.is_strip;
    head += `<th class="month-col ${isStrip ? 'strip-col' : ''}">${m.contract_label}</th>`;
  });
  head += '</tr>';
  elHead.innerHTML = head;

  // ---- Body (leg-aware: HL / LL / FLAT) ----
  const lc = legConfig();
  const legTag = lc.legTag;
  let html = '';
  html += sectionHeader('MARKET', cols.length + 1);
  html += rowMarket(cols, `Power ${legTag} (CAD/MWh)`, m => m[lc.ontKey], fmt.power);
  html += rowMarket(cols, 'Henry Hub (USD/MMBtu)', m => m.hh, fmt.gas);
  html += rowMarket(cols, 'Dawn (USD/MMBtu)', m => m.dawn_usd, fmt.gas);
  html += rowMarket(cols, 'Gas @ Dawn (CAD/MMBtu)', m => m.dawn_cad, fmt.gas, 'row-highlight');

  // Heat rate section (leg-aware)
  html += sectionHeader(lc.sectionHR, cols.length + 1, `ont-${legTag.toLowerCase()}-hr`);
  html += rowMetric(cols, 'Current HR', lc.hrKey, 'current', fmt.hr, true);
  if (lc.hrTrend1w) html += rowTrend(cols, 'HR · 1 week ago', lc.hrTrend1w, fmt.hr, lc.hrKey);
  if (lc.hrTrend2w) html += rowTrend(cols, 'HR · 2 weeks ago', lc.hrTrend2w, fmt.hr, lc.hrKey);
  html += rowPctl(cols, 'Percentile', lc.hrKey);
  html += rowMetric(cols, 'P5  HR', lc.hrKey, 'p5',  fmt.hr);
  html += rowMetric(cols, 'P50 HR', lc.hrKey, 'p50', fmt.hr);
  html += rowMetric(cols, 'P95 HR', lc.hrKey, 'p95', fmt.hr);
  html += rowTradeHR(cols, 'Buy ≤  (CAD/MWh)',  'p5',  'cell-buy',  lc.hrKey);
  html += rowTradeHR(cols, 'Sell ≥ (CAD/MWh)',  'p95', 'cell-sell', lc.hrKey);

  // Spark spread section (leg-aware)
  html += sectionHeader(lc.sectionSpark, cols.length + 1, `ont-${legTag.toLowerCase()}-spark`);
  html += rowMetric(cols, 'Current Spark', lc.sparkKey, 'current', fmt.spark, true);
  if (lc.sparkTrend1w) html += rowTrend(cols, 'Spark · 1 week ago', lc.sparkTrend1w, fmt.spark, lc.sparkKey);
  if (lc.sparkTrend2w) html += rowTrend(cols, 'Spark · 2 weeks ago', lc.sparkTrend2w, fmt.spark, lc.sparkKey);
  html += rowPctl(cols, 'Percentile', lc.sparkKey);
  html += rowMetric(cols, 'P5  Spark', lc.sparkKey, 'p5',  fmt.spark);
  html += rowMetric(cols, 'P50 Spark', lc.sparkKey, 'p50', fmt.spark);
  html += rowMetric(cols, 'P95 Spark', lc.sparkKey, 'p95', fmt.spark);
  html += rowTradeSpark(cols, 'Buy ≤  (CAD/MWh)',  'p5',  target, 'cell-buy',  lc.sparkKey, 'key-block-row key-block-top');
  html += rowTradeSpark(cols, 'Sell ≥ (CAD/MWh)',  'p95', target, 'cell-sell', lc.sparkKey, 'key-block-row');
  html += rowMarket(cols, `Market ${legTag} (CAD/MWh)`, m => m[lc.ontKey], fmt.power, 'row-market-footer key-block-row key-block-bottom');

  elBody.innerHTML = html;

  // ---- Build aggregate periods (Cal-27 from DATA, Winter-27 weighted Jan+Feb 2027) ----
  AGG_PERIODS = [];
  if (DATA.cal27) AGG_PERIODS.push(DATA.cal27);
  const winter = buildWinter27(DATA.months);
  if (winter) AGG_PERIODS.push(winter);

  // ---- Month picker + drill-down ----
  const allPickable = months.concat(AGG_PERIODS);
  if (!SELECTED_MONTH || !allPickable.find(m => m.contract_month === SELECTED_MONTH)) {
    SELECTED_MONTH = months[0]?.contract_month || null;
  }
  renderMonthPicker(months, AGG_PERIODS);
  renderDrilldown(SELECTED_MONTH);

  // ---- Consensus + Summary views ----
  renderConsensus(months);
  renderSummary(months);
}

// ------- Aggregate period builders -------
// Winter-27 = weighted average of Jan 2027 (31 days) and Feb 2027 (28 days).
function buildWinter27(allMonths) {
  const jan = allMonths.find(m => m.contract_month === '2027-01');
  const feb = allMonths.find(m => m.contract_month === '2027-02');
  if (!jan || !feb) return null;
  const wJ = 31, wF = 28, wT = wJ + wF;
  const wavg = (a, b) => (a == null || b == null) ? null : (a * wJ + b * wF) / wT;

  const blendMetric = (key) => {
    const a = jan.metrics?.[key], b = feb.metrics?.[key];
    if (!a || !b) return null;
    const out = {};
    ['current','p5','p10','p25','p50','p75','p90','p95','min','max','avg','pct']
      .forEach(k => out[k] = wavg(a[k], b[k]));
    return out;
  };

  const histKeys = ['hr_hl','hr_ll','spark_hl','spark_ll','ont_hl','ont_ll','dawn_cad','hr_flat','spark_flat','ont_flat'];
  const jh = jan.history || [], fh = feb.history || [];
  const n = Math.min(jh.length, fh.length);
  const history = [];
  for (let i = 0; i < n; i++) {
    const row = { date: jh[i].date };
    histKeys.forEach(k => row[k] = wavg(jh[i][k], fh[i][k]));
    history.push(row);
  }

  return {
    contract_month: '2027-WINTER',
    contract_label: 'Winter-27',
    is_strip: true,
    is_aggregate: true,
    fx: jan.fx,
    ont_hl:   wavg(jan.ont_hl,   feb.ont_hl),
    ont_ll:   wavg(jan.ont_ll,   feb.ont_ll),
    hh:       wavg(jan.hh,       feb.hh),
    dawn_usd: wavg(jan.dawn_usd, feb.dawn_usd),
    dawn_cad: wavg(jan.dawn_cad, feb.dawn_cad),
    ont_flat: wavg(jan.ont_flat, feb.ont_flat),
    metrics: {
      HR_HL:      blendMetric('HR_HL'),
      HR_LL:      blendMetric('HR_LL'),
      Spark_HL:   blendMetric('Spark_HL'),
      Spark_LL:   blendMetric('Spark_LL'),
      HR_FLAT:    blendMetric('HR_FLAT'),
      Spark_FLAT: blendMetric('Spark_FLAT'),
    },
    trend: {
      hr_hl_1w_ago:    wavg(jan.trend?.hr_hl_1w_ago,    feb.trend?.hr_hl_1w_ago),
      hr_hl_2w_ago:    wavg(jan.trend?.hr_hl_2w_ago,    feb.trend?.hr_hl_2w_ago),
      hr_ll_1w_ago:    wavg(jan.trend?.hr_ll_1w_ago,    feb.trend?.hr_ll_1w_ago),
      hr_ll_2w_ago:    wavg(jan.trend?.hr_ll_2w_ago,    feb.trend?.hr_ll_2w_ago),
      hr_flat_1w_ago: wavg(jan.trend?.hr_flat_1w_ago, feb.trend?.hr_flat_1w_ago),
      hr_flat_2w_ago: wavg(jan.trend?.hr_flat_2w_ago, feb.trend?.hr_flat_2w_ago),
      spark_hl_1w_ago: wavg(jan.trend?.spark_hl_1w_ago, feb.trend?.spark_hl_1w_ago),
      spark_hl_2w_ago: wavg(jan.trend?.spark_hl_2w_ago, feb.trend?.spark_hl_2w_ago),
    },
    _flatReady: true, // metrics already blended; don't re-derive
    history,
  };
}

// ------- Recommendation banner -------
function renderRecoBanner(months) {
  if (!elReco) return;
  const target = DATA.target_heat_rate || TARGET_HR;
  const lc = legConfig();
  const strongBuy  = [], buyWatch  = [];
  const strongSell = [], sellWatch = [];
  months.forEach(m => {
    const p = m.metrics?.[lc.hrKey]?.pct;
    if (p == null) return;
    if      (p <= STRONG_BUY)  strongBuy.push(m);
    else if (p <= BUY_PCTL)    buyWatch.push(m);
    else if (p >= STRONG_SELL) strongSell.push(m);
    else if (p >= SELL_PCTL)   sellWatch.push(m);
  });

  // Execution prices for a given month at a target percentile.
  // HR price  = HR_pctile * dawn_cad        (CAD/MWh, rounded to $0.25)
  // Sprk price = Spark_pctile + target*dawn (CAD/MWh, rounded to $0.25)
  const priceAtPctl = (m, statKey) => {
    const hr  = m.metrics?.[lc.hrKey]?.[statKey];
    const sp  = m.metrics?.[lc.sparkKey]?.[statKey];
    const dawn = m.dawn_cad;
    if (dawn == null) return { hr: null, spark: null };
    return {
      hr:    (hr != null) ? hr * dawn                : null,
      spark: (sp != null) ? sp + target * dawn        : null,
    };
  };
  const $0 = v => v == null ? '—' : '$' + roundQuarter(v).toFixed(2);

  // Buys execute at P5, sells execute at P95 — always show that level on the chip.
  const chip = (m, kind) => {
    const pct = Math.round(m.metrics[lc.hrKey].pct * 100);
    const isBuy = (kind === 'strong-buy' || kind === 'buy');
    const statKey = isBuy ? 'p5' : 'p95';
    const levelLabel = isBuy ? 'Buy @ P5' : 'Sell @ P95';
    const px = priceAtPctl(m, statKey);
    const title = `HR now ${fmt.hr(m.metrics[lc.hrKey].current)} (${pct}%ile) · ${levelLabel}: HR ${$0(px.hr)} · Spark ${$0(px.spark)}`;
    return `
      <span class="reco-chip reco-${kind}" title="${title}">
        <span class="reco-chip-month">${m.contract_label}</span>
        <span class="reco-chip-pct">${pct}%</span>
        <span class="reco-chip-level">${levelLabel}</span>
        <span class="reco-chip-px">
          <span class="reco-chip-px-row"><em>HR</em> ${$0(px.hr)}</span>
          <span class="reco-chip-px-row"><em>Spark</em> ${$0(px.spark)}</span>
        </span>
      </span>`;
  };
  const card = (title, subtitle, items, kind, emptyMsg) => `
    <div class="reco-card reco-card-${kind}">
      <div class="reco-card-head">
        <div class="reco-card-title">${title} <span class="reco-count">${items.length}</span></div>
        <div class="reco-card-sub">${subtitle}</div>
      </div>
      <div class="reco-chips">${items.length ? items.map(m => chip(m, kind)).join('') : `<span class="reco-empty">${emptyMsg}</span>`}</div>
    </div>`;

  elReco.innerHTML = `
    ${card('Strong Buy',  'execute at P5',  strongBuy,  'strong-buy',  'no months at P5 lows')}
    ${card('Buy Watch',   'execute at P5',  buyWatch,   'buy',         'no buy-watch months')}
    ${card('Sell Watch',  'execute at P95', sellWatch,  'sell',        'no sell-watch months')}
    ${card('Strong Sell', 'execute at P95', strongSell, 'strong-sell', 'no months at P95 highs')}
  `;
}

// ------- Row builders -------
function sectionHeader(label, span, cls = '') {
  return `<tr class="section ${cls}"><td class="section-label" colspan="2">${label}</td><td class="section-spacer" colspan="${span - 1}"></td></tr>`;
}

function colCellCls(col) { return col.is_strip ? 'strip-col' : ''; }

function rowMarket(cols, label, getter, fmtFn, extraCls = '') {
  let row = `<tr class="${extraCls}"><td class="section-label"></td><td class="metric-col">${label}</td>`;
  cols.forEach(m => {
    const v = getter(m);
    row += `<td class="num ${colCellCls(m)}">${fmtFn(v)}</td>`;
  });
  return row + '</tr>';
}

function rowMetric(cols, label, metricKey, statKey, fmtFn, isCurrent = false) {
  const cls = isCurrent ? 'row-current' : '';
  let row = `<tr class="${cls}"><td class="section-label"></td><td class="metric-col">${label}</td>`;
  cols.forEach(m => {
    const v = m.metrics?.[metricKey]?.[statKey];
    row += `<td class="num ${colCellCls(m)}">${fmtFn(v)}</td>`;
  });
  return row + '</tr>';
}

// HR/Spark current vs trend: arrow + delta vs current
function rowTrend(cols, label, trendKey, fmtFn, metricKey) {
  let row = `<tr class="row-trend"><td class="section-label"></td><td class="metric-col">${label}</td>`;
  cols.forEach(m => {
    const v = m.trend?.[trendKey];
    const cur = m.metrics?.[metricKey]?.current;
    let arrow = '';
    if (v != null && cur != null) {
      const d = cur - v;
      if      (d >  0.01) arrow = `<span class="trend-up">▲</span>`;
      else if (d < -0.01) arrow = `<span class="trend-down">▼</span>`;
      else                arrow = `<span class="trend-flat">·</span>`;
    }
    row += `<td class="num ${colCellCls(m)}">${arrow} ${fmtFn(v)}</td>`;
  });
  return row + '</tr>';
}

function rowPctl(cols, label, metricKey) {
  let row = `<tr class="row-pctl"><td class="section-label"></td><td class="metric-col">${label}</td>`;
  cols.forEach(m => {
    const p = m.metrics?.[metricKey]?.pct;
    let cls = 'num ' + colCellCls(m);
    if (p != null) {
      if      (p <= STRONG_BUY)  cls += ' cell-gold-buy';
      else if (p <= BUY_PCTL)    cls += ' cell-buy';
      else if (p >= STRONG_SELL) cls += ' cell-gold-sell';
      else if (p >= SELL_PCTL)   cls += ' cell-sell';
    }
    row += `<td class="${cls}">${fmt.pct(p)}</td>`;
  });
  return row + '</tr>';
}

function rowTradeHR(cols, label, statKey, cellCls, hrKey = 'HR_HL') {
  let row = `<tr class="row-trade"><td class="section-label"></td><td class="metric-col">${label}</td>`;
  cols.forEach(m => {
    const hr = m.metrics?.[hrKey]?.[statKey];
    const dawn = m.dawn_cad;
    const v = (hr != null && dawn != null) ? hr * dawn : null;
    row += `<td class="num ${cellCls} ${colCellCls(m)}">${fmt.cad(v)}</td>`;
  });
  return row + '</tr>';
}

function rowTradeSpark(cols, label, statKey, target, cellCls, sparkKey = 'Spark_HL', extraRowCls = '') {
  let row = `<tr class="row-trade ${extraRowCls}"><td class="section-label"></td><td class="metric-col">${label}</td>`;
  cols.forEach(m => {
    const sp = m.metrics?.[sparkKey]?.[statKey];
    const dawn = m.dawn_cad;
    const v = (sp != null && dawn != null) ? sp + target * dawn : null;
    row += `<td class="num ${cellCls} ${colCellCls(m)}">${fmt.cad(v)}</td>`;
  });
  return row + '</tr>';
}

// ------- Month Picker -------
function renderMonthPicker(months, aggregates = []) {
  if (!elMonthPicker) return;
  const btn = (m, strip = false) =>
    `<button class="month-btn ${strip ? 'month-btn-strip' : ''} ${m.contract_month === SELECTED_MONTH ? 'active' : ''}" data-month="${m.contract_month}">${m.contract_label}</button>`;
  const monthsHtml = months.map(m => btn(m, false)).join('');
  const aggHtml = aggregates.length
    ? `<span class="month-picker-sep" aria-hidden="true"></span>` + aggregates.map(m => btn(m, true)).join('')
    : '';
  elMonthPicker.innerHTML = monthsHtml + aggHtml;
  elMonthPicker.querySelectorAll('.month-btn').forEach(b => {
    b.addEventListener('click', () => {
      SELECTED_MONTH = b.dataset.month;
      elMonthPicker.querySelectorAll('.month-btn').forEach(x =>
        x.classList.toggle('active', x.dataset.month === SELECTED_MONTH));
      renderDrilldown(SELECTED_MONTH);
    });
  });
}

// Lookup a month or aggregate by contract_month string.
function findPeriod(contractMonth) {
  if (!contractMonth) return null;
  if (DATA.cal27 && DATA.cal27.contract_month === contractMonth) return DATA.cal27;
  const agg = AGG_PERIODS.find(a => a.contract_month === contractMonth);
  if (agg) return agg;
  return DATA.months.find(x => x.contract_month === contractMonth) || null;
}

// ------- Drill-down Charts -------
function renderDrilldown(contractMonth) {
  if (!elDrilldown) return;
  if (!contractMonth) { elDrilldown.innerHTML = ''; return; }
  const m = findPeriod(contractMonth);
  if (!m) { elDrilldown.innerHTML = ''; return; }

  const lc = legConfig();
  const charts = [
    { key: lc.hrHistKey,    metric: lc.hrKey,    title: lc.hrTitle,    unit: '',         fmtFn: v => v.toFixed(2) },
    { key: lc.sparkHistKey, metric: lc.sparkKey, title: lc.sparkTitle, unit: ' CAD/MWh', fmtFn: v => v.toFixed(2) },
    { key: lc.ontKey,       metric: null,        title: lc.powerTitle, unit: ' CAD/MWh', fmtFn: v => v.toFixed(2), series: lc.ontKey },
    { key: 'dawn_cad',      metric: null,        title: 'Dawn Gas',    unit: ' CAD/MMBtu', fmtFn: v => v.toFixed(3), series: 'dawn_cad' },
    // Counterfactual: what would power have been each day if gas had always sat at today's Dawn?
    // Series = historical heat rate (leg) × today's dawn_cad. Isolates HR driver from gas driver.
    { key: 'power_at_today_gas',
      metric: null,
      title: lc.gasNormTitle,
      subtitle: 'hypothetical — historical heat rate × latest Dawn gas price',
      unit: ' CAD/MWh',
      fmtFn: v => v.toFixed(2),
      highlight: true,
      compute: (d, ctx) => (d[lc.hrHistKey] != null && ctx.dawnToday != null) ? d[lc.hrHistKey] * ctx.dawnToday : null,
    },
  ];

  const isAgg = !!m.is_strip;
  const stripTag = isAgg ? '<span class="drill-strip-tag">STRIP</span>' : '';
  const subTitle = isAgg
    ? 'Strip view · period-average history with P5 / P50 / P95 reference levels · percentile track below each.'
    : 'Execution snapshot · 90-day history with P5 / P50 / P95 reference levels · percentile track below each.';

  elDrilldown.innerHTML = `
    <div class="drill-header">
      <h3>${m.contract_label} drill-down ${stripTag}</h3>
      <div class="drill-sub">${subTitle}</div>
    </div>
    ${renderSnapshot(m)}
    <div class="drill-grid">
      ${charts.map(c => `
        <div class="drill-card ${c.highlight ? 'drill-card-highlight' : ''}">
          <div class="drill-title">${c.title}${c.subtitle ? `<span class="drill-subtitle">${c.subtitle}</span>` : ''}</div>
          <div class="drill-chart" id="chart-${c.key}"></div>
          <div class="drill-chart drill-chart-sub" id="chart-${c.key}-pct"></div>
        </div>
      `).join('')}
    </div>
  `;

  charts.forEach(c => drawChart(m, c));
}

// ------- Execution Snapshot Table -------
function renderSnapshot(m) {
  const target = DATA.target_heat_rate || TARGET_HR;
  const lc = legConfig();
  const dawn = m.dawn_cad;
  const hr = m.metrics?.[lc.hrKey];
  const sp = m.metrics?.[lc.sparkKey];
  if (!hr || !sp) return '<div class="snap-empty">no snapshot data</div>';

  // HR percentile  -> CAD/MWh:  HR * dawn_cad
  // Spark percentile -> CAD/MWh: Spark + target * dawn_cad
  const hrPx = v => (v == null || dawn == null) ? null : v * dawn;
  const spPx = v => (v == null || dawn == null) ? null : v + target * dawn;

  const cadFmt   = v => v == null ? '—' : '$' + roundQuarter(v).toFixed(2);
  const hrFmt    = v => v == null ? '—' : roundTenth(v).toFixed(1);
  const sparkFmt = v => v == null ? '—' : roundQuarter(v).toFixed(2);
  const gasFmt   = v => v == null ? '—' : v.toFixed(3);

  const pctChip = (p) => {
    if (p == null) return '<span class="snap-pct snap-pct-mid">—</span>';
    const txt = Math.round(p * 100) + '%';
    let cls = 'snap-pct snap-pct-mid';
    if      (p <= STRONG_BUY)   cls = 'snap-pct snap-pct-strong-buy';
    else if (p <= BUY_PCTL)     cls = 'snap-pct snap-pct-buy';
    else if (p >= STRONG_SELL)  cls = 'snap-pct snap-pct-strong-sell';
    else if (p >= SELL_PCTL)    cls = 'snap-pct snap-pct-sell';
    return `<span class="${cls}">${txt}</span>`;
  };

  const hrBuyP5   = hrPx(hr.p5);
  const hrBuyP10  = hrPx(hr.p10);
  const hrSellP90 = hrPx(hr.p90);
  const hrSellP95 = hrPx(hr.p95);
  const spBuyP5   = spPx(sp.p5);
  const spBuyP10  = spPx(sp.p10);
  const spSellP90 = spPx(sp.p90);
  const spSellP95 = spPx(sp.p95);

  const stripBadge = m.is_strip ? ' <span class="snap-strip-tag">strip</span>' : '';

  return `
    <div class="snap-table-wrap">
      <table class="snap-table snap-table-mkt">
        <thead>
          <tr>
            <th class="snap-label">${m.contract_label}${stripBadge}</th>
            <th class="snap-unit">Power ${lc.legTag}<br><em>CAD/MWh</em></th>
            <th class="snap-unit">Henry Hub<br><em>USD/MMBtu</em></th>
            <th class="snap-unit">Dawn<br><em>USD/MMBtu</em></th>
            <th class="snap-unit">Dawn<br><em>CAD/MMBtu</em></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="snap-label">Market</td>
            <td class="snap-num snap-mkt">${cadFmt(m[lc.ontKey])}</td>
            <td class="snap-num snap-mkt">${gasFmt(m.hh)}</td>
            <td class="snap-num snap-mkt">${gasFmt(m.dawn_usd)}</td>
            <td class="snap-num snap-mkt">${gasFmt(dawn)}</td>
          </tr>
        </tbody>
      </table>

      <table class="snap-table snap-table-trade">
        <thead>
          <tr>
            <th class="snap-label">Metric</th>
            <th>Current</th>
            <th>%ile</th>
            <th>P5</th>
            <th>P50</th>
            <th>P95</th>
            <th class="snap-buy-th">Buy @ P5</th>
            <th class="snap-buy-th snap-buy-th-soft">Buy @ P10</th>
            <th class="snap-sell-th snap-sell-th-soft">Sell @ P90</th>
            <th class="snap-sell-th">Sell @ P95</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="snap-label">Heat Rate <em>(MMBtu/MWh)</em></td>
            <td class="snap-num snap-cur">${hrFmt(hr.current)}</td>
            <td class="snap-num">${pctChip(hr.pct)}</td>
            <td class="snap-num">${hrFmt(hr.p5)}</td>
            <td class="snap-num">${hrFmt(hr.p50)}</td>
            <td class="snap-num">${hrFmt(hr.p95)}</td>
            <td class="snap-num snap-buy-strong">${cadFmt(hrBuyP5)}</td>
            <td class="snap-num snap-buy">${cadFmt(hrBuyP10)}</td>
            <td class="snap-num snap-sell">${cadFmt(hrSellP90)}</td>
            <td class="snap-num snap-sell-strong">${cadFmt(hrSellP95)}</td>
          </tr>
          <tr>
            <td class="snap-label">Spark @ ${target.toFixed(1)} HR <em>(CAD/MWh)</em></td>
            <td class="snap-num snap-cur">${sparkFmt(sp.current)}</td>
            <td class="snap-num">${pctChip(sp.pct)}</td>
            <td class="snap-num">${sparkFmt(sp.p5)}</td>
            <td class="snap-num">${sparkFmt(sp.p50)}</td>
            <td class="snap-num">${sparkFmt(sp.p95)}</td>
            <td class="snap-num snap-buy-strong">${cadFmt(spBuyP5)}</td>
            <td class="snap-num snap-buy">${cadFmt(spBuyP10)}</td>
            <td class="snap-num snap-sell">${cadFmt(spSellP90)}</td>
            <td class="snap-num snap-sell-strong">${cadFmt(spSellP95)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function drawChart(m, cfg) {
  const host = document.getElementById(`chart-${cfg.key}`);
  const hostPct = document.getElementById(`chart-${cfg.key}-pct`);
  if (!host) return;

  // Latest Dawn gas price for this month ("today's gas") — falls back to the last
  // observed dawn_cad in the history if the field is missing on the snapshot.
  const rawHist = m.history || [];
  const dawnToday = m.dawn_cad != null
    ? m.dawn_cad
    : (rawHist.slice().reverse().find(d => d.dawn_cad != null) || {}).dawn_cad;
  const ctx = { dawnToday };

  let hist;
  if (cfg.compute) {
    hist = rawHist
      .map(d => ({ ...d, [cfg.key]: cfg.compute(d, ctx) }))
      .filter(d => d[cfg.key] != null && Number.isFinite(d[cfg.key]));
  } else {
    hist = rawHist.filter(d => d[cfg.key] != null);
  }
  if (!hist.length) {
    host.innerHTML = '<div class="chart-empty">no history</div>';
    return;
  }

  const values = hist.map(d => d[cfg.key]);
  const dates  = hist.map(d => new Date(d.date));

  // For HR / Spark we have stored percentile levels on metrics; otherwise derive from values.
  let p5, p50, p95;
  if (cfg.metric && m.metrics?.[cfg.metric]) {
    p5  = m.metrics[cfg.metric].p5;
    p50 = m.metrics[cfg.metric].p50;
    p95 = m.metrics[cfg.metric].p95;
  } else {
    const sorted = [...values].sort((a,b) => a-b);
    const q = (p) => {
      const i = (sorted.length - 1) * p;
      const lo = Math.floor(i), hi = Math.ceil(i);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
    };
    p5 = q(0.05); p50 = q(0.50); p95 = q(0.95);
  }
  const cur = values[values.length - 1];

  // Y-axis scale: include all of values + reference lines
  const lo = Math.min(...values, p5);
  const hi = Math.max(...values, p95);
  const pad = (hi - lo) * 0.08 || 0.5;
  const yMin = lo - pad, yMax = hi + pad;

  // Main chart SVG
  const W = host.clientWidth || 340, H = 260;
  const ml = 50, mr = 14, mt = 14, mb = 26;
  const iw = W - ml - mr, ih = H - mt - mb;
  const x = i => ml + (i / (values.length - 1)) * iw;
  const y = v => mt + (1 - (v - yMin) / (yMax - yMin)) * ih;

  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const xTicks = [0, Math.floor(values.length * 0.25), Math.floor(values.length * 0.5), Math.floor(values.length * 0.75), values.length - 1];
  const fmtDate = d => `${d.toLocaleDateString('en-US', {month:'short'})} ${d.getDate()}`;

  const refLine = (val, color, label) => {
    const yp = y(val).toFixed(1);
    return `
      <line x1="${ml}" y1="${yp}" x2="${ml+iw}" y2="${yp}" stroke="${color}" stroke-width="1.25" stroke-dasharray="4 4" opacity="0.85"/>
      <text x="${ml+iw-2}" y="${(parseFloat(yp)-4).toFixed(1)}" text-anchor="end" fill="${color}" font-size="12" font-family="JetBrains Mono">${label} ${cfg.fmtFn(val)}</text>
    `;
  };

  // Y-axis labels (3 ticks)
  const yTicks = [yMin + pad, (yMin+yMax)/2, yMax - pad];
  const yTickEls = yTicks.map(v => `
    <text x="${ml-6}" y="${(y(v)+4).toFixed(1)}" text-anchor="end" fill="var(--text-faint)" font-size="12" font-family="JetBrains Mono">${cfg.fmtFn(v)}</text>
  `).join('');

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
      <rect x="${ml}" y="${mt}" width="${iw}" height="${ih}" fill="none" stroke="var(--border)" stroke-width="1"/>
      ${refLine(p5,  'var(--buy)',  'P5')}
      ${refLine(p50, 'var(--text-muted)', 'P50')}
      ${refLine(p95, 'var(--sell)', 'P95')}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.75"/>
      <circle cx="${x(values.length-1).toFixed(1)}" cy="${y(cur).toFixed(1)}" r="4" fill="var(--accent)"/>
      ${yTickEls}
      ${xTicks.map(i => `<text x="${x(i).toFixed(1)}" y="${H-7}" text-anchor="middle" fill="var(--text-faint)" font-size="12" font-family="JetBrains Mono">${fmtDate(dates[i])}</text>`).join('')}
    </svg>
  `;

  // ---- Percentile-over-time sub-chart (rank of each historical point) ----
  if (hostPct) {
    const sorted = [...values].sort((a,b) => a-b);
    const rank = v => sorted.filter(s => s <= v).length / sorted.length;
    const pctSeries = values.map(rank);
    const Wp = hostPct.clientWidth || W, Hp = 110;
    const ihp = Hp - mt - mb;
    const xp = i => ml + (i / (pctSeries.length - 1)) * iw;
    const yp = v => mt + (1 - v) * ihp;
    const pPath = pctSeries.map((v, i) => `${i ? 'L' : 'M'}${xp(i).toFixed(1)},${yp(v).toFixed(1)}`).join(' ');
    const band = (v, color) => `<line x1="${ml}" y1="${yp(v).toFixed(1)}" x2="${ml+iw}" y2="${yp(v).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>`;
    hostPct.innerHTML = `
      <svg viewBox="0 0 ${Wp} ${Hp}" width="100%" height="${Hp}" preserveAspectRatio="none">
        <rect x="${ml}" y="${mt}" width="${iw}" height="${ihp}" fill="none" stroke="var(--border)" stroke-width="1"/>
        ${band(0.05, 'var(--buy)')}
        ${band(0.50, 'var(--text-faint)')}
        ${band(0.95, 'var(--sell)')}
        <path d="${pPath}" fill="none" stroke="var(--accent)" stroke-width="1.25"/>
        <text x="${ml-6}" y="${(yp(1)+12).toFixed(1)}"   text-anchor="end" fill="var(--text-faint)" font-size="12" font-family="JetBrains Mono">100%</text>
        <text x="${ml-6}" y="${(yp(0.5)+4).toFixed(1)}"  text-anchor="end" fill="var(--text-faint)" font-size="12" font-family="JetBrains Mono">50%</text>
        <text x="${ml-6}" y="${(yp(0)-2).toFixed(1)}"    text-anchor="end" fill="var(--text-faint)" font-size="12" font-family="JetBrains Mono">0%</text>
      </svg>
    `;
  }
}

window.addEventListener('resize', () => {
  if (DATA && SELECTED_MONTH) renderDrilldown(SELECTED_MONTH);
});

loadData();

// =========================================================
// VIEW TAB SWITCHING (Summary / Consensus / Desk)
// =========================================================
function switchView(name) {
  CURRENT_VIEW = name;
  document.querySelectorAll('.view-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === `view-${name}`);
  });
  // On desk activation, drilldown SVGs may have been sized with clientWidth=0;
  // re-render to size correctly.
  if (name === 'desk' && DATA && SELECTED_MONTH) renderDrilldown(SELECTED_MONTH);
}
document.querySelectorAll('.view-tab').forEach(b => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// Desk sub-tabs: On-Peak (HL) / Off-Peak (LL) / FLAT
document.querySelectorAll('.desk-leg-tab').forEach(b => {
  b.addEventListener('click', () => {
    const newLeg = b.dataset.deskLeg;
    if (newLeg === DESK_LEG) return;
    DESK_LEG = newLeg;
    document.querySelectorAll('.desk-leg-tab').forEach(x =>
      x.classList.toggle('active', x.dataset.deskLeg === DESK_LEG));
    const cap = document.getElementById('desk-leg-caption');
    if (cap) cap.textContent = legConfig().caption;
    if (DATA) render();
  });
});

// Leg toggle on consensus tab
document.querySelectorAll('.leg-btn').forEach(b => {
  b.addEventListener('click', () => {
    SELECTED_LEG = b.dataset.leg;
    document.querySelectorAll('.leg-btn').forEach(x => x.classList.toggle('active', x.dataset.leg === SELECTED_LEG));
    if (DATA) {
      // rebuild the consensus rows with the new leg
      const asOf = new Date(DATA.as_of + 'T00:00:00');
      const nextFull = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1);
      const months = DATA.months
        .filter(m => {
          const [y, mo] = m.contract_month.split('-').map(Number);
          return new Date(y, mo - 1, 1) >= nextFull;
        })
        .slice(0, MONTHS_TO_SHOW);
      renderConsensus(months);
      renderSummary(months);
    }
  });
});

// =========================================================
// CONSENSUS VIEW
// =========================================================
// All CAD/MWh prices and price deltas round to the nearest $0.25 for readability
// on the trading desk. Percentages round to whole %.
const _q25 = v => v == null ? null : Math.round(v * 4) / 4;
const $D = v => { const q = _q25(v); return q == null ? '—' : (q >= 0 ? '+' : '') + q.toFixed(2); };
const $P = v => { const q = _q25(v); return q == null ? '—' : '$' + q.toFixed(2); };
const $Pct = v => v == null ? '—' : Math.round(v * 100) + '%';

// Map verdict string → CSS class suffix
function verdictClass(v) {
  if (!v) return 'mixed';
  return v.toLowerCase().replace(/\s+/g, '-');
}
function verdictRowClass(v) {
  if (v === 'STRONG BUY')  return 'row-strong-buy';
  if (v === 'STRONG SELL') return 'row-strong-sell';
  return '';
}

function renderConsensus(months) {
  const headEl = document.getElementById('consensus-head');
  const bodyEl = document.getElementById('consensus-body');
  if (!headEl || !bodyEl) return;

  // Render neighbor-zone trade date meta line above the table.
  // PJM has its own per-day series in the DATA tab so it carries its own trade date;
  // NYISO Zone A is a monthly snapshot curve (no per-row date), so we fall back to the workbook as-of.
  const meta = DATA && DATA.neighbor_meta;
  const metaEl = document.getElementById('consensus-legend-meta');
  if (metaEl && meta) {
    const pjmTd = meta.pjm_wh_hl_trade_date || meta.pjm_wh_ll_trade_date || DATA.as_of;
    const nyTd  = meta.ny_a_hl_trade_date  || meta.ny_a_ll_trade_date  || DATA.as_of;
    const nySrc = (!meta.ny_a_hl_trade_date && !meta.ny_a_ll_trade_date) ? ' (workbook as-of — snapshot curve)' : '';
    metaEl.innerHTML = `
      <b>PJM WH</b> mark: ${pjmTd} · wheel $${meta.wheel_pjm_wh_cad}/MWh
      &nbsp;·&nbsp;
      <b>NYISO Zone A</b> mark: ${nyTd}${nySrc} · wheel $${meta.wheel_ny_a_cad}/MWh
      &nbsp;·&nbsp;
      <b>FX</b>: ${DATA.fx_latest} CAD/USD
    `;
  }

  const leg = SELECTED_LEG;  // 'HL' or 'LL'

  // Header
  headEl.innerHTML = `
    <tr>
      <th rowspan="2" class="col-month">Month</th>
      <th rowspan="2" class="col-price">Market<br>CAD/MWh</th>
      <th colspan="4" class="thead-group group-percentile">1. Percentile (HR)</th>
      <th colspan="3" class="thead-group group-flow">2. Flow Spread (CAD/MWh)</th>
      <th rowspan="2" class="col-verdict thead-group group-verdict">Verdict</th>
    </tr>
    <tr>
      <th class="col-factor">Pctl</th>
      <th class="col-price">P5</th>
      <th class="col-price">P95</th>
      <th class="col-factor">Signal</th>
      <th class="col-price">NY-A be</th>
      <th class="col-price">PJM be</th>
      <th class="col-factor">Signal</th>
    </tr>
  `;

  // Rows — individual months only (strips like Cal-27/Winter-27 don't have the
  // Consensus is calculated from percentile and flow inputs.
  const rows = [];
  months.forEach(m => {
    rows.push(buildConsensusRow(m, leg, false));
  });

  bodyEl.innerHTML = rows.join('');
}

function buildConsensusRow(m, leg, isStrip) {
  const priceKey = leg === 'HL' ? 'ont_hl' : 'ont_ll';
  const nyBeKey  = leg === 'HL' ? 'ny_a_hl_be_cad' : 'ny_a_ll_be_cad';
  const pjmBeKey = leg === 'HL' ? 'pjm_wh_hl_be_cad' : 'pjm_wh_ll_be_cad';
  const gapKey   = leg === 'HL' ? 'gap_hl_avg_cad' : 'gap_ll_avg_cad';
  const hrKey    = leg === 'HL' ? 'HR_HL' : 'HR_LL';

  const consensus = (m.consensus && m.consensus[leg]) ? m.consensus[leg] : null;
  const verdict = consensus ? consensus.verdict : 'N/A';
  const factors = consensus ? consensus.factors : {};

  const price   = m[priceKey];
  const pct     = m.metrics && m.metrics[hrKey] ? m.metrics[hrKey].pct : null;
  const hrP5    = m.metrics && m.metrics[hrKey] ? m.metrics[hrKey].p5  : null;
  const hrP95   = m.metrics && m.metrics[hrKey] ? m.metrics[hrKey].p95 : null;
  const dawnCad = m.dawn_cad;
  const p5Price  = (hrP5  != null && dawnCad != null) ? hrP5  * dawnCad : null;
  const p95Price = (hrP95 != null && dawnCad != null) ? hrP95 * dawnCad : null;
  const nyBe    = m.flow ? m.flow[nyBeKey]  : null;
  const pjmBe   = m.flow ? m.flow[pjmBeKey] : null;
  const flowGap = m.flow ? m.flow[gapKey] : null;

  const fPct   = factors.percentile || 'NA';
  const fFlow  = factors.flow || 'NA';

  const factorCell = (sig, subtext) => {
    const cls = 'f-' + (sig || 'na').toLowerCase();
    const label = sig === 'BUY' ? 'BUY' : sig === 'SELL' ? 'SELL' : sig === 'NEUTRAL' ? 'NEUT' : '—';
    return `<td class="factor ${cls}"><span class="factor-inner">${label}${subtext ? ' <span class="dim" style="opacity:.65">'+subtext+'</span>' : ''}</span></td>`;
  };
  const flowSub  = $D(flowGap);

  const vCls = 'v-' + verdictClass(verdict);
  const rowCls = [isStrip ? 'strip-row' : '', verdictRowClass(verdict)].filter(Boolean).join(' ');

  return `
    <tr class="${rowCls}">
      <td class="month-cell">${m.contract_label}</td>
      <td class="num strong">${$P(price)}</td>
      <td class="num">${$Pct(pct)}</td>
      <td class="num cell-buy">${$P(p5Price)}</td>
      <td class="num cell-sell">${$P(p95Price)}</td>
      ${factorCell(fPct)}
      <td class="num">${$P(nyBe)}</td>
      <td class="num">${$P(pjmBe)}</td>
      ${factorCell(fFlow, flowSub)}
      <td class="verdict-cell"><span class="verdict-badge ${vCls}">${verdict}</span></td>
    </tr>
  `;
}

// =========================================================
// SUMMARY VIEW — commentary + top calls + transitions
// =========================================================

// Rank verdicts by strength for sorting; positive = buy-side, negative = sell-side
const VERDICT_RANK = {
  'STRONG BUY':   3,
  'BUY':          2,
  'LEAN BUY':     1,
  'MIXED':        0,
  'N/A':          0,
  'LEAN SELL':   -1,
  'SELL':        -2,
  'STRONG SELL': -3,
};

function verdictTagClass(v) {
  return 'tag-' + verdictClass(v);
}

function renderSummary(months) {
  const el = document.getElementById('summary-content');
  if (!el) return;
  if (!months.length) { el.innerHTML = '<div class="summary-empty">No forward months to summarize.</div>'; return; }

  const leg = SELECTED_LEG;

  // Extract verdicts for current + previous
  const current = months.map(m => ({
    month: m,
    label: m.contract_label,
    key: m.contract_month,
    verdict: (m.consensus && m.consensus[leg]) ? m.consensus[leg].verdict : 'N/A',
    factors: (m.consensus && m.consensus[leg]) ? m.consensus[leg].factors : {},
    price: leg === 'HL' ? m.ont_hl : m.ont_ll,
    pct:   m.metrics && m.metrics['HR_' + leg] ? m.metrics['HR_' + leg].pct : null,
    flowGap: m.flow ? (leg === 'HL' ? m.flow.gap_hl_avg_cad : m.flow.gap_ll_avg_cad) : null,
  }));

  const prevByKey = {};
  if (PREV_DATA && PREV_DATA.months) {
    PREV_DATA.months.forEach(pm => {
      if (pm.consensus && pm.consensus[leg]) {
        prevByKey[pm.contract_month] = {
          verdict: pm.consensus[leg].verdict,
          price: leg === 'HL' ? pm.ont_hl : pm.ont_ll,
        };
      }
    });
  }

  // Transitions: moves that crossed a boundary
  // Bucket: BUY-side (STRONG BUY, BUY, LEAN BUY), NEUTRAL (MIXED, N/A), SELL-side.
  const bucket = v => {
    if (v === 'STRONG BUY' || v === 'BUY' || v === 'LEAN BUY') return 'BUY';
    if (v === 'STRONG SELL' || v === 'SELL' || v === 'LEAN SELL') return 'SELL';
    return 'NEUTRAL';
  };
  const transitions = [];
  current.forEach(c => {
    const p = prevByKey[c.key];
    if (!p) return;
    const nowB  = bucket(c.verdict);
    const prevB = bucket(p.verdict);
    if (nowB === prevB && c.verdict === p.verdict) return;
    // Only surface meaningful moves: bucket change OR strength change to/from STRONG
    const isBucketChange = nowB !== prevB;
    const strengthChange =
      (c.verdict === 'STRONG BUY' && p.verdict !== 'STRONG BUY' && nowB === prevB) ||
      (c.verdict === 'STRONG SELL' && p.verdict !== 'STRONG SELL' && nowB === prevB);
    if (!isBucketChange && !strengthChange) return;
    transitions.push({ ...c, prevVerdict: p.verdict, prevPrice: p.price });
  });

  // Sort transitions: STRONG moves first, then bucket-crossers, sorted by |verdict rank|
  transitions.sort((a, b) => {
    const scoreA = Math.abs(VERDICT_RANK[a.verdict] || 0);
    const scoreB = Math.abs(VERDICT_RANK[b.verdict] || 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    // then by month
    return a.key.localeCompare(b.key);
  });

  // Top calls (aligned): STRONG BUY and STRONG SELL months (individual months only, no strips)
  const strongBuys  = current.filter(c => c.verdict === 'STRONG BUY');
  const strongSells = current.filter(c => c.verdict === 'STRONG SELL');
  const buys = current.filter(c => c.verdict === 'LEAN BUY');
  const sells = current.filter(c => c.verdict === 'LEAN SELL');

  // Hero commentary — high-level summary sentence
  const asOfNice = niceAsOf(DATA.as_of);
  const prevAsOfNice = PREV_DATA?.as_of ? niceAsOf(PREV_DATA.as_of) : null;
  const commentary = buildHeroCommentary({
    strongBuys, strongSells, buys, sells, transitions,
    leg, current,
  });

  // Assemble HTML
  const hero = `
    <div class="summary-hero">
      <div class="summary-hero-head">
        <div>
          <div class="summary-hero-title">Ontario ${leg === 'HL' ? 'On-Peak' : 'Off-Peak'} — What to Focus On</div>
          <div class="summary-hero-sub">Consensus of percentile · export flow spread</div>
        </div>
        <div class="summary-hero-asof">As of ${asOfNice}${prevAsOfNice ? ' · vs ' + prevAsOfNice : ''}</div>
      </div>
      <div class="summary-hero-body">${commentary}</div>
    </div>
  `;

  const strongBuysCard = renderTopCallCard('Strong Buy — Both Factors Align', strongBuys, 'strong-buy', 'pri-buy',
    'Percentile and flow both point to buy.');
  const strongSellsCard = renderTopCallCard('Strong Sell — Both Factors Align', strongSells, 'strong-sell', 'pri-sell',
    'Percentile and flow both point to sell.');
  const buysCard = renderTopCallCard('Lean Buy — One Factor Directional', buys, 'buy', '',
    'One factor points to buy and the other is neutral.');
  const sellsCard = renderTopCallCard('Lean Sell — One Factor Directional', sells, 'sell', '',
    'One factor points to sell and the other is neutral.');

  const changesCard = renderChangesCard(transitions, prevAsOfNice);

  el.innerHTML = `
    ${hero}
    ${changesCard}
    <div class="summary-grid">
      ${strongBuysCard}
      ${strongSellsCard}
      ${buysCard}
      ${sellsCard}
    </div>
  `;
}

function niceAsOf(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildHeroCommentary({ strongBuys, strongSells, buys, sells, transitions, leg, current }) {
  const parts = [];
  if (strongBuys.length || strongSells.length) {
    const sb = strongBuys.map(x => `<b>${x.label}</b>`).join(', ');
    const ss = strongSells.map(x => `<b>${x.label}</b>`).join(', ');
    if (strongBuys.length && strongSells.length) {
      parts.push(`Both factors line up on <b>${strongBuys.length}</b> buy${strongBuys.length>1?'s':''} (${sb}) and <b>${strongSells.length}</b> sell${strongSells.length>1?'s':''} (${ss}). These are your highest-conviction trades right now.`);
    } else if (strongBuys.length) {
      parts.push(`Both factors line up on <b>${strongBuys.length}</b> buy${strongBuys.length>1?'s':''}: ${sb}. Highest-conviction spots to add length.`);
    } else {
      parts.push(`Both factors line up on <b>${strongSells.length}</b> sell${strongSells.length>1?'s':''}: ${ss}. Highest-conviction spots to sell into strength.`);
    }
  } else if (buys.length || sells.length) {
    parts.push(`No months have full two-factor alignment. Best directional setups are the one-factor lean signals (${buys.length} buy · ${sells.length} sell) below.`);
  } else {
    parts.push(`No strong directional setups this run — most of the strip is mixed. Waiting for percentile and flow signals to become more directional.`);
  }

  // Transition commentary
  if (transitions.length) {
    const toBuy  = transitions.filter(t => VERDICT_RANK[t.verdict] > VERDICT_RANK[t.prevVerdict]);
    const toSell = transitions.filter(t => VERDICT_RANK[t.verdict] < VERDICT_RANK[t.prevVerdict]);
    const bits = [];
    if (toBuy.length)  bits.push(`<b>${toBuy.length}</b> month${toBuy.length>1?'s':''} strengthened toward buy`);
    if (toSell.length) bits.push(`<b>${toSell.length}</b> month${toSell.length>1?'s':''} weakened toward sell`);
    if (bits.length) parts.push(`Since last snapshot: ${bits.join(' and ')}. See "Recent Moves" below.`);
  } else if (PREV_DATA) {
    parts.push(`No verdict changes vs the last snapshot.`);
  }

  return parts.join(' ');
}

function renderTopCallCard(title, items, tagKind, pri, sub) {
  const cardClass = pri ? `summary-card ${pri}` : 'summary-card';
  const list = items.length ? `
    <ul>
      ${items.map(x => {
        const gap = x.flowGap != null ? ` · flow ${$D(x.flowGap)}` : '';
        const pct = x.pct != null ? Math.round(x.pct*100) + '%' : '—';
        return `
          <li>
            <span class="li-month">${x.label}</span>
            <span class="li-note">Mkt <b>${$P(x.price)}</b> · HR ${pct}${gap}</span>
            <span class="li-tag tag-${tagKind}">${title.startsWith('Strong Buy')?'STRONG BUY':title.startsWith('Strong Sell')?'STRONG SELL':title.startsWith('Lean Buy')?'LEAN BUY':'LEAN SELL'}</span>
          </li>
        `;
      }).join('')}
    </ul>
  ` : `<div class="summary-empty">— none —</div>`;
  return `
    <div class="${cardClass}">
      <div class="summary-card-head">
        <div class="summary-card-title">${title}</div>
        <div class="summary-card-count">${items.length}</div>
      </div>
      <div class="summary-card-sub">${sub}</div>
      ${list}
    </div>
  `;
}

function renderChangesCard(transitions, prevAsOf) {
  if (!PREV_DATA) {
    return `
      <div class="summary-card">
        <div class="summary-card-head">
          <div class="summary-card-title">Recent Moves</div>
          <div class="summary-card-count">—</div>
        </div>
        <div class="summary-card-sub">No prior snapshot available to compare against yet.</div>
      </div>
    `;
  }
  const rows = transitions.length ? `
    <div class="summary-changes-list">
      ${transitions.map(t => {
        const nowRank  = VERDICT_RANK[t.verdict] || 0;
        const prevRank = VERDICT_RANK[t.prevVerdict] || 0;
        const dir = nowRank > prevRank ? 'up' : 'down';
        const arrow = nowRank > prevRank ? '↑' : '↓';
        const priceDelta = (t.price != null && t.prevPrice != null) ? (t.price - t.prevPrice) : null;
        const priceNote = priceDelta != null ? `mkt ${$D(priceDelta)}` : '';
        return `
          <div class="summary-change-row">
            <span class="li-month">${t.label}</span>
            <span class="li-note">
              <span class="li-tag ${verdictTagClass(t.prevVerdict)}" style="font-size:10px">${t.prevVerdict}</span>
              <span class="arrow ${dir}">${arrow}</span>
              <span class="verdict-badge v-${verdictClass(t.verdict)}">${t.verdict}</span>
              ${priceNote ? '· <b>'+priceNote+'</b>' : ''}
            </span>
          </div>
        `;
      }).join('')}
    </div>
  ` : `<div class="summary-empty">No verdict changes vs the ${prevAsOf} snapshot.</div>`;
  return `
    <div class="summary-card">
      <div class="summary-card-head">
        <div class="summary-card-title">Recent Moves — since ${prevAsOf || 'last snapshot'}</div>
        <div class="summary-card-count">${transitions.length}</div>
      </div>
      <div class="summary-card-sub">Months whose verdict bucket changed (buy/neutral/sell) or moved into/out of a STRONG signal.</div>
      ${rows}
    </div>
  `;
}
