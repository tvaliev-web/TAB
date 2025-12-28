// bot.js (CommonJS)
// Multi-pair arb alerts: Odos quote vs Sushi V2 spot price (Polygon)
// Pairs: LINK/USDC, WMATIC/USDC, AAVE/USDC
// Anti-spam: per-pair cooldown + profit step + global minimum seconds between any sends
// Uses state.json committed back to repo.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TG_TOKEN || process.env.tg_token;
const CHAT_ID = process.env.CHAT_ID || process.env.TG_CHAT_ID || process.env.tg_chat_id;
const RPC_URL = process.env.RPC_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID) throw new Error("CHAT_ID missing");
if (!RPC_URL) throw new Error("RPC_URL missing");

const CHAIN_ID = Number(process.env.CHAIN_ID || 137); // Polygon

// SushiSwap V2 Factory (commonly used across chains)
const SUSHI_FACTORY = (process.env.SUSHI_FACTORY || "0xc35DADB65012eC5796536bD9864eD8773aBc74C4").toLowerCase();

const USDC = (process.env.USDC || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174").toLowerCase();
const LINK = (process.env.LINK || "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39").toLowerCase();
const WMATIC = (process.env.WMATIC || "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270").toLowerCase();
const AAVE = (process.env.AAVE || "0xD6DF932A45C0f255f85145f286ea0b292b21c90B").toLowerCase();

const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);       // send if >= 1%
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);    // re-send only if profit grew by +0.25%
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 10 * 60);       // per-pair cooldown
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);     // if profit jumps by +1% send even during cooldown
const MIN_SECONDS_BETWEEN_ANY = Number(process.env.MIN_SECONDS_BETWEEN_ANY || 60); // global anti-spam

const STATE_PATH = path.join(__dirname, "state.json");

const factoryAbi = ["function getPair(address tokenA, address tokenB) external view returns (address pair)"];
const pairAbi = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const erc20Abi = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

const PAIRS = [
  { key: "LINK/USDC", base: LINK, quote: USDC },
  { key: "WMATIC/USDC", base: WMATIC, quote: USDC },
  { key: "AAVE/USDC", base: AAVE, quote: USDC },
];

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { pairs: {}, meta: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function tgSend(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(
    url,
    { chat_id: CHAT_ID, text, disable_web_page_preview: true },
    { timeout: 15000 }
  );
}

function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

function sushiSwapLink(tokenIn, tokenOut) {
  return `https://www.sushi.com/swap?chainId=${CHAIN_ID}&token0=${tokenIn}&token1=${tokenOut}`;
}

function odosLink(tokenIn, tokenOut) {
  return `https://app.odos.xyz/?chain=${CHAIN_ID}&tokenIn=${tokenIn}&tokenOut=${tokenOut}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function stateKeyFor(pairAddress, label) {
  return `polygon:${pairAddress.toLowerCase()}:${label}`;
}

function shouldSendPair(statePair, profitPct) {
  const now = nowSec();
  const lastSentAt = statePair?.lastSentAt || 0;
  const lastSentProfit = statePair?.lastSentProfit ?? -999;

  if (profitPct < MIN_PROFIT_PCT) return { ok: false, reason: "below_min" };

  const since = now - lastSentAt;
  const growth = profitPct - lastSentProfit;

  if (growth >= BIG_JUMP_BYPASS) return { ok: true, reason: "big_jump" };
  if (since < COOLDOWN_SEC) return { ok: false, reason: "cooldown" };
  if (growth < PROFIT_STEP_PCT) return { ok: false, reason: "no_growth" };

  return { ok: true, reason: "growth" };
}

function canSendGlobal(state) {
  const now = nowSec();
  const lastAny = state?.meta?.lastAnySentAt || 0;
  if (now - lastAny < MIN_SECONDS_BETWEEN_ANY) return false;
  return true;
}

async function getDecimals(provider, token) {
  const c = new ethers.Contract(token, erc20Abi, provider);
  const d = await c.decimals();
  return Number(d);
}

async function getSymbol(provider, token) {
  try {
    const c = new ethers.Contract(token, erc20Abi, provider);
    return await c.symbol();
  } catch {
    return token.slice(0, 6);
  }
}

async function getSushiSpotPriceBaseInQuote(provider, tokenBase, tokenQuote) {
  const factory = new ethers.Contract(SUSHI_FACTORY, factoryAbi, provider);
  const pairAddr = (await factory.getPair(tokenBase, tokenQuote)).toLowerCase();
  if (pairAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No Sushi V2 pair for ${tokenBase}/${tokenQuote}`);
  }

  const pair = new ethers.Contract(pairAddr, pairAbi, provider);
  const [r0, r1] = await pair.getReserves();
  const t0 = (await pair.token0()).toLowerCase();
  const t1 = (await pair.token1()).toLowerCase();

  const d0 = await getDecimals(provider, t0);
  const d1 = await getDecimals(provider, t1);

  const reserve0 = parseFloat(ethers.formatUnits(r0, d0));
  const reserve1 = parseFloat(ethers.formatUnits(r1, d1));

  // We want: price of 1 BASE in QUOTE
  // If token0 = BASE and token1 = QUOTE => price = reserve1/reserve0
  if (t0 === tokenBase.toLowerCase() && t1 === tokenQuote.toLowerCase()) {
    return { price: reserve1 / reserve0, pairAddr };
  }
  // If token0 = QUOTE and token1 = BASE => price = reserve0/reserve1
  if (t0 === tokenQuote.toLowerCase() && t1 === tokenBase.toLowerCase()) {
    return { price: reserve0 / reserve1, pairAddr };
  }

  throw new Error(`Pair tokens mismatch: token0=${t0}, token1=${t1}`);
}

async function getOdosQuotePriceBaseInQuote(provider, tokenBase, tokenQuote) {
  const baseDecimals = await getDecimals(provider, tokenBase);
  const amountIn = ethers.parseUnits("1", baseDecimals).toString(); // 1 base token

  const url = "https://api.odos.xyz/sor/quote/v2";
  const body = {
    chainId: CHAIN_ID,
    inputTokens: [{ tokenAddress: tokenBase, amount: amountIn }],
    outputTokens: [{ tokenAddress: tokenQuote, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000001",
    slippageLimitPercent: 0.3,
    referralCode: 0,
    disableRFQs: true,
    compact: true,
  };

  const res = await axios.post(url, body, { timeout: 20000 });
  const out = res.data?.outAmounts?.[0];
  if (!out) throw new Error("Odos quote missing outAmounts");

  const quoteDecimals = await getDecimals(provider, tokenQuote);
  const quoteOut = parseFloat(ethers.formatUnits(out, quoteDecimals));
  return quoteOut; // quote per 1 base
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || {};

  // optional: send started only on manual run
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  if (eventName === "workflow_dispatch") {
    await tgSend("✅ BOT STARTED");
  }

  for (const p of PAIRS) {
    let sushiPrice, odosPrice, pairAddr;

    try {
      const sushi = await getSushiSpotPriceBaseInQuote(provider, p.base, p.quote);
      sushiPrice = sushi.price;
      pairAddr = sushi.pairAddr;
      odosPrice = await getOdosQuotePriceBaseInQuote(provider, p.base, p.quote);
    } catch (e) {
      console.error(`[${p.key}] FETCH ERROR:`, e?.message || e);
      continue; // no telegram spam on errors
    }

    const profitPct = ((odosPrice - sushiPrice) / sushiPrice) * 100;

    const key = stateKeyFor(pairAddr, p.key);
    state.pairs[key] = state.pairs[key] || {};

    const decision = shouldSendPair(state.pairs[key], profitPct);
    if (!decision.ok) {
      console.log(`[${p.key}] No send: ${decision.reason}. profit=${profitPct}`);
      continue;
    }

    if (!canSendGlobal(state)) {
      console.log(`[${p.key}] Blocked by global anti-spam. profit=${profitPct}`);
      continue;
    }

    const baseSym = await getSymbol(provider, p.base);
    const quoteSym = await getSymbol(provider, p.quote);

    const msg =
`🔥 ARBITRAGE SIGNAL (${baseSym}/${quoteSym}) [Polygon]

Sushi: ${fmt(sushiPrice, 6)} ${quoteSym} per 1 ${baseSym}
Odos:  ${fmt(odosPrice, 6)} ${quoteSym} per 1 ${baseSym}
Profit: +${fmt(profitPct, 2)}%

Sushi: ${sushiSwapLink(p.quote, p.base)}
Odos:  ${odosLink(p.base, p.quote)}
`;

    try {
      await tgSend(msg);

      const now = nowSec();
      state.meta.lastAnySentAt = now;

      state.pairs[key].lastSentAt = now;
      state.pairs[key].lastSentProfit = profitPct;
      state.pairs[key].lastSushi = sushiPrice;
      state.pairs[key].lastOdos = odosPrice;

      writeState(state);
      console.log(`[${p.key}] Sent. Reason=${decision.reason}`);
    } catch (e) {
      console.error(`[${p.key}] TELEGRAM ERROR:`, e?.response?.data || e?.message || e);
      // don't fail workflow
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
