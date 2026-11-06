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
  return { barBuy: thaiGoldNow - 100, barSell: thaiGoldNow, ornamentBuy: Math.round((thaiGoldNow - 100) * 0.98), ornamentSell: thaiGoldNow + 500, asOf: 'MOCK', source: 'MOCK' };
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
