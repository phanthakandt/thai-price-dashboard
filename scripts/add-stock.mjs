// เพิ่มหุ้นนอกรายการเข้า watchlist.json จาก issue ชื่อ "เพิ่มหุ้น: XXX" (เรียกจาก workflow add-stock.yml)
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { searchStock, fetchStockHistory } from '../sources.js';

const title = process.env.ISSUE_TITLE || '';
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}<<EOF\n${v}\nEOF\n`);
const q = (title.split(/[:：]/)[1] || '').trim().toUpperCase().replace(/[^A-Z0-9.&^=-]/g, '').slice(0, 20);
let msg, added = '';
if (!q) msg = 'ไม่พบชื่อหุ้นในหัวข้อ ตัวอย่างที่ถูกต้อง: "เพิ่มหุ้น: SCB"';
else {
  try {
    const res = await searchStock(q);
    const pick = res.find((x) => x.symbol === q) || res.find((x) => x.symbol === q + '.BK') || res.find((x) => x.symbol.startsWith(q + '.')) || res[0];
    if (!pick) throw new Error(`ค้นหา "${q}" ใน Yahoo Finance ไม่พบ`);
    const H = await fetchStockHistory(pick.symbol);
    if (H.c.length < 120) throw new Error(`${pick.symbol} มีราคาย้อนหลังแค่ ${H.c.length} วัน น้อยเกินกว่าจะวิเคราะห์`);
    const wl = JSON.parse(readFileSync('watchlist.json', 'utf8'));
    wl.extra ??= [];
    if (wl.extra.includes(pick.symbol)) msg = `${pick.symbol} (${pick.name}) อยู่ในรายการแล้ว`;
    else {
      wl.extra.push(pick.symbol); wl.extra = wl.extra.slice(-60);
      writeFileSync('watchlist.json', JSON.stringify(wl, null, 2) + '\n');
      added = pick.symbol;
      msg = `เพิ่ม ${pick.symbol} (${pick.name}) แล้ว ข้อมูลจะขึ้นบนเว็บในรอบอัปเดตถัดไป ราว 3–5 นาที`;
    }
  } catch (e) { msg = `เพิ่ม ${q} ไม่สำเร็จ: ${e.message}`; }
}
console.log(msg);
out('message', msg); out('added', added);
