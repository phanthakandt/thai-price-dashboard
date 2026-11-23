// วิเคราะห์หุ้นรายตัว: ตัวชี้วัดทางเทคนิค + พื้นฐาน → คะแนนระยะสั้น/ระยะยาว สัญญาณเตือน
// กรอบการลงต่อ เวลาฟื้นตัวจากสถิติในอดีต และ backtest ของคะแนนระยะสั้น
// ทุกอย่างเป็นกฎที่อธิบายได้ ไม่ใช่คำแนะนำการลงทุน

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const quant = (arr, q) => {
  const a = arr.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const p = (a.length - 1) * q, b = Math.floor(p);
  return a[b] + (a[Math.min(b + 1, a.length - 1)] - a[b]) * (p - b);
};
export const median = (a) => quant(a, 0.5);

// ---------- ตัวชี้วัด ณ ตำแหน่ง i (ใช้ซ้ำได้ใน backtest) ----------
function smaAt(c, n, i) { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k]; return s / n; }
function rsiAt(c, i, n = 14) {
  const st = Math.max(1, i - 120); if (i - st < n + 1) return null;
  let g = 0, l = 0;
  for (let k = st; k < st + n; k++) { const d = c[k] - c[k - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let k = st + n; k <= i; k++) { const d = c[k] - c[k - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function macdHistAt(c, i) {
  const st = Math.max(0, i - 200); if (i - st < 60) return null;
  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
  let e12 = c[st], e26 = c[st], sig = 0, first = true;
  for (let k = st + 1; k <= i; k++) {
    e12 = c[k] * k12 + e12 * (1 - k12); e26 = c[k] * k26 + e26 * (1 - k26);
    const m = e12 - e26; if (first) { sig = m; first = false; } else sig = m * k9 + sig * (1 - k9);
  }
  return (e12 - e26 - sig) / c[i];
}
function volAt(c, i, n = 60) {
  if (i < n) return null;
  const r = []; for (let k = i - n + 1; k <= i; k++) r.push(Math.log(c[k] / c[k - 1]));
  const m = avg(r); return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252);
}
const retAt = (c, i, k) => (i >= k ? c[i] / c[i - k] - 1 : null);

// ดัชนีอ้างอิง (SET หรือ S&P 500) ตามวันที่
export function benchLookup(b) {
  if (!b?.d?.length) return () => null;
  return (date) => { let lo = 0, hi = b.d.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b.d[m] <= date) { a = m; lo = m + 1; } else hi = m - 1; } return a < 0 ? null : b.c[a]; };
}

export function techAt(H, i, bench) {
  const c = H.c;
  if (i < 200) return null;
  const sma50 = smaAt(c, 50, i), sma200 = smaAt(c, 200, i), sma20 = smaAt(c, 20, i), sma50p = smaAt(c, 50, i - 10), sma20p = smaAt(c, 20, i - 5);
  const lo = Math.max(0, i - 251);
  let hi52 = -Infinity, lo52 = Infinity;
  for (let k = lo; k <= i; k++) { if (H.h[k] > hi52) hi52 = H.h[k]; if (H.l[k] < lo52) lo52 = H.l[k]; }
  const v20 = avg(H.v.slice(Math.max(0, i - 19), i + 1)), v60 = avg(H.v.slice(Math.max(0, i - 59), i + 1));
  const ret3m = retAt(c, i, 63);
  let rel3m = null;
  if (bench && ret3m != null) { const b0 = bench(H.d[i - 63]), b1 = bench(H.d[i]); if (b0 && b1) rel3m = ret3m - (b1 / b0 - 1); }
  return {
    price: c[i], sma20, sma50, sma200, sma50Slope: sma50p ? sma50 / sma50p - 1 : null, sma20Slope: sma20p ? sma20 / sma20p - 1 : null,
    rsi: rsiAt(c, i), macd: macdHistAt(c, i), vol: volAt(c, i),
    ret1w: retAt(c, i, 5), ret1m: retAt(c, i, 21), ret3m, ret6m: retAt(c, i, 126), ret1y: retAt(c, i, 252),
    hi52, lo52, dd: c[i] / hi52 - 1, fromLow: c[i] / lo52 - 1,
    volRatio: v60 ? v20 / v60 : null, rel3m, liquidity: v20 * c[i],
  };
}

// ---------- คะแนนระยะสั้น (1–3 เดือน): แนวโน้ม โมเมนตัม ความแข็งแกร่งเทียบตลาด ปริมาณซื้อขาย ----------
export function shortScore(t) {
  if (!t) return null;
  const parts = {};
  parts.trend = (t.price > t.sma50 ? 20 : 0) + (t.sma50Slope > 0 ? 10 : 0) + (t.sma200 && t.price > t.sma200 ? 10 : 0);
  const r = t.rsi;
  const rsiPts = r == null ? 7 : r >= 50 && r < 70 ? 15 : r >= 70 && r < 80 ? 6 : r >= 80 ? 0 : r >= 40 ? 8 : r >= 30 ? 3 : 6;
  parts.momentum = rsiPts + (t.macd > 0 ? 5 : 0) + (t.ret1m > 0 ? 5 : 0);
  parts.relative = t.rel3m == null ? 10 : clamp((t.rel3m + 0.15) / 0.3, 0, 1) * 20;
  parts.volume = t.volRatio == null ? 8 : t.volRatio > 1.15 ? (t.ret1m > 0 ? 15 : 3) : 8;
  const score = Math.round(parts.trend + parts.momentum + parts.relative + parts.volume);
  return { score, parts };
}

// ---------- คะแนนระยะยาว (1 ปีขึ้นไป): มูลค่า คุณภาพ การเติบโต ปันผล ----------
const FIN_SECTORS = ['Financial Services', 'Real Estate'];
export function longScore(p, fin, peer) {
  if (!p) return null;
  const parts = {}, w = {};
  const isFin = FIN_SECTORS.includes(p.sector);
  // มูลค่า: P/E เทียบค่ากลางของกลุ่มเดียวกัน และ P/B
  if (p.pe != null && p.pe > 0) {
    const ratio = peer?.pe ? p.pe / peer.pe : null;
    let v = ratio == null ? (p.pe < 12 ? 22 : p.pe < 20 ? 15 : p.pe < 35 ? 8 : 3) : ratio < 0.7 ? 24 : ratio < 0.9 ? 19 : ratio < 1.1 ? 14 : ratio < 1.4 ? 8 : 3;
    if (p.fpe && p.fpe > 0 && p.fpe < p.pe * 0.9) v += 3; // คาดกำไรโต
    if (p.pb != null && p.pb > 0) v += p.pb < 1 ? 3 : p.pb < 3 ? 2 : 0;
    parts.value = Math.min(30, v); w.value = 30;
  } else if (p.pe == null && (p.margin ?? 0) < 0) { parts.value = 0; w.value = 30; }
  // คุณภาพ: ROE อัตรากำไร หนี้
  {
    let v = 0, ww = 0;
    if (p.roe != null) { v += p.roe >= 0.15 ? 14 : p.roe >= 0.1 ? 10 : p.roe >= 0.05 ? 5 : p.roe > 0 ? 2 : 0; ww += 14; }
    if (p.margin != null) { v += p.margin >= 0.15 ? 8 : p.margin >= 0.07 ? 6 : p.margin >= 0.02 ? 3 : 0; ww += 8; }
    if (!isFin && p.de != null) { v += p.de < 50 ? 8 : p.de < 100 ? 5 : p.de < 200 ? 2 : 0; ww += 8; }
    if (ww) { parts.quality = (v / ww) * 30; w.quality = 30; }
  }
  // การเติบโต: ล่าสุด และแนวโน้มหลายปี
  {
    let v = 0, ww = 0;
    if (p.revGrowth != null) { v += p.revGrowth > 0.1 ? 7 : p.revGrowth > 0.03 ? 5 : p.revGrowth > 0 ? 2 : 0; ww += 7; }
    if (p.epsGrowth != null) { v += p.epsGrowth > 0.1 ? 7 : p.epsGrowth > 0 ? 4 : 0; ww += 7; }
    const tr = trendOf(fin?.annualNetIncome), rv = trendOf(fin?.annualTotalRevenue);
    if (tr) { v += tr.ups >= tr.n - 1 && tr.last > 0 ? 6 : tr.cagr > 0 && tr.last > 0 ? 4 : tr.last > 0 ? 2 : 0; ww += 6; }
    if (rv) { v += rv.cagr > 0.08 ? 5 : rv.cagr > 0.02 ? 3 : rv.cagr > 0 ? 1 : 0; ww += 5; }
    if (ww) { parts.growth = (v / ww) * 25; w.growth = 25; }
  }
  // ปันผล (นับเฉพาะหุ้นที่จ่าย และลดคะแนนถ้าสูงผิดปกติแต่กำไรหด)
  if (p.dy != null && p.dy > 0) {
    let v = p.dy >= 0.03 && p.dy <= 0.08 ? 15 : p.dy > 0.08 ? 9 : p.dy >= 0.015 ? 9 : 5;
    if (p.payout != null && p.payout > 1) v -= 6;
    if (p.dy > 0.08 && (p.epsGrowth ?? 0) < -0.1) v -= 6;
    parts.dividend = clamp(v, 0, 15); w.dividend = 15;
  }
  const tw = Object.values(w).reduce((s, x) => s + x, 0);
  if (tw < 40) return { score: null, parts, coverage: tw };
  let score = (Object.keys(w).reduce((s, k) => s + parts[k], 0) / tw) * 100;
  // เป้าราคานักวิเคราะห์ (ถ้ามีนักวิเคราะห์อย่างน้อย 5 ราย) ปรับไม่เกิน ±5
  if (p.target && p.analysts >= 5 && p.price) score += clamp(((p.target / p.price - 1) / 0.3) * 5, -5, 5);
  return { score: Math.round(clamp(score, 0, 100)), parts, coverage: tw };
}
export function trendOf(series) {
  const s = (series || []).filter((x) => x.value != null);
  if (s.length < 3) return null;
  let ups = 0; for (let k = 1; k < s.length; k++) if (s[k].value > s[k - 1].value) ups++;
  const a = s[0].value, b = s.at(-1).value;
  const cagr = a > 0 && b > 0 ? (b / a) ** (1 / (s.length - 1)) - 1 : null;
  return { n: s.length, ups, cagr, last: b, first: a, years: s.map((x) => x.date.slice(0, 4)) };
}

// ---------- แนวรับ/แนวต้าน จากจุดกลับตัวในอดีต ----------
export function levels(H, i, t) {
  const lows = [], highs = [], W = 5, st = Math.max(W, i - 260);
  for (let k = st; k <= i - W; k++) {
    let isL = true, isH = true;
    for (let j = k - W; j <= k + W; j++) { if (H.l[j] < H.l[k]) isL = false; if (H.h[j] > H.h[k]) isH = false; }
    if (isL) lows.push(H.l[k]); if (isH) highs.push(H.h[k]);
  }
  const p = H.c[i];
  const cluster = (arr) => {
    const s = [...arr].sort((a, b) => a - b), out = [];
    for (const x of s) { const g = out.at(-1); if (g && x / g.v - 1 < 0.02) { g.v = (g.v * g.n + x) / (g.n + 1); g.n++; } else out.push({ v: x, n: 1 }); }
    return out;
  };
  const sup = cluster(lows).filter((x) => x.v < p * 0.995).map((x) => ({ price: x.v, touches: x.n, kind: 'จุดกลับตัวเดิม' }));
  const res = cluster(highs).filter((x) => x.v > p * 1.005).map((x) => ({ price: x.v, touches: x.n, kind: 'จุดกลับตัวเดิม' }));
  if (t.sma200 && t.sma200 < p) sup.push({ price: t.sma200, kind: 'เส้นค่าเฉลี่ย 200 วัน' });
  if (t.sma50 && t.sma50 < p) sup.push({ price: t.sma50, kind: 'เส้นค่าเฉลี่ย 50 วัน' });
  if (t.sma200 && t.sma200 > p) res.push({ price: t.sma200, kind: 'เส้นค่าเฉลี่ย 200 วัน' });
  if (t.sma50 && t.sma50 > p) res.push({ price: t.sma50, kind: 'เส้นค่าเฉลี่ย 50 วัน' });
  sup.push({ price: t.lo52, kind: 'จุดต่ำสุด 52 สัปดาห์' });
  res.push({ price: t.hi52, kind: 'จุดสูงสุด 52 สัปดาห์' });
  const pick = (arr, dir) => arr.filter((x) => (dir < 0 ? x.price < p : x.price > p))
    .sort((a, b) => (dir < 0 ? b.price - a.price : a.price - b.price))
    .filter((x, k, a) => k === 0 || Math.abs(x.price / a[k - 1].price - 1) > 0.015).slice(0, 3)
    .map((x) => ({ ...x, pct: x.price / p - 1 }));
  return { support: pick(sup, -1), resistance: pick(res, 1) };
}

// ---------- สถานการณ์คล้ายกันในอดีต: ลงต่ออีกแค่ไหน ใช้เวลากี่วันกว่าจะฟื้น ----------
// "ฟื้น" = ราคาปิดกลับขึ้นเหนือเส้นค่าเฉลี่ย 50 วัน
// คำนวณวันที่เข้าเงื่อนไข "ลง" ทั้งหมดไว้ครั้งเดียว แล้วค่อยเลือกตามระดับการลงที่ต้องการ
export function fallCandidates(H) {
  const c = H.c, n = c.length, s50 = new Array(n).fill(null), out = [];
  let run = 0; for (let k = 0; k < n; k++) { run += c[k]; if (k >= 50) run -= c[k - 50]; if (k >= 49) s50[k] = run / 50; }
  for (let j = 252; j < n - 61; j++) {
    if (!(c[j] < s50[j]) || c[j] / c[j - 21] - 1 > -0.03) continue;
    let hi = 0; for (let k = j - 251; k <= j; k++) hi = Math.max(hi, H.h[k]);
    let minL = Infinity; for (let k = j + 1; k <= j + 60; k++) minL = Math.min(minL, H.l[k]);
    let rec = null; for (let k = j + 1; k < Math.min(n, j + 181); k++) if (c[k] > s50[k]) { rec = k - j; break; }
    out.push({ j, dd: c[j] / hi - 1, further: minL / c[j] - 1, rec, ret60: c[j + 60] / c[j] - 1 });
  }
  return out;
}
export function selectEpisodes(cands, ddTarget) {
  const out = []; let last = -1e9;
  for (const e of cands) if (Math.abs(e.dd - ddTarget) <= 0.07 && e.j > last + 20) { out.push(e); last = e.j; }
  return out;
}
export function summarizeEpisodes(eps) {
  if (!eps.length) return null;
  const rec = eps.map((e) => e.rec ?? 181);
  return {
    n: eps.length,
    furtherMed: median(eps.map((e) => e.further)), furtherBad: quant(eps.map((e) => e.further), 0.2),
    recMed: median(rec), recSlow: quant(rec, 0.75), recWithin60: eps.filter((e) => e.rec != null && e.rec <= 60).length / eps.length,
    up60: eps.filter((e) => e.ret60 > 0).length / eps.length, ret60Med: median(eps.map((e) => e.ret60)),
  };
}

// ---------- สัญญาณเตือน ----------
export function riskFlags(t, p, fin, q) {
  const F = [], isFin = FIN_SECTORS.includes(p?.sector);
  if (p) {
    if ((p.margin != null && p.margin < 0) || (p.pe == null && p.epsGrowth != null && p.margin != null && p.margin <= 0)) F.push({ level: 'high', text: 'บริษัทยังขาดทุน' });
    const ni = trendOf(fin?.annualNetIncome);
    if (ni && ni.last < 0) F.push({ level: 'high', text: `ปี ${+ni.years.at(-1) + 543} ขาดทุนสุทธิ` });
    if (!isFin && p.de != null && p.de > 200) F.push({ level: 'mid', text: `หนี้สูง (หนี้สิน/ทุน ${Math.round(p.de)}%)` });
    if (p.epsGrowth != null && p.epsGrowth < -0.25) F.push({ level: 'mid', text: `กำไรล่าสุดหดตัว ${Math.round(-p.epsGrowth * 100)}%` });
    if (p.revGrowth != null && p.revGrowth < -0.1) F.push({ level: 'mid', text: `รายได้หดตัว ${Math.round(-p.revGrowth * 100)}%` });
    if (p.dy != null && p.dy > 0.1) F.push({ level: 'mid', text: `ปันผลสูงผิดปกติ ${(p.dy * 100).toFixed(1)}% อาจเป็นเพราะราคาลงแรงหรือปันผลพิเศษครั้งเดียว` });
    if (p.payout != null && p.payout > 1.2) F.push({ level: 'mid', text: 'จ่ายปันผลเกินกำไร อาจลดปันผลในอนาคต' });
    if (!isFin && p.currentRatio != null && p.currentRatio < 0.8) F.push({ level: 'mid', text: 'สภาพคล่องระยะสั้นต่ำ (สินทรัพย์หมุนเวียนน้อยกว่าหนี้ระยะสั้น)' });
    if (p.rec && ['sell', 'strong_sell', 'underperform'].includes(p.rec)) F.push({ level: 'mid', text: 'นักวิเคราะห์ส่วนใหญ่แนะนำขาย' });
  }
  if (t) {
    if (t.price < t.sma200 && t.sma50 < t.sma200 && t.sma50Slope < 0) F.push({ level: 'mid', text: 'อยู่ในขาลง (ต่ำกว่าเส้นค่าเฉลี่ย 50 และ 200 วัน และยังชี้ลง)' });
    if (t.dd < -0.4) F.push({ level: 'high', text: `ราคาต่ำกว่าจุดสูงสุดรอบปี ${Math.round(-t.dd * 100)}%` });
    if (t.vol > 0.6) F.push({ level: 'mid', text: `ราคาผันผวนสูงมาก (${Math.round(t.vol * 100)}% ต่อปี)` });
    if (t.rsi > 80) F.push({ level: 'mid', text: `ขึ้นแรงเกินไปในระยะสั้น (RSI ${Math.round(t.rsi)}) เสี่ยงย่อตัว` });
    if (t.liquidity != null && q?.currency === 'THB' && t.liquidity < 5e6) F.push({ level: 'mid', text: 'สภาพคล่องต่ำ ซื้อขายเฉลี่ยไม่ถึง 5 ล้านบาทต่อวัน' });
  }
  return F;
}

// ---------- รวมเป็นผลวิเคราะห์ ----------
const pctT = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`;
export function analyze({ symbol, H, q, p, fin, bench, peer, pooled, cands }) {
  const i = H.c.length - 1;
  const t = techAt(H, i, bench);
  if (!t) return null;
  const ss = shortScore(t), ls = longScore(p ? { ...p, price: t.price } : null, fin, peer);
  const flags = riskFlags(t, p, fin, q), lv = levels(H, i, t);
  const highFlags = flags.filter((f) => f.level === 'high').length;
  const shortLabel = ss.score >= 65 ? 'good' : ss.score >= 45 ? 'mid' : 'weak';
  const longLabel = ls?.score == null ? 'na' : ls.score >= 65 ? 'good' : ls.score >= 45 ? 'mid' : 'weak';
  const caution = highFlags > 0 || (ss.score < 35 && (ls?.score ?? 50) < 40) || flags.length >= 4;
  const verdict = caution ? 'caution' : shortLabel === 'good' && longLabel === 'good' ? 'both' : longLabel === 'good' ? 'long' : shortLabel === 'good' ? 'short' : 'wait';

  // จุดเด่น / จุดด้อย
  const pros = [], cons = [];
  if (t.price > t.sma50 && t.sma50 > t.sma200) pros.push('อยู่ในขาขึ้น ราคาเหนือเส้นค่าเฉลี่ย 50 และ 200 วัน');
  else if (t.price < t.sma50 && t.price < t.sma200) cons.push('ราคาต่ำกว่าเส้นค่าเฉลี่ย 50 และ 200 วัน แนวโน้มยังเป็นขาลง');
  if (t.rel3m != null) (t.rel3m > 0.05 ? pros : t.rel3m < -0.05 ? cons : []).push(`3 เดือนล่าสุด${t.rel3m > 0 ? 'ดีกว่า' : 'แย่กว่า'}ดัชนีตลาด ${Math.abs(t.rel3m * 100).toFixed(0)}%`);
  if (t.rsi != null && t.rsi < 30) pros.push(`ขายมากเกินไปในระยะสั้น (RSI ${Math.round(t.rsi)}) มักมีแรงเด้งกลับ`);
  if (t.volRatio > 1.3 && t.ret1m > 0) pros.push('ปริมาณซื้อขายเพิ่มขึ้นพร้อมราคาขึ้น มีแรงซื้อจริง');
  if (t.volRatio > 1.3 && t.ret1m < 0) cons.push('ปริมาณซื้อขายเพิ่มขึ้นตอนราคาลง มีแรงขายออกมาก');
  if (p) {
    if (p.pe > 0 && peer?.pe) (p.pe < peer.pe * 0.8 ? pros : p.pe > peer.pe * 1.4 ? cons : []).push(`P/E ${p.pe.toFixed(1)} เท่า ${p.pe < peer.pe ? 'ถูกกว่า' : 'แพงกว่า'}ค่ากลางกลุ่มเดียวกัน (${peer.pe.toFixed(1)} เท่า)`);
    if (p.roe != null) (p.roe >= 0.15 ? pros : p.roe < 0.05 ? cons : []).push(`ROE ${(p.roe * 100).toFixed(1)}% ${p.roe >= 0.15 ? 'ทำกำไรจากทุนได้ดี' : 'ทำกำไรจากทุนได้น้อย'}`);
    if (p.revGrowth != null) (p.revGrowth > 0.08 ? pros : p.revGrowth < 0 ? cons : []).push(`รายได้ล่าสุด${p.revGrowth >= 0 ? 'โต' : 'หด'} ${Math.abs(p.revGrowth * 100).toFixed(0)}% จากปีก่อน`);
    if (p.dy >= 0.03 && p.dy <= 0.1) pros.push(`ปันผล ${(p.dy * 100).toFixed(1)}% ต่อปี`);
    const ni = trendOf(fin?.annualNetIncome);
    if (ni && ni.n >= 3) (ni.ups >= ni.n - 1 && ni.last > 0 ? pros : ni.cagr != null && ni.cagr < -0.05 ? cons : []).push(`กำไรสุทธิปี ${+ni.years[0] + 543}–${+ni.years.at(-1) + 543} ${ni.ups >= ni.n - 1 ? 'เพิ่มขึ้นต่อเนื่อง' : ni.cagr < 0 ? `ลดลงเฉลี่ย ${Math.abs(ni.cagr * 100).toFixed(0)}% ต่อปี` : 'ขึ้นลงไม่สม่ำเสมอ'}`);
    if (p.target && p.analysts >= 5) (p.target > t.price * 1.15 ? pros : p.target < t.price * 0.95 ? cons : []).push(`เป้าราคาเฉลี่ยนักวิเคราะห์ ${p.analysts} ราย ${p.target.toFixed(2)} (${pctT(p.target / t.price - 1, 0)})`);
  }

  // ถ้ากำลังลง: กรอบลงต่อ + เวลาฟื้นจากสถิติ + สัญญาณฟื้น
  let fall = null;
  if (t.ret1m < -0.05 || (t.price < t.sma50 && t.dd < -0.12)) {
    const own = selectEpisodes(cands || fallCandidates(H), t.dd);
    const pool = pooled ? pooled(t.dd) : [];
    const use = own.length >= 8 ? own : [...own, ...pool];
    const st = summarizeEpisodes(use);
    const m1 = Math.sqrt(21 / 252) * (t.vol || 0.3);
    let prevLow = null, lastLow = null;
    for (let k = i - 60; k <= i - 3; k++) { if (k < 5) continue; let isL = true; for (let j = k - 3; j <= k + 3; j++) if (H.l[j] < H.l[k]) isL = false; if (isL) { prevLow = lastLow; lastLow = H.l[k]; } }
    const checks = [
      { ok: t.rsi > 50, text: 'RSI กลับขึ้นเหนือ 50' },
      { ok: t.price > t.sma20, text: 'ราคากลับขึ้นเหนือเส้นค่าเฉลี่ย 20 วัน' },
      { ok: t.sma20Slope > 0, text: 'เส้นค่าเฉลี่ย 20 วันหันขึ้น' },
      { ok: t.macd > 0, text: 'MACD กลับเป็นบวก (แรงขายอ่อนลง)' },
      { ok: prevLow != null && lastLow > prevLow, text: 'จุดต่ำสุดใหม่สูงกว่าจุดต่ำเดิม' },
      { ok: t.price > t.sma50, text: 'ราคายืนเหนือเส้นค่าเฉลี่ย 50 วัน (ยืนยันการฟื้น)' },
    ];
    fall = {
      ret1m: t.ret1m, dd: t.dd,
      range1m: { lo: t.price * Math.exp(-1.2816 * m1), hi: t.price * Math.exp(1.2816 * m1) },
      support: lv.support, stats: st, statsSource: own.length >= 8 ? 'own' : 'pooled', ownN: own.length,
      checks, met: checks.filter((x) => x.ok).length,
    };
  }
  return { t, short: ss, long: ls, flags, levels: lv, verdict, shortLabel, longLabel, pros, cons, fall };
}

// ---------- backtest คะแนนระยะสั้น: คะแนน ณ สิ้นแต่ละเดือนในอดีต เทียบผลตอบแทน 1 เดือนถัดไป ----------
export function backtestShort(list) {
  const rows = [];
  for (const { H, bench } of list) {
    for (let i = 252; i < H.c.length - 22; i += 21) {
      const t = techAt(H, i, bench); if (!t) continue;
      const s = shortScore(t).score;
      rows.push({ date: H.d[i].slice(0, 7), s, fwd: H.c[i + 21] / H.c[i] - 1 });
    }
  }
  if (rows.length < 200) return null;
  // ผลตอบแทนส่วนเกินเทียบค่าเฉลี่ยของทุกตัวในเดือนเดียวกัน (ตัดผลของตลาดรวม)
  const byM = {}; for (const r of rows) (byM[r.date] ??= []).push(r.fwd);
  const mAvg = Object.fromEntries(Object.entries(byM).map(([k, v]) => [k, avg(v)]));
  const B = [{ key: 'low', name: 'ต่ำกว่า 35', f: (s) => s < 35 }, { key: 'mid', name: '35–50', f: (s) => s >= 35 && s < 50 },
    { key: 'hi', name: '50–65', f: (s) => s >= 50 && s < 65 }, { key: 'top', name: '65 ขึ้นไป', f: (s) => s >= 65 }];
  const buckets = B.map((b) => {
    const r = rows.filter((x) => b.f(x.s));
    return { ...b, f: undefined, n: r.length, avg: avg(r.map((x) => x.fwd)), excess: avg(r.map((x) => x.fwd - mAvg[x.date])), hit: r.filter((x) => x.fwd > 0).length / (r.length || 1),
      beat: r.filter((x) => x.fwd > mAvg[x.date]).length / (r.length || 1) };
  });
  return { n: rows.length, months: Object.keys(byM).length, from: Object.keys(byM).sort()[0], to: Object.keys(byM).sort().at(-1), buckets };
}
