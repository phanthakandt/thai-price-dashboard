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

    // บันทึกราคาทองทุกครั้งที่ดึงใหม่ เก็บไว้ 14 วัน
    recordGold(thaiSell, worldThb) {
      const last = h.gold.at(-1);
      if (last && Date.now() - last.t < 60_000) return;
      h.gold.push({ t: Date.now(), thaiSell, worldThb });
      const cutoff = Date.now() - 14 * 864e5;
      h.gold = h.gold.filter((g) => g.t >= cutoff);
      save();
    },
  };
}
