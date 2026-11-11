const UA = 'Mozilla/5.0 (thai-price-dashboard)';
async function get(u) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/xml' }, signal: AbortSignal.timeout(45000) });
    const t = await r.text();
    console.log('\n=== ', u, '→', r.status, t.length);
    const ds = t.slice(t.indexOf('<message:DataSet'));
    console.log(ds.replace(/\s+/g, ' ').slice(0, 2500));
  } catch (e) { console.log('\n=== ', u, '→ ERR', e.message); }
}
const B = 'https://api.imf.org/external/sdmx/2.1/data/IMF.STA,IMTS';
await get(`${B}/THA.XG_FOB_USD+MG_CIF_USD+TBG_USD.G001.M?startPeriod=2026-01`);
await get(`${B}/THA+VNM+MYS+IDN+PHL+SGP.XG_FOB_USD.G001.M?startPeriod=2026-06`);
