// ทดลองแหล่งข้อมูลการค้าแยกหมวดสินค้า (ไฟล์ชั่วคราว)
const UA = 'Mozilla/5.0 (thai-price-dashboard)';
async function get(u, n = 900) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
    const t = await r.text();
    console.log('\n=== ', u, '→', r.status, t.length, 'bytes');
    console.log(t.replace(/\s+/g, ' ').slice(0, n));
    return t;
  } catch (e) { console.log('\n=== ', u, '→ ERR', e.message, e.cause?.code || ''); }
}
const C = 'https://comtradeapi.un.org/public/v1';
// ช่วงเวลาที่มีข้อมูลของไทย (764) รายเดือน
const da = await get(`${C}/getDA/C/M/HS?reporterCode=764`, 600);
try { const j = JSON.parse(da); console.log('periods:', (j.data || []).map((d) => d.period).sort().slice(-8).join(',')); } catch {}
for (const per of ['202607', '202606', '202605']) {
  const t = await get(`${C}/preview/C/M/HS?reporterCode=764&period=${per}&partnerCode=0&flowCode=X,M&cmdCode=AG2&includeDesc=true`, 1200);
  try {
    const j = JSON.parse(t), d = j.data || [];
    console.log('rows', d.length, 'count', j.count, 'error', j.error);
    const top = (f) => d.filter((r) => r.flowCode === f && r.cmdCode !== 'TOTAL').sort((a, b) => b.primaryValue - a.primaryValue).slice(0, 6).map((r) => `${r.cmdCode} ${String(r.cmdDesc).slice(0, 40)} ${(r.primaryValue / 1e6).toFixed(0)}`).join(' | ');
    console.log('X top:', top('X')); console.log('M top:', top('M'));
    if (d.length) break;
  } catch {}
}
// รายปี (สำรอง)
const t = await get(`${C}/preview/C/A/HS?reporterCode=764&period=2025&partnerCode=0&flowCode=X,M&cmdCode=AG2`, 400);
try { const j = JSON.parse(t); console.log('annual rows', j.data?.length); } catch {}
