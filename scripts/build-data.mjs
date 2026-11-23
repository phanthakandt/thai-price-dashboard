// สร้างเว็บแบบ static สำหรับ GitHub Pages: ดึงข้อมูลหนึ่งรอบ แล้วเขียนไฟล์ลงโฟลเดอร์ _site
//   node scripts/build-data.mjs                ใช้ข้อมูลจริง
//   MOCK=1 node scripts/build-data.mjs         ใช้ข้อมูลสมมติ
// ถ้ากำหนด PREV_URL (เช่น https://user.github.io/repo/) จะโหลดประวัติราคาจากเว็บที่ deploy ไว้รอบก่อนมาต่อ
import { mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHistory } from '../lib/history.js';
import { createBuilder } from '../lib/build.js';
import { buildStocks } from '../lib/stock-data.js';

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

// ---- หุ้นจับตา: วิเคราะห์หุ้นไทยใหญ่ 100 ตัว + หุ้นต่างประเทศยอดนิยม + หุ้นที่ขอเพิ่มใน watchlist.json ----
{
  const wl = existsSync(path.join(ROOT, 'watchlist.json')) ? JSON.parse(readFileSync(path.join(ROOT, 'watchlist.json'), 'utf8')) : {};
  const stockCache = MOCK ? {} : (await loadPrev('stock-cache.json')) || {};
  const DEFAULT_WATCH = ['PTT.BK', 'CPALL.BK', 'DELTA.BK', 'KBANK.BK', 'AOT.BK', 'ADVANC.BK', 'NVDA', 'AAPL'];
  try {
    const st = await buildStocks({ S, cache: stockCache, extra: wl.extra || [], priority: DEFAULT_WATCH, mock: MOCK });
    st.summary.defaults = DEFAULT_WATCH;
    mkdirSync(path.join(OUT, 'stocks'), { recursive: true });
    for (const [sym, d] of Object.entries(st.details)) writeFileSync(path.join(OUT, 'stocks', sym.replace(/[^A-Za-z0-9.-]/g, '_') + '.json'), JSON.stringify(d));
    writeFileSync(path.join(OUT, 'stocks.json'), JSON.stringify(st.summary));
    writeFileSync(path.join(OUT, 'stock-cache.json'), JSON.stringify(stockCache));
    const L = st.summary.list, cnt = (v) => L.filter((x) => x.v === v).length;
    console.log('หุ้นจับตา    ', `วิเคราะห์ ${L.length} ตัว (ขาด ${st.log.missing}) · ดึงใหม่ ราคา ${st.log.hist} พื้นฐาน ${st.log.prof} งบ ${st.log.fin} · ${Math.round(st.log.ms / 1000)} วินาที`,
      `· ทั้งคู่ ${cnt('both')} ยาว ${cnt('long')} สั้น ${cnt('short')} รอ ${cnt('wait')} ระวัง ${cnt('caution')} · ล้มเหลว ${st.log.fail.length}`);
    for (const f of st.log.fail.slice(0, 6)) console.log('   ✗', f);
    for (const x of L.filter((x) => DEFAULT_WATCH.includes(x.s))) {
      const e = st.details[x.s].analysis.entry;
      console.log(`   ${x.s.padEnd(10)} ${x.px} สั้น ${x.ss} ยาว ${x.ls ?? '-'} → ${x.v}${x.flTop ? ' ⚠ ' + x.flTop : ''} | มูลค่า ${x.fair?.toFixed(2) ?? '-'} โซนยาว ${e.long ? e.long.lo.toFixed(2) + '–' + e.long.hi.toFixed(2) + ' ' + e.long.status : '-'} | สั้น ซื้อ ${e.short.entry.toFixed(2)} ตัด ${e.short.stop.toFixed(2)} เป้า ${e.short.target.toFixed(2)} RR ${e.short.rr.toFixed(1)}`);
    }
    const be = st.summary.backtest?.entry;
    if (be) console.log('   backtest แผนซื้อ', `ตัวอย่าง ${be.samples} ได้ราคา ${Math.round(be.fillRate * 100)}% | ทั้งหมด n=${be.all.n} ชนะ ${Math.round(be.all.win * 100)}% แพ้ ${Math.round(be.all.loss * 100)}% เฉลี่ย ${be.all.avgR.toFixed(2)}R กำไรเฉลี่ย ${(be.all.avgRet * 100).toFixed(2)}% vs ถือเฉยๆ ${(be.all.hold * 100).toFixed(2)}%`,
      be.worth ? `| RR≥1.5 n=${be.worth.n} ชนะ ${Math.round(be.worth.win * 100)}% เฉลี่ย ${be.worth.avgR.toFixed(2)}R กำไร ${(be.worth.avgRet * 100).toFixed(2)}%` : '');
    const bt = st.summary.backtest?.all;
    if (bt) console.log('   backtest', `n=${bt.n} ${bt.from}–${bt.to}`, bt.buckets.map((b) => `${b.name}: n=${b.n} 1ด.เฉลี่ย ${(b.avg * 100).toFixed(2)}% ส่วนเกิน ${(b.excess * 100).toFixed(2)}% ชนะตลาด ${Math.round(b.beat * 100)}%`).join(' | '));
  } catch (e) { console.log('หุ้นจับตา     ล้มเหลว', e.stack); }
}

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
const mx = data.macro;
console.log('GDP เพื่อนบ้าน', mx?.countries ? mx.countries.map((c) => `${c.code} ${c.growth.join('/')}`).join(' | ') + ` · TH rank ${mx.rank?.pos}/${mx.rank?.of}` : mx?.status?.peers?.error);
console.log('การค้าไทย  ', mx?.trade ? `${mx.trade.last.date} X ${(mx.trade.last.x / 1e3).toFixed(2)} M ${(mx.trade.last.m / 1e3).toFixed(2)} B ${(mx.trade.last.b / 1e3).toFixed(2)} bn$ · yoy ${mx.trade.xYoy?.toFixed(1)}% · ytd ${mx.trade.ytd.xG?.toFixed(1)}% · open ${mx.trade.openness?.toFixed(0)}%` : mx?.status?.trade?.error);
console.log('การค้าเพื่อนบ้าน', (mx?.peerTrade || []).map((p) => `${p.code} ${p.date || '-'} ${p.xYoy?.toFixed(1) ?? '-'}%`).join(' | '));
for (const l of mx?.insights || []) console.log('  •', l);
const gd = mx?.goods;
console.log('สินค้าแยกกลุ่ม', gd?.month ? `${gd.period} ytd=${!!gd.ytd} fetched ${gd.status.fetched} pending ${gd.status.pending} ${gd.status.errors?.join('; ') || ''}` : gd?.status?.error);
for (const g of (gd?.ytd || gd?.month)?.groups || []) console.log(`   ${g.name}: X ${(g.x / 1e3).toFixed(2)} (${g.xYoy?.toFixed(1)}%) M ${(g.m / 1e3).toFixed(2)} B ${(g.b / 1e3).toFixed(2)}`);
for (const l of gd?.insights || []) console.log('  •', l);
const imf = data.forecast?.imf;
console.log('IMF         ', imf?.status?.ok ? imf.years.join(',') + ' ' + imf.rows.map((r) => `${r.key} TH ${r.th.join('/')} WLD ${r.world.join('/')}`).join(' | ') : imf?.status?.error);
console.log('ค่าไฟ/LPG    ', data.energy?.ft ? `Ft ${data.energy.ft.current.label} = ${data.energy.ft.current.ft}` : 'Ft: ' + data.energy?.status?.ft?.error, '|', data.energy?.lpg ? `LPG ${data.energy.lpg.perKg} บาท/กก. กองทุน ${data.energy.lpg.fund}` : 'LPG: ไม่มี');
console.log('ตราสารหนี้   ', data.bonds?.key ? `${data.bonds.date} ` + data.bonds.key.map((k) => `${k.tenor}=${k.yield?.toFixed(3)}`).join(' ') + (data.bonds.spread ? ` | US10=${data.bonds.spread.us10} spread=${data.bonds.spread.now.toFixed(2)}` : '') : 'ล้มเหลว: ' + data.bonds?.status?.error);
console.log('สนพ.        ', ok(data.oil.status.eppo), data.oil.eppo ? `ไฟล์วันที่ ${data.oil.eppo.date}, ประวัติ ${data.oil.eppo.history} วัน, เติมย้อนหลัง ${JSON.stringify(data.oil.eppo.backfill)}` : '');
console.log('ตัวชี้นำ     ', data.leads.items.map((l) => `${l.symbol}:${l.status.ok ? 'OK' : 'X'}`).join(' '));
console.log('ข่าว        ', data.news.map((n) => `${n.key}:${n.status.ok ? n.items.length : 'X ' + n.status.error}`).join(' '));
data.oil.signals.forEach((s) => console.log('สัญญาณ', s.key, s.method, s.estimate?.toFixed(2), JSON.stringify(s.backtest)));
console.log(`ประวัติ: น้ำมัน ${history.get().oil.length} วัน, ทอง ${history.get().gold.length} จุด`);
