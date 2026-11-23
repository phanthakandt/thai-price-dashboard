// ทดลองแหล่งข้อมูลหุ้น (ไฟล์ชั่วคราว)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const ORIGIN = 'https://phanthakandt.github.io';
async function get(u, { n = 600, headers = {} } = {}) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Origin: ORIGIN, ...headers }, signal: AbortSignal.timeout(30000), redirect: 'manual' });
    const t = await r.text();
    console.log('\n=== ', u.slice(0, 160), '→', r.status, t.length, 'ACAO=', r.headers.get('access-control-allow-origin'));
    console.log(t.replace(/\s+/g, ' ').slice(0, n));
    return { r, t };
  } catch (e) { console.log('\n=== ', u, '→ ERR', e.message); return {}; }
}
await get('https://query1.finance.yahoo.com/v8/finance/chart/PTT.BK?range=5d&interval=1d', { n: 200 });
await get('https://query2.finance.yahoo.com/v1/finance/search?q=cpall&quotesCount=5&newsCount=0', { n: 500 });
// crumb + quoteSummary
const c1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' }).catch(() => null);
const cookie = (c1?.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
console.log('\ncookie:', cookie ? cookie.slice(0, 40) + '…' : 'none', c1?.status);
const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
const crumb = await cr.text(); console.log('crumb', cr.status, crumb.slice(0, 20));
for (const s of ['PTT.BK', 'CPALL.BK', 'AAPL']) {
  const { t } = await get(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${s}?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents&crumb=${encodeURIComponent(crumb)}`, { n: 300, headers: { Cookie: cookie } });
  try {
    const j = JSON.parse(t).quoteSummary.result[0], f = j.financialData || {}, sd = j.summaryDetail || {}, k = j.defaultKeyStatistics || {};
    const r = (o) => o?.raw ?? null;
    console.log(s, { pe: r(sd.trailingPE), fpe: r(sd.forwardPE), pb: r(k.priceToBook), dy: r(sd.dividendYield), roe: r(f.returnOnEquity), de: r(f.debtToEquity), rg: r(f.revenueGrowth), eg: r(f.earningsGrowth), pm: r(f.profitMargins), tgt: r(f.targetMeanPrice), nAn: r(f.numberOfAnalystOpinions), rec: f.recommendationKey, sector: j.assetProfile?.sector, ind: j.assetProfile?.industry, mcap: r(j.price?.marketCap), beta: r(sd.beta), exDiv: r(j.calendarEvents?.exDividendDate), earn: j.calendarEvents?.earnings?.earningsDate?.[0]?.fmt });
  } catch (e) { console.log(s, 'parse fail', e.message); }
}
// v7 quote (many symbols at once)
await get(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=PTT.BK,CPALL.BK,AOT.BK&crumb=${encodeURIComponent(crumb)}`, { n: 400, headers: { Cookie: cookie } });
// timeseries fundamentals (งบย้อนหลัง)
await get(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/CPALL.BK?type=annualTotalRevenue,annualNetIncome,annualDilutedEPS&period1=1500000000&period2=1800000000`, { n: 500 });
// รายชื่อ SET100
await get('https://en.wikipedia.org/w/api.php?action=parse&page=SET100_Index&prop=wikitext&format=json', { n: 800 });
