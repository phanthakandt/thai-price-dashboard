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

// ---- แจ้งเตือนผ่าน Telegram (ทำงานเมื่อตั้ง secrets TELEGRAM_BOT_TOKEN และ TELEGRAM_CHAT_ID) ----
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const SITE = process.env.PREV_URL || '';
const pending = (data.alerts || []).filter((a) => !history.alertSent(a.key));
if (TG_TOKEN && TG_CHAT && !MOCK) {
  for (const a of pending) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text: a.text + (SITE ? `\n${SITE}` : ''), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) history.markAlert(a.key); else console.log('ส่ง Telegram ไม่สำเร็จ', res.status, (await res.text()).slice(0, 200));
    } catch (e) { console.log('ส่ง Telegram ไม่สำเร็จ', e.message); }
  }
  console.log(`แจ้งเตือน     ส่ง ${pending.length} รายการ`);
} else {
  // ยังไม่ได้ตั้งค่า: บันทึกว่าเห็นแล้ว เพื่อไม่ให้ส่งย้อนหลังทั้งหมดเมื่อเริ่มตั้งค่า
  for (const a of pending) if (!a.key.startsWith('daily:')) history.markAlert(a.key);
  console.log(`แจ้งเตือน     ยังไม่ได้ตั้งค่า Telegram (มี ${pending.length} เหตุการณ์)`);
}
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
for (const r of data.forecast?.ranges || []) console.log('คาดการณ์    ', r.key, 'ตอนนี้', r.now, '| σ/วัน', r.sigmaDaily.toFixed(2) + '%', '|', r.horizons.map((h) => `${h.days}d ${h.lo68.toFixed(2)}–${h.hi68.toFixed(2)}`).join(' '), `| ย้อนหลัง 68%:${Math.round(r.backtest.cover68 * 100)}% 95%:${Math.round(r.backtest.cover95 * 100)}% (n=${r.backtest.n})`);
for (const o of data.forecast?.oil || []) console.log('คาดการณ์    ', o.key, `กลุ่ม ${o.bucket} n=${o.n} ปรับใน7วัน=${o.pChange?.toFixed(2)} ทางเดียวกัน=${o.pSameDir?.toFixed(2)} คาด=${o.expectedPrice?.toFixed(2)}`);
const imf = data.forecast?.imf;
console.log('IMF         ', imf?.status?.ok ? imf.years.join(',') + ' ' + imf.rows.map((r) => `${r.key} TH ${r.th.join('/')} WLD ${r.world.join('/')}`).join(' | ') : imf?.status?.error);
console.log('ค่าไฟ/LPG    ', data.energy?.ft ? `Ft ${data.energy.ft.current.label} = ${data.energy.ft.current.ft}` : 'Ft: ' + data.energy?.status?.ft?.error, '|', data.energy?.lpg ? `LPG ${data.energy.lpg.perKg} บาท/กก. กองทุน ${data.energy.lpg.fund}` : 'LPG: ไม่มี');
console.log('สนพ.        ', ok(data.oil.status.eppo), data.oil.eppo ? `ไฟล์วันที่ ${data.oil.eppo.date}, ประวัติ ${data.oil.eppo.history} วัน, เติมย้อนหลัง ${JSON.stringify(data.oil.eppo.backfill)}` : '');
console.log('ตัวชี้นำ     ', data.leads.items.map((l) => `${l.symbol}:${l.status.ok ? 'OK' : 'X'}`).join(' '));
console.log('ข่าว        ', data.news.map((n) => `${n.key}:${n.status.ok ? n.items.length : 'X ' + n.status.error}`).join(' '));
data.oil.signals.forEach((s) => console.log('สัญญาณ', s.key, s.method, s.estimate?.toFixed(2), JSON.stringify(s.backtest)));
console.log(`ประวัติ: น้ำมัน ${history.get().oil.length} วัน, ทอง ${history.get().gold.length} จุด`);
