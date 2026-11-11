// ทดลองว่าแหล่งข้อมูลตราสารหนี้ใดเข้าได้จาก GitHub Actions (ไฟล์ชั่วคราว)
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (thai-price-dashboard)', Accept: '*/*' };
const urls = [
  'https://www.thaibma.or.th/',
  'https://www.thaibma.or.th/EN/Market/YieldCurve/Government.aspx',
  'https://www.thaibma.or.th/yieldcurve/government',
  'https://fred.stlouisfed.org/graph/fredgraph.csv?id=IRLTLT01THM156N',
  'https://www.bot.or.th/th/statistics/interest-rate.html',
  'https://asianbondsonline.adb.org/economy/?economy=TH',
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(25000), redirect: 'follow' });
    const t = await r.text();
    const apis = [...new Set([...t.matchAll(/["'(]((?:https?:\/\/[^"'()\s]*)?\/(?:api|Api|API|_next\/data|services?)\/[^"'()\s]{3,120})["')]/g)].map((m) => m[1]))].slice(0, 25);
    const js = [...new Set([...t.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]))].slice(0, 15);
    console.log('\n=== ', u, '→', r.status, r.headers.get('content-type'), t.length, 'bytes final', r.url);
    console.log('TEXT:', t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600));
    if (apis.length) console.log('APIS:', apis.join(' | '));
    if (js.length) console.log('JS:', js.join(' | '));
  } catch (e) { console.log('\n=== ', u, '→ ERROR', e.message, e.cause?.code || ''); }
}
// ไล่หา endpoint ของ ThaiBMA ในไฟล์ JS ของหน้าแรก
try {
  const home = await (await fetch('https://www.thaibma.or.th/', { headers: HEADERS })).text();
  const js = [...new Set([...home.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => new URL(m[1], 'https://www.thaibma.or.th/').href))].slice(0, 12);
  for (const j of js) {
    const t = await (await fetch(j, { headers: HEADERS })).text();
    const hits = [...new Set([...t.matchAll(/["'`]((?:https?:\/\/[a-z0-9.-]*thaibma[^"'`\s]*)|(?:\/api\/[^"'`\s]{3,100}))["'`]/gi)].map((m) => m[1]))].filter((x) => /yield|curve|gov|api/i.test(x)).slice(0, 30);
    if (hits.length) console.log('\nJS HITS', j, '\n  ', hits.join('\n   '));
  }
} catch (e) { console.log('js scan error', e.message); }
