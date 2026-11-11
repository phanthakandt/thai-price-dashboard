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
  async function cached(key, ttl, fn, onFresh, fixedTtl = false) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl * (fixedTtl ? 1 : ttlScale)) return hit;
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

  // แบบจำลองราคาน้ำมันไทย (จากข้อมูล สนพ.):
  //   ค่าการตลาดของไทยแทบคงที่ เมื่อราคาเนื้อน้ำมัน (ณ โรงกลั่น อิงสิงคโปร์) ขยับ กองทุนน้ำมันจะรับส่วนต่างไว้ก่อน
  //   แล้วราคาขายปลีกจะถูกปรับเป็นขั้น (ประมาณ 0.5–1 บาท) เมื่อแรงกดดันสะสมพอ
  //   แรงกดดัน = [ราคาเนื้อน้ำมันที่เปลี่ยนไปตั้งแต่ปรับราคาครั้งล่าสุด + ภาระที่กองทุนอุดหนุนอยู่ (−เงินกองทุน)] × 1.07
  //   (ทดสอบกับข้อมูลจริง ก.ค.–พ.ย. 2569: ทิศทางตรง 86% ของการปรับแก๊สโซฮอล์ 95 และ 73% ของดีเซล)
  const exrOf = (p) => (p.exr ?? 0) + (p.disc || 0);
  function oilModel(rows) {
    let j = 0;
    return rows.map((r, i) => {
      if (i > 0 && Math.abs(r.retail - rows[i - 1].retail) > 0.001) j = i;
      const cost = (exrOf(r) - exrOf(rows[j])) * VAT, fundLoad = -(r.fund ?? 0) * VAT;
      return { date: r.date, retail: r.retail, fund: r.fund, mm: r.mm, exr: exrOf(r), lastChangeIdx: j,
        cost, fundLoad, pressure: cost + fundLoad };
    });
  }
  // ทดสอบย้อนหลัง: ในวันที่ราคาไทยปรับจริง แรงกดดันของวันก่อนหน้าชี้ทิศเดียวกันกี่ %
  function backtestOil(model) {
    const changes = [];
    for (let i = 1; i < model.length; i++) {
      const d = model[i].retail - model[i - 1].retail;
      if (Math.abs(d) > 0.001) changes.push({ date: model[i].date, delta: d, pressure: model[i - 1].pressure });
    }
    const signaled = changes.filter((c) => Math.abs(c.pressure) >= 0.3);
    const hit = signaled.filter((c) => Math.sign(c.delta) === Math.sign(c.pressure)).length;
    // เมื่อแรงกดดันสะสม ≥ 1 บาท ราคาปรับภายใน 2 วันบ่อยแค่ไหน
    let strong = 0, followed = 0;
    for (let i = 0; i < model.length - 1; i++) {
      if (Math.abs(model[i].pressure) < 1) continue;
      const next = model.slice(i + 1, i + 3);
      if (!next.length) continue;
      strong++;
      if (next.some((x) => Math.sign(x.retail - model[i].retail) === Math.sign(model[i].pressure) && Math.abs(x.retail - model[i].retail) > 0.001)) followed++;
    }
    return {
      days: model.length, from: model[0]?.date, changes: changes.length,
      avgStep: changes.length ? changes.reduce((a, c) => a + Math.abs(c.delta), 0) / changes.length : null,
      ups: changes.filter((c) => c.delta > 0).length, downs: changes.filter((c) => c.delta < 0).length,
      n: signaled.length, hit, hitRate: signaled.length ? hit / signaled.length : null,
      strong, followed, followRate: strong ? followed / strong : null,
    };
  }

  // ---- คาดการณ์น้ำมัน 7 วัน: ในอดีต วันที่แรงกดดันอยู่ระดับเดียวกับตอนนี้ ภายใน 7 วันราคาปรับบ่อยแค่ไหน ไปทางไหน ----
  const bucketOf = (p) => (Math.abs(p) >= 1 ? 'strong' : Math.abs(p) >= 0.3 ? 'medium' : 'weak');
  function oilOutlookStats(model) {
    const stats = { strong: { n: 0, changed: 0, same: 0 }, medium: { n: 0, changed: 0, same: 0 }, weak: { n: 0, changed: 0, same: 0 } };
    const lastDate = model.at(-1)?.date;
    for (let i = 0; i < model.length; i++) {
      const r = model[i], end = addDays(r.date, 7);
      if (!lastDate || lastDate < end) break; // ต้องรู้ผล 7 วันเต็ม
      const fut = model.filter((x) => x.date > r.date && x.date <= end);
      const first = fut.find((x) => Math.abs(x.retail - r.retail) > 0.001);
      const b = stats[bucketOf(r.pressure)];
      b.n++;
      if (first) { b.changed++; if (Math.sign(first.retail - r.retail) === Math.sign(r.pressure)) b.same++; }
    }
    return stats;
  }
  function oilOutlookNow(stats, estimate, bt, priceNow) {
    if (!stats || estimate == null) return null;
    const bucket = bucketOf(estimate), st = stats[bucket];
    const dir = Math.abs(estimate) < 0.3 ? 0 : Math.sign(estimate);
    const step = bt?.avgStep ?? null;
    return { bucket, n: st.n, pChange: st.n ? st.changed / st.n : null, pSameDir: st.n ? st.same / st.n : null, dir,
      expectedPrice: dir && step && priceNow != null ? priceNow + dir * step : null, step };
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

    let model = null, estimate = null, method = 'world', structure = null, backtest = null, eppoSeries = [], outlookStats = null;
    if (eppoRows.length >= 2) {
      const rows = eppoRows.map((r) => ({ date: r.date, ...r.p[group.eppo] }));
      eppoSeries = oilModel(rows);
      backtest = backtestOil(eppoSeries);
      outlookStats = oilOutlookStats(eppoSeries);
      const last = eppoSeries.at(-1), lastP = rows.at(-1);
      const wBase = worldAt(addDays(last.date, -1));
      const dExr = wBase != null ? nowVal - wBase : 0;  // ราคาโลกหลังวันที่ของไฟล์ สนพ. (ประมาณจากตลาดนิวยอร์ก)
      let base, cost;
      if (lastChange && lastChange.date > last.date) {
        // ราคาหน้าปั๊มปรับหลังวันที่ของไฟล์ สนพ.: นับต้นทุนจากราคาโลกตั้งแต่วันก่อนปรับ
        const w0 = worldAt(addDays(lastChange.date, -1));
        cost = (w0 != null ? nowVal - w0 : dExr) * VAT;
        base = { date: lastChange.date, exr: null };
      } else {
        const j = eppoSeries[last.lastChangeIdx];
        cost = last.cost + dExr * VAT;
        base = { date: j.date, exr: j.exr };
      }
      // กองทุนต้องรับการขยับของตลาดโลกหลังวันที่ของไฟล์ สนพ. ด้วย (ถ้ายังไม่ปรับราคา)
      const fundEst = (last.fund ?? 0) - dExr;
      const fundLoad = -fundEst * VAT;
      estimate = cost + fundLoad;
      method = 'eppo';
      model = { eppoDate: last.date, exrNow: last.exr, base, dExr, cost, fundLoad, fundEst, fund: last.fund, mm: last.mm,
        fundAtBase: base.exr != null ? eppoSeries[last.lastChangeIdx].fund : null };
      const exr = exrOf(lastP), tax = lastP.excise * 1.1;
      structure = { exr, tax, fund: lastP.fund, mm: lastP.mm, retail: lastP.retail, other: lastP.retail - exr - tax - lastP.fund - lastP.mm };
    }
    if (estimate == null) {
      // สำรอง: ราคาโลกเปลี่ยนไปเท่าไรตั้งแต่ไทยปรับครั้งล่าสุด
      const baseDate = lastChange ? addDays(lastChange.date, -1) : addDays(today, -3);
      const baseVal = worldAt(baseDate);
      estimate = baseVal != null ? (nowVal - baseVal) * VAT : null;
    }

    // กราฟ 90 วัน: ราคาเนื้อน้ำมันที่เปลี่ยนไป (× 1.07) เทียบราคาขายปลีกไทยที่เปลี่ยนไป ตั้งต้นที่ 0 วันเดียวกัน
    const from = addDays(today, -90);
    let worldCum = [], thaiCum = [];
    const t = thai.filter((p) => p.date >= from);
    let costSeries = eppoSeries.length >= 2
      ? eppoSeries.filter((p) => p.date >= from).map((p) => ({ date: p.date, value: p.exr }))
      : world.filter((p) => p.date >= from);
    if (eppoSeries.length >= 2 && model) {
      // ต่อหางด้วยการขยับของตลาดโลกหลังวันที่ของไฟล์ สนพ.
      const lastC = costSeries.at(-1);
      if (lastC && today > lastC.date) costSeries.push({ date: today, value: lastC.value + model.dExr });
    }
    if (costSeries.length) {
      const c0 = costSeries[0];
      worldCum = costSeries.map((p) => ({ date: p.date, value: (p.value - c0.value) * VAT }));
      if (t.length >= 2) {
        const thaiAt = lookup(t);
        const t0 = thaiAt(c0.date) ?? t[0].value;
        thaiCum = worldCum.map((p) => ({ date: p.date, value: (thaiAt(p.date) ?? t0) - t0 }));
      }
    }
    const fundHist = eppoRows.filter((r) => r.date >= from).map((r) => ({ date: r.date, value: r.p[group.eppo].fund }));

    return {
      outlook: oilOutlookNow(outlookStats, estimate, backtest, item?.today ?? thai.at(-1)?.value),
      key: group.key, title: group.title, proxyName: group.proxyName, ok: true, method,
      thaiName: bcName || eppoRows.at(-1)?.p[group.eppo] && group.title, thaiNow, thaiTomorrow: item?.tomorrow ?? null,
      worldNow: nowVal, worldUsd: proxyEntry.data.price, lastChange, estimate, announced, model, structure, backtest,
      direction: announced != null ? Math.sign(announced) : estimate == null ? 0 : Math.abs(estimate) < 0.3 ? 0 : Math.sign(estimate),
      change1d: (nowVal - (worldAt(addDays(today, -1)) ?? nowVal)) * VAT,
      change3d: (nowVal - (worldAt(addDays(today, -3)) ?? nowVal)) * VAT,
      change7d: (nowVal - (worldAt(addDays(today, -7)) ?? nowVal)) * VAT,
      chart: { world: worldCum, thai: thaiCum, thaiDays: t.length, fund: fundHist, costLabel: eppoSeries.length >= 2 ? 'ราคาเนื้อน้ำมัน (สนพ.)' : 'ราคาโลก' },
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

  // ---- ช่วงราคาที่น่าจะเป็น (คิดจากความผันผวนในอดีต สมมติว่าราคาเดินแบบสุ่ม ไม่เดาทิศทาง) ----
  const tradingDays = (cal) => Math.max(1, Math.round((cal * 5) / 7));
  const stdev = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  function volCone(series, now, label, unit, decimals = 2) {
    const v = series.filter((p) => p.value > 0);
    if (v.length < 70 || !now) return null;
    const rets = v.slice(1).map((p, i) => Math.log(p.value / v[i].value));
    const sigma = stdev(rets.slice(-60));
    const band = (cal) => { const sd = sigma * Math.sqrt(tradingDays(cal));
      return { lo68: now * Math.exp(-sd), hi68: now * Math.exp(sd), lo95: now * Math.exp(-1.96 * sd), hi95: now * Math.exp(1.96 * sd) }; };
    // ทดสอบย้อนหลัง: ช่วง 7 วัน (5 วันทำการ) ครอบคลุมราคาจริงกี่ %
    let n = 0, in68 = 0, in95 = 0;
    for (let i = 60; i + 5 < v.length; i++) {
      const sd = stdev(rets.slice(i - 60, i)) * Math.sqrt(5), base = v[i].value, act = v[i + 5].value, z = Math.abs(Math.log(act / base)) / sd;
      n++; if (z <= 1) in68++; if (z <= 1.96) in95++;
    }
    const today = bkkDate();
    const from = addDays(today, -90);
    return {
      label, unit, decimals, now, sigmaDaily: sigma * 100,
      horizons: [1, 7, 30].map((d) => ({ days: d, ...band(d) })),
      backtest: { n, cover68: n ? in68 / n : null, cover95: n ? in95 / n : null },
      chart: {
        history: v.filter((p) => p.date >= from).map((p) => ({ date: p.date, value: p.value })).concat(v.at(-1).date < today ? [{ date: today, value: now }] : []),
        cone: [{ date: today, ...band(0.0001), lo68: now, hi68: now, lo95: now, hi95: now }]
          .concat(Array.from({ length: 30 }, (_, k) => ({ date: addDays(today, k + 1), ...band(k + 1) }))),
      },
    };
  }

  // บันทึกช่วงคาดการณ์ 7 วันวันละครั้ง แล้วตรวจผลเมื่อครบกำหนด (ความแม่นแบบเดินหน้า ไม่ใช่ทดสอบย้อนหลัง)
  function trackForecast(key, cone, actualAt) {
    if (!cone) return null;
    const today = bkkDate(), h7 = cone.horizons.find((h) => h.days === 7);
    history.recordForecast(key, { made: today, horizon: 7, target: addDays(today, 7), base: cone.now,
      lo68: h7.lo68, hi68: h7.hi68, lo95: h7.lo95, hi95: h7.hi95 });
    const done = (history.get().forecasts || []).filter((f) => f.key === key && f.target <= today);
    let n = 0, in68 = 0, in95 = 0;
    for (const f of done) {
      const a = actualAt(f.target);
      if (a == null) continue;
      n++; if (a >= f.lo68 && a <= f.hi68) in68++; if (a >= f.lo95 && a <= f.hi95) in95++;
    }
    return { n, cover68: n ? in68 / n : null, cover95: n ? in95 / n : null, pending: (history.get().forecasts || []).filter((f) => f.key === key && f.target > today).length };
  }

  function imfFrom(entry, status) {
    const d = entry.data?.data;
    if (!d) return { status: status(entry) };
    const y0 = new Date().getUTCFullYear();
    const years = [y0 - 2, y0 - 1, y0, y0 + 1, y0 + 2].map(String);
    const rows = Object.entries(S.IMF_INDICATORS || {}).map(([k, name]) => ({
      key: k, name,
      th: years.map((y) => d[k]?.THA?.[y] ?? null),
      world: years.map((y) => d[k]?.WLD?.[y] ?? null),
    }));
    return { status: status(entry), years, projectedFrom: String(y0), rows };
  }

  // ---------- GDP การค้า ดุลบัญชี: ไทยเทียบเพื่อนบ้าน ----------
  function macroFrom(peersE, tradeE, o, status) {
    const P = S.PEERS || {}, y0 = new Date().getUTCFullYear(), Y = (k) => String(k);
    const years = [y0 - 2, y0 - 1, y0, y0 + 1, y0 + 2].map(String);
    const d = peersE.data?.data, t = tradeE.data?.data;
    const fx = o.fx.live?.usdthb ?? o.fx.rates?.USD ?? null;
    const out = { status: { peers: status(peersE), trade: status(tradeE) }, years, projectedFrom: Y(y0), fx };
    // ปีล่าสุดที่เป็นตัวเลขจริง (ไม่ใช่คาดการณ์) ตาม WEO = ปีที่แล้ว
    const ya = Y(y0 - 1);
    if (d) {
      out.countries = Object.entries(P).filter(([c]) => d.NGDP_RPCH?.[c]).map(([code, name]) => ({
        code, name,
        growth: years.map((y) => d.NGDP_RPCH?.[code]?.[y] ?? null),
        gdp: d.NGDPD?.[code]?.[ya] ?? null,
        gdpNow: d.NGDPD?.[code]?.[Y(y0)] ?? null,
        gdppc: d.NGDPDPC?.[code]?.[ya] ?? null,
        ca: years.map((y) => d.BCA_NGDPD?.[code]?.[y] ?? null),
        caUsd: d.BCA?.[code]?.[ya] ?? null,
      }));
      out.world = years.map((y) => d.NGDP_RPCH?.WEOWORLD?.[y] ?? null);
      out.actualYear = ya;
      // อันดับการเติบโตปีนี้ในกลุ่มเพื่อนบ้าน
      const i0 = years.indexOf(Y(y0));
      const ranked = out.countries.filter((c) => c.growth[i0] != null).sort((a, b) => b.growth[i0] - a.growth[i0]);
      out.rank = { year: Y(y0), pos: ranked.findIndex((c) => c.code === 'THA') + 1, of: ranked.length };
    }
    if (t) {
      const series = (c) => {
        const x = t[c]?.x || [], m = t[c]?.m || [];
        const mm = new Map(m.map((p) => [p.date, p.value]));
        const bb = new Map((t[c]?.b || []).map((p) => [p.date, p.value]));
        return x.filter((p) => mm.has(p.date)).map((p) => ({ date: p.date, x: p.value, m: mm.get(p.date), b: bb.get(p.date) ?? p.value - mm.get(p.date) }));
      };
      const sameLastYear = (rows, date) => rows.find((r) => r.date === `${+date.slice(0, 4) - 1}${date.slice(4)}`);
      const summary = (c) => {
        const rows = series(c);
        if (rows.length < 13) return null;
        const last = rows.at(-1), prev = sameLastYear(rows, last.date);
        const yr = last.date.slice(0, 4), mo = last.date.slice(5);
        const ytd = rows.filter((r) => r.date.slice(0, 4) === yr);
        const ytdPrev = rows.filter((r) => r.date.slice(0, 4) === String(+yr - 1) && r.date.slice(5) <= mo);
        const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
        const l12 = rows.slice(-12), p12 = rows.slice(-24, -12);
        return {
          rows, last, months: ytd.length,
          xYoy: prev ? pct(last.x, prev.x) : null, mYoy: prev ? pct(last.m, prev.m) : null,
          ytd: { x: sum(ytd, 'x'), m: sum(ytd, 'm'), b: sum(ytd, 'b'),
            xG: ytdPrev.length === ytd.length ? pct(sum(ytd, 'x'), sum(ytdPrev, 'x')) : null,
            mG: ytdPrev.length === ytd.length ? pct(sum(ytd, 'm'), sum(ytdPrev, 'm')) : null,
            bPrev: ytdPrev.length === ytd.length ? sum(ytdPrev, 'b') : null },
          r12: { x: sum(l12, 'x'), m: sum(l12, 'm'), b: sum(l12, 'b'), xG: p12.length === 12 ? pct(sum(l12, 'x'), sum(p12, 'x')) : null },
          // เดือนติดกันที่ส่งออกโต (YoY) และดุลการค้าเกินดุล
          xStreak: (() => { let n = 0, s0 = null; for (let i = rows.length - 1; i >= 0; i--) { const p = sameLastYear(rows, rows[i].date); if (!p) break; const sg = Math.sign(rows[i].x - p.x); if (s0 == null) s0 = sg; if (sg !== s0 || !sg) break; n++; } return { dir: s0, n }; })(),
          surplusMonths: rows.slice(-12).filter((r) => r.b > 0).length,
        };
      };
      const th = summary('THA');
      if (th) {
        out.trade = { ...th, rows: th.rows.slice(-36) };
        const gdp = d?.NGDPD?.THA?.[ya];
        if (gdp) out.trade.openness = ((th.r12.x + th.r12.m) / 1000) / gdp * 100;
      }
      out.peerTrade = Object.entries(P).map(([code, name]) => {
        const s = summary(code);
        return s ? { code, name, date: s.last.date, x: s.last.x, xYoy: s.xYoy, ytdXG: s.ytd.xG, ytdB: s.ytd.b, months: s.months, r12x: s.r12.x } : { code, name };
      });
    }
    out.insights = macroInsights(out);
    return out;
  }

  function macroInsights(mx) {
    const L = [], bn = (v) => n1(v / 1000);
    const thM = (d) => `${['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][+d.slice(5) - 1]} ${+d.slice(0, 4) + 543}`;
    const tr = mx.trade;
    if (tr) {
      const l = tr.last;
      L.push(`${thM(l.date)} ไทยส่งออก ${bn(l.x)} พันล้านดอลลาร์${tr.xYoy != null ? ` ${tr.xYoy >= 0 ? 'โต' : 'หด'} ${n1(Math.abs(tr.xYoy))}% จากเดือนเดียวกันปีก่อน` : ''} นำเข้า ${bn(l.m)} พันล้านดอลลาร์ ${l.b >= 0 ? `เกินดุลการค้า ${bn(l.b)}` : `ขาดดุลการค้า ${bn(-l.b)}`} พันล้านดอลลาร์${mx.fx ? ` (ราว ${Math.round(Math.abs(l.b) * mx.fx / 1000).toLocaleString('th-TH')} พันล้านบาท)` : ''}`);
      if (tr.ytd.xG != null) L.push(`ตั้งแต่ต้นปีถึง ${thM(l.date)} ส่งออกรวม${tr.ytd.xG >= 0 ? 'โต' : 'หด'} ${n1(Math.abs(tr.ytd.xG))}% นำเข้า${tr.ytd.mG >= 0 ? 'โต' : 'หด'} ${n1(Math.abs(tr.ytd.mG))}%${tr.ytd.mG != null && tr.ytd.xG != null ? (tr.ytd.mG > tr.ytd.xG + 2 ? ' นำเข้าโตเร็วกว่าส่งออก ดุลการค้าจึงแคบลง' : tr.ytd.xG > tr.ytd.mG + 2 ? ' ส่งออกโตเร็วกว่านำเข้า ดุลการค้าจึงดีขึ้น' : '') : ''}`);
      if (tr.xStreak?.n >= 3) L.push(`ส่งออก${tr.xStreak.dir > 0 ? 'โต' : 'หด'}ต่อเนื่อง ${tr.xStreak.n} เดือนติด (เทียบเดือนเดียวกันปีก่อน)`);
      if (tr.openness) L.push(`ส่งออกบวกนำเข้าสินค้า 12 เดือนล่าสุดเท่ากับราว ${Math.round(tr.openness)}% ของ GDP เศรษฐกิจไทยจึงขึ้นกับการค้าโลกมาก ถ้าคู่ค้าชะลอตัว รายได้ของโรงงานและแรงงานในไทยจะได้รับผลตาม`);
    }
    const pt = (mx.peerTrade || []).filter((p) => p.xYoy != null);
    if (pt.length >= 3) {
      const r = [...pt].sort((a, b) => b.xYoy - a.xYoy), pos = r.findIndex((p) => p.code === 'THA') + 1;
      if (pos) L.push(`การส่งออกเดือนล่าสุดของไทยโตเป็นอันดับ ${pos} จาก ${r.length} ประเทศในภูมิภาคที่มีข้อมูล (สูงสุด: ${r[0].name} ${r[0].xYoy >= 0 ? '+' : '−'}${n1(Math.abs(r[0].xYoy))}%)`);
    }
    const cs = mx.countries;
    if (cs) {
      const i0 = mx.years.indexOf(mx.projectedFrom), th = cs.find((c) => c.code === 'THA');
      const avg = cs.filter((c) => c.code !== 'THA' && c.growth[i0] != null), mean = avg.reduce((s, c) => s + c.growth[i0], 0) / (avg.length || 1);
      if (th?.growth[i0] != null) L.push(`IMF คาดว่าปี ${+mx.projectedFrom + 543} GDP ไทยโต ${n1(th.growth[i0])}% ${th.growth[i0] < mean - 0.5 ? 'ต่ำกว่า' : th.growth[i0] > mean + 0.5 ? 'สูงกว่า' : 'ใกล้เคียง'}ค่าเฉลี่ยเพื่อนบ้าน (${n1(mean)}%)${mx.rank?.pos ? ` อยู่อันดับ ${mx.rank.pos} จาก ${mx.rank.of}` : ''}${mx.world?.[i0] != null ? ` และเศรษฐกิจโลก ${n1(mx.world[i0])}%` : ''}`);
      const ia = mx.years.indexOf(mx.actualYear);
      if (th?.ca[ia] != null) L.push(`ดุลบัญชีเดินสะพัดปี ${+mx.actualYear + 543} ${th.ca[ia] >= 0 ? 'เกินดุล' : 'ขาดดุล'} ${n1(Math.abs(th.ca[ia]))}% ของ GDP${th.caUsd != null ? ` (${n1(Math.abs(th.caUsd))} พันล้านดอลลาร์)` : ''} ${th.ca[ia] >= 0 ? 'เงินตราต่างประเทศไหลเข้ามากกว่าไหลออก ช่วยพยุงค่าเงินบาท' : 'เงินไหลออกมากกว่าเข้า กดดันให้บาทอ่อน'}`);
    }
    return L;
  }

  function buildForecast(o, { goldFut, fxLive, brent, fxAt }) {
    const items = [];
    const fxNow = o.fx.live?.usdthb ?? o.fx.rates?.USD;
    // ทองไทย: Gold futures × ค่าเงินของวันนั้น × (15.244 × 0.965 / 31.1035) + ส่วนต่างของสมาคมฯ ตอนนี้
    const g = o.gold;
    if (goldFut.data && fxAt && g.thai?.barSell && g.factor) {
      const fxLiveAt = fxLive.data ? lookup(fxLive.data.history) : fxAt;
      const raw = goldFut.data.history.map((p) => ({ date: p.date, value: p.value * (fxLiveAt(p.date) ?? fxAt(p.date)) * g.factor }));
      const premium = g.thai.barSell - (g.worldUsdPerOz && fxNow ? g.worldUsdPerOz * fxNow * g.factor : raw.at(-1).value);
      const series = raw.map((p) => ({ date: p.date, value: p.value + premium }));
      const cone = volCone(series, g.thai.barSell, 'ทองคำแท่ง (ขายออก)', 'บาท', 0);
      if (cone) { cone.key = 'gold'; cone.tracking = trackForecast('gold', cone, lookup(series)); items.push(cone); }
    }
    if (fxLive.data) {
      const cone = volCone(fxLive.data.history, fxNow, 'ค่าเงิน USD/THB', 'บาท', 2);
      if (cone) { cone.key = 'usdthb'; cone.tracking = trackForecast('usdthb', cone, lookup(fxLive.data.history)); items.push(cone); }
    }
    if (brent.data) {
      const cone = volCone(brent.data.history, brent.data.price, 'น้ำมันดิบ Brent', 'USD/บาร์เรล', 2);
      if (cone) { cone.key = 'brent'; cone.tracking = trackForecast('brent', cone, lookup(brent.data.history)); items.push(cone); }
    }
    const set = o.stocks.find((x) => x.symbol === '^SET.BK');
    if (set?.historyThb?.length) {
      const cone = volCone(set.historyThb, set.price, 'ดัชนี SET', 'จุด', 2);
      if (cone) { cone.key = 'set'; cone.tracking = trackForecast('set', cone, lookup(set.historyThb)); items.push(cone); }
    }
    const oil = (o.oil.signals || []).filter((x) => x.ok && x.outlook).map((x) => ({ key: x.key, title: x.title, thaiNow: x.thaiNow, announced: x.announced, ...x.outlook }));
    return { ranges: items, oil };
  }

  // ---- ค่าครองชีพด้านพลังงานในบ้าน: LPG (จาก สนพ.) และค่าไฟผันแปร Ft (จาก กกพ.) ----
  function energyFrom(ftE, status) {
    const rows = (history.get().eppo || []).filter((r) => r.p.lpg?.retail != null);
    const last = rows.at(-1);
    let lpg = null;
    if (last) {
      const p = last.p.lpg, from = addDays(bkkDate(), -120);
      const series = rows.filter((r) => r.date >= from).map((r) => ({ date: r.date, value: r.p.lpg.retail }));
      let lastChange = null;
      for (let i = series.length - 1; i > 0; i--) if (Math.abs(series[i].value - series[i - 1].value) > 0.001) { lastChange = { date: series[i].date, delta: series[i].value - series[i - 1].value }; break; }
      lpg = { date: last.date, perKg: p.retail, tank15: p.retail * 15, fund: p.fund, exr: (p.exr ?? 0) + (p.disc || 0), lastChange,
        series, fundSeries: rows.filter((r) => r.date >= from).map((r) => ({ date: r.date, value: r.p.lpg.fund })) };
    }
    let ft = null;
    const per = ftE.data?.periods;
    if (per?.length) {
      const nowM = bkkDate().slice(0, 7);
      const cur = [...per].reverse().find((x) => x.from <= nowM) || per.at(-1);
      const idx = per.indexOf(cur);
      const next = per.find((x) => x.from > nowM) || null; // ถ้า กกพ. ประกาศงวดถัดไปแล้ว
      ft = { current: cur, previous: per[idx - 1] || null, next, change: per[idx - 1] ? cur.ft - per[idx - 1].ft : null, history: per,
        fallback: !!ftE.data.fallback, checked: ftE.data.checked || null };
      // ถ้าใช้ค่าสำรองและเลยงวดสุดท้ายที่บันทึกไว้แล้ว ให้เตือนว่าอาจไม่เป็นปัจจุบัน
      if (ft.fallback && per.at(-1).to < nowM) ft.stale = true;
    }
    return { status: { ft: status(ftE) }, lpg, ft };
  }

  // ---- ตราสารหนี้: อัตราผลตอบแทนพันธบัตรรัฐบาลไทย เทียบสหรัฐ ----
  // ช่วงคาดการณ์ของ "อัตราผลตอบแทน" ใช้การเปลี่ยนแปลงแบบบวกลบ (จุดเปอร์เซ็นต์) ไม่ใช่แบบร้อยละ
  function volConeAdd(series, now, label, unit, decimals = 2) {
    const v = series.filter((p) => p.value != null);
    if (v.length < 70 || now == null) return null;
    const ch = v.slice(1).map((p, i) => p.value - v[i].value);
    const sigma = stdev(ch.slice(-60));
    const band = (cal) => { const sd = sigma * Math.sqrt(tradingDays(cal)); return { lo68: now - sd, hi68: now + sd, lo95: now - 1.96 * sd, hi95: now + 1.96 * sd }; };
    let n = 0, in68 = 0, in95 = 0;
    for (let i = 60; i + 5 < v.length; i++) {
      const sd = stdev(ch.slice(i - 60, i)) * Math.sqrt(5), z = Math.abs(v[i + 5].value - v[i].value) / sd;
      n++; if (z <= 1) in68++; if (z <= 1.96) in95++;
    }
    const today = bkkDate(), from = addDays(today, -90);
    return {
      label, unit, decimals, now, sigmaDaily: sigma * 100, additive: true,
      horizons: [1, 7, 30].map((d) => ({ days: d, ...band(d) })),
      backtest: { n, cover68: n ? in68 / n : null, cover95: n ? in95 / n : null },
      chart: {
        history: v.filter((p) => p.date >= from).concat(v.at(-1).date < today ? [{ date: today, value: now }] : []),
        cone: [{ date: today, lo68: now, hi68: now, lo95: now, hi95: now }].concat(Array.from({ length: 30 }, (_, k) => ({ date: addDays(today, k + 1), ...band(k + 1) }))),
      },
    };
  }

  function bondsFrom(entry, tnxEntry, o, status) {
    const rows = entry.data?.rows;
    if (!rows?.length) return { status: status(entry) };
    const T = S.BOND_TENORS || [], last = rows.at(-1);
    const rowAt = (date) => [...rows].reverse().find((r) => r.date <= date) || rows[0];
    const prev = rows.at(-2), m1 = rowAt(addDays(last.date, -30)), y1 = rowAt(addDays(last.date, -365));
    const bp = (a, b) => (a != null && b != null ? (a - b) * 100 : null);
    const key = ['1Y', '2Y', '5Y', '10Y', '30Y'].map((t) => ({ tenor: t, yield: last[t], d1: bp(last[t], prev?.[t]), m1: bp(last[t], m1[t]), y1: bp(last[t], y1[t]) }));
    const curve = (r) => T.filter((t) => r[t] != null).map((t) => ({ date: t, value: r[t] }));
    // ส่วนต่างกับสหรัฐ (พันธบัตร 10 ปี)
    const us = tnxEntry?.data;
    let spread = null;
    if (us) {
      const usAt = lookup(us.history);
      const from = addDays(last.date, -365);
      const hist = rows.filter((r) => r.date >= from).map((r) => { const u = usAt(r.date); return u != null ? { date: r.date, value: r['10Y'] - u } : null; }).filter(Boolean);
      const usNow = us.price;
      spread = { us10: usNow, th10: last['10Y'], now: last['10Y'] - usNow, m1: hist.length ? (lookup(hist)(addDays(last.date, -30)) ?? null) : null, history: hist,
        usHistory: us.history.filter((p) => p.date >= from), thHistory: rows.filter((r) => r.date >= from).map((r) => ({ date: r.date, value: r['10Y'] })) };
    }
    // ผลตอบแทนแท้จริง = 10 ปี − เงินเฟ้อ (ประมาณการปีนี้ของ IMF ถ้ามี)
    const imf = o.forecast?.imf, y0 = String(new Date().getUTCFullYear());
    const inflRow = imf?.rows?.find((r) => r.key === 'PCPIPCH');
    const infl = inflRow ? inflRow.th[imf.years.indexOf(y0)] : o.inflation?.thailand?.at(-1)?.value ?? null;
    const slope = { now: bp(last['10Y'], last['2Y']), m1: bp(m1['10Y'], m1['2Y']), y1: bp(y1['10Y'], y1['2Y']) };
    // ราคาพันธบัตรเปลี่ยนโดยประมาณ ≈ −ดูเรชัน × การเปลี่ยนของ yield (ดูเรชันแบบปรับแก้ของพันธบัตร 5 และ 10 ปีที่ดอกเบี้ยราว 1.5–2%)
    const DUR = { '5Y': 4.8, '10Y': 9.0 };
    const priceEffect = ['5Y', '10Y'].map((t) => ({ tenor: t, m1: -DUR[t] * (last[t] - m1[t]), y1: -DUR[t] * (last[t] - y1[t]) }));
    const series10 = rows.map((r) => ({ date: r.date, value: r['10Y'] }));
    const cone = volConeAdd(series10, last['10Y'], 'พันธบัตรรัฐบาลไทย 10 ปี', '%', 2);
    if (cone) { cone.key = 'th10y'; cone.tracking = trackForecast('th10y', cone, lookup(series10)); (o.forecast.ranges ||= []).push(cone); }
    const out = {
      status: status(entry), date: last.date, key, slope, spread, infl, real10: infl != null ? last['10Y'] - infl : null, priceEffect,
      curves: [{ label: `ล่าสุด (${last.date})`, points: curve(last) }, { label: `1 เดือนก่อน (${m1.date})`, points: curve(m1) }, { label: `1 ปีก่อน (${y1.date})`, points: curve(y1) }],
    };
    out.insights = bondInsights(out);
    return out;
  }

  function bondInsights(b) {
    const L = [], k10 = b.key.find((k) => k.tenor === '10Y'), k2 = b.key.find((k) => k.tenor === '2Y');
    const bpTxt = (v) => `${v > 0 ? '+' : '−'}${Math.abs(Math.round(v))} bp`;
    if (k10) L.push(`พันธบัตรรัฐบาลไทยอายุ 10 ปีให้ผลตอบแทน ${k10.yield.toFixed(2)}%${k10.m1 != null ? ` เปลี่ยน ${bpTxt(k10.m1)} ใน 1 เดือน` : ''}${k10.y1 != null ? ` และ ${bpTxt(k10.y1)} ใน 1 ปี` : ''} (1 bp = 0.01%)`);
    const pe = b.priceEffect.find((p) => p.tenor === '10Y');
    if (pe && Math.abs(pe.m1) >= 0.3) L.push(`ผลตอบแทนที่${pe.m1 > 0 ? 'ลดลง' : 'สูงขึ้น'}ทำให้ราคาพันธบัตร 10 ปี${pe.m1 > 0 ? 'เพิ่มขึ้น' : 'ลดลง'}ราว ${n1(Math.abs(pe.m1))}% ใน 1 เดือน กองทุนตราสารหนี้ระยะยาวจะ${pe.m1 > 0 ? 'ได้ประโยชน์' : 'ขาดทุนจากราคา'}ตามไปด้วย`);
    if (b.slope.now != null) {
      const s = b.slope.now;
      L.push(s < 0 ? `เส้นอัตราผลตอบแทนกลับหัว (10 ปีต่ำกว่า 2 ปี ${Math.abs(Math.round(s))} bp) มักสะท้อนว่าตลาดคาดเศรษฐกิจชะลอและดอกเบี้ยจะลดลง`
        : s < 50 ? `เส้นอัตราผลตอบแทนค่อนข้างแบน (10 ปีสูงกว่า 2 ปีเพียง ${Math.round(s)} bp) ตลาดยังไม่คาดว่าเศรษฐกิจจะเร่งตัว`
        : `เส้นอัตราผลตอบแทนชัน (10 ปีสูงกว่า 2 ปี ${Math.round(s)} bp)${b.slope.m1 != null && s - b.slope.m1 > 10 ? ' และชันขึ้นในเดือนที่ผ่านมา' : ''}`);
    }
    if (k2 && b.key.find((k) => k.tenor === '1Y')) {
      const short = b.key.find((k) => k.tenor === '1Y');
      if (short.m1 != null && short.m1 <= -10) L.push(`ผลตอบแทนระยะสั้น (1 ปี) ลดลง ${Math.abs(Math.round(short.m1))} bp ใน 1 เดือน ตลาดอาจกำลังคาดว่า กนง. จะลดดอกเบี้ย`);
      if (short.m1 != null && short.m1 >= 10) L.push(`ผลตอบแทนระยะสั้น (1 ปี) เพิ่มขึ้น ${Math.round(short.m1)} bp ใน 1 เดือน ตลาดอาจลดความคาดหวังเรื่องการลดดอกเบี้ย`);
    }
    if (b.spread) {
      const sp = b.spread.now;
      L.push(`ผลตอบแทน 10 ปีของไทย${sp < 0 ? 'ต่ำกว่า' : 'สูงกว่า'}สหรัฐ ${Math.abs(sp).toFixed(2)} จุด (${b.spread.th10.toFixed(2)}% เทียบ ${b.spread.us10.toFixed(2)}%)${sp < 0 ? ' นักลงทุนต่างชาติจึงได้ผลตอบแทนจากพันธบัตรไทยน้อยกว่า เป็นแรงกดดันให้เงินไหลออกและบาทอ่อนได้' : ''}`);
    }
    if (b.real10 != null) L.push(`หักเงินเฟ้อที่ IMF คาดไว้ปีนี้ (${n1(b.infl)}%) ผลตอบแทนแท้จริงของพันธบัตร 10 ปีอยู่ที่ราว ${b.real10 >= 0 ? '' : '−'}${n1(Math.abs(b.real10))}%${b.real10 < 0 ? ' คือถือพันธบัตรแล้วอำนาจซื้อลดลง' : ''}`);
    return L;
  }

  // ---- รวมความแม่นของทุกการคาดการณ์ไว้ที่เดียว ----
  function accuracyFrom(o) {
    const rows = [];
    for (const s of o.oil.signals || []) {
      if (!s.ok || !s.backtest) continue;
      rows.push({ topic: 'น้ำมัน', what: `${s.title}: ทิศทางเมื่อราคาปรับจริง`, kind: 'ย้อนหลัง', n: s.backtest.n, rate: s.backtest.hitRate, target: null,
        note: `${s.backtest.days} วัน ปรับ ${s.backtest.changes} ครั้ง` });
      rows.push({ topic: 'น้ำมัน', what: `${s.title}: ปรับภายใน 2 วันเมื่อแรงกดดันเกิน 1 บาท`, kind: 'ย้อนหลัง', n: s.backtest.strong, rate: s.backtest.followRate, target: null, note: 'บอกช่วงเวลาได้ยาก' });
    }
    const ga = o.gold.accuracy;
    rows.push({ topic: 'ทอง', what: 'ทิศทางที่สมาคมฯ ปรับครั้งถัดไป เมื่อราคาโลกต่าง ≥ 100 บาท', kind: 'บันทึกจริง', n: ga?.n || 0, rate: ga?.hitRate ?? null, target: null, note: `${ga?.snapshots ?? 0} จุดข้อมูล` });
    for (const r of o.forecast?.ranges || []) {
      rows.push({ topic: r.label, what: 'ช่วง 7 วัน (68%) ครอบคลุมราคาจริง', kind: 'ย้อนหลัง', n: r.backtest.n, rate: r.backtest.cover68, target: 0.68, note: `ช่วง 95% ครอบคลุม ${Math.round(r.backtest.cover95 * 100)}%` });
      if (r.tracking) rows.push({ topic: r.label, what: 'ช่วง 7 วัน (68%) ครอบคลุมราคาจริง', kind: 'บันทึกจริง', n: r.tracking.n, rate: r.tracking.cover68, target: 0.68, note: r.tracking.pending ? `รอครบกำหนด ${r.tracking.pending} รายการ` : '' });
    }
    return rows;
  }

  // ---- เหตุการณ์ที่ควรแจ้งเตือน (ส่งจริงใน scripts/build-data.mjs ถ้าตั้งค่า Telegram ไว้) ----
  function alertEvents(o) {
    const ev = [], today = bkkDate();
    for (const s of o.oil.signals || []) {
      if (s.ok && s.announced != null)
        ev.push({ key: `oil:${s.key}:${today}:${s.thaiTomorrow}`, text: `⛽ ${s.thaiName}: พรุ่งนี้${s.announced > 0 ? 'ขึ้น' : 'ลง'} ${n1(Math.abs(s.announced))} บาท/ลิตร เป็น ${n1(s.thaiTomorrow)} บาท` });
    }
    const g = o.gold.signal;
    if (g?.ok && Math.abs(g.estimate) >= 200)
      ev.push({ key: `gold:${today}:${Math.sign(g.estimate)}:${Math.round(g.thaiSell / 100)}`, text: `🥇 ราคาโลกชี้ว่าทองคำแท่งน่าจะ${g.estimate > 0 ? 'ขึ้น' : 'ลง'}ประมาณ ${Math.abs(g.estimateRounded).toLocaleString('th-TH')} บาท (ตอนนี้ขายออก ${g.thaiSell.toLocaleString('th-TH')})` });
    const prev = history.getMeta('sectorVerdicts') || {};
    const nowV = {};
    for (const x of (o.sectors?.sectors || []).filter((x) => x.ok)) {
      nowV[x.key] = x.verdict;
      if (prev[x.key] != null && prev[x.key] !== x.verdict && x.verdict !== 0)
        ev.push({ key: `sector:${x.key}:${today}:${x.verdict}`, text: `📊 กลุ่ม${x.name} เปลี่ยนเป็น "${x.verdict > 0 ? 'ไปได้สวย' : 'ซบเซา'}" (${x.signals.join(', ')})` });
    }
    if (Object.keys(nowV).length) history.setMeta('sectorVerdicts', nowV);
    // สรุปเช้า: ส่งรอบแรกหลัง 7 โมง (เวลาไทย)
    const hourBkk = new Date(Date.now() + 7 * 3600e3).getUTCHours();
    if (hourBkk >= 7 && o.summary?.length)
      ev.push({ key: `daily:${today}`, text: `☀️ สรุปเช้า ${today}\n` + o.summary.map((x) => `• [${x.tag}] ${x.text}`).join('\n') });
    return ev;
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
    { key: 'econ', title: 'เศรษฐกิจ/การค้า', q: '(ส่งออกไทย OR GDP ไทย OR ดุลการค้า OR สภาพัฒน์ OR เศรษฐกิจไทย) when:3d' },
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

  // ---- กลุ่มธุรกิจ: หุ้นหลักของแต่ละกลุ่ม + ภาคธุรกิจในข้อมูลการจ้างงาน (ISIC) ----
  const SECTORS = [
    { key: 'bank', name: 'ธนาคาร', isic: ['K'], stocks: ['KBANK.BK', 'SCB.BK', 'BBL.BK', 'KTB.BK'] },
    { key: 'finance', name: 'สินเชื่อและประกัน', isic: ['K'], stocks: ['KTC.BK', 'MTC.BK', 'TIDLOR.BK', 'TLI.BK'] },
    { key: 'energy', name: 'พลังงานและไฟฟ้า', isic: ['B', 'D'], stocks: ['PTT.BK', 'PTTEP.BK', 'TOP.BK', 'GULF.BK'] },
    { key: 'tourism', name: 'ท่องเที่ยว โรงแรม สนามบิน', isic: ['I'], stocks: ['AOT.BK', 'MINT.BK', 'CENTEL.BK', 'ERW.BK'] },
    { key: 'retail', name: 'ค้าปลีก', isic: ['G'], stocks: ['CPALL.BK', 'CRC.BK', 'HMPRO.BK', 'BJC.BK'] },
    { key: 'property', name: 'อสังหาริมทรัพย์', isic: ['L'], stocks: ['SPALI.BK', 'AP.BK', 'LH.BK', 'CPN.BK'] },
    { key: 'construction', name: 'วัสดุก่อสร้างและรับเหมา', isic: ['F'], stocks: ['SCC.BK', 'CK.BK', 'STECON.BK', 'TASCO.BK'] },
    { key: 'electronics', name: 'อิเล็กทรอนิกส์', isic: ['C'], stocks: ['DELTA.BK', 'HANA.BK', 'KCE.BK', 'CCET.BK'] },
    { key: 'food', name: 'อาหารและเกษตร', isic: ['A', 'C'], stocks: ['CPF.BK', 'TU.BK', 'GFPT.BK', 'OSP.BK'] },
    { key: 'health', name: 'โรงพยาบาล', isic: ['Q'], stocks: ['BDMS.BK', 'BH.BK', 'BCH.BK', 'CHG.BK'] },
    { key: 'telecom', name: 'สื่อสารและไอที', isic: ['J'], stocks: ['ADVANC.BK', 'TRUE.BK', 'JTS.BK', 'BBIK.BK'] },
    { key: 'transport', name: 'ขนส่งและโลจิสติกส์', isic: ['H'], stocks: ['BEM.BK', 'BTS.BK', 'AAV.BK', 'PSL.BK'] },
  ];

  function sectorsFrom(raw, jobs, status) {
    const ind = jobs?.industry;
    const jobPct = (codes) => {
      if (!ind) return null;
      const rows = ind.rows.filter((r) => codes.includes(r.key) && r.changePct != null);
      if (!rows.length) return null;
      const now = rows.reduce((a, r) => a + r.now, 0), ch = rows.reduce((a, r) => a + r.change, 0);
      const totalPct = ind.total && ind.totalChange != null ? (ind.totalChange / (ind.total - ind.totalChange)) * 100 : 0;
      const pct = (ch / (now - ch)) * 100;
      return { pct, change: ch, now, rel: pct - totalPct, totalPct };
    };
    let k = 0;
    const out = SECTORS.map((sec) => {
      const members = sec.stocks.map(() => raw[k++]).filter((e) => e.data);
      if (!members.length) return { ...sec, ok: false, error: 'ไม่มีข้อมูลหุ้นในกลุ่ม' };
      const ret = (h, days) => {
        const last = h.at(-1), cut = addDays(last.date, -days);
        const base = [...h].reverse().find((p) => p.date <= cut) || h[0];
        return (last.value / base.value - 1) * 100;
      };
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      // มูลค่าซื้อขายต่อวัน (บาท) = ราคาปิด × จำนวนหุ้น
      const valueSeries = members.map((e) => e.data.history.map((p) => (p.volume || 0) * p.value));
      const recentVal = valueSeries.reduce((a, v) => a + avg(v.slice(-20)), 0);
      const priorVal = valueSeries.reduce((a, v) => a + avg(v.slice(-80, -20)), 0);
      const r1m = avg(members.map((e) => ret(e.data.history, 30)));
      const r3m = avg(members.map((e) => ret(e.data.history, 91)));
      const flow = priorVal ? (recentVal / priorVal - 1) * 100 : null;
      const jobs = jobPct(sec.isic);
      // คะแนน: ราคา 3 เดือน, เงินไหลเข้า/ออก, การจ้างงาน
      let score = 0;
      const sig = [];
      if (r3m > 5) { score++; sig.push('ราคาหุ้นขึ้น'); } else if (r3m < -5) { score--; sig.push('ราคาหุ้นลง'); }
      if (flow != null && flow > 20) { score++; sig.push('เงินไหลเข้า'); } else if (flow != null && flow < -20) { score--; sig.push('เงินไหลออก'); }
      // เทียบกับการจ้างงานรวมทั้งประเทศ (ตัดผลของการปรับวิธีสำรวจที่ทำให้ทุกกลุ่มเพิ่มพร้อมกัน)
      if (jobs && jobs.rel > 3) { score++; sig.push('จ้างงานโตกว่าภาพรวม'); } else if (jobs && jobs.rel < -3) { score--; sig.push('จ้างงานโตช้ากว่าภาพรวม'); }
      // ราคาเฉลี่ยแบบตั้งต้น 100 (6 เดือน) สำหรับกราฟเล็ก
      const dates = members[0].data.history.map((p) => p.date);
      const spark = dates.filter((_, i) => i % 3 === 0 || i === dates.length - 1).map((d) => ({ date: d,
        value: avg(members.map((e) => { const h = e.data.history; const v = lookup(h)(d) ?? h[0].value; return (v / h[0].value) * 100; })) }));
      return { key: sec.key, name: sec.name, ok: true, stocks: members.map((e) => e.data.symbol.replace('.BK', '')),
        missing: sec.stocks.length - members.length, r1m, r3m, flow, valuePerDay: recentVal, jobs, score, signals: sig,
        verdict: score >= 2 ? 1 : score <= -2 ? -1 : 0, spark };
    });
    const totalVal = out.filter((s) => s.ok).reduce((a, s) => a + s.valuePerDay, 0);
    out.forEach((s) => { if (s.ok) s.valueShare = (s.valuePerDay / totalVal) * 100; });
    const failed = raw.filter((e) => !e.data).length;
    return { sectors: out, totalValuePerDay: totalVal, failedStocks: failed, jobsQuarter: ind?.quarter, jobsPrevYear: ind?.prevYear };
  }

  // คนทำงานแยกกลุ่ม: ไตรมาสล่าสุดเทียบไตรมาสเดียวกันปีก่อน (ข้อมูลไม่ได้ปรับฤดูกาล)
  function jobsFrom(entry, status) {
    const d = entry.data;
    if (!d) return { status: status(entry) };
    const prevY = (q) => `${+q.slice(0, 4) - 1}${q.slice(4)}`;
    const at = (s, date) => s?.find((p) => p.date === date)?.value ?? null;
    const yoy = (s, q) => { const a = at(s, q), b = at(s, prevY(q)); return a != null && b ? (a / b - 1) * 100 : null; };
    const table = (series, names, minSize = 30) => {
      const total = series.TOTAL || [];
      const last = total.at(-1)?.date;
      if (!last) return null;
      const quarters = total.map((p) => p.date).filter((q) => at(total, prevY(q)) != null).slice(-4); // 4 ไตรมาสล่าสุดที่เทียบปีก่อนได้
      const totalPct = yoy(total, last);
      const rows = Object.entries(names).map(([k, name]) => {
        const s = series[k];
        const now = at(s, last), before = at(s, prevY(last));
        if (now == null) return null;
        const changePct = before ? (now / before - 1) * 100 : null;
        // ส่วนต่างการเติบโตเทียบภาพรวม ย้อนหลัง 4 ไตรมาส ใช้ดูว่าเป็นแนวโน้มต่อเนื่องหรือแค่ไตรมาสเดียว
        const relHist = quarters.map((q) => { const a = yoy(s, q), t = yoy(total, q); return { date: q, value: a != null && t != null ? a - t : null }; });
        let streak = 0;
        const sgn0 = Math.sign(relHist.at(-1)?.value ?? 0);
        for (let i = relHist.length - 1; i >= 0 && sgn0 !== 0; i--) { if (Math.sign(relHist[i].value ?? 0) === sgn0 && Math.abs(relHist[i].value) >= 0.5) streak++; else break; }
        return { key: k, name, now, share: at(total, last) ? (now / at(total, last)) * 100 : null,
          change: before != null ? now - before : null, changePct, rel: changePct != null && totalPct != null ? changePct - totalPct : null,
          streak: streak * sgn0, relHist, trend: (s || []).slice(-8) };
      }).filter((r) => r && r.now >= minSize); // ตัดกลุ่มเล็กมาก (ต่ำกว่า 3 หมื่นคน) ที่ค่าประมาณจากการสำรวจไม่นิ่ง
      return { quarter: last, prevYear: prevY(last), total: at(total, last), totalChange: at(total, last) - (at(total, prevY(last)) ?? NaN), totalPct, quarters, rows };
    };
    const out = { status: status(entry), occupation: table(d.occupation, S.OCCUPATIONS || {}), industry: table(d.industry, S.INDUSTRIES || {}),
      skill: d.skill ? table(d.skill, S.SKILLS || {}) : null };
    out.insights = jobsInsights(out);
    return out;
  }

  // ---- คำอธิบายภาษาไทยอัตโนมัติ (กฎตายตัว ไม่ใช้ AI) ----
  const qTh = (d) => d ? `ไตรมาส ${d.slice(5)}/${String(+d.slice(0, 4) + 543).slice(2)}` : '';
  const n1 = (v) => (Math.round(v * 10) / 10).toLocaleString('th-TH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const people = (k) => Math.abs(k) >= 1000 ? `${n1(Math.abs(k) / 1000)} ล้านคน` : `${Math.round(Math.abs(k)).toLocaleString('th-TH')},000 คน`;
  const sp = (v) => `${v >= 0 ? '+' : '−'}${n1(Math.abs(v))}%`;

  function jobsInsights(j) {
    const o = j.occupation, ind = j.industry, sk = j.skill;
    if (!o && !ind) return [];
    const t = o || ind, lines = [];
    const big = (rows) => rows.filter((r) => r.rel != null && r.now >= 300); // กลุ่มที่มีคนทำงาน 3 แสนคนขึ้นไป ค่าจากการสำรวจนิ่งพอ
    const odd = Math.abs(t.totalPct ?? 0) > 2.5;
    lines.push(`${qTh(t.quarter)} มีคนทำงาน ${people(t.total)} ${t.totalChange >= 0 ? 'เพิ่มขึ้น' : 'ลดลง'} ${people(t.totalChange)} (${sp(t.totalPct)}) จาก${qTh(t.prevYear)}`
      + (odd ? ' ซึ่งเปลี่ยนเร็วผิดปกติ อาจมาจากการปรับวิธีสำรวจ จึงควรดูว่ากลุ่มไหนโตเร็วหรือช้ากว่าภาพรวม มากกว่าดูว่าเพิ่มหรือลด' : ''));
    if (ind) {
      const top = [...ind.rows].sort((a, b) => b.now - a.now).slice(0, 3);
      lines.push(`ภาคธุรกิจที่จ้างคนมากที่สุดคือ ${top.map((r) => `${r.name} ${people(r.now)}`).join(' · ')}`);
    }
    const describe = (tbl, label) => {
      if (!tbl) return;
      const rows = big(tbl.rows);
      const up = rows.filter((r) => r.rel >= 2).sort((a, b) => b.rel - a.rel).slice(0, 3);
      const down = rows.filter((r) => r.rel <= -2).sort((a, b) => a.rel - b.rel).slice(0, 3);
      const fmtR = (r) => `${r.name} ${sp(r.changePct)}${Math.abs(r.streak) >= 2 ? ` (ต่อเนื่อง ${Math.abs(r.streak)} ไตรมาส)` : ''}`;
      if (up.length) lines.push(`${label}ที่โตเร็วกว่าภาพรวม: ${up.map(fmtR).join(', ')}`);
      if (down.length) lines.push(`${label}ที่โตช้ากว่าภาพรวมหรือหดตัว: ${down.map(fmtR).join(', ')}`);
    };
    describe(o, 'อาชีพ');
    describe(ind, 'ภาคธุรกิจ');
    // รูปแบบที่น่าสังเกต: งานออฟฟิศ/เทคนิคหด ขณะที่งานบริการโต
    const rel = (tbl, k) => tbl?.rows.find((r) => r.key === k)?.rel;
    const office = [rel(o, '3'), rel(o, '4'), rel(ind, 'J'), rel(ind, 'M')].filter((v) => v != null);
    const service = [rel(o, '5'), rel(ind, 'G'), rel(ind, 'I')].filter((v) => v != null);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    if (office.length && service.length && avg(office) < -2 && avg(service) > 1)
      lines.push('งานสำนักงาน งานเทคนิค และไอที เติบโตช้ากว่าภาพรวม ขณะที่งานบริการและค้าขายโตเร็วกว่า ถ้าเป็นแบบนี้ต่อเนื่อง อาจสะท้อนการใช้ระบบอัตโนมัติแทนงานสำนักงาน หรือธุรกิจไอทีที่ชะลอตัว');
    if (sk) {
      const hi = sk.rows.find((r) => r.key === 'L3-4'), lo = sk.rows.find((r) => r.key === 'L1');
      if (hi?.rel != null && lo?.rel != null && Math.abs(hi.rel - lo.rel) >= 2)
        lines.push(`งานทักษะสูง${hi.rel > lo.rel ? 'โตเร็วกว่า' : 'โตช้ากว่า'}งานทักษะพื้นฐาน (${sp(hi.changePct)} เทียบกับ ${sp(lo.changePct)})`
          + (hi.rel < lo.rel ? ' แปลว่างานใหม่ส่วนใหญ่เป็นงานที่ใช้ทักษะไม่สูง ซึ่งมักมีรายได้ต่ำกว่า' : ''));
    }
    lines.push('ตัวเลขมาจากการสำรวจตัวอย่าง กลุ่มที่ "ต่อเนื่องหลายไตรมาส" เชื่อถือได้มากกว่ากลุ่มที่เปลี่ยนแค่ไตรมาสเดียว');
    return lines;
  }

  function sectorsInsights(sx) {
    const ok = (sx?.sectors || []).filter((x) => x.ok);
    if (!ok.length) return [];
    const lines = [];
    const byVal = [...ok].sort((a, b) => b.valuePerDay - a.valuePerDay).slice(0, 3);
    lines.push(`เงินซื้อขายหุ้นกระจุกอยู่ที่ ${byVal.map((x) => `${x.name} (${n1(x.valueShare)}%)`).join(', ')}`);
    const good = ok.filter((x) => x.verdict > 0), bad = ok.filter((x) => x.verdict < 0);
    if (good.length) lines.push(`กลุ่มที่ไปได้สวย: ${good.map((x) => `${x.name} (${x.signals.join(', ')})`).join('; ')}`);
    if (bad.length) lines.push(`กลุ่มที่ซบเซา: ${bad.map((x) => `${x.name} (${x.signals.join(', ')})`).join('; ')}`);
    const inflow = ok.filter((x) => x.flow > 20).sort((a, b) => b.flow - a.flow);
    const outflow = ok.filter((x) => x.flow < -20).sort((a, b) => a.flow - b.flow);
    if (inflow.length) lines.push(`เงินกำลังไหลเข้า: ${inflow.map((x) => `${x.name} (มูลค่าซื้อขาย ${sp(x.flow)})`).join(', ')}`);
    if (outflow.length) lines.push(`เงินกำลังไหลออก: ${outflow.map((x) => `${x.name} (${sp(x.flow)})`).join(', ')}`);
    const crash = ok.filter((x) => x.r1m <= -10);
    if (crash.length) lines.push(`ราคาหุ้นร่วงแรงใน 1 เดือน: ${crash.map((x) => `${x.name} ${sp(x.r1m)}`).join(', ')} ควรตรวจข่าวว่ามีเหตุเฉพาะหรือไม่`);
    return lines;
  }

  // สรุปภาพรวมทั้งหน้า: ประเด็นสำคัญที่สุดของแต่ละหมวด
  function summaryInsights(o) {
    const L = [];
    for (const s of o.oil.signals || []) {
      if (!s.ok) continue;
      const bt = s.backtest?.n ? ` (ย้อนหลังทายทิศถูก ${Math.round(s.backtest.hitRate * 100)}%)` : '';
      if (s.announced != null) L.push({ cost: true, tag: 'น้ำมัน', text: `${s.title}: ประกาศแล้ว พรุ่งนี้${s.announced > 0 ? 'ขึ้น' : 'ลง'} ${n1(Math.abs(s.announced))} บาท/ลิตร`, dir: Math.sign(s.announced) });
      else if (s.direction !== 0) L.push({ cost: true, tag: 'น้ำมัน', text: `${s.title}: ถ้าปรับ น่าจะเป็นขา${s.direction > 0 ? 'ขึ้น' : 'ลง'} แรงกดดัน ${s.estimate > 0 ? '+' : '−'}${n1(Math.abs(s.estimate))} บาท/ลิตร${bt}`, dir: s.direction });
      else L.push({ tag: 'น้ำมัน', text: `${s.title}: ยังไม่มีแรงกดดันชัดเจนให้ปรับราคา`, dir: 0 });
    }
    const g = o.gold.signal;
    if (g?.ok) L.push({ tag: 'ทอง', text: Math.abs(g.estimate) < 50 ? `ทองไทยสอดคล้องกับราคาโลก (ต่าง ${Math.round(g.estimate)} บาท)` : `ราคาโลกชี้ว่าทองไทยมีแนวโน้ม${g.estimate > 0 ? 'ขึ้น' : 'ลง'}ประมาณ ${Math.abs(g.estimateRounded).toLocaleString('th-TH')} บาท`, dir: g.direction });
    const fx = o.fx.live?.change1d ?? o.fx.change1d;
    if (fx != null && Math.abs(fx) >= 0.2) L.push({ tag: 'ค่าเงิน', text: `บาท${fx > 0 ? 'อ่อน' : 'แข็ง'}ค่า ${n1(Math.abs(fx))}% ทำให้ราคาทองและน้ำมันในรูปเงินบาท${fx > 0 ? 'สูงขึ้น' : 'ถูกลง'}`, dir: Math.sign(fx) });
    const ld = o.leads;
    if (ld?.counted) L.push({ tag: 'หุ้น', text: `บรรยากาศตลาดโลก${ld.score >= 2 ? 'เป็นบวก' : ld.score <= -2 ? 'เป็นลบ' : 'ผสม'} (คะแนน ${ld.score >= 0 ? '+' : ''}${ld.score} จาก ${ld.counted} ตัวชี้)`, dir: ld.score >= 2 ? 1 : ld.score <= -2 ? -1 : 0, good: true });
    const sx = (o.sectors?.sectors || []).filter((x) => x.ok);
    const good = sx.filter((x) => x.verdict > 0).map((x) => x.name), bad = sx.filter((x) => x.verdict < 0).map((x) => x.name);
    if (good.length || bad.length) L.push({ tag: 'กลุ่มธุรกิจ', text: [good.length ? `ไปได้สวย: ${good.join(', ')}` : '', bad.length ? `ซบเซา: ${bad.join(', ')}` : ''].filter(Boolean).join(' · '), dir: 0 });
    for (const x of o.forecast?.oil || []) {
      if (x.announced != null || x.pChange == null || !x.n) continue;
      const pct = Math.round(x.pChange * 100), few = x.n < 15 ? ' ข้อมูลในอดีตยังน้อย' : '';
      L.push({ cost: true, tag: 'คาดการณ์', dir: x.dir, text: x.dir
        ? `${x.title}: ถ้าปรับ น่าจะเป็นขา${x.dir > 0 ? 'ขึ้น' : 'ลง'}${x.expectedPrice ? `ไปราว ${n1(x.expectedPrice)} บาท` : ''} · โอกาสปรับภายใน 7 วัน ~${pct}% (จาก ${x.n} วันในอดีตที่แรงกดดันระดับเดียวกัน${few})`
        : `${x.title}: แรงกดดันน้อย โอกาสปรับภายใน 7 วัน ~${pct}%` });
    }
    const gc = o.forecast?.ranges?.find((r) => r.key === 'gold');
    if (gc) { const h = gc.horizons.find((x) => x.days === 7);
      L.push({ tag: 'คาดการณ์', dir: 0, text: `ทองคำแท่ง 7 วันข้างหน้า: มีโอกาสราว 2 ใน 3 ที่จะอยู่ระหว่าง ${(Math.round(h.lo68 / 50) * 50).toLocaleString('th-TH')}–${(Math.round(h.hi68 / 50) * 50).toLocaleString('th-TH')} บาท` }); }
    const bk = o.bonds?.key?.find((k) => k.tenor === '10Y');
    if (bk) L.push({ tag: 'ตราสารหนี้', dir: bk.m1 == null ? 0 : Math.abs(bk.m1) < 5 ? 0 : Math.sign(bk.m1), text: `พันธบัตรไทย 10 ปี ${bk.yield.toFixed(2)}%${bk.m1 != null ? ` (${bk.m1 > 0 ? '+' : '−'}${Math.abs(Math.round(bk.m1))} bp ใน 1 เดือน)` : ''}${o.bonds.spread ? ` · ${o.bonds.spread.now < 0 ? 'ต่ำกว่า' : 'สูงกว่า'}สหรัฐ ${n1(Math.abs(o.bonds.spread.now))} จุด` : ''}` });
    const ft = o.energy?.ft;
    if (ft?.next && ft.next.ft !== ft.current.ft) L.push({ cost: true, tag: 'ค่าไฟ', dir: Math.sign(ft.next.ft - ft.current.ft), text: `ค่า Ft งวด ${ft.next.label} ${ft.next.ft > ft.current.ft ? 'ขึ้น' : 'ลง'}เป็น ${n1(ft.next.ft)} สตางค์/หน่วย` });
    const lpg = o.energy?.lpg;
    if (lpg?.lastChange && lpg.lastChange.date >= addDays(bkkDate(), -7)) L.push({ cost: true, tag: 'LPG', dir: Math.sign(lpg.lastChange.delta), text: `LPG ${lpg.lastChange.delta > 0 ? 'ขึ้น' : 'ลง'} ${n1(Math.abs(lpg.lastChange.delta))} บาท/กก. (ถัง 15 กก. ราว ${Math.round(lpg.tank15)} บาท ตามโครงสร้าง สนพ.)` });
    const tr = o.macro?.trade;
    if (tr) {
      const mo = `${['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][+tr.last.date.slice(5) - 1]} ${+tr.last.date.slice(0, 4) + 543 - 2500}`;
      L.push({ tag: 'การค้า', dir: tr.xYoy == null ? 0 : Math.sign(tr.xYoy), good: true, text: `ส่งออก ${mo}${tr.xYoy != null ? ` ${tr.xYoy >= 0 ? 'โต' : 'หด'} ${n1(Math.abs(tr.xYoy))}%` : ''} · ${tr.last.b >= 0 ? 'เกินดุล' : 'ขาดดุล'}การค้า ${n1(Math.abs(tr.last.b) / 1000)} พันล้านดอลลาร์${tr.ytd.xG != null ? ` · ทั้งปีถึงตอนนี้ส่งออก${tr.ytd.xG >= 0 ? 'โต' : 'หด'} ${n1(Math.abs(tr.ytd.xG))}%` : ''}` });
    }
    const th = o.unemployment?.countries?.find((c) => c.code === 'THA');
    if (th?.lastQuarter) L.push({ tag: 'การว่างงาน', text: `ไทย ${qTh(th.lastQuarter.date)} ว่างงาน ${n1(th.lastQuarter.value)}%${th.yoy != null ? ` (${th.yoy > 0.05 ? 'สูงขึ้นจาก' : th.yoy < -0.05 ? 'ลดลงจาก' : 'ใกล้เคียงกับ'}ปีก่อน)` : ''}`, dir: 0 });
    const jo = o.jobs?.occupation;
    if (jo) {
      const big = jo.rows.filter((r) => r.rel != null && r.now >= 300);
      const up = big.sort((a, b) => b.rel - a.rel)[0], down = [...big].sort((a, b) => a.rel - b.rel)[0];
      if (up && down) L.push({ tag: 'อาชีพ', text: `งานที่โตเร็วสุด: ${up.name} · โตช้าสุด: ${down.name} (เทียบกับภาพรวม)`, dir: 0 });
    }
    return L;
  }

  // อัตราการว่างงาน: ไทยเทียบโลก/เพื่อนบ้าน ทั้งรายปีและรายไตรมาส
  function unemploymentFrom(unA, unQ, status) {
    const names = S.UNEMP_COUNTRIES || {};
    const A = unA.data?.series || {}, Q = unQ.data?.series || {};
    const countries = Object.keys(names).filter((c) => A[c] || Q[c]).map((c) => {
      const q = Q[c] || [], a = A[c] || [];
      const lastQ = q.at(-1);
      // เทียบกับไตรมาสเดียวกันของปีก่อน (ข้อมูลไม่ได้ปรับฤดูกาล)
      const yoyBase = lastQ ? q.find((p) => p.date === `${+lastQ.date.slice(0, 4) - 1}${lastQ.date.slice(4)}`) : null;
      return { code: c, name: names[c], lastQuarter: lastQ || null, prevQuarter: q.at(-2) || null,
        yoy: lastQ && yoyBase ? lastQ.value - yoyBase.value : null, lastYear: a.at(-1) || null };
    });
    return {
      status: { annual: status(unA), quarterly: status(unQ) },
      countries,
      annual: { THA: A.THA || [], WLD: A.WLD || [] },
      quarterlyTH: Q.THA || [],
    };
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
    const sectorSymbols = SECTORS.flatMap((x) => x.stocks);
    const [eppo, unA, unQ, jobs, goldFut, imf, peersE, tradeE, ftE, thY, ...rest] = await Promise.all([
      cached('eppo', 60 * MIN, fetchEppoLatest),
      cached('unempAnnual', 24 * 60 * MIN, S.fetchUnemploymentAnnual),
      cached('unempQuarterly', 12 * 60 * MIN, S.fetchUnemploymentQuarterly),
      cached('jobs', 12 * 60 * MIN, S.fetchJobsByGroup),
      cached('goldFut', 60 * MIN, () => S.fetchYahoo('GC=F'), null, true),
      cached('imf', 24 * 60 * MIN, S.fetchImfOutlook),
      cached('peers', 24 * 60 * MIN, S.fetchPeersOutlook),
      cached('trade', 12 * 60 * MIN, S.fetchTradeMonthly),
      cached('ft', 24 * 60 * MIN, S.fetchFt),
      cached('thYields', 3 * 60 * MIN, S.fetchThaiYields, null, true),
      ...LEADS.map((l) => cached(`lead:${l.symbol}`, 15 * MIN, () => S.fetchYahoo(l.symbol))),
      ...NEWS.map((n) => cached(`news:${n.key}`, 30 * MIN, () => S.fetchNews(n.q))),
    ]);
    const leadsRaw = rest.slice(0, LEADS.length), newsRaw = rest.slice(LEADS.length);
    // หุ้นรายกลุ่ม: อัปเดตทุก 1 ชม. (แม้ใน GitHub Actions) และดึงทีละ 6 ตัวเพื่อไม่ให้ถูกจำกัดการเรียก
    const sectorRaw = [];
    for (let i = 0; i < sectorSymbols.length; i += 6) {
      sectorRaw.push(...await Promise.all(sectorSymbols.slice(i, i + 6).map((sym) =>
        cached(`stk:${sym}`, 60 * MIN, () => S.fetchStockDaily(sym), null, true))));
    }
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
    const jobsOut = jobsFrom(jobs, status);
    const out = {
      mock,
      generatedAt: new Date().toISOString(),
      fx: { status: status(fx), live: fxLive.data ? { usdthb: fxLive.data.price, change1d: pct(fxLive.data.price, fxLive.data.prevClose) } : null,
        ...(fx.data ? { date: fx.data.date, rates: fx.data.rates, usdthbHistory: fxH,
        change1d: fxH.length > 1 ? pct(fxH.at(-1).value, fxH.at(-2).value) : null } : {}) },
      gold, oil, stocks,
      leads: leadsFrom(leadsRaw, status),
      news: NEWS.map((n, i) => ({ key: n.key, title: n.title, status: status(newsRaw[i]), items: (newsRaw[i].data || []).slice(0, 6) })),
      inflation: { status: status(infl), ...(infl.data || {}) },
      unemployment: unemploymentFrom(unA, unQ, status),
      jobs: jobsOut,
      sectors: sectorsFrom(sectorRaw, jobsOut, status),
    };
    out.forecast = buildForecast(out, { goldFut, fxLive, brent, fxAt });
    out.forecast.imf = imfFrom(imf, status);
    out.macro = macroFrom(peersE, tradeE, out, status);
    out.sectors.insights = sectorsInsights(out.sectors);
    out.energy = energyFrom(ftE, status);
    out.bonds = bondsFrom(thY, leadsRaw[LEADS.findIndex((l) => l.symbol === '^TNX')], out, status);
    out.summary = summaryInsights(out);
    out.accuracy = accuracyFrom(out);
    if (out.summary.length) history.recordDailySummary(bkkDate(), out.summary);
    out.archive = (history.get().daily || []).filter((d) => d.date < bkkDate()).slice(-14).reverse();
    out.alerts = alertEvents(out);
    return out;
  }

  // สำหรับบันทึก cache ไว้ใช้รอบถัดไป (ถ้าแหล่งใดดึงไม่ได้ จะใช้ค่าล่าสุดแทน)
  const exportCache = () => Object.fromEntries([...cache].filter(([, v]) => v.data));
  return { buildData, exportCache };
}
