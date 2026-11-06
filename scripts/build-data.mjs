// สร้างเว็บแบบ static สำหรับ GitHub Pages: ดึงข้อมูลหนึ่งรอบ แล้วเขียนไฟล์ลงโฟลเดอร์ _site
//   node scripts/build-data.mjs                ใช้ข้อมูลจริง
//   MOCK=1 node scripts/build-data.mjs         ใช้ข้อมูลสมมติ
// ถ้ากำหนด PREV_URL (เช่น https://user.github.io/repo/) จะโหลดประวัติราคาจากเว็บที่ deploy ไว้รอบก่อนมาต่อ
import { mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHistory } from '../lib/history.js';
import { createBuilder } from '../lib/build.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, process.env.OUT_DIR || '_site');
const MOCK = process.env.MOCK === '1';
const PREV_URL = process.env.PREV_URL;

async function loadPrev(name) {
  if (PREV_URL) {
    try {
      const res = await fetch(new URL(name, PREV_URL.endsWith('/') ? PREV_URL : PREV_URL + '/'), { signal: AbortSignal.timeout(15000) });
      if (res.ok) { console.log(`โหลด ${name} รอบก่อนจากเว็บแล้ว`); return await res.json(); }
      console.log(`ยังไม่มี ${name} บนเว็บ (HTTP ${res.status}) เริ่มใหม่`);
    } catch (e) { console.log(`โหลด ${name} รอบก่อนไม่ได้: ${e.message}`); }
  }
  const local = path.join(OUT, name);
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf8'));
  return null;
}

mkdirSync(OUT, { recursive: true });
cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });

const S = MOCK ? await import('../mock.js') : await import('../sources.js');
const prevHistory = MOCK ? S.seedHistory() : (await loadPrev('history.json')) || { oil: [], gold: [] };
const prevCache = MOCK ? null : await loadPrev('cache.json');

const history = createHistory(path.join(OUT, 'history.json'), { persist: true, seed: prevHistory });
const { buildData, exportCache } = createBuilder({ S, history, mock: MOCK, cacheSeed: prevCache, ttlScale: 0, backfillPerRun: 45 });

const data = await buildData();
history.save();
writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data));
writeFileSync(path.join(OUT, 'cache.json'), JSON.stringify(exportCache()));
writeFileSync(path.join(OUT, '.nojekyll'), '');

// สรุปผลใน log ของ Actions
const ok = (s) => (s?.ok ? (s.stale ? 'ใช้ค่าเก่า' : 'OK') : `ล้มเหลว: ${s?.error}`);
console.log('ค่าเงิน      ', ok(data.fx.status));
console.log('ทองโลก      ', ok(data.gold.status.world));
console.log('ทองไทย      ', ok(data.gold.status.thai));
console.log('น้ำมันไทย    ', ok(data.oil.status.thai));
console.log('น้ำมันโลก    ', ok(data.oil.status.rbob), '/', ok(data.oil.status.ulsd));
data.stocks.forEach((s) => console.log(s.name.padEnd(12), ok(s.status)));
console.log('เงินเฟ้อ     ', ok(data.inflation.status));
console.log('ว่างงาน     ', ok(data.unemployment.status.annual), '/', ok(data.unemployment.status.quarterly), data.unemployment.countries.map((c) => `${c.code}:${c.lastQuarter?.date ?? '-'}/${c.lastYear?.date ?? '-'}`).join(' '));
console.log('อาชีพ       ', ok(data.jobs.status), data.jobs.occupation ? `${data.jobs.occupation.quarter} อาชีพ ${data.jobs.occupation.rows.length} กลุ่ม, ภาคธุรกิจ ${data.jobs.industry?.rows.length} กลุ่ม` : '');
console.log('กลุ่มธุรกิจ   ', `หุ้นดึงไม่ได้ ${data.sectors.failedStocks} ตัว`, data.sectors.sectors.map((x) => `${x.key}:${x.ok ? (x.verdict > 0 ? '+' : x.verdict < 0 ? '-' : '=') + `(${x.r3m?.toFixed(0)}%,flow ${x.flow?.toFixed(0)}%)` : 'X'}`).join(' '));
console.log('สนพ.        ', ok(data.oil.status.eppo), data.oil.eppo ? `ไฟล์วันที่ ${data.oil.eppo.date}, ประวัติ ${data.oil.eppo.history} วัน, เติมย้อนหลัง ${JSON.stringify(data.oil.eppo.backfill)}` : '');
console.log('ตัวชี้นำ     ', data.leads.items.map((l) => `${l.symbol}:${l.status.ok ? 'OK' : 'X'}`).join(' '));
console.log('ข่าว        ', data.news.map((n) => `${n.key}:${n.status.ok ? n.items.length : 'X ' + n.status.error}`).join(' '));
data.oil.signals.forEach((s) => console.log('สัญญาณ', s.key, s.method, s.estimate?.toFixed(2), JSON.stringify(s.backtest)));
console.log(`ประวัติ: น้ำมัน ${history.get().oil.length} วัน, ทอง ${history.get().gold.length} จุด`);
