const UA = 'Mozilla/5.0 (thai-price-dashboard)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = 'https://comtradeapi.un.org/public/v1';
for (const per of ['202605', '202505', '202601,202602,202603,202604,202605']) {
  await sleep(6000);
  const u = `${C}/preview/C/M/HS?reporterCode=764&period=${per}&partnerCode=0&flowCode=X,M&cmdCode=AG2&includeDesc=true`;
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
  const j = await r.json().catch(() => ({}));
  const d = j.data || [];
  console.log('\n=== ', per, r.status, 'rows', d.length, 'count', j.count, j.error || j.message || '');
  if (!d.length) continue;
  console.log('keys:', Object.keys(d[0]).join(','));
  console.log('distinct mot/customs/partner2:', [...new Set(d.map((x) => `${x.motCode}/${x.customsCode}/${x.partner2Code}`))].slice(0, 5).join(' '), 'periods', [...new Set(d.map((x) => x.period))].join(','));
  const top = (f) => d.filter((x) => x.flowCode === f).sort((a, b) => b.primaryValue - a.primaryValue).slice(0, 8).map((x) => `${x.cmdCode} ${String(x.cmdDesc).slice(0, 45)} ${(x.primaryValue / 1e6).toFixed(0)}`).join(' | ');
  console.log('X:', top('X')); console.log('M:', top('M'));
  const sum = (f) => d.filter((x) => x.flowCode === f).reduce((s, x) => s + x.primaryValue, 0) / 1e9;
  console.log('sum X', sum('X').toFixed(2), 'M', sum('M').toFixed(2), 'bn');
}
