// ตัวอ่านไฟล์ .xlsx แบบเล็ก (ไม่ต้องติดตั้งแพ็กเกจ) อ่านได้เฉพาะค่าในเซลล์ของแต่ละชีต
import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  // หา End of Central Directory แล้วอ่านรายการไฟล์ใน zip
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ไม่ใช่ไฟล์ xlsx (zip)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(lStart, lStart + csize);
    files[name] = () => (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const textOf = (xml) => unescape([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// คืนค่า { ชื่อชีต: [[แถว 0], [แถว 1], ...] } ช่องว่างเป็น ''
export function readXlsx(buf) {
  const z = unzip(Buffer.from(buf));
  const shared = z['xl/sharedStrings.xml'] ? [...z['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const wb = z['xl/workbook.xml']();
  const rels = z['xl/_rels/workbook.xml.rels']();
  const target = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
    m[0].match(/Id="([^"]+)"/)[1], m[0].match(/Target="([^"]+)"/)[1].replace(/^\/?(xl\/)?/, 'xl/')]));
  const out = {};
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescape(m[0].match(/name="([^"]+)"/)[1]);
    const rid = m[0].match(/r:id="([^"]+)"/)[1];
    const xml = z[target[rid]]?.();
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/r="([A-Z]+\d+)"/)?.[1];
        if (!ref) continue;
        const type = c[1].match(/t="([^"]+)"/)?.[1];
        const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val = '';
        if (type === 's') val = shared[+v] ?? '';
        else if (type === 'inlineStr') val = textOf(c[2] || '');
        else if (type === 'str' || type === 'e') val = v != null ? unescape(v) : '';
        else if (type === 'b') val = v === '1';
        else if (v != null) val = Number(v);
        row[colIndex(ref)] = val;
      }
      rows[+r[1] - 1] = Array.from(row, (x) => x ?? '');
    }
    out[name] = Array.from(rows, (x) => x ?? []);
  }
  return out;
}
