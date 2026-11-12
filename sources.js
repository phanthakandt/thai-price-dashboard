// แหล่งข้อมูลฟรีทั้งหมด (ไม่ต้องใช้ API key)
// แต่ละฟังก์ชันคืนค่า object ข้อมูล หรือ throw error ถ้าดึงไม่ได้

import { readXlsx } from './lib/xlsx-lite.js';

const UA = 'Mozilla/5.0 (thai-price-dashboard)';

// ค่าคงที่สำหรับแปลงหน่วย
export const OZ_TO_GRAM = 31.1034768;        // 1 ทรอยออนซ์ = 31.103 กรัม
export const BAHT_GOLD_GRAM = 15.244;        // ทองแท่ง 1 บาท = 15.244 กรัม
export const THAI_GOLD_PURITY = 0.965;       // ทองไทย 96.5%
export const LITRE_PER_BARREL = 158.987294928;

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 15000),
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
  const vols = r.indicators?.quote?.[0]?.volume || [];
  const history = (r.timestamp || [])
    .map((ts, i) => ({ date: isoDate(new Date(ts * 1000)), value: closes[i], volume: vols[i] ?? null }))
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
  // SET: Yahoo มักให้ประวัติมาไม่ครบ ใช้ API ของตลาดหลักทรัพย์ฯ แทน (ข้อมูลรายวัน 1 ปี)
  if (symbol === '^SET.BK' && history.length < 30) {
    try {
      const j = await getJSON('https://www.set.or.th/api/set/index/SET/chart-quotation?period=1Y&accumulated=false',
        { headers: { Referer: 'https://www.set.or.th/th/market/index/set/overview' } });
      const h = (j.quotations || []).map((q) => ({ date: String(q.localDatetime || q.datetime).slice(0, 10), value: toNum(q.price) }))
        .filter((p) => p.value != null);
      if (h.length > history.length) history = h;
    } catch (e) { console.error('[SET history]', e.message); }
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

// ---------- 7) โครงสร้างราคาน้ำมันรายวันของ สนพ. (ไฟล์ Excel) ----------
// แยกราคาขายปลีกเป็น ราคา ณ โรงกลั่น + ภาษี + กองทุนน้ำมัน + ค่าการตลาด
const EPPO_KEYS = [
  ['g95', /^GASOHOL95 E10/i], ['g91', /^GASOHOL91/i], ['e20', /^GASOHOL95 E20/i], ['e85', /^GASOHOL95 E85/i],
  ['ulg95', /^ULG95/i], ['b20', /^H-DIESEL\s+B20/i], ['diesel', /^H-DIESEL\s*$/i], ['lpg', /^LPG/i],
];
const excelDate = (n) => new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10);

const EPPO_LIST = 'https://www.eppo.go.th/data-energy-statistic/energy-price-th/%e0%b9%82%e0%b8%84%e0%b8%a3%e0%b8%87%e0%b8%aa%e0%b8%a3%e0%b9%89%e0%b8%b2%e0%b8%87%e0%b8%a3%e0%b8%b2%e0%b8%84%e0%b8%b2%e0%b8%99%e0%b9%89%e0%b8%b3%e0%b8%a1%e0%b8%b1%e0%b8%99-lpg/';
// รายชื่อไฟล์จากหน้ารวมของ สนพ. (ชื่อไฟล์ไม่สม่ำเสมอ เช่น 2026-9-5, 2026-09-05, 2026-9-30-1)
export async function fetchEppoIndex(pages = 12) {
  const map = {};
  for (let p = 1; p <= pages; p++) {
    let html;
    try { html = await getText(p === 1 ? EPPO_LIST : `${EPPO_LIST}page/${p}/`); } catch { break; }
    for (const m of html.matchAll(/href="([^"]*pt-price-st-(\d{4})-(\d{1,2})-(\d{1,2})(?:-\d+)?\.xlsx)"/gi)) {
      const date = `${m[2]}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}`;
      map[date] ??= m[1];
    }
  }
  return map;
}

export async function fetchEppo(date, knownUrl = null) {
  const [y, m, dd] = date.split('-');
  const d = new Date(date + 'T00:00:00Z');
  const folders = [`${y}/${m}`];
  for (const off of [1, -1]) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + off, 1));
    folders.push(`${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const names = [...new Set([`${y}-${m}-${dd}`, `${y}-${+m}-${+dd}`, `${y}-${+m}-${dd}`])];
  const urls = knownUrl ? [knownUrl] : folders.flatMap((f) => names.map((n) => `https://www.eppo.go.th/wp-content/uploads/${f}/pt-price-st-${n}.xlsx`));
  let buf = null, lastErr;
  for (const url of urls) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (res.ok) { buf = Buffer.from(await res.arrayBuffer()); break; }
    lastErr = `HTTP ${res.status}`;
    if (res.status !== 404) break;
  }
  if (!buf) throw Object.assign(new Error(`ไม่พบไฟล์โครงสร้างราคาของ สนพ. วันที่ ${date} (${lastErr})`), { notFound: lastErr === 'HTTP 404' });

  const sheets = readXlsx(buf);
  const rows = sheets['Oil Price Structure'] || Object.values(sheets)[0];
  const label = (r) => String(r?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const head = rows.findIndex((r) => r.some((c) => /EX-REFIN/i.test(String(c))));
  if (head < 0) throw new Error('รูปแบบไฟล์ สนพ. เปลี่ยน (ไม่พบหัวตาราง)');
  const cols = rows[head].map((c) => String(c).replace(/\s+/g, ' ').trim().toUpperCase());
  const ci = (re) => cols.findIndex((c) => re.test(c));
  const C = { exr: ci(/^EX-REFIN/), disc: ci(/^DISCOUNT/), excise: ci(/^EXCISE/), fund: ci(/^OIL FUND/), ws: ci(/^WHOLESALE/), mm: ci(/^MARKETING/), retail: ci(/^RETAIL/) };
  const products = {};
  for (let i = head + 1; i < rows.length && label(rows[i]); i++) {
    const r = rows[i];
    const key = EPPO_KEYS.find(([, re]) => re.test(label(r)))?.[0];
    if (!key) continue;
    const num = (c) => (c >= 0 && typeof r[c] === 'number' ? r[c] : null);
    products[key] = { name: label(r), exr: num(C.exr), discount: num(C.disc) || 0, excise: num(C.excise), fund: num(C.fund), ws: num(C.ws), mm: num(C.mm), retail: num(C.retail) };
  }
  if (!products.g95 && !products.diesel) throw new Error('อ่านโครงสร้างราคาจากไฟล์ สนพ. ไม่ได้');
  const fxRow = rows.find((r) => /Exchange Rate/i.test(label(r)));
  const serial = rows.slice(0, head).flat().find((c) => typeof c === 'number' && c > 40000 && c < 80000);
  const avgRow = (re) => { const r = rows.find((x) => re.test(label(x))); const nums = (r || []).filter((c) => typeof c === 'number'); return nums.at(-1) ?? null; };
  return {
    date: serial ? excelDate(serial) : date,
    fx: fxRow ? fxRow.find((c) => typeof c === 'number') : null,
    products,
    avgMM: { all: avgRow(/AVERAGE MARKETING MARGIN OF GASOLINE/i), diesel: avgRow(/AVERAGE MARKETING MARGIN OF DIESEL/i) },
    source: 'สนพ. (eppo.go.th)',
  };
}

// ---------- 8) ข่าวล่าสุด: Google News RSS (เฉพาะหัวข้อข่าว) ----------
export async function fetchNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=th&gl=TH&ceid=TH:th`;
  const xml = await getText(url);
  const tag = (s, t) => s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? '';
  const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map((m) => {
    const it = m[1];
    const source = dec(tag(it, 'source'));
    let title = dec(tag(it, 'title'));
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    return { title, link: tag(it, 'link'), source, time: Date.parse(tag(it, 'pubDate')) || null };
  }).filter((n) => n.title && n.link);
}

// ---------- 9) อัตราการว่างงาน ----------
export const UNEMP_COUNTRIES = { THA: 'ไทย', WLD: 'ค่าเฉลี่ยโลก', MYS: 'มาเลเซีย', VNM: 'เวียดนาม', PHL: 'ฟิลิปปินส์', USA: 'สหรัฐ', CHN: 'จีน', JPN: 'ญี่ปุ่น' };

// รายปี: World Bank (ประมาณการตามมาตรฐาน ILO) มีค่าเฉลี่ยโลกให้เทียบ
export async function fetchUnemploymentAnnual() {
  const codes = Object.keys(UNEMP_COUNTRIES).join(';');
  const j = await getJSON(`https://api.worldbank.org/v2/country/${codes}/indicator/SL.UEM.TOTL.ZS?format=json&date=2010:2030&per_page=500`);
  const out = {};
  for (const r of j[1] || []) {
    if (r.value == null) continue;
    (out[r.countryiso3code] ??= []).push({ date: r.date, value: r.value });
  }
  for (const k in out) out[k].sort((a, b) => a.date.localeCompare(b.date));
  if (!out.THA?.length) throw new Error('ไม่พบข้อมูลการว่างงานของไทยจาก World Bank');
  return { series: out, source: 'World Bank / ILO (รายปี)' };
}

// รายไตรมาส: ILOSTAT (จากการสำรวจภาวะการทำงานของแต่ละประเทศ ไม่ปรับฤดูกาล)
export async function fetchUnemploymentQuarterly() {
  const areas = ['THA', 'MYS', 'VNM', 'PHL', 'USA', 'JPN'].join('+');
  const from = new Date().getUTCFullYear() - 4;
  const url = `https://rplumber.ilo.org/data/indicator/?id=UNE_DEAP_SEX_AGE_RT_Q&ref_area=${areas}&sex=SEX_T&classif1=AGE_YTHADULT_YGE15&timefrom=${from}&format=.csv`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} จาก rplumber.ilo.org`);
  const lines = (await res.text()).trim().split('\n');
  const head = lines.shift().split(',').map((h) => h.replace(/"/g, ''));
  const ix = (k) => head.indexOf(k);
  const out = {};
  for (const l of lines) {
    const c = l.split(',').map((x) => x.replace(/"/g, ''));
    const v = toNum(c[ix('obs_value')]);
    if (v == null) continue;
    (out[c[ix('ref_area')]] ??= []).push({ date: c[ix('time')], value: v });
  }
  for (const k in out) {
    // ถ้าประเทศเดียวกันมีหลายแหล่งข้อมูลในไตรมาสเดียวกัน ใช้ค่าแรก
    const seen = new Set();
    out[k] = out[k].filter((p) => !seen.has(p.date) && seen.add(p.date)).sort((a, b) => a.date.localeCompare(b.date));
  }
  if (!out.THA?.length) throw new Error('ไม่พบข้อมูลการว่างงานรายไตรมาสของไทยจาก ILO');
  return { series: out, source: 'ILOSTAT (รายไตรมาส)' };
}

// ---------- 10) คนทำงานแยกตามอาชีพและภาคธุรกิจ (ILOSTAT รายไตรมาส หน่วย: พันคน) ----------
export const OCCUPATIONS = {
  1: 'ผู้บริหาร ผู้จัดการ', 2: 'ผู้ประกอบวิชาชีพ (แพทย์ วิศวกร ครู ฯลฯ)', 3: 'ช่างเทคนิคและผู้ช่วยวิชาชีพ',
  4: 'เสมียน งานสำนักงาน', 5: 'พนักงานบริการและพนักงานขาย', 6: 'เกษตรกร ประมง ป่าไม้ (มีฝีมือ)',
  7: 'ช่างฝีมือ (ก่อสร้าง โลหะ อิเล็กทรอนิกส์ ฯลฯ)', 8: 'ผู้ควบคุมเครื่องจักรและงานประกอบ คนขับรถ', 9: 'อาชีพพื้นฐาน / แรงงานทั่วไป', 0: 'ทหาร',
};
export const INDUSTRIES = {
  A: 'เกษตร ป่าไม้ ประมง', B: 'เหมืองแร่', C: 'การผลิต (โรงงาน)', D: 'ไฟฟ้า ก๊าซ', E: 'ประปา จัดการของเสีย', F: 'ก่อสร้าง',
  G: 'ขายส่ง ขายปลีก ซ่อมรถ', H: 'ขนส่งและคลังสินค้า', I: 'โรงแรมและร้านอาหาร', J: 'ไอทีและการสื่อสาร', K: 'การเงินและประกันภัย',
  L: 'อสังหาริมทรัพย์', M: 'วิชาชีพ วิทยาศาสตร์ เทคนิค', N: 'บริการสนับสนุนธุรกิจ', O: 'ราชการและป้องกันประเทศ', P: 'การศึกษา',
  Q: 'สุขภาพและสังคมสงเคราะห์', R: 'ศิลปะ บันเทิง นันทนาการ', S: 'บริการอื่น ๆ', T: 'ลูกจ้างในครัวเรือน', U: 'องค์การระหว่างประเทศ',
};

// อ่านข้อมูล ILO หนึ่งชุด แล้วแยกตามกลุ่ม (classif1) ที่ขึ้นต้นด้วย prefix ที่ระบุ
async function iloSeries(id, prefixes) {
  const from = new Date().getUTCFullYear() - 4;
  const url = `https://rplumber.ilo.org/data/indicator/?id=${id}&ref_area=THA&sex=SEX_T&timefrom=${from}&format=.csv`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} จาก rplumber.ilo.org`);
  const lines = (await res.text()).trim().split('\n');
  const head = lines.shift().split(',').map((h) => h.replace(/"/g, ''));
  const ix = (k) => head.indexOf(k);
  const out = Object.fromEntries(prefixes.map((p) => [p, {}])), seen = new Set();
  for (const l of lines) {
    const c = l.split(',').map((x) => x.replace(/"/g, ''));
    const cls = c[ix('classif1')];
    const prefix = prefixes.find((p) => cls.startsWith(p));
    if (!prefix) continue;
    const key = cls.slice(prefix.length), date = c[ix('time')], v = toNum(c[ix('obs_value')]);
    if (v == null || seen.has(cls + date)) continue;
    seen.add(cls + date);
    (out[prefix][key] ??= []).push({ date, value: v });
  }
  for (const p of prefixes) for (const k in out[p]) out[p][k].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export const SKILLS = { 'L3-4': 'ทักษะสูง (ผู้บริหาร วิชาชีพ ช่างเทคนิค)', L2: 'ทักษะกลาง (สำนักงาน บริการ เกษตร ช่าง คุมเครื่องจักร)', L1: 'ทักษะพื้นฐาน (แรงงานทั่วไป)' };

export async function fetchJobsByGroup() {
  const [occ, ind] = await Promise.all([
    iloSeries('EMP_TEMP_SEX_OCU_NB_Q', ['OCU_ISCO08_', 'OCU_SKILL_']),
    iloSeries('EMP_TEMP_SEX_ECO_NB_Q', ['ECO_ISIC4_']),
  ]);
  const occupation = occ.OCU_ISCO08_, skill = occ.OCU_SKILL_, industry = ind.ECO_ISIC4_;
  if (!occupation.TOTAL?.length && !industry.TOTAL?.length) throw new Error('ไม่พบข้อมูลคนทำงานแยกตามอาชีพของไทยจาก ILO');
  return { occupation, industry, skill, source: 'ILOSTAT (สำรวจภาวะการทำงานของประชากร)' };
}

// ---------- 11) กลุ่มธุรกิจในตลาดหุ้นไทย: ราคาและมูลค่าซื้อขายของหุ้นหลักในแต่ละกลุ่ม (Yahoo, 6 เดือน) ----------
export async function fetchStockDaily(symbol) {
  const { meta, history } = await yahooChart(symbol, 'range=6mo&interval=1d');
  if (history.length < 40) throw new Error(`ข้อมูล ${symbol} ไม่พอ`);
  return { symbol, price: meta.regularMarketPrice, currency: meta.currency, history };
}

// ---------- 12) ประมาณการเศรษฐกิจของ IMF (World Economic Outlook) ----------
export const IMF_INDICATORS = {
  NGDP_RPCH: 'GDP เติบโต (%)',
  PCPIPCH: 'เงินเฟ้อ (%)',
  LUR: 'อัตราการว่างงาน (%)',
};
export async function fetchImfOutlook() {
  const out = {};
  for (const ind of Object.keys(IMF_INDICATORS)) {
    const j = await getJSON(`https://www.imf.org/external/datamapper/api/v1/${ind}/THA/WEOWORLD`);
    const v = j?.values?.[ind] || {};
    out[ind] = { THA: v.THA || {}, WLD: v.WEOWORLD || {} };
  }
  if (!Object.keys(out.NGDP_RPCH.THA).length) throw new Error('ไม่พบข้อมูลประมาณการของ IMF สำหรับไทย');
  return { data: out, source: 'IMF World Economic Outlook' };
}

// ---------- 12b) GDP และดุลบัญชีเดินสะพัด: ไทยเทียบเพื่อนบ้าน (IMF DataMapper, รายปี + ประมาณการ) ----------
export const PEERS = { THA: 'ไทย', VNM: 'เวียดนาม', MYS: 'มาเลเซีย', IDN: 'อินโดนีเซีย', PHL: 'ฟิลิปปินส์', SGP: 'สิงคโปร์', KHM: 'กัมพูชา', LAO: 'ลาว', MMR: 'เมียนมา' };
export const PEER_INDICATORS = {
  NGDP_RPCH: 'GDP เติบโต (%)',
  NGDPD: 'ขนาด GDP (พันล้านดอลลาร์)',
  NGDPDPC: 'GDP ต่อหัว (ดอลลาร์)',
  BCA: 'ดุลบัญชีเดินสะพัด (พันล้านดอลลาร์)',
  BCA_NGDPD: 'ดุลบัญชีเดินสะพัด (% ของ GDP)',
};
export async function fetchPeersOutlook() {
  const codes = [...Object.keys(PEERS), 'WEOWORLD'], y0 = new Date().getUTCFullYear(), out = {};
  for (const ind of Object.keys(PEER_INDICATORS)) {
    // API คืนทุกประเทศเสมอ (~150KB) จึงเลือกเฉพาะประเทศที่ใช้ และปี y0−6 ถึง y0+3
    const j = await getJSON(`https://www.imf.org/external/datamapper/api/v1/${ind}/${codes.join('/')}`, { timeout: 40000 });
    const v = j?.values?.[ind] || {};
    out[ind] = Object.fromEntries(codes.filter((c) => v[c]).map((c) => [c,
      Object.fromEntries(Object.entries(v[c]).filter(([y]) => +y >= y0 - 6 && +y <= y0 + 3))]));
  }
  if (!out.NGDP_RPCH?.THA) throw new Error('ไม่พบข้อมูล GDP ของไทยจาก IMF');
  return { data: out, source: 'IMF World Economic Outlook (DataMapper)' };
}

// ---------- 12c) ส่งออก นำเข้า ดุลการค้า รายเดือน (IMF International Trade in Goods, ข้อมูลจากหน่วยงานของแต่ละประเทศ) ----------
export async function fetchTradeMonthly() {
  const y = new Date().getUTCFullYear(), codes = Object.keys(PEERS);
  const url = `https://api.imf.org/external/sdmx/2.1/data/IMF.STA,IMTS/${codes.join('+')}.XG_FOB_USD+MG_CIF_USD+TBG_USD.G001.M?startPeriod=${y - 3}-01`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} จาก api.imf.org`);
  const xml = await res.text();
  const KEY = { XG_FOB_USD: 'x', MG_CIF_USD: 'm', TBG_USD: 'b' }, out = {};
  for (const [, attrs, body] of xml.matchAll(/<Series ([^>]*)>([\s\S]*?)<\/Series>/g)) {
    const c = attrs.match(/COUNTRY="([A-Z]+)"/)?.[1], k = KEY[attrs.match(/INDICATOR="([A-Z_]+)"/)?.[1]];
    if (!c || !k) continue;
    const pts = [...body.matchAll(/TIME_PERIOD="(\d{4})-M(\d{2})"[^>]*?OBS_VALUE="([-\d.Ee+]+)"/g)]
      .map(([, yy, mm, v]) => ({ date: `${yy}-${mm}`, value: +v / 1e6 })).filter((p) => Number.isFinite(p.value));
    // ล้านดอลลาร์ เรียงตามเดือน
    (out[c] ??= {})[k] = pts.sort((a, b) => a.date.localeCompare(b.date));
  }
  if (!out.THA?.x?.length) throw new Error('ไม่พบข้อมูลการส่งออกของไทยจาก IMF');
  return { data: out, source: 'IMF International Trade in Goods (IMTS)' };
}

// ---------- 12d) ส่งออก/นำเข้าแยกหมวดสินค้า (UN Comtrade, รายเดือน, HS 2 หลัก) ----------
// API สาธารณะไม่ต้องใช้ key แต่จำกัด 1 เดือนต่อคำขอ และต้องเว้นระยะ (โดน 429 ถ้าถี่เกิน)
const COMTRADE = 'https://comtradeapi.un.org/public/v1';
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function comtradeJSON(url) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
    if (res.status === 429) { await sleepMs(5000 + i * 3000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} จาก comtradeapi.un.org`);
    return res.json();
  }
  throw new Error('UN Comtrade จำกัดความถี่ (429) ลองใหม่รอบหน้า');
}
export async function fetchGoodsPeriods() {
  const j = await comtradeJSON(`${COMTRADE}/getDA/C/M/HS?reporterCode=764`);
  const per = [...new Set((j.data || []).map((d) => String(d.period)))].sort();
  if (!per.length) throw new Error('ไม่พบช่วงเวลาที่มีข้อมูลของไทยใน UN Comtrade');
  return per.slice(-30);
}
export async function fetchGoodsMonth(period) {
  await sleepMs(4000); // เว้นระยะระหว่างคำขอ
  const j = await comtradeJSON(`${COMTRADE}/preview/C/M/HS?reporterCode=764&period=${period}&partnerCode=0&flowCode=X,M&cmdCode=AG2&includeDesc=true`);
  const rows = {};
  for (const r of j.data || []) {
    if (r.partnerCode !== 0 || r.motCode !== 0 || r.customsCode !== 'C00') continue;
    const c = String(r.cmdCode).padStart(2, '0'), k = r.flowCode === 'X' ? 'x' : r.flowCode === 'M' ? 'm' : null;
    if (!k || !Number.isFinite(r.primaryValue)) continue;
    (rows[c] ??= { c, desc: r.cmdDesc, x: 0, m: 0 })[k] += r.primaryValue / 1e6; // ล้านดอลลาร์
  }
  const list = Object.values(rows);
  if (!list.length) throw new Error(`ไม่มีข้อมูลเดือน ${period}`);
  return { period, rows: list };
}

// ---------- 13) ค่าไฟฟ้าผันแปร (Ft) จากหน้าเว็บ กกพ. (ปรับทุก 4 เดือน หน่วย สตางค์/หน่วย) ----------
const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export async function fetchFt() {
  let html;
  try { html = await getText('https://www.erc.or.th/th/automatic/1355'); }
  catch (e) {
    // เว็บ กกพ. เข้าจากเซิร์ฟเวอร์บางแห่งไม่ได้: ใช้ค่าที่บันทึกไว้ใน repo (Ft ปรับทุก 4 เดือน)
    const { readFileSync } = await import('node:fs');
    const seed = JSON.parse(readFileSync(new URL('./seed/ft.json', import.meta.url), 'utf8'));
    console.error('[ft] ใช้ค่าสำรองจาก seed/ft.json:', e.message, e.cause?.code || e.cause?.message || '');
    return { periods: seed.periods.slice(-12), source: `ค่าที่บันทึกไว้ (ตรวจล่าสุด ${seed.checked})`, fallback: true, checked: seed.checked };
  }
  const lines = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').split('\n').map((l) => l.replace(/\*+/g, '').trim()).filter(Boolean);
  const rows = [];
  const re = new RegExp(`^(${TH_MONTHS.join('|')})\\s*[-–]?\\s*(${TH_MONTHS.join('|')})?\\s*(25\\d\\d)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const ft = toNum(lines[i + 1]);
    if (ft == null) continue; // ช่วงที่แยกบ้านอยู่อาศัย/ประเภทอื่น ข้ามไป
    const startMonth = TH_MONTHS.indexOf(m[1]) + 1, endMonth = m[2] ? TH_MONTHS.indexOf(m[2]) + 1 : startMonth;
    rows.push({ label: lines[i], from: `${+m[3] - 543}-${String(startMonth).padStart(2, '0')}`, to: `${+m[3] - 543}-${String(endMonth).padStart(2, '0')}`, ft });
  }
  if (!rows.length) throw new Error('อ่านค่า Ft จากหน้าเว็บ กกพ. ไม่ได้ (หน้าเว็บอาจเปลี่ยนรูปแบบ)');
  rows.sort((a, b) => a.from.localeCompare(b.from));
  return { periods: rows.slice(-12), source: 'สำนักงาน กกพ. (erc.or.th)' };
}

// ---------- 14) อัตราผลตอบแทนพันธบัตรรัฐบาลไทย (ThaiBMA รายวัน แยกตามอายุ) ----------
export const BOND_TENORS = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y'];
export const TENOR_YEARS = { '1M': 1 / 12, '3M': 0.25, '6M': 0.5, '1Y': 1, '2Y': 2, '3Y': 3, '5Y': 5, '7Y': 7, '10Y': 10, '15Y': 15, '20Y': 20, '30Y': 30 };
export async function fetchThaiYields() {
  const y = new Date().getUTCFullYear();
  const rows = [];
  for (const year of [y - 1, y]) {
    const j = await getJSON(`https://www.thaibma.or.th/yieldcurve/getintpttm?year=${year}`, { headers: { Referer: 'https://www.thaibma.or.th/EN/Market/YieldCurve/Government.aspx' } });
    for (const r of Array.isArray(j) ? j : []) {
      const date = String(r.asof || '').slice(0, 10);
      if (!date) continue;
      const row = { date };
      for (const t of BOND_TENORS) row[t] = toNum(r[t]);
      if (row['10Y'] != null) rows.push(row);
    }
  }
  if (!rows.length) throw new Error('ไม่พบข้อมูลอัตราผลตอบแทนพันธบัตรจาก ThaiBMA');
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, source: 'ThaiBMA (สมาคมตลาดตราสารหนี้ไทย)' };
}
