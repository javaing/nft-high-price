// Ethereum NFT 高價作品篩選
// 用法: node eth.mjs <0x地址1> [0x地址2 ...] [--threshold=200]
//
// 資料流程:
//   1. Alchemy getAssetTransfers (toAddress=wallet, category=erc721/erc1155) → 所有入帳 NFT
//   2. 去重: (contract, tokenId) 保留最新一次
//   3. Alchemy getAssetTransfers (fromAddress=wallet, category=external/erc20) → 出帳 ETH/WETH/穩定幣
//   4. 同 tx hash 配對 → 計算購入成本 (ETH-equivalent + stable)
//      若同一 tx 收到多個 NFT (bundle), 成本平均分配
//   5. Alchemy getNFTMetadataBatch → 補齊 name/collection/image
//   6. CryptoCompare histoday → ETH/USD 歷史日收盤 (cache)
//   7. priceUsd = priceEth × ETH/USD_當日 + stableUsd
//   輸出: out/eth_<tag>_<ts>.csv / _slim.csv / _all.csv

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');
const OUT_DIR = path.join(__dirname, 'out');
const PRICE_CACHE = path.join(CACHE_DIR, 'eth_prices.json');

const CRYPTOCOMPARE = 'https://min-api.cryptocompare.com/data/v2/histoday';

// ─── Alchemy key ──────────────────────────────────────────────────────────
// 優先順序:
//   1) 環境變數 ALCHEMY_API_KEY
//   2) 專案根目錄 .env 的 ALCHEMY_API_KEY=xxx
async function loadAlchemyKey() {
  if (process.env.ALCHEMY_API_KEY) return process.env.ALCHEMY_API_KEY.trim();
  try {
    const raw = await fs.readFile(path.join(__dirname, '.env'), 'utf8');
    const m = raw.match(/^ALCHEMY_API_KEY=(\S+)/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error('找不到 ALCHEMY_API_KEY（請設環境變數或建立 .env，參考 .env.example）');
}

// ─── CLI ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const addresses = args.filter(a => /^0x[0-9a-fA-F]{40}$/.test(a)).map(a => a.toLowerCase());
  const threshold = Number(
    (args.find(a => a.startsWith('--threshold=')) ?? '--threshold=200').split('=')[1]
  );
  if (addresses.length === 0) {
    console.error('用法: node eth.mjs <0x...地址1> [0x...地址2 ...] [--threshold=200]');
    process.exit(1);
  }
  return { addresses, threshold };
}

// ─── Alchemy helpers ──────────────────────────────────────────────────────
let ALCHEMY_RPC = null;
let ALCHEMY_NFT = null;

async function rpc(method, params) {
  const res = await fetch(ALCHEMY_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`Alchemy ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function getAllTransfers(address, direction, categories) {
  const all = [];
  let pageKey;
  while (true) {
    const params = {
      fromBlock: '0x0',
      toBlock: 'latest',
      [direction === 'to' ? 'toAddress' : 'fromAddress']: address,
      category: categories,
      withMetadata: true,
      maxCount: '0x3e8', // 1000
      order: 'desc',
      excludeZeroValue: false,
    };
    if (pageKey) params.pageKey = pageKey;
    const res = await rpc('alchemy_getAssetTransfers', [params]);
    const batch = res.transfers ?? [];
    all.push(...batch);
    pageKey = res.pageKey;
    console.log(`  [${direction}/${categories.join(',')}] +${batch.length} (total=${all.length})`);
    if (!pageKey) break;
  }
  return all;
}

// 十六進制 tokenId → 十進制 string
function hexToDecimal(hex) {
  if (!hex) return '';
  try { return BigInt(hex).toString(); } catch { return ''; }
}

// ─── 付款資產分類 ────────────────────────────────────────────────────────
// ETH-equivalent: 以當日 ETH/USD 換算
// Stable: 直接當 USD (approx)
const ETH_EQUIV = new Set(['ETH', 'WETH', 'BETH']);
const STABLE = new Set(['USDC', 'USDT', 'DAI']);

function classifyPayment(t) {
  const asset = t.asset ?? '';
  const v = Number(t.value ?? 0);
  if (!v || !Number.isFinite(v)) return null;
  if (ETH_EQUIV.has(asset)) return { kind: 'eth', value: v };
  if (STABLE.has(asset)) return { kind: 'usd', value: v };
  return null; // 其他 ERC20 忽略 (swap 出去的 memecoin 等)
}

// ─── NFT metadata batch (Alchemy NFT v3) ──────────────────────────────────
async function getMetadataBatch(tokens) {
  // Alchemy 限制 100 / request
  const out = [];
  const batchSize = 100;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const slice = tokens.slice(i, i + batchSize);
    const res = await fetch(`${ALCHEMY_NFT}/getNFTMetadataBatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        tokens: slice.map(t => ({ contractAddress: t.contract, tokenId: t.tokenId })),
        refreshCache: false,
      }),
    });
    if (!res.ok) {
      console.warn(`  [meta] batch ${i} failed ${res.status}`);
      continue;
    }
    const j = await res.json();
    out.push(...(j.nfts ?? []));
    console.log(`  [meta] batch ${i / batchSize + 1}/${Math.ceil(tokens.length / batchSize)} ok (${j.nfts?.length ?? 0})`);
  }
  return out;
}

// ─── 幣價 cache (CryptoCompare ETH/USD) ───────────────────────────────────
async function loadPriceCache() {
  try { return JSON.parse(await fs.readFile(PRICE_CACHE, 'utf8')); } catch { return {}; }
}
async function savePriceCache(c) {
  await fs.writeFile(PRICE_CACHE, JSON.stringify(c, null, 2));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function bulkFetchEthRange(fromYmd, toYmd, cache) {
  const fromTs = Math.floor(new Date(fromYmd + 'T00:00:00Z').getTime() / 1000);
  let toTs = Math.floor(new Date(toYmd + 'T00:00:00Z').getTime() / 1000);
  const DAY = 86400;
  while (toTs >= fromTs) {
    const needed = Math.floor((toTs - fromTs) / DAY);
    const limit = Math.min(needed, 2000);
    const url = `${CRYPTOCOMPARE}?fsym=ETH&tsym=USD&limit=${limit}&toTs=${toTs}`;
    console.log(`[cc] fetch ${limit + 1} days ending ${new Date(toTs * 1000).toISOString().slice(0, 10)}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CryptoCompare ${res.status}`);
    const j = await res.json();
    const data = j?.Data?.Data ?? [];
    for (const d of data) {
      const ymd = new Date(d.time * 1000).toISOString().slice(0, 10);
      if (d.close > 0) cache[ymd] = d.close;
    }
    await savePriceCache(cache);
    if (data.length === 0 || limit < 2000) break;
    const earliestTs = data[0].time - DAY;
    if (earliestTs <= fromTs) break;
    toTs = earliestTs;
    await sleep(500);
  }
  // 無資料的日期標 null 避免重查
  for (let t = fromTs; t <= Math.floor(new Date(toYmd + 'T00:00:00Z').getTime() / 1000); t += DAY) {
    const ymd = new Date(t * 1000).toISOString().slice(0, 10);
    if (cache[ymd] === undefined) cache[ymd] = null;
  }
  await savePriceCache(cache);
}

// ─── CSV helpers ─────────────────────────────────────────────────────────
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header, items) {
  return '\uFEFF' + [
    header.join(','),
    ...items.map(r => header.map(h => csvEscape(r[h])).join(',')),
  ].join('\n');
}

// ─── processWallet ───────────────────────────────────────────────────────
async function processWallet(address, priceCache) {
  console.log(`\n========== ${address} ==========`);
  console.log('[1/4] 抓取 NFT 入帳 transfers');
  const nftIn = await getAllTransfers(address, 'to', ['erc721', 'erc1155']);
  console.log(`[1/4] 共 ${nftIn.length} 筆 NFT 入帳事件`);

  console.log('[2/4] 抓取出帳 ETH + ERC20 transfers');
  const paymentsOut = await getAllTransfers(address, 'from', ['external', 'erc20']);
  console.log(`[2/4] 共 ${paymentsOut.length} 筆出帳事件`);

  // 以 txHash 聚合出帳金額
  const txPayments = new Map(); // hash → { eth, usd }
  for (const p of paymentsOut) {
    const c = classifyPayment(p);
    if (!c) continue;
    const cur = txPayments.get(p.hash) ?? { eth: 0, usd: 0 };
    cur[c.kind] += c.value;
    txPayments.set(p.hash, cur);
  }

  // 展開 ERC1155 (單筆可能帶多個 tokenId)
  const inboundRows = [];
  for (const t of nftIn) {
    const contract = t.rawContract?.address?.toLowerCase() ?? '';
    const ts = t.metadata?.blockTimestamp ?? '';
    if (t.category === 'erc1155' && Array.isArray(t.erc1155Metadata) && t.erc1155Metadata.length) {
      for (const m of t.erc1155Metadata) {
        inboundRows.push({
          contract,
          tokenId: hexToDecimal(m.tokenId),
          hash: t.hash,
          from: t.from,
          timestamp: ts,
          category: 'erc1155',
        });
      }
    } else {
      inboundRows.push({
        contract,
        tokenId: hexToDecimal(t.erc721TokenId ?? t.tokenId),
        hash: t.hash,
        from: t.from,
        timestamp: ts,
        category: t.category,
      });
    }
  }

  // 計算每個 tx 收到幾筆 NFT (用於平均分配 bundle 成本)
  const nftCountPerTx = new Map();
  for (const r of inboundRows) {
    nftCountPerTx.set(r.hash, (nftCountPerTx.get(r.hash) ?? 0) + 1);
  }

  // 去重: 同 (contract, tokenId) 取最新
  const dedup = new Map();
  for (const r of inboundRows) {
    const key = `${r.contract}-${r.tokenId}`;
    if (!dedup.has(key) || new Date(r.timestamp) > new Date(dedup.get(key).timestamp)) {
      dedup.set(key, r);
    }
  }
  console.log(`[info] 去重後 ${dedup.size} 個獨立 NFT`);

  // 補幣價 cache
  const neededDates = [...new Set([...dedup.values()].map(r => r.timestamp?.slice(0, 10)).filter(Boolean))];
  const missing = neededDates.filter(d => priceCache[d] === undefined);
  if (missing.length > 0) {
    missing.sort();
    console.log(`[3/4] 缺 ${missing.length} 個日期 (${missing[0]} ~ ${missing[missing.length - 1]})，bulk 抓取中`);
    await bulkFetchEthRange(missing[0], missing[missing.length - 1], priceCache);
  }

  // 拿 metadata
  console.log('[4/4] 抓 NFT metadata');
  const metaList = await getMetadataBatch(
    [...dedup.values()].map(r => ({ contract: r.contract, tokenId: r.tokenId }))
  );
  const metaMap = new Map(metaList.map(m => [
    `${m.contract?.address?.toLowerCase()}-${m.tokenId}`,
    m,
  ]));

  // 組 row
  const rows = [];
  for (const r of dedup.values()) {
    const pay = txPayments.get(r.hash) ?? { eth: 0, usd: 0 };
    const count = Math.max(1, nftCountPerTx.get(r.hash) ?? 1);
    const priceEth = pay.eth / count;
    const stableUsd = pay.usd / count;
    const date = r.timestamp?.slice(0, 10) ?? '';
    const ethUsd = date ? priceCache[date] : null;
    const priceUsd = (ethUsd != null ? priceEth * ethUsd : 0) + stableUsd;

    const meta = metaMap.get(`${r.contract}-${r.tokenId}`);
    const name = meta?.name || meta?.raw?.metadata?.name || `#${r.tokenId}`;
    const collection = meta?.collection?.name || meta?.contract?.name || meta?.contract?.openSeaMetadata?.collectionName || '';
    const image = meta?.image?.cachedUrl || meta?.image?.originalUrl || meta?.image?.thumbnailUrl || '';

    // eventType 分類:
    //   sale        — 同 tx 有 ETH/stable 付款
    //   mint        — from = 0x0 (真實 on-chain mint, 可能免費)
    //   relay_mint  — from ≠ 0x0 且無付款 (fxhash/Verse 等平台法幣 mint / 空投 / 禮物)
    const isMint = r.from === '0x0000000000000000000000000000000000000000';
    let eventType;
    if (priceUsd > 0) eventType = 'sale';
    else if (isMint) eventType = 'mint';
    else eventType = 'relay_mint';
    const priceSource = priceUsd > 0 ? 'onchain' : '';

    rows.push({
      wallet: address,
      chain: 'ethereum',
      collection,
      name,
      tokenId: r.tokenId,
      contract: r.contract,
      eventType,
      purchaseDate: date,
      priceEth: priceEth.toFixed(6),
      ethUsdRate: ethUsd != null ? ethUsd.toFixed(2) : '',
      stableUsd: stableUsd.toFixed(2),
      priceUsd: priceUsd > 0 ? priceUsd.toFixed(2) : '0.00',
      priceSource,
      txHash: r.hash,
      imageUrl: image,
      openseaLink: r.contract && r.tokenId ? `https://opensea.io/assets/ethereum/${r.contract}/${r.tokenId}` : '',
    });
  }
  return rows;
}

// ─── main ────────────────────────────────────────────────────────────────
const FULL_HEADER = [
  'wallet', 'chain', 'collection', 'name', 'tokenId', 'contract',
  'eventType', 'purchaseDate', 'priceEth', 'ethUsdRate', 'stableUsd', 'priceUsd', 'priceSource',
  'txHash', 'imageUrl', 'openseaLink',
];
const SLIM_HEADER = [
  'chain', 'collection', 'name', 'eventType',
  'purchaseDate', 'priceEth', 'ethUsdRate', 'priceUsd', 'priceSource', 'openseaLink',
];

async function main() {
  const key = await loadAlchemyKey();
  ALCHEMY_RPC = `https://eth-mainnet.g.alchemy.com/v2/${key}`;
  ALCHEMY_NFT = `https://eth-mainnet.g.alchemy.com/nft/v3/${key}`;

  const { addresses, threshold } = parseArgs();
  console.log(`[start] wallets=${addresses.length} threshold=$${threshold}`);

  const priceCache = await loadPriceCache();
  const allRows = [];
  for (const addr of addresses) {
    const rows = await processWallet(addr, priceCache);
    allRows.push(...rows);
  }

  const filtered = allRows
    .filter(r => Number(r.priceUsd) >= threshold)
    .sort((a, b) => Number(b.priceUsd) - Number(a.priceUsd));
  const sortedAll = allRows.slice().sort((a, b) => Number(b.priceUsd || 0) - Number(a.priceUsd || 0));

  console.log(`\n[info] 合計 ≥ $${threshold}: ${filtered.length} 筆 (總 NFT ${allRows.length})`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = addresses.length === 1 ? addresses[0].slice(0, 10) : `multi${addresses.length}`;
  const base = path.join(OUT_DIR, `eth_${tag}_${ts}`);

  await fs.writeFile(`${base}.csv`,      toCsv(FULL_HEADER, filtered),  'utf8');
  await fs.writeFile(`${base}_slim.csv`, toCsv(SLIM_HEADER, filtered),  'utf8');
  await fs.writeFile(`${base}_all.csv`,  toCsv(FULL_HEADER, sortedAll), 'utf8');

  console.log(`\n✅ 篩選 (≥$${threshold}) 完整: ${base}.csv`);
  console.log(`✂️  篩選 (≥$${threshold}) 精簡: ${base}_slim.csv`);
  console.log(`📄 全部 NFT 完整清單:     ${base}_all.csv`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
