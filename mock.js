// ข้อมูลสมมติสำหรับทดสอบหน้าเว็บโดยไม่ต้องต่ออินเทอร์เน็ต (MOCK=1)
// ตัวเลขทั้งหมดเป็นของปลอม ไม่ใช่ราคาจริง
export { OZ_TO_GRAM, BAHT_GOLD_GRAM, THAI_GOLD_PURITY, LITRE_PER_BARREL } from './sources.js';
import { bkkDate } from './lib/history.js';

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function walk(start, days, vol, drift = 0) {
  const out = [];
  let v = start;
  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    v *= 1 + drift + (rand() - 0.5) * vol;
    out.push({ date: d.toISOString().slice(0, 10), value: +v.toFixed(4) });
  }
  return out;
}
const at = (series, date) => [...series].reverse().find((p) => p.date <= date)?.value ?? series[0].value;

const fxHist = walk(34.5, 400, 0.008, -0.0001);
const usdthb = fxHist.at(-1).value;

const Y = {
  'BZ=F': [walk(78, 370, 0.03, -0.0004), 'USD'],
  'CL=F': [walk(74, 370, 0.03, -0.0004), 'USD'],
  'RB=F': [walk(2.2, 370, 0.03, -0.0002), 'USD'],
  'HO=F': [walk(2.5, 370, 0.03, -0.0002), 'USD'],
  '^SET.BK': [walk(1400, 370, 0.015, -0.0002), 'THB'],
  '^GSPC': [walk(5800, 370, 0.012, 0.0006), 'USD'],
  URTH: [walk(155, 370, 0.012, 0.0004), 'USD'],
  'THB=X': [fxHist.map((p) => ({ ...p })), 'THB'],
  'ES=F': [walk(5850, 370, 0.012, 0.0006), 'USD'],
  'GC=F': [walk(3300, 370, 0.018, 0.0008), 'USD'],
  'NQ=F': [walk(20500, 370, 0.015, 0.0007), 'USD'],
  '^N225': [walk(38000, 370, 0.013, 0.0004), 'JPY'],
  '^HSI': [walk(20000, 370, 0.015, 0.0002), 'HKD'],
  '^VIX': [walk(16, 370, 0.06, 0), 'USD'],
  'DX-Y.NYB': [walk(104, 370, 0.004, -0.0001), 'USD'],
  '^TNX': [walk(4.3, 370, 0.02, 0), 'USD'],
};
// ทำให้ช่วง 3 วันล่าสุดราคาเบนซินโลกขึ้นแรง เพื่อให้เห็นสัญญาณ
Y['RB=F'][0].slice(-3).forEach((p, i) => (p.value *= 1 + 0.025 * (i + 1)));

// ---- ประวัติราคาน้ำมันไทยสมมติ: ปรับตามราคาโลกของวันก่อนหน้า เมื่อส่วนต่างสะสมเกิน 0.40 บาท ----
const thaiStart = { 'แก๊สโซฮอล์ 95': [34.65, 'RB=F'], 'ดีเซล': [32.94, 'HO=F'] };
const oilHist = [];
{
  const cur = Object.fromEntries(Object.entries(thaiStart).map(([k, [v]]) => [k, v]));
  const anchor = {};
  for (let i = 90; i >= 1; i--) {
    const date = bkkDate(Date.now(), -i), prev = bkkDate(Date.now(), -i - 1);
    for (const [name, [, sym]] of Object.entries(thaiStart)) {
      const w = (at(Y[sym][0], prev) * at(fxHist, prev)) / 3.785;
      anchor[name] ??= w;
      const gap = (w - anchor[name]) * 1.07;
      if (i > 3 && Math.abs(gap) >= 0.4) { cur[name] = +(cur[name] + Math.round(gap * 10) / 10).toFixed(2); anchor[name] = w; }
    }
    oilHist.push({ date, prices: { ...cur } });
  }
}
const lastOil = oilHist.at(-1).prices;

// ---- ราคาทองสมมติทุก 10 นาที 2 วัน: สมาคมฯ ปรับครั้งละ 50 บาทเมื่อราคาโลกห่างเกิน 150 บาท ----
const goldHist = [];
let worldNow;
{
  let w = 62000, thai = 62100;
  for (let t = Date.now() - 48 * 3600e3; t <= Date.now(); t += 10 * 60e3) {
    w += (rand() - 0.48) * 60;
    const last40min = Date.now() - t < 40 * 60e3;
    if (!last40min && Math.abs(w + 100 - thai) > 150) thai = Math.round((w + 100) / 50) * 50;
    if (last40min) w += 70;
    goldHist.push({ t, thaiSell: thai, worldThb: +w.toFixed(2) });
  }
  worldNow = w;
}
const thaiGoldNow = goldHist.at(-1).thaiSell;
const xau = (worldNow * 31.1034768) / (usdthb * 15.244 * 0.965);

export function seedHistory() {
  return { oil: oilHist.map((r) => ({ ...r, prices: { ...r.prices } })), gold: goldHist.slice(0, -1) };
}

export async function fetchFx() {
  return {
    date: fxHist.at(-1).date,
    rates: { USD: usdthb, EUR: usdthb * 1.16, GBP: usdthb * 1.33, CNY: usdthb / 7.1, JPY100: usdthb / 1.5 },
    usdthbHistory: fxHist, source: 'MOCK',
  };
}
export async function fetchWorldGold() {
  return { usdPerOz: xau, updatedAt: new Date().toISOString(), source: 'MOCK' };
}
export async function fetchThaiGold() {
  // ประกาศล่าสุดอิงราคาโลกเมื่อ 40 นาทีก่อน (ตอนนั้นราคาโลกต่ำกว่าตอนนี้)
  const lastChangeIdx = goldHist.findLastIndex((g, i) => i > 0 && g.thaiSell !== goldHist[i - 1].thaiSell);
  const refRow = goldHist[Math.min(goldHist.length - 5, Math.max(0, lastChangeIdx))];
  const factor = (15.244 * 0.965) / 31.1034768;
  const startToday = Date.now() - 30 * 3600e3;
  const today = goldHist.filter((g, i) => g.t >= startToday && (i === 0 || g.thaiSell !== goldHist[i - 1].thaiSell))
    .map((g) => ({ t: g.t, sell: g.thaiSell, spot: g.worldThb / (usdthb * factor), fx: usdthb }));
  return {
    barBuy: thaiGoldNow - 200, barSell: thaiGoldNow, ornamentBuy: Math.round((thaiGoldNow - 200) * 0.98), ornamentSell: thaiGoldNow + 800,
    asOf: 'MOCK', asOfTime: refRow.t, refSpot: (refRow.worldThb - 100) / (usdthb * factor), refFx: usdthb, changeToday: -900,
    today, source: 'MOCK',
  };
}
export async function fetchThaiOil() {
  const others = [['แก๊สโซฮอล์ 91', -0.37], ['แก๊สโซฮอล์ E20', -2.21], ['แก๊สโซฮอล์ E85', -3.86], ['เบนซิน', 8.29]]
    .map(([name, d]) => ({ name, yesterday: lastOil['แก๊สโซฮอล์ 95'] + d, today: lastOil['แก๊สโซฮอล์ 95'] + d, tomorrow: lastOil['แก๊สโซฮอล์ 95'] + d }));
  return {
    date: bkkDate(),
    items: [
      { name: 'ดีเซล', yesterday: lastOil['ดีเซล'], today: lastOil['ดีเซล'], tomorrow: lastOil['ดีเซล'] },
      { name: 'แก๊สโซฮอล์ 95', yesterday: lastOil['แก๊สโซฮอล์ 95'], today: lastOil['แก๊สโซฮอล์ 95'], tomorrow: lastOil['แก๊สโซฮอล์ 95'] },
      ...others,
    ],
    source: 'MOCK',
  };
}
export async function fetchYahoo(symbol) {
  const [history, currency] = Y[symbol];
  return { symbol, currency, price: history.at(-1).value, prevClose: history.at(-2).value, history };
}
export async function fetchInflation() {
  const th = [3.3, 3.8, 3.0, 2.2, 1.9, -0.9, 0.2, 0.7, 1.1, 0.7, -0.8, 1.2, 6.1, 1.2, 0.4, 0.2];
  const w = [3.3, 4.8, 3.7, 2.6, 2.3, 1.4, 1.6, 2.2, 2.4, 2.2, 1.9, 3.5, 8.0, 5.7, 4.2, 3.6];
  const mk = (a) => a.map((v, i) => ({ date: String(2010 + i), value: v }));
  return { thailand: mk(th), world: mk(w), source: 'MOCK' };
}

// ---- โครงสร้างราคา สนพ. สมมติ: ค่าการตลาดแกว่งเพราะราคาไทยปรับช้ากว่าราคาโลก ----
const eppoSym = { g95: ['แก๊สโซฮอล์ 95', 'RB=F', 7.475, 3.37], diesel: ['ดีเซล', 'HO=F', 7.662, -2.37] };
let lpgMock = 25.87;
const eppoFund = {};
export async function fetchEppo(date) {
  if (date > bkkDate() || date < bkkDate(Date.now(), -95)) throw Object.assign(new Error('ไม่พบไฟล์ (MOCK)'), { notFound: true });
  const products = {};
  for (const [k, [name, sym, tax, fund]] of Object.entries(eppoSym)) {
    const prev = new Date(new Date(date).getTime() - 864e5).toISOString().slice(0, 10);
    const exr = (at(Y[sym][0], prev) * at(fxHist, prev)) / 3.785;
    const retail = [...oilHist].reverse().find((r) => r.date <= date)?.prices[name] ?? thaiStart[name][0];
    eppoFund[k] ??= fund; // กองทุนสมมติ (ค่าการตลาดจะแกว่งแทน)
    const mm = retail / 1.07 - exr - tax - eppoFund[k];
    products[k] = { name: k, exr, discount: 0, excise: tax / 1.1, fund: eppoFund[k], ws: exr + tax + eppoFund[k], mm, retail };
  }
  products.lpg = { name: 'LPG', exr: 33.07, discount: 0, excise: 2.17, fund: -14.54, ws: 22.38, mm: 3.26, retail: date < bkkDate(Date.now(), -40) ? 25.87 - 0.5 : 25.87 };
  return { date, fx: at(fxHist, date), products, avgMM: { all: 2.45, diesel: 2.0 }, source: 'MOCK' };
}
export async function fetchNews(q) {
  const t = q.includes('น้ำมัน') ? ['ผู้ค้าประกาศลดราคาเบนซินพรุ่งนี้ 40 สตางค์ (ตัวอย่าง)', 'กบน. คงอัตราเงินกองทุนดีเซล (ตัวอย่าง)']
    : q.includes('ทอง') ? ['ทองเปิดตลาดบวก 100 บาท (ตัวอย่าง)'] : q.includes('SET') ? ['SET ปิดลบตามตลาดภูมิภาค (ตัวอย่าง)'] : ['บาทอ่อนค่าตามดอลลาร์ (ตัวอย่าง)'];
  return t.map((title, i) => ({ title, link: 'https://example.com/', source: 'ข่าวตัวอย่าง', time: Date.now() - (i + 1) * 3600e3 }));
}
export async function fetchEppoIndex() {
  const m = {};
  for (let i = 0; i <= 95; i++) { const d = bkkDate(Date.now(), -i); const wd = new Date(d).getUTCDay(); if (wd !== 0 && wd !== 6) m[d] = `mock://${d}`; }
  return m;
}
export { UNEMP_COUNTRIES } from './sources.js';
export async function fetchUnemploymentAnnual() {
  const mk = (a) => a.map((v, i) => ({ date: String(2010 + i), value: v }));
  return { series: {
    THA: mk([0.6, 0.7, 0.6, 0.3, 0.6, 0.6, 0.7, 0.8, 0.8, 0.7, 1.1, 1.2, 0.9, 0.7, 0.8, 0.8]),
    WLD: mk([6.0, 5.9, 5.9, 5.9, 5.8, 5.8, 5.8, 5.6, 5.4, 5.4, 6.6, 6.2, 5.2, 4.9, 4.8, 4.8]),
    USA: mk([9.6, 8.9, 8.1, 7.4, 6.2, 5.3, 4.9, 4.4, 3.9, 3.7, 8.1, 5.4, 3.6, 3.6, 4.0, 4.2]),
    MYS: mk([3.3, 3.1, 3.0, 3.1, 2.9, 3.1, 3.4, 3.4, 3.3, 3.3, 4.5, 4.7, 3.9, 3.9, 3.9, 3.8]),
  }, source: 'MOCK' };
}
export async function fetchUnemploymentQuarterly() {
  const q = (vals, start = 2022) => vals.map((v, i) => ({ date: `${start + Math.floor(i / 4)}Q${(i % 4) + 1}`, value: v }));
  return { series: {
    THA: q([1.5, 1.4, 1.2, 1.2, 1.0, 1.0, 1.0, 0.8, 0.8, 0.8, 0.8, 0.7, 0.7, 0.7, 0.5, 0.5, 0.7]),
    MYS: q([4.1, 3.9, 3.7, 3.6, 3.5, 3.4, 3.4, 3.3, 3.3, 3.3, 3.2, 3.1, 3.1, 3.0, 3.0, 3.0, 3.0]),
    USA: q([4.0, 3.6, 3.6, 3.4, 3.8, 3.5, 3.8, 3.6, 4.1, 4.1, 4.2, 4.0, 4.4, 4.1, 4.3, 4.3, 4.6]),
  }, source: 'MOCK' };
}
export { OCCUPATIONS, INDUSTRIES, SKILLS } from './sources.js';
export async function fetchJobsByGroup() {
  const qs = []; for (let y = 2023; y <= 2026; y++) for (let q = 1; q <= 4; q++) if (!(y === 2026 && q > 1)) qs.push(`${y}Q${q}`);
  const mk = (base, drift) => qs.map((date, i) => ({ date, value: +(base * (1 + drift * i + (rand() - 0.5) * 0.02)).toFixed(1) }));
  const occ = { 1: mk(1300, 0.004), 2: mk(2300, 0.006), 3: mk(1800, 0.002), 4: mk(1850, -0.004), 5: mk(9200, 0.003), 6: mk(9600, -0.006), 7: mk(4400, -0.002), 8: mk(4600, -0.003), 9: mk(5600, 0.001) };
  const ind = { A: mk(11000, -0.005), C: mk(6450, -0.003), F: mk(2350, -0.004), G: mk(6900, 0.002), I: mk(3100, 0.008), K: mk(520, 0.003), O: mk(1840, 0), P: mk(1150, 0.001), Q: mk(870, 0.006) };
  const total = (o) => qs.map((date, i) => ({ date, value: Object.values(o).reduce((a, s) => a + s[i].value, 0) }));
  const skill = { 'L3-4': mk(5400, 0.003), L2: mk(29500, 0.002), L1: mk(5600, 0.001) };
  return { occupation: { ...occ, TOTAL: total(occ) }, industry: { ...ind, TOTAL: total(ind) }, skill: { ...skill, TOTAL: total(skill) }, source: 'MOCK' };
}

export async function fetchStockDaily(symbol) {
  let h = 0; for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 9973;
  const drift = ((h % 21) - 10) / 4000, volBase = 2e6 + (h % 50) * 1e5, flowTilt = ((h % 7) - 3) / 3;
  const hist = walk(20 + (h % 200), 185, 0.03, drift).map((p, i, a) => ({ ...p, volume: Math.round(volBase * (1 + (i > a.length - 20 ? flowTilt * 0.5 : 0)) * (0.7 + rand() * 0.6)) }));
  return { symbol, price: hist.at(-1).value, currency: 'THB', history: hist };
}
export { IMF_INDICATORS } from './sources.js';
export async function fetchImfOutlook() {
  const yrs = (o) => Object.fromEntries(Object.entries(o).map(([y, v]) => [y, v]));
  return { data: {
    NGDP_RPCH: { THA: yrs({ 2023: 2.0, 2024: 2.5, 2025: 2.4, 2026: 1.5, 2027: 2.1, 2028: 2.3 }), WLD: yrs({ 2023: 3.3, 2024: 3.3, 2025: 3.2, 2026: 3.0, 2027: 3.1, 2028: 3.2 }) },
    PCPIPCH: { THA: yrs({ 2023: 1.2, 2024: 0.4, 2025: 0.2, 2026: 0.6, 2027: 1.0, 2028: 1.5 }), WLD: yrs({ 2023: 6.7, 2024: 5.7, 2025: 4.2, 2026: 3.6, 2027: 3.3, 2028: 3.2 }) },
    LUR: { THA: yrs({ 2023: 1.0, 2024: 1.0, 2025: 0.9, 2026: 1.0, 2027: 1.0, 2028: 1.0 }), WLD: {} },
  }, source: 'MOCK' };
}

export { PEERS, PEER_INDICATORS } from './sources.js';
export async function fetchPeersOutlook() {
  const g = { THA: [2.0, 2.5, 2.4, 1.6, 2.0, 2.4], VNM: [5.1, 7.1, 7.0, 6.2, 6.5, 6.6], MYS: [3.6, 5.1, 4.5, 4.1, 4.0, 4.0], IDN: [5.0, 5.0, 4.9, 4.8, 4.9, 5.0],
    PHL: [5.5, 5.7, 5.6, 5.4, 5.8, 6.0], SGP: [1.8, 4.4, 2.2, 1.8, 2.0, 2.3], KHM: [5.0, 6.0, 5.2, 4.5, 4.8, 5.5], LAO: [3.7, 4.3, 4.0, 3.5, 3.5, 3.6], MMR: [1.0, -1.1, -2.0, 1.5, 2.0, 2.5], WEOWORLD: [3.3, 3.3, 3.2, 3.0, 3.1, 3.2] };
  const gdp = { THA: 526, VNM: 476, MYS: 422, IDN: 1396, PHL: 462, SGP: 547, KHM: 46, LAO: 16, MMR: 66 };
  const pc = { THA: 7500, VNM: 4700, MYS: 12500, IDN: 4900, PHL: 4000, SGP: 90000, KHM: 2700, LAO: 2100, MMR: 1200 };
  const ca = { THA: [1.4, 2.1, 3.0, 2.2, 2.0, 2.0], VNM: [5.8, 6.1, 4.0, 3.0, 2.5, 2.0], MYS: [1.5, 1.5, 2.0, 2.2, 2.3, 2.4], IDN: [-0.1, -0.6, -0.8, -1.0, -1.1, -1.2],
    PHL: [-2.6, -3.8, -3.5, -3.2, -3.0, -2.8], SGP: [18, 17.5, 17, 16.5, 16, 15.5], KHM: [-1.6, -1.0, -2.5, -4.0, -4.5, -4.8], LAO: [-1, 0.5, 1, 0, -0.5, -1], MMR: [-2, -1.5, -1.8, -2, -2, -2] };
  const yrs = [2023, 2024, 2025, 2026, 2027, 2028], obj = (a) => Object.fromEntries(yrs.map((y, i) => [y, a[i]]));
  const out = { NGDP_RPCH: {}, NGDPD: {}, NGDPDPC: {}, BCA: {}, BCA_NGDPD: {} };
  for (const c of Object.keys(g)) {
    out.NGDP_RPCH[c] = obj(g[c]);
    if (!gdp[c]) continue;
    out.NGDPD[c] = obj(yrs.map((_, i) => gdp[c] * (1 + 0.04 * (i - 2))));
    out.NGDPDPC[c] = obj(yrs.map((_, i) => pc[c] * (1 + 0.035 * (i - 2))));
    out.BCA_NGDPD[c] = obj(ca[c]);
    out.BCA[c] = obj(ca[c].map((v, i) => v * gdp[c] / 100 * (1 + 0.04 * (i - 2))));
  }
  return { data: out, source: 'MOCK' };
}
export async function fetchTradeMonthly() {
  const base = { THA: [24000, 23500], VNM: [33000, 31000], MYS: [26000, 23000], IDN: [22000, 19000], PHL: [6500, 10500], SGP: [55000, 49000], KHM: [2200, 2500] };
  const out = {};
  for (const [c, [bx, bm]] of Object.entries(base)) {
    const x = [], m = [];
    for (let k = 0; k < 31; k++) {
      const y = 2024 + Math.floor(k / 12), mo = (k % 12) + 1, date = `${y}-${String(mo).padStart(2, '0')}`;
      const season = 1 + 0.06 * Math.sin((mo / 12) * 2 * Math.PI), trend = 1 + 0.008 * k;
      x.push({ date, value: bx * season * trend * (0.95 + rand() * 0.1) });
      m.push({ date, value: bm * season * (1 + 0.006 * k) * (0.95 + rand() * 0.1) });
    }
    out[c] = { x, m, b: x.map((p, i) => ({ date: p.date, value: p.value - m[i].value })) };
  }
  return { data: out, source: 'MOCK' };
}

export async function fetchFt() {
  const p = [['มกราคม – เมษายน 2568', '2025-01', '2025-04', 36.72], ['พฤษภาคม – สิงหาคม 2568', '2025-05', '2025-08', 19.72], ['กันยายน – ธันวาคม 2568', '2025-09', '2025-12', 15.72],
    ['มกราคม – เมษายน 2569', '2026-01', '2026-04', 9.72], ['พฤษภาคม – สิงหาคม 2569', '2026-05', '2026-08', 16.23], ['กันยายน – ธันวาคม 2569', '2026-09', '2026-12', 16.23]];
  return { periods: p.map(([label, from, to, ft]) => ({ label, from, to, ft })), source: 'MOCK' };
}
export { BOND_TENORS, TENOR_YEARS } from './sources.js';
export async function fetchThaiYields() {
  const ten = { '1M': 0.86, '3M': 0.88, '6M': 0.9, '1Y': 0.94, '2Y': 1.17, '3Y': 1.31, '5Y': 1.56, '7Y': 1.77, '10Y': 1.99, '15Y': 2.43, '20Y': 2.9, '30Y': 3.15 };
  const rows = [];
  let shift = 0.35;
  for (let i = 400; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    shift += (rand() - 0.505) * 0.03;
    const row = { date: d.toISOString().slice(0, 10) };
    for (const [t, v] of Object.entries(ten)) row[t] = +(v + shift * (t.endsWith('M') ? 1.2 : 1)).toFixed(4);
    rows.push(row);
  }
  return { rows, source: 'MOCK' };
}
