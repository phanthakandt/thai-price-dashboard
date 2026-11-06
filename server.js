// เว็บรวมราคา หุ้น น้ำมัน ทอง ค่าเงิน เงินเฟ้อ — เทียบไทยกับโลก และจับทิศทางที่ราคาไทยน่าจะปรับตาม
// รัน:  node server.js        แล้วเปิด http://localhost:3000
// โหมดข้อมูลตัวอย่าง (ไม่ต่อเน็ต): MOCK=1 node server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHistory } from './lib/history.js';
import { createBuilder } from './lib/build.js';

const PORT = process.env.PORT || 3000;
const MOCK = process.env.MOCK === '1';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const S = MOCK ? await import('./mock.js') : await import('./sources.js');
const history = createHistory(path.join(DIR, 'data', 'history.json'),
  MOCK ? { persist: false, seed: S.seedHistory() } : {});

const MIN = 60_000;
const { buildData } = createBuilder({ S, history, mock: MOCK });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/data' || url.pathname === '/data.json') {
        const data = await buildData();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(data));
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (file.includes('..')) throw Object.assign(new Error('bad path'), { code: 'ENOENT' });
      const body = await readFile(path.join(DIR, 'public', file));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(e.code === 'ENOENT' ? 'ไม่พบหน้า' : 'เกิดข้อผิดพลาด');
      if (e.code !== 'ENOENT') console.error(e);
    }
  })
  .listen(PORT, () => console.log(`เปิดเว็บที่ http://localhost:${PORT}${MOCK ? '  (โหมดข้อมูลตัวอย่าง)' : ''}`));

// เก็บประวัติต่อเนื่องแม้ไม่มีใครเปิดหน้าเว็บ (ทองทุก 2 นาที, น้ำมันทุก 30 นาที)
if (!MOCK) {
  const tick = () => buildData().catch((e) => console.error('[bg]', e.message));
  tick();
  setInterval(tick, 2 * MIN);
}
