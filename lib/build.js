// ตรรกะหลัก: ดึงข้อมูลทุกแหล่ง เทียบราคาไทยกับโลก และคำนวณสัญญาณทิศทาง
// ใช้ร่วมกันทั้ง server.js (รันเอง) และ scripts/build-data.mjs (GitHub Actions)
import { readFileSync } from 'node:fs';
import { bkkDate } from './history.js';

// ประวัติ SET ย้อนหลัง (เว็บตลาดหลักทรัพย์ฯ บล็อกเซิร์ฟเวอร์ของ GitHub จึงเก็บไว้ใน repo แล้วบันทึกต่อเองทุกวัน)
function loadSetSeed() {
  try {
    return readFileSync(new URL('../seed/set-history.csv', import.meta.url), 'utf8')
      .trim().split('\n').slice(1).map((l) => l.split(',')).map(([date, v]) => ({ date, value: +v }));
  } catch { return []; }
}
const mergeByDate = (...lists) => {
  const m = new Map();
  for (const l of lists) for (const p of l || []) if (p.value != null) m.set(p.date, p.value);
  return [...m].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
};

export function createBuilder({ S, history, mock = false, cacheSeed = null, ttlScale = 1, backfillPerRun = 10 }) {
  const LITRE_PER_GALLON = 3.785411784;
  const VAT = 1.07;
  
  // ---------- cache: แต่ละแหล่งมีรอบอัปเดตต่างกัน; ถ้าดึงใหม่ไม่สำเร็จจะใช้ค่าเก่าต่อ ----------
  const MIN = 60_000;
  const cache = new Map(cacheSeed ? Object.entries(cacheSeed) : []);
  async function cached(key, ttl, fn, onFresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl * ttlScale) return hit;
    try {
      const entry = { ok: true, data: await fn(), at: Date.now(), error: null };
      cache.set(key, entry);
      onFresh?.(entry.data);
      return entry;
    } catch (e) {
      console.error(`[${key}]`, e.message);
      if (hit?.data) return { ...hit, stale: true, error: e.message };
      return { ok: false, data: null, at: Date.now(), error: e.message };
    }
  }
  
  const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);
  const addDays = (date, n) => new Date(new Date(date).getTime() + n * 864e5).toISOString().slice(0, 10);
  
  // หาค่าของวันนั้นในอนุกรม (ถ้าวันนั้นไม่มี ใช้วันก่อนหน้าที่ใกล้ที่สุด)
  function lookup(history) {
    const dates = history.map((h) => h.date);
    return (date) => {
      let lo = 0, hi = dates.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans >= 0 ? history[ans].value : null;
    };
  }
  
  function changeOver(history, days) {
    if (!history.length) return null;
    const last = history.at(-1);
    const base = lookup(history)(addDays(last.date, -days)) ?? history[0].value;
    return pct(last.value, base);
  }
  
  const INDICES = [
    { symbol: '^SET.BK', name: 'SET (ไทย)', region: 'th' },
    { symbol: '^GSPC', name: 'S&P 500 (สหรัฐ)', region: 'world' },
    { symbol: 'URTH', name: 'MSCI World (หุ้นทั่วโลก)', region: 'world' },
  ];
  
  // น้ำมันไทยแต่ละกลุ่มจับคู่กับราคาน้ำมันสำเร็จรูปตลาดโลกที่ใกล้เคียงที่สุดที่หาได้ฟรี
  const OIL_GROUPS = [
    { key: 'gasoline', eppo: 'g95', title: 'เบนซิน / แก๊สโซฮอล์ 95', proxy: 'RB=F', proxyName: 'น้ำมันเบนซินตลาดโลก (RBOB)',
      match: (n) => /แก๊สโซฮอล์|แก๊สโซฮอลล์|gasohol/i.test(n) && /95/.test(n) && !/E20|E85|พรีเมียม|ซูเปอร์|ซุปเปอร์|premium|super/i.test(n) },
    { key: 'diesel', eppo: 'diesel', title: 'ดีเซล', proxy: 'HO=F', proxyName: 'น้ำมันดีเซลตลาดโลก (ULSD)',
      match: (n) => /ดีเซล|diesel/i.test(n) && !/พรีเมียม|ซูเปอร์|ซุปเปอร์|premium|super|B20/i.test(n) },
  ];
  const median = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const NORM_DAYS = 30;

  // แบบจำลองราคาน้ำมันไทย:
  //   ราคาขายปลีก = (ราคา ณ โรงกลั่น + ภาษี + กองทุน + ค่าการตลาด) × 1.07
  //   ราคา ณ โรงกลั่นขยับตามราคาตลาดโลก ส่วนผู้ค้าจะปรับราคาขายปลีกเพื่อให้ค่าการตลาดกลับไปอยู่ระดับปกติ
  //   => ราคาไทยน่าจะปรับ ≈ (ค่าการตลาดปกติ − ค่าการตลาดที่คาดว่าจะเหลือ) × 1.07
  function oilModel(eppoRows, key, worldAt) {
    // คืน { norm, mm, dExr, estimate } ของแต่ละวันใน eppoRows (ใช้ทั้งค่าปัจจุบันและทดสอบย้อนหลัง)
    return eppoRows.map((r, i) => {
      const prior = eppoRows.slice(Math.max(0, i - NORM_DAYS), i).map((x) => x.p[key]?.mm);
      const norm = prior.filter((v) => v != null).length >= 10 ? median(prior) : null;
      const mm = r.p[key]?.mm;
      const w1 = worldAt(r.date), w0 = worldAt(addDays(r.date, -1));
      const dExr = w1 != null && w0 != null ? w1 - w0 : 0;
      return { date: r.date, retail: r.p[key]?.retail, mm, norm, dExr,
        estimate: norm != null && mm != null ? (norm - (mm - dExr)) * VAT : null };
    });
  }

  // ทดสอบย้อนหลัง: วันที่แบบจำลองบอกให้ปรับ ≥ 0.30 บาท ราคาไทยปรับไปทางเดียวกันภายใน 2 วันหรือไม่
  function backtestOil(model) {
    let n = 0, hit = 0, moved = 0, sumPred = 0, sumReal = 0;
    for (let i = 0; i < model.length; i++) {
      const m = model[i];
      if (m.estimate == null || Math.abs(m.estimate) < 0.3 || m.retail == null) continue;
      const later = model.filter((x) => x.date > m.date && x.date <= addDays(m.date, 2) && x.retail != null).at(-1);
      if (!later) continue;
      const real = later.retail - m.retail;
      n++;
      if (Math.abs(real) > 0.001) moved++;
      if (Math.sign(real) === Math.sign(m.estimate) && Math.abs(real) > 0.001) { hit++; sumPred += Math.abs(m.estimate); sumReal += Math.abs(real); }
    }
    return { n, hit, hitRate: n ? hit / n : null, movedRate: n ? moved / n : null, sizeRatio: sumPred ? sumReal / sumPred : null };
  }

  function oilSignal(group, proxyEntry, fxAt, usdthb, thaiItems) {
    if (!proxyEntry.data || !fxAt) return { ...group, ok: false, error: proxyEntry.error || 'ไม่มีข้อมูลค่าเงิน' };
    // ราคาโลก USD/แกลลอน -> บาท/ลิตร
    const world = proxyEntry.data.history.map((p) => ({ date: p.date, value: (p.value * fxAt(p.date)) / LITRE_PER_GALLON }));
    const nowVal = (proxyEntry.data.price * usdthb) / LITRE_PER_GALLON;
    const today = bkkDate();
    if (world.length && world.at(-1).date < today) world.push({ date: today, value: nowVal });
    else if (world.length) world.at(-1).value = nowVal;
    const worldAt = lookup(world);

    const item = (thaiItems || []).find((i) => group.match(i.name));
    const eppoRows = (history.get().eppo || []).filter((r) => r.p[group.eppo]?.retail != null);
    const bcName = item?.name || history.get().oil.flatMap((r) => Object.keys(r.prices)).find(group.match);
    // ประวัติราคาขายปลีกไทย: สนพ. เป็นหลัก เสริมด้วยราคาบางจากที่บันทึกเอง (วันที่ สนพ. ยังไม่ออกไฟล์)
    const thai = mergeByDate(
      bcName ? history.get().oil.map((r) => ({ date: r.date, value: r.prices[bcName] })) : [],
      eppoRows.map((r) => ({ date: r.date, value: r.p[group.eppo].retail })),
    );
    const lastEppoDate = eppoRows.at(-1)?.date;
    if (item?.today != null && (!lastEppoDate || today > lastEppoDate)) {
      const i = thai.findIndex((p) => p.date === today);
      if (i >= 0) thai[i].value = item.today; else thai.push({ date: today, value: item.today });
    }

    let lastChange = null;
    for (let i = thai.length - 1; i > 0; i--) {
      if (Math.abs(thai[i].value - thai[i - 1].value) > 0.001) { lastChange = { date: thai[i].date, delta: thai[i].value - thai[i - 1].value }; break; }
    }
    const thaiNow = item?.today ?? thai.at(-1)?.value ?? null;
    const announced = item && item.tomorrow != null && Math.abs(item.tomorrow - item.today) > 0.001 ? item.tomorrow - item.today : null;

    let model = null, estimate = null, method = 'world', structure = null, backtest = null;
    if (eppoRows.length) {
      const series = oilModel(eppoRows, group.eppo, worldAt);
      backtest = backtestOil(series);
      const last = eppoRows.at(-1), lastP = last.p[group.eppo];
      const norm = series.at(-1).norm ?? (group.eppo === 'diesel' ? last.avgMM?.diesel : last.avgMM?.all) ?? null;
      // ถ้าราคาหน้าปั๊มเปลี่ยนหลังวันที่ของไฟล์ สนพ. ค่าการตลาดก็เปลี่ยนตาม
      const mmNow = lastP.mm + ((thaiNow ?? lastP.retail) - lastP.retail) / VAT;
      const wBase = worldAt(addDays(last.date, -1));
      const dExr = wBase != null ? nowVal - wBase : 0;
      const mmProjected = mmNow - dExr;
      if (norm != null) {
        estimate = (norm - mmProjected) * VAT;
        method = 'eppo';
      }
      model = { eppoDate: last.date, norm, mmNow, mmProjected, dExr, normDays: Math.min(NORM_DAYS, eppoRows.length - 1) };
      const exr = lastP.exr + (lastP.disc || 0), tax = lastP.excise * 1.1;
      structure = { exr, tax, fund: lastP.fund, mm: lastP.mm, retail: lastP.retail, other: lastP.retail - exr - tax - lastP.fund - lastP.mm };
    }
    if (estimate == null) {
      // สำรอง: ราคาโลกเปลี่ยนไปเท่าไรตั้งแต่ไทยปรับครั้งล่าสุด
      const baseDate = lastChange ? addDays(lastChange.date, -1) : addDays(today, -3);
      const baseVal = worldAt(baseDate);
      estimate = baseVal != null ? (nowVal - baseVal) * VAT : null;
    }

    // กราฟ 90 วัน: ราคาไทยเทียบราคาโลก (บาท/ลิตร รวม VAT) ตั้งต้นที่ 0 วันเดียวกัน
    const from = addDays(today, -90);
    const w = world.filter((p) => p.date >= from);
    const t = thai.filter((p) => p.date >= from);
    let worldCum = [], thaiCum = [];
    if (w.length) {
      const start = t.length ? (w.find((p) => p.date >= t[0].date) || w[0]) : w[0];
      worldCum = w.filter((p) => p.date >= start.date).map((p) => ({ date: p.date, value: (p.value - start.value) * VAT }));
      if (t.length >= 2) {
        const thaiAt = lookup(t);
        const t0 = thaiAt(start.date) ?? t[0].value;
        thaiCum = worldCum.map((p) => ({ date: p.date, value: (thaiAt(p.date) ?? t0) - t0 }));
      }
    }
    // ค่าการตลาดย้อนหลัง
    const mmHist = eppoRows.filter((r) => r.date >= from).map((r) => ({ date: r.date, value: r.p[group.eppo].mm }));

    return {
      key: group.key, title: group.title, proxyName: group.proxyName, ok: true, method,
      thaiName: bcName || eppoRows.at(-1)?.p[group.eppo] && group.title, thaiNow, thaiTomorrow: item?.tomorrow ?? null,
      worldNow: nowVal, worldUsd: proxyEntry.data.price, lastChange, estimate, announced, model, structure, backtest,
      direction: announced != null ? Math.sign(announced) : estimate == null ? 0 : Math.abs(estimate) < 0.25 ? 0 : Math.sign(estimate),
      change1d: (nowVal - (worldAt(addDays(today, -1)) ?? nowVal)) * VAT,
      change3d: (nowVal - (worldAt(addDays(today, -3)) ?? nowVal)) * VAT,
      change7d: (nowVal - (worldAt(addDays(today, -7)) ?? nowVal)) * VAT,
      chart: { world: worldCum, thai: thaiCum, thaiDays: t.length, mm: mmHist },
    };
  }

  // ทอง: สมาคมฯ บอกว่าประกาศครั้งล่าสุดอิงราคาโลก (refSpot) และค่าเงิน (refFx) เท่าไร
  // ราคาที่ราคาโลกตอนนี้ชี้ = ราคาขายล่าสุด × (spot ตอนนี้ / refSpot) × (ค่าเงินตอนนี้ / refFx)
  function goldSignal(thai, spotNow, fxNow, factor) {
    if (!thai || !spotNow || !fxNow) return { ok: false, reason: 'ข้อมูลไม่ครบ' };
    const refSpot = thai.refSpot, refFx = thai.refFx || fxNow;
    let implied, method;
    if (refSpot) {
      implied = thai.barSell * (spotNow / refSpot) * (fxNow / refFx);
      method = 'ref';
    } else {
      // สำรอง: ใช้ประวัติที่บันทึกไว้ (ราคาโลกเปลี่ยนไปเท่าไรตั้งแต่ไทยปรับครั้งล่าสุด)
      const snaps = history.get().gold;
      let ref = null;
      for (let i = snaps.length - 1; i > 0; i--) if (snaps[i].thaiSell !== snaps[i - 1].thaiSell) { ref = snaps[i]; break; }
      ref = ref || snaps[0];
      if (!ref) return { ok: false, reason: 'ยังไม่มีประวัติ' };
      implied = thai.barSell + (spotNow * fxNow * factor - ref.worldThb);
      method = 'history';
    }
    const estimate = implied - thai.barSell;
    // กราฟ: ราคาไทยวันนี้ (ทุกครั้งที่ปรับ) เทียบราคาโลกที่ปรับฐานให้เทียบกันได้
    const premium = refSpot ? thai.barSell - refSpot * refFx * factor : 0;
    const since = Date.now() - 36 * 3600e3;
    const worldPts = history.get().gold.filter((g) => g.t >= since).map((g) => ({ t: g.t, v: g.worldThb + premium }));
    worldPts.push({ t: Date.now(), v: spotNow * fxNow * factor + premium });
    const thaiPts = (thai.today || []).filter((r) => r.t && r.sell).map((r) => ({ t: r.t, v: r.sell }));
    if (thaiPts.length) thaiPts.push({ t: Date.now(), v: thai.barSell });
    return {
      ok: true, method, thaiSell: thai.barSell, implied, estimate,
      estimateRounded: Math.round(estimate / 50) * 50,
      direction: Math.abs(estimate) < 50 ? 0 : Math.sign(estimate),
      refTime: thai.asOfTime, refSpot, refFx, spotNow, fxNow, adjustmentsToday: thai.today?.length || 0,
      chart: { thai: thaiPts, world: worldPts },
    };
  }

  // ---- สนพ.: ไฟล์ล่าสุด (วันนี้ หรือย้อนไปไม่เกิน 4 วัน) ----
  async function fetchEppoLatest() {
    let lastErr;
    for (let back = 0; back <= 4; back++) {
      const date = bkkDate(Date.now(), -back);
      try {
        const e = await S.fetchEppo(date);
        history.recordEppo(e);
        return e;
      } catch (err) { lastErr = err; if (!err.notFound) break; }
    }
    throw lastErr;
  }
  // เติมประวัติย้อนหลังประมาณ 120 วัน จากรายชื่อไฟล์ในหน้ารวมของ สนพ. ทีละไม่เกิน maxPerRun ไฟล์ต่อรอบ
  async function backfillEppo(maxPerRun) {
    const have = new Set((history.get().eppo || []).map((r) => r.date));
    const from = bkkDate(Date.now(), -120);
    if ((history.get().eppo || []).filter((r) => r.date >= from).length >= 75) return { skipped: true, days: have.size };
    const index = S.fetchEppoIndex ? await S.fetchEppoIndex(12) : {};
    const todo = Object.keys(index).filter((d) => d >= from && !have.has(d)).sort().reverse().slice(0, maxPerRun);
    let got = 0, failed = 0;
    for (let i = 0; i < todo.length; i += 5) {
      await Promise.all(todo.slice(i, i + 5).map(async (d) => {
        try { history.recordEppo(await S.fetchEppo(d, index[d])); got++; } catch { failed++; }
      }));
    }
    return { listed: Object.keys(index).length, tried: todo.length, got, failed, days: (history.get().eppo || []).length };
  }

  // ตัวชี้นำทิศทางตลาดหุ้นไทย (sign = +1 ถ้าค่าขึ้นแปลว่าบรรยากาศดี, −1 ถ้าตรงข้าม)
  const LEADS = [
    { symbol: 'ES=F', name: 'S&P 500 ฟิวเจอร์ส', note: 'ซื้อขายเกือบ 24 ชม.', sign: 1 },
    { symbol: 'NQ=F', name: 'Nasdaq ฟิวเจอร์ส', note: 'หุ้นเทคโนโลยี', sign: 1 },
    { symbol: '^N225', name: 'Nikkei 225', note: 'ญี่ปุ่น เปิดก่อนไทย 2 ชม.', sign: 1 },
    { symbol: '^HSI', name: 'Hang Seng', note: 'ฮ่องกง เปิดก่อนไทย 1 ชม.', sign: 1 },
    { symbol: '^VIX', name: 'VIX ดัชนีความกลัว', note: 'ขึ้น = นักลงทุนกังวล', sign: -1 },
    { symbol: 'DX-Y.NYB', name: 'ดัชนีดอลลาร์ (DXY)', note: 'ขึ้น = เงินไหลออกจากตลาดเกิดใหม่', sign: -1 },
    { symbol: '^TNX', name: 'บอนด์สหรัฐ 10 ปี (%)', note: 'ขึ้น = กดดันหุ้น', sign: -1, yield: true },
  ];
  const NEWS = [
    { key: 'oil', title: 'น้ำมัน', q: '(ราคาน้ำมัน OR กองทุนน้ำมัน OR กบน. OR ราคาดีเซล) when:3d' },
    { key: 'gold', title: 'ทองคำ', q: '(ราคาทอง OR สมาคมค้าทองคำ) when:2d' },
    { key: 'stock', title: 'หุ้น', q: '(SET OR หุ้นไทย OR ตลาดหุ้น) when:2d' },
    { key: 'fx', title: 'ค่าเงิน/ดอกเบี้ย', q: '(ค่าเงินบาท OR กนง. OR ดอกเบี้ยนโยบาย OR เงินเฟ้อ) when:3d' },
  ];

  // ความแม่นของสัญญาณทอง: เมื่อราคาที่โลกชี้ต่างจากราคาไทย ≥ 100 บาท สมาคมฯ ปรับครั้งถัดไป (ภายใน 3 ชม.) ไปทางเดียวกันไหม
  function goldAccuracy() {
    const g = (history.get().gold || []).filter((x) => x.implied != null);
    let n = 0, hit = 0;
    for (let i = 0; i < g.length; i++) {
      const est = g[i].implied - g[i].thaiSell;
      if (Math.abs(est) < 100) continue;
      const next = g.slice(i + 1).find((x) => x.t - g[i].t <= 3 * 3600e3 && x.thaiSell !== g[i].thaiSell);
      if (!next) continue;
      n++;
      if (Math.sign(next.thaiSell - g[i].thaiSell) === Math.sign(est)) hit++;
    }
    return { n, hit, hitRate: n ? hit / n : null, snapshots: g.length };
  }

  function leadsFrom(raw, status) {
    const items = LEADS.map((l, i) => {
      const d = raw[i].data;
      if (!d) return { ...l, status: status(raw[i]) };
      const change = l.yield ? (d.price - d.prevClose) * 100 : pct(d.price, d.prevClose); // บอนด์: หน่วย bp
      return { ...l, status: status(raw[i]), price: d.price, change, lastDate: d.history.at(-1)?.date };
    });
    // คะแนนบรรยากาศ: นับว่าแต่ละตัวชี้ไปทางบวกหรือลบ (ไม่นับถ้าขยับน้อยมาก)
    let score = 0, counted = 0;
    for (const it of items) {
      if (it.change == null) continue;
      const th = it.yield ? 2 : 0.15;
      counted++;
      if (Math.abs(it.change) >= th) score += Math.sign(it.change) * it.sign;
    }
    return { items, score, counted };
  }

  async function buildData() {
    const [fx, fxLive, wGold, tGold, tOil, brent, wti, rbob, ulsd, infl, ...idx] = await Promise.all([
      cached('fx', 60 * MIN, S.fetchFx),
      cached('fxLive', 10 * MIN, () => S.fetchYahoo('THB=X')),
      cached('worldGold', 2 * MIN, S.fetchWorldGold),
      cached('thaiGold', 2 * MIN, S.fetchThaiGold),
      cached('thaiOil', 30 * MIN, S.fetchThaiOil, (d) => history.recordOil(d.items)),
      cached('brent', 15 * MIN, () => S.fetchYahoo('BZ=F')),
      cached('wti', 15 * MIN, () => S.fetchYahoo('CL=F')),
      cached('rbob', 15 * MIN, () => S.fetchYahoo('RB=F')),
      cached('ulsd', 15 * MIN, () => S.fetchYahoo('HO=F')),
      cached('inflation', 24 * 60 * MIN, S.fetchInflation),
      ...INDICES.map((i) => cached(`idx:${i.symbol}`, 15 * MIN, () => S.fetchYahoo(i.symbol))),
    ]);
    const [eppo, ...rest] = await Promise.all([
      cached('eppo', 60 * MIN, fetchEppoLatest),
      ...LEADS.map((l) => cached(`lead:${l.symbol}`, 15 * MIN, () => S.fetchYahoo(l.symbol))),
      ...NEWS.map((n) => cached(`news:${n.key}`, 30 * MIN, () => S.fetchNews(n.q))),
    ]);
    const leadsRaw = rest.slice(0, LEADS.length), newsRaw = rest.slice(LEADS.length);
    let backfill = null;
    if (eppo.data && backfillPerRun > 0) {
      try { backfill = await backfillEppo(backfillPerRun); } catch (e) { console.error('[eppo backfill]', e.message); }
    }
  
    // ค่าเงินตอนนี้: ใช้ราคาตลาดจาก Yahoo (THB=X) ถ้าได้ ไม่งั้นใช้อัตราอ้างอิงรายวัน
    const usdthb = fxLive.data?.price ?? fx.data?.rates.USD ?? null;
    const fxAt = fx.data ? lookup(fx.data.usdthbHistory) : null;
    const status = (e) => ({ ok: !!e.data, stale: !!e.stale, error: e.error, updatedAt: e.at });
  
    // ---- ทอง: แปลงราคาโลก (USD/ออนซ์, 99.99%) เป็น บาท/ทองแท่ง 1 บาท (96.5%) ----
    let gold = { status: { world: status(wGold), thai: status(tGold) } };
    let worldThbPerBaht = null;
    if (wGold.data && usdthb) {
      worldThbPerBaht = wGold.data.usdPerOz * usdthb * (S.BAHT_GOLD_GRAM * S.THAI_GOLD_PURITY) / S.OZ_TO_GRAM;
      gold = {
        ...gold, worldUsdPerOz: wGold.data.usdPerOz, worldThbPerBaht,
        worldThbPerGram: wGold.data.usdPerOz * usdthb / S.OZ_TO_GRAM,
      };
    }
    if (tGold.data) {
      gold.thai = tGold.data;
      gold.premiumPct = pct(tGold.data.barSell, worldThbPerBaht);
    }
    const gFactor = (S.BAHT_GOLD_GRAM * S.THAI_GOLD_PURITY) / S.OZ_TO_GRAM;
    gold.signal = goldSignal(tGold.data, wGold.data?.usdPerOz, usdthb, gFactor);
    gold.factor = gFactor;
    if (tGold.data && worldThbPerBaht && !tGold.stale) history.recordGold(tGold.data.barSell, worldThbPerBaht, gold.signal.ok ? gold.signal.implied : null);
    gold.accuracy = goldAccuracy();
  
    // ---- น้ำมัน ----
    const crude = (e, name) =>
      e.data && usdthb
        ? { name, usdPerBarrel: e.data.price, thbPerLitre: (e.data.price * usdthb) / S.LITRE_PER_BARREL, change1d: pct(e.data.price, e.data.prevClose) }
        : null;
    const oil = {
      status: { thai: status(tOil), brent: status(brent), rbob: status(rbob), ulsd: status(ulsd), eppo: status(eppo) },
      eppo: eppo.data ? { date: eppo.data.date, fx: eppo.data.fx, avgMM: eppo.data.avgMM, products: eppo.data.products, history: (history.get().eppo || []).length, backfill } : null,
      crude: [crude(brent, 'Brent'), crude(wti, 'WTI')].filter(Boolean),
      thai: tOil.data,
      signals: [oilSignal(OIL_GROUPS[0], rbob, fxAt, usdthb, tOil.data?.items), oilSignal(OIL_GROUPS[1], ulsd, fxAt, usdthb, tOil.data?.items)],
    };
  
    // ---- หุ้น: ดัชนีต่างประเทศคิดผลตอบแทนเป็นบาท (รวมผลของค่าเงิน) ----
    const stocks = INDICES.map((meta, i) => {
      const e = idx[i];
      if (!e.data) return { ...meta, status: status(e) };
      let d = e.data;
      if (meta.symbol === '^SET.BK') {
        const last = d.history.at(-1);
        if (last) history.recordDaily('set', last.date, d.price ?? last.value);
        d = { ...d, history: mergeByDate(mock ? [] : loadSetSeed(), history.get().set, d.history) };
      }
      const thbHist = d.currency === 'USD' && fxAt ? d.history.map((p) => ({ date: p.date, value: p.value * fxAt(p.date) })) : d.history;
      return {
        ...meta, status: status(e), currency: d.currency, price: d.price,
        lastDate: d.history.at(-1)?.date,
        change1d: pct(d.price, d.prevClose), change1m: changeOver(d.history, 30),
        change1y: changeOver(d.history, 365), change1yThb: changeOver(thbHist, 365),
        historyThb: thbHist,
      };
    });
  
    const fxH = fx.data?.usdthbHistory || [];
    return {
      mock,
      generatedAt: new Date().toISOString(),
      fx: { status: status(fx), live: fxLive.data ? { usdthb: fxLive.data.price, change1d: pct(fxLive.data.price, fxLive.data.prevClose) } : null,
        ...(fx.data ? { date: fx.data.date, rates: fx.data.rates, usdthbHistory: fxH,
        change1d: fxH.length > 1 ? pct(fxH.at(-1).value, fxH.at(-2).value) : null } : {}) },
      gold, oil, stocks,
      leads: leadsFrom(leadsRaw, status),
      news: NEWS.map((n, i) => ({ key: n.key, title: n.title, status: status(newsRaw[i]), items: (newsRaw[i].data || []).slice(0, 6) })),
      inflation: { status: status(infl), ...(infl.data || {}) },
    };
  }

  // สำหรับบันทึก cache ไว้ใช้รอบถัดไป (ถ้าแหล่งใดดึงไม่ได้ จะใช้ค่าล่าสุดแทน)
  const exportCache = () => Object.fromEntries([...cache].filter(([, v]) => v.data));
  return { buildData, exportCache };
}
