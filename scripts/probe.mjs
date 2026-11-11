// ดูรูปแบบข้อมูลเส้นอัตราผลตอบแทนของ ThaiBMA (ไฟล์ชั่วคราว)
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (thai-price-dashboard)', Accept: 'application/json' };
const base = 'https://www.thaibma.or.th';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function show(p, n = 900) {
  try {
    const r = await fetch(base + p, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    console.log('\nGET', p, r.status, t.length, 'bytes');
    let j; try { j = JSON.parse(t); } catch { console.log('  not json:', t.slice(0, 200)); return; }
    const top = Array.isArray(j) ? `array[${j.length}]` : Object.keys(j).join(',');
    console.log('  keys:', top);
    const arr = Array.isArray(j) ? j : Object.values(j).find(Array.isArray);
    if (arr) { console.log('  n =', arr.length); console.log('  first:', JSON.stringify(arr[0]).slice(0, 400)); console.log('  last :', JSON.stringify(arr.at(-1)).slice(0, 400)); }
    else console.log('  body:', t.slice(0, n));
  } catch (e) { console.log('\nGET', p, 'ERR', e.message, e.cause?.code || ''); }
  await sleep(1500);
}
await show('/api/yieldcurve/getgovernmentyieldcurve');
await show('/yieldcurve/avail');
await show('/yieldcurve/availyear');
await show('/yieldcurve/getintpttm?year=2026');
await show('/yieldcurve/getbyyear?year=2026');
// curve ทั้งเส้นของวันล่าสุด
try {
  const j = await (await fetch(base + '/api/yieldcurve/getgovernmentyieldcurve', { headers: HEADERS })).json();
  console.log('\nCURVE', j.Curve.length, 'points; tenors:', j.Curve.filter((_, i) => i % 3 === 0).map((p) => `${p.X.toFixed(2)}y=${p.Y.toFixed(3)}`).join(' '));
  console.log('other keys:', Object.keys(j).filter((k) => k !== 'Curve').map((k) => `${k}=${JSON.stringify(j[k]).slice(0, 120)}`).join(' | '));
} catch (e) { console.log('curve err', e.message); }
