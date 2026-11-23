// ดึงข้อมูลหุ้นทั้งชุด (หุ้นไทยใหญ่ 100 ตัว + หุ้นต่างประเทศยอดนิยม + หุ้นที่ขอเพิ่ม) แล้ววิเคราะห์
// ข้อมูลแต่ละประเภทเปลี่ยนช้าเร็วต่างกัน จึงทยอยดึงตามอายุและงบเวลาต่อรอบ
import { analyze, benchLookup, fallCandidates, selectEpisodes, backtestShort, backtestEntry, median, trendOf } from './stocks.js';

export const US_LIST = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'TSM', 'BRK-B', 'JPM', 'V', 'MA', 'LLY', 'UNH',
  'XOM', 'WMT', 'COST', 'NFLX', 'AMD', 'PLTR', 'KO', 'PEP', 'JNJ', 'PG', 'ORCL', 'ASML', 'BABA', 'DIS', 'INTC'];
// สำรองไว้ใช้ถ้าดึงรายชื่อหุ้นใหญ่จาก Yahoo ไม่ได้ในรอบแรก
const TH_FALLBACK = ['PTT', 'DELTA', 'ADVANC', 'GULF', 'AOT', 'KBANK', 'KTB', 'PTTEP', 'SCB', 'CPALL', 'TRUE', 'BBL', 'BDMS', 'BAY', 'CPN', 'SCC',
  'TTB', 'CRC', 'PTTGC', 'CPAXT', 'BH', 'OR', 'CPF', 'GPSC', 'TOP', 'MINT', 'IVL', 'SCGP', 'TISCO', 'BEM', 'KTC', 'BJC', 'HMPRO', 'RATCH', 'TLI', 'AWC', 'KKP', 'TCAP'].map((s) => s + '.BK');
const BENCH = { TH: '^SET.BK', US: '^GSPC' };
const H6 = 6 * 3600e3, D1 = 24 * 3600e3, D7 = 7 * D1;
const marketOf = (s) => (s.endsWith('.BK') ? 'TH' : 'US');

async function pool(items, n, fn) {
  const out = []; let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const it = items[k++]; out.push(await fn(it)); } }));
  return out;
}

export async function buildStocks({ S, cache, extra = [], priority = [], mock = false, budgetMs = 170000 }) {
  const t0 = Date.now(), log = { hist: 0, prof: 0, fin: 0, fail: [] };
  const fresh = (k, ttl) => { const e = cache[k]; return e?.data && Date.now() - e.at < ttl; };
  const put = (k, data) => { cache[k] = { at: Date.now(), data }; };
  const timeLeft = () => budgetMs - (Date.now() - t0);

  // 1) รายชื่อหุ้น
  let uni = cache.universe?.data;
  if (!fresh('universe', D1)) {
    try { uni = await S.fetchSetUniverse(100); put('universe', uni); } catch (e) { log.fail.push(`universe: ${e.message}`); }
  }
  const thai = uni?.length ? uni.map((x) => x.symbol) : TH_FALLBACK;
  const symbols = [...new Set([...priority, ...extra, ...thai, ...US_LIST])];

  // 2) ราคาล่าสุดทุกตัว (ทุกรอบ)
  let quotes = {};
  try { quotes = await S.fetchQuotes([...symbols, ...Object.values(BENCH)]); } catch (e) { log.fail.push(`quotes: ${e.message}`); }

  // 3) ทยอยดึงราคาย้อนหลัง ข้อมูลพื้นฐาน และงบ ตามอายุ (ตัวที่จับตาและตัวที่ยังไม่มีมาก่อน)
  const order = (prefix, ttl) => symbols.concat(Object.values(BENCH).filter(() => prefix === 'h'))
    .filter((s) => !fresh(`${prefix}:${s}`, ttl))
    .sort((a, b) => (priority.includes(b) || extra.includes(b)) - (priority.includes(a) || extra.includes(a)) || (cache[`${prefix}:${a}`]?.at || 0) - (cache[`${prefix}:${b}`]?.at || 0));
  const jobs = [
    ['h', H6, mock ? 999 : 70, S.fetchStockHistory, 'hist'],
    ['p', D1, mock ? 999 : 45, S.fetchStockProfile, 'prof'],
    ['f', D7, mock ? 999 : 30, S.fetchStockFinancials, 'fin'],
  ];
  for (const [prefix, ttl, max, fn, name] of jobs) {
    const todo = order(prefix, ttl).filter((s) => prefix === 'h' || !s.startsWith('^')).slice(0, max);
    await pool(todo, 4, async (s) => {
      if (timeLeft() < 20000) return;
      try { put(`${prefix}:${s}`, await fn(s)); log[name]++; } catch (e) { log.fail.push(`${prefix}:${s} ${e.message}`); }
    });
  }

  // 4) ต่อราคาวันนี้จาก quote เข้าไปท้ายราคาย้อนหลัง
  const histOf = (s) => {
    const H0 = cache[`h:${s}`]?.data; if (!H0?.c?.length) return null;
    const H = { ...H0, d: [...H0.d], c: [...H0.c], h: [...H0.h], l: [...H0.l], v: [...H0.v] }, q = quotes[s];
    if (q?.price && q.time) {
      const d = new Date((q.time + (marketOf(s) === 'TH' ? 7 * 3600 : -5 * 3600)) * 1000).toISOString().slice(0, 10);
      const n = H.c.length - 1;
      if (d > H.d[n]) { H.d.push(d); H.c.push(q.price); H.h.push(q.price); H.l.push(q.price); H.v.push(H.v[n]); }
      else if (d === H.d[n]) { H.c[n] = q.price; H.h[n] = Math.max(H.h[n], q.price); H.l[n] = Math.min(H.l[n], q.price); }
    }
    return H;
  };
  const bench = { TH: benchLookup(histOf(BENCH.TH)), US: benchLookup(histOf(BENCH.US)) };

  // 5) ค่ากลาง P/E ของแต่ละกลุ่มธุรกิจในตลาดเดียวกัน
  const peers = {}, pbs = {};
  for (const s of symbols) {
    const p = cache[`p:${s}`]?.data, m = marketOf(s); if (!p) continue;
    if (p.pe > 0 && p.pe < 150) { (peers[`${m}|${p.sector}`] ??= []).push(p.pe); (peers[m] ??= []).push(p.pe); }
    if (p.pb > 0 && p.pb < 50) { (pbs[`${m}|${p.sector}`] ??= []).push(p.pb); (pbs[m] ??= []).push(p.pb); }
  }
  const peerOf = (s, sector) => {
    const m = marketOf(s), g = peers[`${m}|${sector}`], b = pbs[`${m}|${sector}`];
    const pe = g?.length >= 3 ? { pe: median(g), n: g.length, scope: 'sector' } : peers[m]?.length ? { pe: median(peers[m]), n: peers[m].length, scope: 'market' } : null;
    if (!pe) return null;
    return { ...pe, pb: b?.length >= 3 ? median(b) : pbs[m]?.length ? median(pbs[m]) : null };
  };

  // 6) สถิติการลงในอดีตของทุกตัว (ใช้รวมกันเมื่อหุ้นตัวนั้นมีเหตุการณ์ไม่พอ)
  const Hs = {}, cands = {};
  for (const s of symbols) { const H = histOf(s); if (H && H.c.length > 260) { Hs[s] = H; cands[s] = fallCandidates(H); } }
  const pooledFor = (s) => (dd) => Object.keys(cands).filter((x) => x !== s && marketOf(x) === marketOf(s)).flatMap((x) => selectEpisodes(cands[x], dd));

  // 7) วิเคราะห์
  const list = [], details = {};
  for (const s of symbols) {
    const H = Hs[s]; if (!H) continue;
    const q = quotes[s] || {}, p = cache[`p:${s}`]?.data || null, fin = cache[`f:${s}`]?.data || null, m = marketOf(s);
    const peer = p ? peerOf(s, p.sector) : null;
    let a;
    try { a = analyze({ symbol: s, H, q: { ...q, currency: q.currency || H.currency }, p, fin, bench: bench[m], peer, pooled: pooledFor(s), cands: cands[s] }); } catch (e) { log.fail.push(`analyze ${s}: ${e.message}`); continue; }
    if (!a) continue;
    const n = H.c.length - 1, prev = q.prev ?? H.c[n - 1];
    const name = q.name || p?.name || H.name || s;
    const top = a.flags.find((f) => f.level === 'high') || a.flags[0];
    list.push({
      s, n: name, m, sec: p?.sector || null, px: H.c[n], chg: prev ? H.c[n] / prev - 1 : null, cur: q.currency || H.currency,
      ss: a.short.score, ls: a.long?.score ?? null, v: a.verdict, fl: a.flags.length, flTop: top?.text || null,
      r1m: a.t.ret1m, r1y: a.t.ret1y, dd: a.t.dd, pe: p?.pe ?? q.pe ?? null, dy: p?.dy ?? (q.dy != null ? q.dy / 100 : null), fall: !!a.fall,
      cap: p?.cap ?? q.cap ?? null, date: H.d[n],
      fair: a.fair?.mid ?? null, buyHi: a.entry?.long?.hi ?? null, zone: a.entry?.long?.status ?? null, zoneBasis: a.entry?.long?.basis ?? null,
    });
    const k0 = Math.max(0, n - 259), sma = (w) => H.c.slice(k0).map((_, j) => { const i = k0 + j; if (i < w - 1) return null; let t = 0; for (let x = i - w + 1; x <= i; x++) t += H.c[x]; return Math.round((t / w) * 1e4) / 1e4; });
    details[s] = {
      s, name, market: m, currency: q.currency || H.currency, exchange: H.exchange, date: H.d[n], price: H.c[n], chg: prev ? H.c[n] / prev - 1 : null,
      profile: p, peer, earnings: q.earnings || p?.earnings || null, rating: q.rating || null,
      chart: { d: H.d.slice(k0), c: H.c.slice(k0), sma50: sma(50), sma200: sma(200) },
      fin: fin ? {
        revenue: fin.annualTotalRevenue || [], netIncome: fin.annualNetIncome || [], eps: fin.annualDilutedEPS || [], fcf: fin.annualFreeCashFlow || [],
        qRevenue: fin.quarterlyTotalRevenue || [], qNetIncome: fin.quarterlyNetIncome || [],
      } : null,
      divs: (H.divs || []).slice(-8),
      analysis: a,
      updated: { hist: cache[`h:${s}`]?.at, prof: cache[`p:${s}`]?.at || null, fin: cache[`f:${s}`]?.at || null },
    };
  }

  // 8) ทดสอบย้อนหลังคะแนนระยะสั้น (วันละครั้ง)
  let bt = cache.backtest?.data;
  if ((!fresh('backtest', D1) || !bt?.entry) && Object.keys(Hs).length >= 20) {
    bt = {
      all: backtestShort(Object.entries(Hs).filter(([s]) => !s.startsWith('^')).map(([s, H]) => ({ H, bench: bench[marketOf(s)] }))),
      TH: backtestShort(Object.entries(Hs).filter(([s]) => marketOf(s) === 'TH' && !s.startsWith('^')).map(([s, H]) => ({ H, bench: bench.TH }))),
      entry: backtestEntry(Object.entries(Hs).filter(([s]) => !s.startsWith('^')).map(([s, H]) => ({ H, bench: bench[marketOf(s)] }))),
    };
    put('backtest', bt);
  }
  const missing = symbols.filter((s) => !Hs[s]);
  return {
    summary: { updated: new Date().toISOString(), count: list.length, universe: { th: thai.length, us: US_LIST.length, extra }, missing, backtest: bt, list },
    details, log: { ...log, ms: Date.now() - t0, missing: missing.length },
  };
}
