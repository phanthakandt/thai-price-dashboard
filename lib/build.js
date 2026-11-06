// ตรรกะหลัก: ดึงข้อมูลทุกแหล่ง เทียบราคาไทยกับโลก และคำนวณสัญญาณทิศทาง
// ใช้ร่วมกันทั้ง server.js (รันเอง) และ scripts/build-data.mjs (GitHub Actions)
import { bkkDate } from './history.js';

export function createBuilder({ S, history, mock = false, cacheSeed = null, ttlScale = 1 }) {
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
    { key: 'gasoline', title: 'เบนซิน / แก๊สโซฮอล์', proxy: 'RB=F', proxyName: 'น้ำมันเบนซินตลาดโลก (RBOB)',
      match: (n) => /แก๊สโซฮอล์|แก๊สโซฮอลล์|gasohol/i.test(n) && /95/.test(n) && !/E20|E85|พรีเมียม|ซูเปอร์|ซุปเปอร์|premium|super/i.test(n) },
    { key: 'diesel', title: 'ดีเซล', proxy: 'HO=F', proxyName: 'น้ำมันดีเซลตลาดโลก (ULSD)',
      match: (n) => /ดีเซล|diesel/i.test(n) && !/พรีเมียม|ซูเปอร์|ซุปเปอร์|premium|super|B20/i.test(n) },
  ];
  
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
    const thaiName = item?.name || history.get().oil.flatMap((r) => Object.keys(r.prices)).find(group.match);
    const thai = thaiName
      ? history.get().oil.map((r) => ({ date: r.date, value: r.prices[thaiName] })).filter((p) => p.value != null)
      : [];
  
    // วันที่ไทยปรับราคาครั้งล่าสุด (จากประวัติที่บันทึกไว้)
    let lastChange = null;
    for (let i = thai.length - 1; i > 0; i--) {
      if (Math.abs(thai[i].value - thai[i - 1].value) > 0.001) {
        lastChange = { date: thai[i].date, delta: thai[i].value - thai[i - 1].value };
        break;
      }
    }
    // ราคาไทยวันที่ D มักตั้งจากราคาตลาดโลกของวันก่อนหน้า จึงใช้ราคาโลกของวัน D-1 เป็นฐาน
    const baseDate = lastChange ? addDays(lastChange.date, -1) : addDays(today, -3);
    const baseVal = worldAt(baseDate);
    const estimate = baseVal != null ? (nowVal - baseVal) * VAT : null;
    const announced = item && item.tomorrow != null && Math.abs(item.tomorrow - item.today) > 0.001 ? item.tomorrow - item.today : null;
  
    // กราฟ: การเปลี่ยนแปลงสะสม (บาท/ลิตร) ของโลก(รวม VAT) เทียบไทย 90 วันล่าสุด
    const from = addDays(today, -90);
    const w = world.filter((p) => p.date >= from);
    const w0 = w[0]?.value;
    const worldCum = w.map((p) => ({ date: p.date, value: (p.value - w0) * VAT }));
    let thaiCum = [];
    const t = thai.filter((p) => p.date >= from);
    if (t.length >= 2) {
      const start = worldCum.find((p) => p.date >= t[0].date) || worldCum[0];
      const thaiAt = lookup(t);
      thaiCum = worldCum.filter((p) => p.date >= t[0].date)
        .map((p) => ({ date: p.date, value: thaiAt(p.date) - t[0].value + start.value }));
    }
  
    return {
      key: group.key, title: group.title, proxyName: group.proxyName, ok: true,
      thaiName, thaiNow: item?.today ?? thai.at(-1)?.value ?? null, thaiTomorrow: item?.tomorrow ?? null,
      worldNow: nowVal, worldUsd: proxyEntry.data.price,
      lastChange, baseDate, sinceLabel: lastChange ? 'ตั้งแต่ไทยปรับราคาครั้งล่าสุด' : 'ใน 3 วันที่ผ่านมา (ยังไม่มีประวัติการปรับของไทย)',
      estimate, announced,
      direction: announced != null ? Math.sign(announced) : estimate == null ? 0 : Math.abs(estimate) < 0.15 ? 0 : Math.sign(estimate),
      change1d: world.length > 1 ? (nowVal - worldAt(addDays(today, -1))) * VAT : null,
      change3d: (nowVal - (worldAt(addDays(today, -3)) ?? nowVal)) * VAT,
      change7d: (nowVal - (worldAt(addDays(today, -7)) ?? nowVal)) * VAT,
      chart: { world: worldCum, thai: thaiCum, thaiDays: thai.length },
    };
  }
  
  function goldSignal(worldThbNow, thaiSell) {
    const snaps = history.get().gold;
    if (snaps.length < 2 || worldThbNow == null) return { ok: false, snaps: snaps.length };
    let ref = null;
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i].thaiSell !== snaps[i - 1].thaiSell) { ref = snaps[i]; break; }
    }
    const sinceLabel = ref ? 'ตั้งแต่สมาคมฯ ปรับราคาครั้งล่าสุด' : 'ตั้งแต่เริ่มบันทึกข้อมูล';
    ref = ref || snaps[0];
    const estimate = worldThbNow - ref.worldThb;
    const since48h = Date.now() - 48 * 3600e3;
    return {
      ok: true, sinceLabel, refTime: ref.t, thaiSell,
      estimate, estimateRounded: Math.round(estimate / 50) * 50,
      direction: Math.abs(estimate) < 50 ? 0 : Math.sign(estimate),
      chart: snaps.filter((s) => s.t >= since48h).map((s) => ({ t: new Date(s.t).toISOString(), thai: s.thaiSell, world: s.worldThb })),
    };
  }
  
  async function buildData() {
    const [fx, wGold, tGold, tOil, brent, wti, rbob, ulsd, infl, ...idx] = await Promise.all([
      cached('fx', 60 * MIN, S.fetchFx),
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
  
    const usdthb = fx.data?.rates.USD ?? null;
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
      if (worldThbPerBaht && !tGold.stale) history.recordGold(tGold.data.barSell, worldThbPerBaht);
    }
    gold.signal = goldSignal(worldThbPerBaht, tGold.data?.barSell);
  
    // ---- น้ำมัน ----
    const crude = (e, name) =>
      e.data && usdthb
        ? { name, usdPerBarrel: e.data.price, thbPerLitre: (e.data.price * usdthb) / S.LITRE_PER_BARREL, change1d: pct(e.data.price, e.data.prevClose) }
        : null;
    const oil = {
      status: { thai: status(tOil), brent: status(brent), rbob: status(rbob), ulsd: status(ulsd) },
      crude: [crude(brent, 'Brent'), crude(wti, 'WTI')].filter(Boolean),
      thai: tOil.data,
      signals: [oilSignal(OIL_GROUPS[0], rbob, fxAt, usdthb, tOil.data?.items), oilSignal(OIL_GROUPS[1], ulsd, fxAt, usdthb, tOil.data?.items)],
    };
  
    // ---- หุ้น: ดัชนีต่างประเทศคิดผลตอบแทนเป็นบาท (รวมผลของค่าเงิน) ----
    const stocks = INDICES.map((meta, i) => {
      const e = idx[i];
      if (!e.data) return { ...meta, status: status(e) };
      const d = e.data;
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
      fx: { status: status(fx), ...(fx.data ? { date: fx.data.date, rates: fx.data.rates, usdthbHistory: fxH,
        change1d: fxH.length > 1 ? pct(fxH.at(-1).value, fxH.at(-2).value) : null } : {}) },
      gold, oil, stocks,
      inflation: { status: status(infl), ...(infl.data || {}) },
    };
  }

  // สำหรับบันทึก cache ไว้ใช้รอบถัดไป (ถ้าแหล่งใดดึงไม่ได้ จะใช้ค่าล่าสุดแทน)
  const exportCache = () => Object.fromEntries([...cache].filter(([, v]) => v.data));
  return { buildData, exportCache };
}
