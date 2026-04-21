// Tezos NFT 高價作品篩選
// 用法: node tezos.mjs <tz1錢包地址> [--threshold=200]
//
// 資料來源 (objkt.com GraphQL v3):
//   event          — mint / open_edition_buy (recipient_address = wallet)
//   listing_sale   — 一般掛單成交 (buyer_address = wallet)
//   offer_sale     — 出價被接受 (buyer_address = wallet)
//   dutch_auction_sale — 荷式拍賣 (buyer_address = wallet)
// 幣價來源: CoinGecko /coins/tezos/history (cache 於 cache/xtz_prices.json)
//
// 輸出: out/tezos_<短地址>_<timestamp>.csv (+ _all.csv 未過濾版)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');
const OUT_DIR = path.join(__dirname, 'out');
const PRICE_CACHE = path.join(CACHE_DIR, 'xtz_prices.json');

const OBJKT_GQL = 'https://data.objkt.com/v3/graphql';
const COINGECKO = 'https://api.coingecko.com/api/v3/coins/tezos/history';
const CRYPTOCOMPARE = 'https://min-api.cryptocompare.com/data/v2/histoday';
const TZKT_API = 'https://api.tzkt.io/v1';

// ─── CLI ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const addresses = args.filter(a => /^tz[1-3]/.test(a));
  const threshold = Number(
    (args.find(a => a.startsWith('--threshold=')) ?? '--threshold=200').split('=')[1]
  );
  if (addresses.length === 0) {
    console.error('用法: node tezos.mjs <tz...地址1> [tz...地址2 ...] [--threshold=200]');
    process.exit(1);
  }
  return { addresses, threshold };
}

// ─── GraphQL helper ───────────────────────────────────────────────────────
async function gql(query, variables) {
  const res = await fetch(OBJKT_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`objkt HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error('objkt: ' + JSON.stringify(json.errors));
  return json.data;
}

const TOKEN_FIELDS = `
  token_id
  name
  display_uri
  thumbnail_uri
  fa { name contract }
`;

async function fetchAllPages(tableName, whereClause) {
  const all = [];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const query = tableName === 'event'
      ? `query($limit: Int!, $offset: Int!) {
          event(where: ${whereClause}, order_by: {timestamp: desc}, limit: $limit, offset: $offset) {
            event_type timestamp price ophash fa_contract
            token { ${TOKEN_FIELDS} }
          }
        }`
      : `query($limit: Int!, $offset: Int!) {
          ${tableName}(where: ${whereClause}, order_by: {timestamp: desc}, limit: $limit, offset: $offset) {
            timestamp price ophash
            token { fa_contract ${TOKEN_FIELDS} }
          }
        }`;
    const data = await gql(query, { limit: pageSize, offset });
    const batch = data[tableName] ?? [];
    all.push(...batch);
    console.log(`[${tableName}] +${batch.length} (offset=${offset}, total=${all.length})`);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// ─── 各來源取資料 → 轉成統一格式 ──────────────────────────────────────────
function normalize(row, sourceType) {
  return {
    eventType: sourceType,
    timestamp: row.timestamp,
    priceMutez: Number(row.price ?? 0),
    ophash: row.ophash,
    faContract: row.fa_contract ?? row.token?.fa_contract ?? row.token?.fa?.contract ?? '',
    tokenId: row.token?.token_id ?? '',
    tokenName: row.token?.name ?? '',
    collection: row.token?.fa?.name ?? '',
    displayUri: row.token?.display_uri ?? row.token?.thumbnail_uri ?? '',
  };
}

async function collectAll(address) {
  // 1) event 表：mint + open_edition_buy
  const events = await fetchAllPages(
    'event',
    `{recipient_address: {_eq: "${address}"}, event_type: {_in: ["mint", "open_edition_buy"]}}`
  );
  // 2) listing_sale / offer_sale / dutch_auction_sale: buyer_address = 錢包
  const listingSales = await fetchAllPages(
    'listing_sale',
    `{buyer_address: {_eq: "${address}"}}`
  );
  const offerSales = await fetchAllPages(
    'offer_sale',
    `{buyer_address: {_eq: "${address}"}}`
  );
  const dutchSales = await fetchAllPages(
    'dutch_auction_sale',
    `{buyer_address: {_eq: "${address}"}}`
  );

  const rows = [
    ...events.map(e => normalize(e, e.event_type)),
    ...listingSales.map(e => normalize(e, 'listing_sale')),
    ...offerSales.map(e => normalize(e, 'offer_sale')),
    ...dutchSales.map(e => normalize(e, 'dutch_auction_sale')),
  ];
  return rows;
}

// ─── TzKT fallback: 非 objkt 市場的購入紀錄 ──────────────────────────────
async function tzktJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TzKT ${res.status}: ${url}`);
  return res.json();
}

async function getTzktHoldings(address) {
  const all = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const url = `${TZKT_API}/tokens/balances?account=${address}&balance.gt=0&limit=${pageSize}&offset=${offset}`
      + `&select=token.contract.address,token.contract.alias,token.tokenId,token.metadata`;
    const batch = await tzktJson(url);
    all.push(...batch);
    console.log(`[tzkt] holdings +${batch.length} (total=${all.length})`);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return all.map(r => ({
    contract: r['token.contract.address'],
    contractAlias: r['token.contract.alias'] || '',
    tokenId: r['token.tokenId'],
    metadata: r['token.metadata'] || {},
  }));
}

// 給定一個 token，找最早一次進入錢包的 transfer，再從 op group 回推 XTZ 支付
async function getTzktAcquisition(address, contract, tokenId) {
  const transferUrl = `${TZKT_API}/tokens/transfers?to=${address}`
    + `&token.contract=${contract}&token.tokenId=${tokenId}&sort=id&limit=1`;
  const transfers = await tzktJson(transferUrl);
  const transfer = transfers[0];
  if (!transfer) return null;

  const timestamp = transfer.timestamp;
  const isMint = !transfer.from?.address;
  const txId = transfer.transactionId;
  if (!txId) return { timestamp, priceMutez: 0, hash: null, isMint };

  // 先取這一筆 transfer 所在的 transaction 以拿到 hash（TzKT 路徑 {hash} 不吃 id，改用 query filter）
  const txArr = await tzktJson(`${TZKT_API}/operations/transactions?id=${txId}&limit=1&select=hash`);
  const hash = txArr[0]?.hash;
  if (!hash) return { timestamp, priceMutez: 0, hash: null, isMint };

  // 抓同一 op hash 內錢包的所有 outbound XTZ（含 internal）
  const opsUrl = `${TZKT_API}/operations/transactions?hash=${hash}&sender.eq=${address}&status=applied&limit=200`;
  const ops = await tzktJson(opsUrl);
  const priceMutez = ops.reduce((sum, op) => sum + (op.amount || 0), 0);

  return { timestamp, priceMutez, hash, isMint };
}

async function supplementWithTzkt(address, dedup) {
  const holdings = await getTzktHoldings(address);
  const missing = holdings.filter(h => !dedup.has(`${h.contract}-${h.tokenId}`));
  console.log(`[tzkt] 持有 ${holdings.length}，objkt 未涵蓋 ${missing.length}`);
  if (missing.length === 0) return 0;

  let added = 0;
  for (let i = 0; i < missing.length; i++) {
    const h = missing[i];
    try {
      const acq = await getTzktAcquisition(address, h.contract, h.tokenId);
      if (!acq) { console.log(`[tzkt] ${i + 1}/${missing.length} no transfer: ${h.contract}/${h.tokenId}`); continue; }

      const row = {
        eventType: acq.isMint ? 'tzkt_mint' : (acq.priceMutez > 0 ? 'tzkt_sale' : 'tzkt_transfer'),
        timestamp: acq.timestamp,
        priceMutez: acq.priceMutez,
        ophash: acq.hash ?? '',
        faContract: h.contract,
        tokenId: String(h.tokenId),
        tokenName: h.metadata?.name || `#${h.tokenId}`,
        collection: h.contractAlias || h.metadata?.symbol || '',
        displayUri: h.metadata?.displayUri || h.metadata?.thumbnailUri || h.metadata?.artifactUri || '',
      };
      dedup.set(`${row.faContract}-${row.tokenId}`, row);
      added++;
      console.log(`[tzkt] +${row.eventType} ${row.tokenName} (${(row.priceMutez / 1e6).toFixed(2)} XTZ)`);
    } catch (e) {
      console.warn(`[tzkt] err ${h.contract}/${h.tokenId}: ${e.message}`);
    }
    await sleep(120); // 避免打爆 TzKT
  }
  return added;
}

// ─── CoinGecko 歷史幣價 ───────────────────────────────────────────────────
async function loadPriceCache() {
  try { return JSON.parse(await fs.readFile(PRICE_CACHE, 'utf8')); }
  catch { return {}; }
}
async function savePriceCache(c) {
  await fs.writeFile(PRICE_CACHE, JSON.stringify(c, null, 2));
}
function toCgDate(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}-${m}-${y}`;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 單日 fallback（CoinGecko），僅在 bulk 仍缺值時使用
async function getXtzUsdSingle(ymd, cache) {
  if (cache[ymd] !== undefined) return cache[ymd];
  await sleep(6000);
  const url = `${COINGECKO}?date=${toCgDate(ymd)}&localization=false`;
  const res = await fetch(url);
  if (res.status === 429) {
    console.warn('[cg] 429, wait 65s...');
    await sleep(65_000);
    return getXtzUsdSingle(ymd, cache);
  }
  if (!res.ok) {
    console.warn(`[cg] ${ymd} failed ${res.status}`);
    cache[ymd] = null;
    await savePriceCache(cache);
    return null;
  }
  const j = await res.json();
  const price = j?.market_data?.current_price?.usd ?? null;
  cache[ymd] = price;
  await savePriceCache(cache);
  console.log(`[cg] ${ymd} → $${price}`);
  return price;
}

// Bulk: CryptoCompare histoday 一次抓 2000 天日收盤價，填滿整個日期範圍
async function bulkFetchXtzRange(fromYmd, toYmd, cache) {
  const fromTs = Math.floor(new Date(fromYmd + 'T00:00:00Z').getTime() / 1000);
  let toTs = Math.floor(new Date(toYmd + 'T00:00:00Z').getTime() / 1000);
  const SECONDS_PER_DAY = 86400;

  while (toTs >= fromTs) {
    const needed = Math.floor((toTs - fromTs) / SECONDS_PER_DAY);
    const limit = Math.min(needed, 2000);
    const url = `${CRYPTOCOMPARE}?fsym=XTZ&tsym=USD&limit=${limit}&toTs=${toTs}`;
    console.log(`[cc] fetch ${limit + 1} days ending ${new Date(toTs * 1000).toISOString().slice(0, 10)}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CryptoCompare HTTP ${res.status}`);
    const j = await res.json();
    const data = j?.Data?.Data ?? [];
    for (const d of data) {
      const ymd = new Date(d.time * 1000).toISOString().slice(0, 10);
      if (d.close > 0) cache[ymd] = d.close;
    }
    await savePriceCache(cache);
    if (data.length === 0 || limit < 2000) break;
    // 往前再抓一輪：下一批 toTs = 目前最早資料 - 1 day
    const earliestTs = data[0].time - SECONDS_PER_DAY;
    if (earliestTs <= fromTs) break;
    toTs = earliestTs;
    await sleep(500);
  }

  // 範圍內仍無資料的日期標成 null（CC 很早期可能沒資料），避免每次重查
  for (let t = fromTs; t <= Math.floor(new Date(toYmd + 'T00:00:00Z').getTime() / 1000); t += SECONDS_PER_DAY) {
    const ymd = new Date(t * 1000).toISOString().slice(0, 10);
    if (cache[ymd] === undefined) cache[ymd] = null;
  }
  await savePriceCache(cache);
}

// ─── 輸出 ────────────────────────────────────────────────────────────────
function ipfsToHttp(uri) {
  if (!uri) return '';
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return uri;
}
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ─── main ────────────────────────────────────────────────────────────────
async function processWallet(address, priceCache) {
  console.log(`\n========== ${address} ==========`);
  const raw = await collectAll(address);
  console.log(`[info] 原始事件數: ${raw.length}`);

  // 去重：同一 NFT 保留「最近一次取得事件」
  const dedup = new Map();
  for (const r of raw) {
    const key = `${r.faContract}-${r.tokenId}`;
    if (!dedup.has(key) || new Date(r.timestamp) > new Date(dedup.get(key).timestamp)) {
      dedup.set(key, r);
    }
  }
  console.log(`[info] objkt 去重後獨立 NFT: ${dedup.size}`);

  // TzKT 補齊：錢包持有但 objkt 無紀錄的 NFT（非 objkt 市場購入）
  const added = await supplementWithTzkt(address, dedup);
  console.log(`[info] TzKT 補齊 ${added} 筆，合計 ${dedup.size} 個 NFT`);

  // 收集日期 → bulk 補幣價 cache
  const neededDates = [...new Set([...dedup.values()].map(r => r.timestamp?.slice(0, 10)).filter(Boolean))];
  const missing = neededDates.filter(d => priceCache[d] === undefined);
  if (missing.length > 0) {
    missing.sort();
    console.log(`[price] 缺 ${missing.length} 個日期 (${missing[0]} ~ ${missing[missing.length - 1]})，bulk 抓取中`);
    await bulkFetchXtzRange(missing[0], missing[missing.length - 1], priceCache);
  }

  const rows = [];
  for (const r of dedup.values()) {
    const date = r.timestamp?.slice(0, 10);
    const priceXtz = r.priceMutez / 1_000_000;
    let xtzUsd = date ? priceCache[date] : null;
    if (date && xtzUsd == null && priceCache[date] === null && priceXtz > 0) {
      xtzUsd = await getXtzUsdSingle(date, priceCache);
    }
    const priceUsd = xtzUsd != null ? priceXtz * xtzUsd : null;
    rows.push({
      wallet: address,
      chain: 'tezos',
      collection: r.collection,
      name: r.tokenName || `#${r.tokenId}`,
      tokenId: r.tokenId,
      contract: r.faContract,
      eventType: r.eventType,
      purchaseDate: date ?? '',
      priceXtz: priceXtz.toFixed(6),
      xtzUsdRate: xtzUsd != null ? xtzUsd.toFixed(4) : '',
      priceUsd: priceUsd != null ? priceUsd.toFixed(2) : '',
      ophash: r.ophash ?? '',
      imageUrl: ipfsToHttp(r.displayUri),
      objktLink: r.faContract && r.tokenId
        ? `https://objkt.com/asset/${r.faContract}/${r.tokenId}` : '',
    });
  }
  return rows;
}

const FULL_HEADER = [
  'wallet', 'chain', 'collection', 'name', 'tokenId', 'contract',
  'eventType', 'purchaseDate', 'priceXtz', 'xtzUsdRate', 'priceUsd',
  'ophash', 'imageUrl', 'objktLink',
];
const SLIM_HEADER = [
  'chain', 'collection', 'name', 'eventType',
  'purchaseDate', 'priceXtz', 'xtzUsdRate', 'priceUsd', 'objktLink',
];

function toCsv(header, items) {
  return '\uFEFF' + [
    header.join(','),
    ...items.map(r => header.map(h => csvEscape(r[h])).join(',')),
  ].join('\n');
}

async function main() {
  const { addresses, threshold } = parseArgs();
  console.log(`[start] wallets=${addresses.length} threshold=$${threshold}`);

  const priceCache = await loadPriceCache();
  const allRows = [];
  for (const addr of addresses) {
    const rows = await processWallet(addr, priceCache);
    allRows.push(...rows);
  }

  const filtered = allRows
    .filter(r => r.priceUsd !== '' && Number(r.priceUsd) >= threshold)
    .sort((a, b) => Number(b.priceUsd) - Number(a.priceUsd));
  const sortedAll = allRows.slice().sort((a, b) => Number(b.priceUsd || 0) - Number(a.priceUsd || 0));

  console.log(`\n[info] 全部錢包合計 ≥ $${threshold}: ${filtered.length} 筆 (總 NFT ${allRows.length})`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = addresses.length === 1 ? addresses[0].slice(0, 8) : `multi${addresses.length}`;
  const base = path.join(OUT_DIR, `tezos_${tag}_${ts}`);

  await fs.writeFile(`${base}.csv`,        toCsv(FULL_HEADER, filtered),  'utf8');
  await fs.writeFile(`${base}_slim.csv`,   toCsv(SLIM_HEADER, filtered),  'utf8');
  await fs.writeFile(`${base}_all.csv`,    toCsv(FULL_HEADER, sortedAll), 'utf8');

  console.log(`\n✅ 篩選 (≥$${threshold}) 完整: ${base}.csv`);
  console.log(`✂️  篩選 (≥$${threshold}) 精簡: ${base}_slim.csv`);
  console.log(`📄 全部 NFT 完整清單:     ${base}_all.csv`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
