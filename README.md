# nft-high-price

篩選個人錢包中「購入時美金價值 ≥ 門檻」的 NFT，支援 Tezos 與 Ethereum。輸出 CSV（完整 / 精簡 / 未過濾全量）。

## 功能

- **Tezos**：查 objkt.com GraphQL (`mint`、`open_edition_buy`、`listing_sale`、`offer_sale`、`dutch_auction_sale`) + TzKT fallback（補齊非 objkt 市場取得的 NFT）
- **Ethereum**：Alchemy `getAssetTransfers` 同 tx hash 配對 ETH/WETH/BETH/USDC/USDT/DAI 付款，處理 bundle 購買 (平均分配)
- **歷史幣價**：CryptoCompare histoday 一次批次抓，本地 JSON cache (`cache/`) 避免重查
- **事件類型標示**：`sale` / `mint` / `relay_mint`（fxhash / Verse.works 類的法幣 relay mint，鏈上無價格資料）
- **多錢包**：同鏈可一次傳多個地址

## 安裝

需要 Node.js 20+（使用 ESM + native fetch）。

```bash
git clone https://github.com/<your-username>/nft-high-price.git
cd nft-high-price
cp .env.example .env
# 編輯 .env 填入 ALCHEMY_API_KEY (ETH 用，可從 https://dashboard.alchemy.com 取得)
```

Tezos 不需要 API key。

## 使用

### Tezos

```bash
node tezos.mjs tz1XXXXX [tz2YYYYY ...] [--threshold=200]
```

### Ethereum

```bash
node eth.mjs 0xXXXXX [0xYYYYY ...] [--threshold=200]
```

`--threshold` 預設 200（美金）。輸出位於 `out/`：

- `<chain>_<tag>_<timestamp>.csv` — 過濾後完整欄位
- `<chain>_<tag>_<timestamp>_slim.csv` — 過濾後精簡欄位
- `<chain>_<tag>_<timestamp>_all.csv` — 全部 NFT（未過濾，含 `relay_mint` / 免費 mint）

## 輸出欄位

**完整版 (eth)**：`wallet, chain, collection, name, tokenId, contract, eventType, purchaseDate, priceEth, ethUsdRate, stableUsd, priceUsd, priceSource, txHash, imageUrl, openseaLink`

**完整版 (tezos)**：`wallet, chain, collection, name, tokenId, contract, eventType, purchaseDate, priceXtz, xtzUsdRate, priceUsd, ophash, imageUrl, objktLink`

## 已知限制

- **法幣 relay mint 無價**：Verse.works、fxhash Ethereum、CIRCA 等平台的法幣付款 mint 在鏈上沒有價格紀錄。此類 NFT 會標為 `relay_mint` 或 `mint` 且 `priceUsd=0`；需要使用者自行查平台帳單。
- **NFT 送進 / 取得來源無法分辨**：空投、禮物、自購 relay mint 同屬 `relay_mint`。
- **穩定幣直接當 USD** 簡化處理（USDC/USDT/DAI 均視為 1:1）。

## 授權

MIT
