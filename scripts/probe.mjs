// ทดลองสูตรคะแนนระยะสั้นแบบต่างๆ กับข้อมูลจริง (ไฟล์ชั่วคราว)
import { techAt, shortScore, benchLookup } from '../lib/stocks.js';
const C = await (await fetch('https://phanthakandt.github.io/thai-price-dashboard/stock-cache.json')).json();
const H = Object.fromEntries(Object.entries(C).filter(([k, v]) => k.startsWith('h:') && v.data?.c?.length > 300).map(([k, v]) => [k.slice(2), v.data]));
const bTH = benchLookup(H['^SET.BK']), bUS = benchLookup(H['^GSPC']);
const syms = Object.keys(H).filter((s) => !s.startsWith('^'));
console.log('stocks', syms.length, 'TH', syms.filter((s) => s.endsWith('.BK')).length);
const rows = [];
for (const s of syms) {
  const h = H[s], b = s.endsWith('.BK') ? bTH : bUS;
  for (let i = 252; i < h.c.length - 64; i += 21) {
    const t = techAt(h, i, b); if (!t) continue;
    const c = h.c;
    rows.push({ m: h.d[i].slice(0, 7), mk: s.endsWith('.BK') ? 'TH' : 'US',
      A: shortScore(t).score,
      B: c[i - 21] / c[i - 252] - 1,                         // โมเมนตัม 12-1 เดือน
      C: (t.price > t.sma200 ? 1 : 0) + (t.sma50 > t.sma200 ? 1 : 0) + (t.sma50Slope > 0 ? 1 : 0), // แนวโน้มล้วน
      D: -t.ret1m,                                           // กลับตัวระยะสั้น
      E: (c[i - 21] / c[i - 126] - 1),                        // โมเมนตัม 6-1 เดือน
      F: t.rel3m ?? 0,
      f1: c[i + 21] / c[i] - 1, f3: c[i + 63] / c[i] - 1 });
  }
}
const byM = {}; for (const r of rows) { const k = r.m + r.mk; (byM[k] ??= { a: [], b: [] }); byM[k].a.push(r.f1); byM[k].b.push(r.f3); }
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const mA = Object.fromEntries(Object.entries(byM).map(([k, v]) => [k, [avg(v.a), avg(v.b)]]));
// แบ่ง 5 กลุ่มตามอันดับภายในเดือนเดียวกัน (ตลาดเดียวกัน)
for (const key of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const q = [[], [], [], [], []];
  for (const [k, g] of Object.entries(rows.reduce((o, r) => ((o[r.m + r.mk] ??= []).push(r), o), {}))) {
    if (g.length < 10) continue;
    const srt = [...g].sort((x, y) => x[key] - y[key] || Math.random() - 0.5);
    srt.forEach((r, j) => q[Math.min(4, Math.floor((j / srt.length) * 5))].push(r));
  }
  const line = q.map((g, j) => { const e1 = avg(g.map((r) => r.f1 - mA[r.m + r.mk][0])), e3 = avg(g.map((r) => r.f3 - mA[r.m + r.mk][1])); const w3 = g.filter((r) => r.f3 > mA[r.m + r.mk][1]).length / g.length; return `Q${j + 1} n${g.length} 1M ${(e1 * 100).toFixed(2)} 3M ${(e3 * 100).toFixed(2)} win3M ${(w3 * 100).toFixed(0)}`; });
  console.log(key, '|', line.join(' | '));
}
