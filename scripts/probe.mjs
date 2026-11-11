// ทดลองแหล่งข้อมูลการค้ารายเดือน (ไฟล์ชั่วคราว)
const UA = 'Mozilla/5.0 (thai-price-dashboard)';
async function get(u, accept = 'application/json', n = 700) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(45000) });
    const t = await r.text();
    console.log('\n=== ', u, '[', accept, ']→', r.status, t.length, 'bytes');
    console.log(t.replace(/\s+/g, ' ').slice(0, n));
    return t;
  } catch (e) { console.log('\n=== ', u, '→ ERR', e.message, e.cause?.code || ''); }
}
const B = 'https://api.imf.org/external/sdmx/2.1';
await get(`${B}/dataflow/IMF.STA/IMTS/+`, 'application/xml', 600);
await get(`${B}/datastructure/IMF.STA/DSD_IMTS/+?references=none`, 'application/xml', 3000);
await get(`${B}/data/IMTS/M.TH.XG_FOB_USD+MG_CIF_USD.W00?startPeriod=2025-01`, 'application/vnd.sdmx.data+json;version=1.0.0', 900);
await get(`${B}/data/IMTS/M.TH.XG_FOB_USD.W00?startPeriod=2025-01`, 'application/xml', 900);
await get(`${B}/data/IMF.STA,IMTS/THA.XG_FOB_USD.G001.M?startPeriod=2025-01`, 'application/xml', 900);
await get('https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/IMTS/+/THA.*.G001.M?c[TIME_PERIOD]=ge:2025-01', 'application/json', 900);
await get('https://api.worldbank.org/v2/country/THA/indicator/NE.EXP.GNFS.CD?format=json&date=2015:2026&per_page=50', 'application/json', 300);
await get('https://api.worldbank.org/v2/country/THA/indicator/NE.EXP.GNFS.KD.ZG?format=json&date=2015:2026&per_page=50', 'application/json', 300);
