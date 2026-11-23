const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const c1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' }).catch(() => null);
const cookie = (c1?.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
const crumb = await (await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } })).text();
const H = { 'User-Agent': UA, Cookie: cookie, 'Content-Type': 'application/json' };
// screener: หุ้นในตลาด SET เรียงตามมูลค่าตลาด
const body = { offset: 0, size: 120, sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY',
  query: { operator: 'AND', operands: [{ operator: 'eq', operands: ['exchange', 'SET'] }] }, userId: '', userIdType: 'guid' };
const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(crumb)}&lang=en-US&region=TH&formatted=false`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const t = await r.text(); console.log('=== screener', r.status, t.length);
try { const q = JSON.parse(t).finance.result[0]; console.log('total', q.total, 'got', q.quotes.length); console.log(q.quotes.slice(0, 120).map((x) => `${x.symbol}:${Math.round((x.marketCap || 0) / 1e9)}`).join(' ')); console.log('keys', Object.keys(q.quotes[0]).join(',')); } catch (e) { console.log(t.slice(0, 500)); }
// predefined screener fallback
const r2 = await fetch(`https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=5&region=TH&crumb=${encodeURIComponent(crumb)}`, { headers: H });
console.log('=== predefined', r2.status, (await r2.text()).slice(0, 200));
// 5y chart size
const r3 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/CPALL.BK?range=5y&interval=1d', { headers: { 'User-Agent': UA } });
const j3 = await r3.json(); console.log('=== 5y', r3.status, j3.chart.result[0].timestamp.length, 'points', JSON.stringify(j3).length, 'bytes', 'events?', Object.keys(j3.chart.result[0].events || {}));
// quarterly timeseries
const r4 = await fetch('https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/CPALL.BK?type=quarterlyTotalRevenue,quarterlyNetIncome,annualTotalRevenue,annualNetIncome,annualDilutedEPS,annualFreeCashFlow&period1=1500000000&period2=1800000000', { headers: { 'User-Agent': UA } });
const j4 = await r4.json(); console.log('=== ts', r4.status, j4.timeseries.result.map((x) => `${x.meta.type[0]}:${(x[x.meta.type[0]] || []).length} last ${(x[x.meta.type[0]] || []).at(-1)?.asOfDate}`).join(' | '));
