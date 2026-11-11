// ทดลองหา endpoint เส้นอัตราผลตอบแทนพันธบัตรรัฐบาลของ ThaiBMA (ไฟล์ชั่วคราว)
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (thai-price-dashboard)', Accept: '*/*' };
const base = 'https://www.thaibma.or.th';
const page = await (await fetch(base + '/EN/Market/YieldCurve/Government.aspx', { headers: HEADERS })).text();
// สคริปต์ในหน้า: หา url/ajax/transport/read
const scripts = [...page.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
for (const sc of scripts) {
  for (const m of sc.matchAll(/(url\s*[:=]\s*[^,;\n]{3,200}|\$\.(?:ajax|get|post|getJSON)\([^)]{0,200}|read\s*:\s*[^,\n]{3,200}|[\"'][^\"']*(?:yield|Yield|curve|Curve|api)[^\"']*[\"'])/g)) console.log('INLINE:', m[1].slice(0, 220));
}
const srcs = [...new Set([...page.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => new URL(m[1], base).href))].filter((s) => /thaibma|yield|curve|Market/i.test(s));
console.log('SRCS', srcs.join(' | '));
for (const j of srcs) {
  const t = await (await fetch(j, { headers: HEADERS })).text();
  for (const m of t.matchAll(/["'`]([^"'`\s]*(?:yieldcurve|YieldCurve|api\/)[^"'`\s]*)["'`]/g)) console.log('JS', j.split('/').pop(), m[1].slice(0, 200));
}
// ลองเดา action ที่พบบ่อย
const tries = [
  '/yieldcurve/government', '/api/yieldcurve/government', '/api/yieldcurve/getgovernmentyieldcurve',
  '/yieldcurve/GetYieldCurve', '/yieldcurve/Gov', '/yieldcurve/list', '/yieldcurve',
  '/api/yieldcurve', '/yieldcurve/get', '/yieldcurve/govtyieldcurve', '/yieldcurve/latest',
];
for (const p of tries) {
  try {
    const r = await fetch(base + p, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    console.log('TRY', p, r.status, t.replace(/\s+/g, ' ').slice(0, 260));
  } catch (e) { console.log('TRY', p, 'ERR', e.message); }
}
