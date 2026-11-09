// เก็บประวัติราคาไทยลงไฟล์ data/history.json
// (แหล่งข้อมูลไทยฟรีให้แค่ราคาปัจจุบัน จึงต้องบันทึกเองเพื่อดูว่าไทยปรับราคาล่าสุดเมื่อไร)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function bkkDate(ms = Date.now(), offsetDays = 0) {
  return new Date(ms + 7 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
}

export function createHistory(file, { persist = true, seed = null } = {}) {
  let h = seed || { oil: [], gold: [] };
  if (!seed && persist) {
    try { h = JSON.parse(readFileSync(file, 'utf8')); } catch { /* ยังไม่มีไฟล์ */ }
  }
  const save = () => {
    if (!persist) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(h));
  };

  return {
    get: () => h,
    save,

    // บันทึกราคาน้ำมันไทยรายวัน (ใช้ราคา "เมื่อวาน" จาก API เติมย้อนหลังได้ 1 วัน)
    recordOil(items) {
      const today = bkkDate(), yest = bkkDate(Date.now(), -1);
      const upsert = (date, prices, overwrite) => {
        const row = h.oil.find((r) => r.date === date);
        if (!row) h.oil.push({ date, prices });
        else if (overwrite) row.prices = prices;
      };
      const pick = (k) => Object.fromEntries(items.filter((i) => i[k] != null).map((i) => [i.name, i[k]]));
      upsert(yest, pick('yesterday'), false);
      upsert(today, pick('today'), true);
      h.oil.sort((a, b) => a.date.localeCompare(b.date));
      h.oil = h.oil.slice(-400);
      save();
    },

    // บันทึกค่ารายวัน (เช่น ราคาปิด SET) ค่าของวันเดียวกันจะถูกเขียนทับด้วยค่าล่าสุด
    recordDaily(key, date, value) {
      if (!date || value == null) return;
      h[key] ??= [];
      const row = h[key].find((r) => r.date === date);
      if (row) row.value = value; else h[key].push({ date, value });
      h[key].sort((a, b) => a.date.localeCompare(b.date));
      h[key] = h[key].slice(-800);
      save();
    },

    // โครงสร้างราคาน้ำมันรายวันของ สนพ. (ย่อเหลือเฉพาะค่าที่ใช้)
    recordEppo(e) {
      h.eppo ??= [];
      const p = Object.fromEntries(Object.entries(e.products).map(([k, v]) => [k, { exr: v.exr, disc: v.discount || 0, fund: v.fund, mm: v.mm, retail: v.retail, excise: v.excise }]));
      const row = { date: e.date, fx: e.fx, p, avgMM: e.avgMM };
      const i = h.eppo.findIndex((r) => r.date === e.date);
      if (i >= 0) h.eppo[i] = row; else h.eppo.push(row);
      h.eppo.sort((a, b) => a.date.localeCompare(b.date));
      h.eppo = h.eppo.slice(-400);
      h.eppoMissing = (h.eppoMissing || []).filter((d) => d !== e.date);
      save();
    },
    markEppoMissing(date) {
      h.eppoMissing ??= [];
      if (!h.eppoMissing.includes(date)) h.eppoMissing.push(date);
      h.eppoMissing = h.eppoMissing.sort().slice(-200);
      save();
    },

    // เก็บ "สรุปวันนี้" ของแต่ละวัน (เขียนทับทั้งวัน จึงได้สรุปล่าสุดของวันนั้น) ไว้ย้อนดู 60 วัน
    recordDailySummary(date, items) {
      h.daily ??= [];
      const i = h.daily.findIndex((d) => d.date === date);
      const row = { date, items: items.map((x) => ({ tag: x.tag, text: x.text, dir: x.dir, cost: x.cost || false })) };
      if (i >= 0) h.daily[i] = row; else h.daily.push(row);
      h.daily = h.daily.sort((a, b) => a.date.localeCompare(b.date)).slice(-60);
      save();
    },
    // กันส่งแจ้งเตือนซ้ำ
    alertSent(key) { return (h.alerts || []).includes(key); },
    markAlert(key) { h.alerts ??= []; h.alerts.push(key); h.alerts = h.alerts.slice(-500); save(); },
    setMeta(k, v) { h.meta ??= {}; h.meta[k] = v; save(); },
    getMeta(k) { return h.meta?.[k]; },

    // บันทึกช่วงคาดการณ์วันละครั้งต่อรายการ ไว้ตรวจย้อนหลังว่าราคาจริงอยู่ในช่วงหรือไม่
    recordForecast(key, f) {
      h.forecasts ??= [];
      if (h.forecasts.some((x) => x.key === key && x.made === f.made && x.horizon === f.horizon)) return;
      h.forecasts.push({ key, ...f });
      h.forecasts = h.forecasts.slice(-2000);
      save();
    },

    // บันทึกราคาทองทุกครั้งที่ดึงใหม่ เก็บไว้ 14 วัน
    recordGold(thaiSell, worldThb, implied = null) {
      h.gold ??= [];
      const last = h.gold.at(-1);
      if (last && Date.now() - last.t < 60_000) return;
      h.gold.push({ t: Date.now(), thaiSell, worldThb, implied: implied != null ? Math.round(implied) : null });
      const cutoff = Date.now() - 14 * 864e5;
      h.gold = h.gold.filter((g) => g.t >= cutoff);
      save();
    },
  };
}
