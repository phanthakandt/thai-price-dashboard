// แหล่งข้อมูลฟรีทั้งหมด (ไม่ต้องใช้ API key)
// แต่ละฟังก์ชันคืนค่า object ข้อมูล หรือ throw error ถ้าดึงไม่ได้

const UA = 'Mozilla/5.0 (thai-price-dashboard)';

// ค่าคงที่สำหรับแปลงหน่วย
export const OZ_TO_GRAM = 31.1034768;        // 1 ทรอยออนซ์ = 31.103 กรัม
export const BAHT_GOLD_GRAM = 15.244;        // ทองแท่ง 1 บาท = 15.244 กรัม
export const THAI_GOLD_PURITY = 0.965;       // ทองไทย 96.5%
export const LITRE_PER_BARREL = 158.987294928;

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} จาก ${new URL(url).host}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} จาก ${new URL(url).host}`);
  return res.text();
}

const toNum = (v) => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const isoDate = (d) => d.toISOString().slice(0, 10);

// ---------- 1) ค่าเงิน: Frankfurter (ข้อมูลอ้างอิงจากธนาคารกลาง ฟรี ไม่ต้องใช้ key) ----------
export async function fetchFx() {
  const latest = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB,EUR,JPY,CNY,GBP');
  const r = latest.rates;
  const thbPer = (cur) => (cur === 'USD' ? r.THB : r.THB / r[cur]);

  // ย้อนหลัง 1 ปีของ USD/THB ใช้แปลงดัชนีหุ้นต่างประเทศเป็นบาท
  const start = new Date(Date.now() - 400 * 864e5);
  const hist = await getJSON(`https://api.frankfurter.dev/v1/${isoDate(start)}..?base=USD&symbols=THB`);
  const usdthbHistory = Object.entries(hist.rates)
    .map(([date, v]) => ({ date, value: v.THB }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    date: latest.date,
    rates: {
      USD: thbPer('USD'),
      EUR: thbPer('EUR'),
      GBP: thbPer('GBP'),
      CNY: thbPer('CNY'),
      JPY100: thbPer('JPY') * 100,
    },
    usdthbHistory,
    source: 'Frankfurter (อัตราอ้างอิงธนาคารกลาง)',
  };
}

// ---------- 2) ทองโลก: gold-api.com (ฟรี ไม่ต้องใช้ key) ----------
export async function fetchWorldGold() {
  const j = await getJSON('https://api.gold-api.com/price/XAU');
  const price = toNum(j.price);
  if (!price) throw new Error('ไม่พบราคาทองโลกในผลลัพธ์');
  return { usdPerOz: price, updatedAt: j.updatedAt || null, source: 'gold-api.com (XAU/USD spot)' };
}

// ---------- 3) ทองไทย: API ที่หน้าเว็บสมาคมค้าทองคำใช้ (JSON) ----------
// Details = รายการทุกครั้งที่ปรับราคาในวันนี้ พร้อมราคาทองโลก (goldSpot) และค่าเงิน (bahtPerUSD) ที่สมาคมฯ ใช้อ้างอิง
const bkkTime = (s) => (s ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + '+07:00').getTime() : null);
export async function fetchThaiGold() {
  const parse = (j) => (typeof j === 'string' ? JSON.parse(j) : j);
  let rows = [];
  try { rows = parse(await getJSON('https://www.goldtraders.or.th/api/GoldPrices/Details?readjson=false')); } catch { /* ใช้ Latest แทน */ }
  if (!Array.isArray(rows) || !rows.length) rows = [parse(await getJSON('https://www.goldtraders.or.th/api/GoldPrices/Latest?readjson=false'))];
  const last = rows.at(-1);
  const barSell = toNum(last?.bL_SellPrice);
  if (!barSell) throw new Error('ไม่พบราคาทองในผลลัพธ์ของสมาคมค้าทองคำ');
  return {
    barBuy: toNum(last.bL_BuyPrice),
    barSell,
    ornamentBuy: toNum(last.oM965_BuyPrice),
    ornamentSell: toNum(last.oM965_SellPrice),
    asOf: last.asTime ? `${last.asTime.slice(11, 16)} น. (ครั้งที่ ${last.seq})` : null,
    asOfTime: bkkTime(last.asTime),
    refSpot: toNum(last.goldSpot),        // ราคาทองโลกที่สมาคมฯ ใช้ตอนประกาศ (USD/ออนซ์)
    refFx: toNum(last.bahtPerUSD),        // ค่าเงินบาทที่สมาคมฯ ใช้ตอนประกาศ
    changeToday: toNum(last.priceChangeFromPrevDayLast),
    today: rows.map((r) => ({ t: bkkTime(r.asTime), sell: toNum(r.bL_SellPrice), spot: toNum(r.goldSpot), fx: toNum(r.bahtPerUSD) })),
    source: 'สมาคมค้าทองคำ (goldtraders.or.th)',
  };
}

// ---------- 4) น้ำมันไทย: API ราคาน้ำมันของบางจาก (สาธารณะ) ----------
export async function fetchThaiOil() {
  let j = await getJSON('https://oil-price.bangchak.co.th/ApiOilPrice2/th');
  if (Array.isArray(j)) j = j[0];
  let list = j.OilList ?? j.oilList ?? [];
  if (typeof list === 'string') list = JSON.parse(list);
  const items = list
    .map((o) => ({
      name: (o.OilName || o.oilName || '').trim(),
      yesterday: toNum(o.PriceYesterday),
      today: toNum(o.PriceToday),
      tomorrow: toNum(o.PriceTomorrow),
    }))
    .filter((o) => o.name && o.today);
  if (!items.length) throw new Error('ไม่พบรายการราคาน้ำมันในผลลัพธ์ของบางจาก');
  return { date: j.OilDateNow || null, remark: j.OilRemark || null, items, source: 'บางจาก (oil-price.bangchak.co.th)' };
}

// ---------- 5) ราคาตลาดโลก/ดัชนีหุ้น: Yahoo Finance chart (ฟรี แต่ไม่เป็นทางการ ข้อมูลดีเลย์) ----------
async function yahooChart(symbol, query) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo ไม่มีข้อมูล ${symbol}`);
  const closes = r.indicators?.quote?.[0]?.close || [];
  const history = (r.timestamp || [])
    .map((ts, i) => ({ date: isoDate(new Date(ts * 1000)), value: closes[i] }))
    .filter((p) => p.value != null);
  return { meta: r.meta, history };
}

export async function fetchYahoo(symbol) {
  let { meta, history } = await yahooChart(symbol, 'range=1y&interval=1d');
  // บางดัชนี (เช่น ^SET.BK) ได้ข้อมูลย้อนหลังมาไม่ครบเมื่อใช้ range ลองขอแบบระบุช่วงวันที่แทน
  if (history.length < 30) {
    const now = Math.floor(Date.now() / 1000);
    try {
      const alt = await yahooChart(symbol, `period1=${now - 400 * 86400}&period2=${now}&interval=1d`);
      if (alt.history.length > history.length) history = alt.history;
    } catch { /* ใช้ชุดเดิม */ }
  }
  // ราคาปิดวันก่อน = ราคาปิดล่าสุดที่อยู่ก่อนวันของราคาล่าสุด
  // (meta.chartPreviousClose คือราคาก่อนวันแรกของช่วงข้อมูล ไม่ใช่เมื่อวาน)
  const lastDate = meta.regularMarketTime ? isoDate(new Date(meta.regularMarketTime * 1000)) : history.at(-1)?.date;
  const before = history.filter((p) => p.date < lastDate);
  const prevClose = before.length ? before.at(-1).value : (meta.previousClose ?? meta.chartPreviousClose);
  return { symbol, currency: meta.currency, price: meta.regularMarketPrice, prevClose, history };
}

// ---------- 6) เงินเฟ้อ: World Bank API (รายปี ฟรี) ----------
export async function fetchInflation() {
  const url = 'https://api.worldbank.org/v2/country/THA;WLD/indicator/FP.CPI.TOTL.ZG?format=json&date=2010:2030&per_page=200';
  const j = await getJSON(url);
  const rows = (j[1] || []).filter((r) => r.value != null);
  const series = (code) =>
    rows
      .filter((r) => r.countryiso3code === code)
      .map((r) => ({ date: r.date, value: r.value }))
      .sort((a, b) => a.date.localeCompare(b.date));
  return {
    thailand: series('THA'),
    world: series('WLD'),
    source: 'World Bank (Inflation, consumer prices, annual %)',
  };
}
