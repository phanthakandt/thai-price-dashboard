// ทดลองแหล่งข้อมูล GDP/การค้า/ดุลบัญชี (ไฟล์ชั่วคราว)
const H = { 'User-Agent': 'Mozilla/5.0 (thai-price-dashboard)', Accept: 'application/json,*/*' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u, n = 500) {
  try {
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    console.log('\n=== ', u, '→', r.status, t.length, 'bytes');
    console.log(t.replace(/\s+/g, ' ').slice(0, n));
    return t;
  } catch (e) { console.log('\n=== ', u, '→ ERR', e.message, e.cause?.code || ''); }
  await sleep(500);
}
// IMF DataMapper: ตัวชี้และประเทศเพื่อนบ้าน
for (const ind of ['NGDPD', 'NGDPDPC', 'BCA', 'BCA_NGDPD', 'TX_RPCH', 'TM_RPCH', 'TXG_RPCH', 'TMG_RPCH']) {
  const t = await get(`https://www.imf.org/external/datamapper/api/v1/${ind}/THA/VNM/MYS/IDN/PHL/SGP`, 300);
  try { const j = JSON.parse(t); const v = j.values?.[ind]; console.log('  countries:', v ? Object.keys(v).join(',') : 'none', ' THA 2024-2027:', v?.THA ? ['2024', '2025', '2026', '2027'].map((y) => v.THA[y]).join('/') : '-'); } catch {}
}
// World Bank: การค้า (% GDP และมูลค่า)
await get('https://api.worldbank.org/v2/country/THA;VNM;MYS/indicator/NE.EXP.GNFS.CD?format=json&date=2022:2026&per_page=50', 400);
await get('https://api.worldbank.org/v2/country/THA/indicator/BN.CAB.XOKA.GD.ZS?format=json&date=2020:2026&per_page=50', 400);
// ข้อมูลการค้ารายเดือนของไทย
await get('https://data.go.th/api/3/action/package_search?q=%E0%B8%A1%E0%B8%B9%E0%B8%A5%E0%B8%84%E0%B9%88%E0%B8%B2%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B8%AA%E0%B9%88%E0%B8%87%E0%B8%AD%E0%B8%AD%E0%B8%81&rows=8', 1500);
await get('https://tradereport.moc.go.th/th', 400);
await get('https://www.customs.go.th/statistic_report.php?lang=th', 400);
await get('https://api.imf.org/external/sdmx/2.1/data/IMTS/M.TH.XG_FOB_USD+MG_CIF_USD.W00?startPeriod=2025-01&format=jsondata', 800);
await get('https://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/IMTS/M.TH.TXG_FOB_USD.W00?startPeriod=2025', 600);
