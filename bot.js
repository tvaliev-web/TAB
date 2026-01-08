// bot.js (CommonJS)
// Polygon/Base/Arbitrum arb notifier (multi-chain, multi-venue):
// BUY  = best venue quote (STABLE -> COIN)
// SELL = best venue quote (COIN -> STABLE)

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TG_TOKEN || process.env.tg_token;
const CHAT_ID_RAW = process.env.CHAT_ID || process.env.TG_CHAT_ID || process.env.tg_chat_id;

// Back-compat: RPC_URL is Polygon (or single-chain) URL
const RPC_URL = process.env.RPC_URL;

// Optional extra chains
const RPC_URL_BASE = process.env.RPC_URL_BASE || process.env.RPC_BASE;
const RPC_URL_ARBITRUM = process.env.RPC_URL_ARBITRUM || process.env.RPC_ARB || process.env.RPC_ARBITRUM;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID_RAW) throw new Error("CHAT_ID missing");
if (!RPC_URL) throw new Error("RPC_URL missing (Polygon)");

const CHAT_IDS = String(CHAT_ID_RAW)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((s) => /^-?\d+$/.test(s));

if (!CHAT_IDS.length) throw new Error("CHAT_ID parsed empty (must be numeric chat id)");

// ---------- CONFIG ----------
// фиксированные объёмы: 100, 1000, 5000
const SIZES = String(process.env.SIZES || "100,1000,5000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

// режим работы (обычный / агрессивный)
const MODE = String(process.env.MODE || "normal"); // "normal" | "aggressive"

// минимальный профит для сигнала (по умолчанию 0.4%)
let MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.4);
let PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
let COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
let BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);

if (MODE === "aggressive") {
  // агрессивные дефолты (можешь перебить ENV’ом)
  MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.4);
  PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.1);
  COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 60);
  BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 0.3);
}

// “Execution window”
const QUOTE_TTL_SEC = Number(process.env.QUOTE_TTL_SEC || 120);

// Slippage haircuts
const SLIPPAGE_BUY_PCT = Number(process.env.SLIPPAGE_BUY_PCT || 0.15);
const SLIPPAGE_SELL_PCT = Number(process.env.SLIPPAGE_SELL_PCT || 0.15);

// Gas model per swap leg (USDC)
const GAS_USDC_V2 = Number(process.env.GAS_USDC_V2 || 0.05);
const GAS_USDC_UNI = Number(process.env.GAS_USDC_UNI || 0.05);
const GAS_USDC_ODOS = Number(process.env.GAS_USDC_ODOS || 0.05);

// диапазон поиска лучшего размера
const MIN_SIZE_USDC = Number(process.env.MIN_SIZE_USDC || 50);
const MAX_SIZE_USDC = Number(process.env.MAX_SIZE_USDC || 5000);

// Demo behavior
const SEND_DEMO_ON_MANUAL = String(process.env.SEND_DEMO_ON_MANUAL || "1") === "1";

// ---------- CHAINS / TOKENS ----------
const CHAINS = [
  {
    key: "polygon",
    name: "Polygon",
    chainId: 137,
    rpcUrl: RPC_URL
  },
  {
    key: "base",
    name: "Base",
    chainId: 8453,
    rpcUrl: RPC_URL_BASE || ""
  },
  {
    key: "arbitrum",
    name: "Arbitrum",
    chainId: 42161,
    rpcUrl: RPC_URL_ARBITRUM || ""
  }
].filter((c) => !!c.rpcUrl);

// Polygon tokens
const TOKENS_POLYGON = {
  USDC: { symbol: "USDC", addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase(), decimals: 6 },
  LINK: { symbol: "LINK", addr: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39".toLowerCase(), decimals: 18 },
  WMATIC: { symbol: "WMATIC", addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase(), decimals: 18 },
  WETH: { symbol: "WETH", addr: "0x7ceB23fD6bC0adD59E62ac25578270cF1b9f619".toLowerCase(), decimals: 18 },
  AAVE: { symbol: "AAVE", addr: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B".toLowerCase(), decimals: 18 },
  USDT: { symbol: "USDT", addr: (process.env.POLYGON_USDT || "0xc2132D05D31c914a87C6611C10748AaCBbD4d7E").toLowerCase(), decimals: 6 },
  DAI:  { symbol: "DAI",  addr: (process.env.POLYGON_DAI  || "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063").toLowerCase(), decimals: 18 },

  // ДОБАВЛЕННЫЕ ТОКЕНЫ (Polygon)
  WBTC:  { symbol: "WBTC",  addr: (process.env.POLYGON_WBTC  || "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6").toLowerCase(), decimals: 8 },
  UNI:   { symbol: "UNI",   addr: (process.env.POLYGON_UNI   || "0xb33EaAd8d922B1083446DC23f610c2567fB5180f").toLowerCase(), decimals: 18 },
  CRV:   { symbol: "CRV",   addr: (process.env.POLYGON_CRV   || "0x172370d5Cd63279eFa6d502DAB29171933a610AF").toLowerCase(), decimals: 18 },
  SNX:   { symbol: "SNX",   addr: (process.env.POLYGON_SNX   || "0x50B728D8D964fd00C2d0AAD81718B71311fef68a").toLowerCase(), decimals: 18 },
  BAL:   { symbol: "BAL",   addr: (process.env.POLYGON_BAL   || "0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3").toLowerCase(), decimals: 18 },
  COMP:  { symbol: "COMP",  addr: (process.env.POLYGON_COMP  || "0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c").toLowerCase(), decimals: 18 },
  MKR:   { symbol: "MKR",   addr: (process.env.POLYGON_MKR   || "0x6f7C932e7684666C9fd1d44527765433e01fF61d").toLowerCase(), decimals: 18 },
  SUSHI: { symbol: "SUSHI", addr: (process.env.POLYGON_SUSHI || "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a").toLowerCase(), decimals: 18 },

  MATIC: { symbol: "MATIC", addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase(), decimals: 18 }
};

const TOKENS_BASE = {
  USDC: { symbol: "USDC", addr: (process.env.BASE_USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913").toLowerCase(), decimals: 6 },
  WETH: { symbol: "WETH", addr: (process.env.BASE_WETH || "0x4200000000000000000000000000000000000006").toLowerCase(), decimals: 18 },
  USDT: process.env.BASE_USDT ? { symbol: "USDT", addr: process.env.BASE_USDT.toLowerCase(), decimals: 6 } : null,
  DAI:  process.env.BASE_DAI  ? { symbol: "DAI",  addr: process.env.BASE_DAI.toLowerCase(),  decimals: 18 } : null,
  ARB:  process.env.BASE_ARB  ? { symbol: "ARB",  addr: process.env.BASE_ARB.toLowerCase(),  decimals: 18 } : null
};

const TOKENS_ARBITRUM = {
  USDC: { symbol: "USDC", addr: (process.env.ARB_USDC || "0xaf88d065e77c8cC2239327C5EDb3A432268e5831").toLowerCase(), decimals: 6 },
  WETH: { symbol: "WETH", addr: (process.env.ARB_WETH || "0x82af49447d8a07e3bd95bd0d56f35241523fbab1").toLowerCase(), decimals: 18 },
  USDT: { symbol: "USDT", addr: (process.env.ARB_USDT || "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9").toLowerCase(), decimals: 6 },
  DAI:  { symbol: "DAI",  addr: (process.env.ARB_DAI  || "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1").toLowerCase(), decimals: 18 },
  ARB:  { symbol: "ARB",  addr: (process.env.ARB_ARB  || "0x912ce59144191c1204e64559fe8253a0e49e6548").toLowerCase(), decimals: 18 },

  // ДОБАВЛЕННЫЕ LINK И AAVE НА ARBITRUM
  LINK: { symbol: "LINK", addr: (process.env.ARB_LINK || "0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7").toLowerCase(), decimals: 18 },
  AAVE:{ symbol: "AAVE", addr: (process.env.ARB_AAVE || "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196").toLowerCase(), decimals: 18 }
};

const TOKENS_BY_CHAIN = {
  polygon: TOKENS_POLYGON,
  base: TOKENS_BASE,
  arbitrum: TOKENS_ARBITRUM
};

const WATCH = String(process.env.WATCH || "LINK,WMATIC,AAVE,WETH,USDT,DAI,ARB,MATIC,WBTC,UNI,CRV,SNX,BAL,COMP,MKR,SUSHI")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// флаг для возможного отключения агрегаторов (Odos/Curve) через ENV
const DISABLE_AGGREGATORS = String(process.env.DISABLE_AGGREGATORS || "0") === "1";

// ---------- VENUES / ROUTERS / QUOTERS ----------
const UNI_QUOTER_V2_BY_CHAIN = {
  polygon: (process.env.UNI_QUOTER_V2_POLYGON || process.env.UNI_QUOTER_V2 || "0x61fFE014bA17989E743c5F6cB21bF9697530B21e").toLowerCase(),
  base: (process.env.UNI_QUOTER_V2_BASE || "").toLowerCase(),
  arbitrum: (process.env.UNI_QUOTER_V2_ARBITRUM || process.env.UNI_QUOTER_V2_ARB || "").toLowerCase()
};

const UNI_FEES = (process.env.UNI_FEES || "500,3000,10000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

const ROUTERS_V2_BY_CHAIN = {
  polygon: {
    Sushi: (process.env.SUSHI_ROUTER || "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506").toLowerCase(),
    QuickSwap: (process.env.QUICKSWAP_ROUTER || "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff").toLowerCase()
  },
  base: {
    Aerodrome: (process.env.AERODROME_ROUTER || "").toLowerCase()
  },
  arbitrum: {
    Camelot: (process.env.CAMELOT_ROUTER || "").toLowerCase()
  }
};

const ODOS_QUOTE_V3 = "https://api.odos.xyz/sor/quote/v3";
const ODOS_QUOTE_V2 = "https://api.odos.xyz/sor/quote/v2";

// таймаут для Odos запросов (меньше 25c, чтобы не виснуть)
const ODOS_TIMEOUT_MS = Number(process.env.ODOS_TIMEOUT_MS || 8000);

// ---------- STATE ----------
const STATE_PATH = path.join(__dirname, "state.json");

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

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function pct(n, d = 2) {
  if (!Number.isFinite(n)) return "";
  return n.toFixed(d);
}

// ---------- TELEGRAM ----------
async function tgSendTo(chatId, html) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(
    url,
    {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true
    },
    { timeout: 20000 }
  );
}

async function tgBroadcast(html) {
  for (const id of CHAT_IDS) {
    try {
      await tgSendTo(id, html);
    } catch (e) {
      const d = e?.response?.data;
      console.error("TELEGRAM SEND ERROR:", id, d || e?.message || e);
    }
  }
}

// ---------- HTML SAFE HELPERS ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function safeHref(url) {
  return String(url).replace(/&/g, "&amp;").replace(/"/g, "%22");
}
function linkA(text, url) {
  return `<a href="${safeHref(url)}">${escapeHtml(text)}</a>`;
}

// ---------- LINKS ----------
function uniswapLink(chainKey, input, output) {
  const chain = chainKey === "polygon" ? "polygon" : chainKey === "base" ? "base" : "arbitrum";
  return `https://app.uniswap.org/swap?chain=${chain}&inputCurrency=${input}&outputCurrency=${output}`;
}

// важная правка: правильные query-параметры для Odos
function odosLink(chainId, input, output) {
  return `https://app.odos.xyz/?chainId=${chainId}&inputTokens=${input}&outputTokens=${output}`;
}

// V2-style router UIs
function sushiSwapLink(token0, token1) {
  return `https://www.sushi.com/polygon/swap?token0=${token0}&token1=${token1}`;
}
function quickSwapLink(token0, token1) {
  return `https://quickswap.exchange/#/swap?currency0=${token0}&currency1=${token1}`;
}
function aerodromeLink(token0, token1) {
  return `https://aerodrome.finance/swap?from=${token0}&to=${token1}`;
}
function camelotLink(token0, token1) {
  return `https://app.camelot.exchange/?inputCurrency=${token0}&outputCurrency=${token1}`;
}
function curveLink(chainKey, token0, token1) {
  const chain = chainKey === "polygon" ? "polygon" : chainKey === "base" ? "base" : "arbitrum";
  return `https://curve.fi/#/${chain}/swap?from=${token0}&to=${token1}`;
}

// ---------- ONCHAIN QUOTES ----------
const v2RouterAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const uniQuoterV2Abi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
];

function gasForVenue(venue) {
  if (venue === "Uniswap") return GAS_USDC_UNI;
  if (venue === "Odos" || venue === "Curve") return GAS_USDC_ODOS;
  return GAS_USDC_V2;
}

function listVenuesForChain(chainKey) {
  const venues = [];
  const v2 = ROUTERS_V2_BY_CHAIN[chainKey] || {};
  for (const [name, addr] of Object.entries(v2)) {
    if (addr && addr !== "0x0000000000000000000000000000000000000000") venues.push(name);
  }
  if (UNI_QUOTER_V2_BY_CHAIN[chainKey]) venues.push("Uniswap");
  // по умолчанию агрегаторы включены; можно отрубить через DISABLE_AGGREGATORS=1
  if (!DISABLE_AGGREGATORS) {
    venues.push("Odos");
    venues.push("Curve");
  }
  return venues;
}

// V2: pick best path for amountsOut
async function quoteV2_bestAmountsOut(provider, routerAddr, amountIn, pathCandidates) {
  const router = new ethers.Contract(routerAddr, v2RouterAbi, provider);
  let bestOut = null;

  for (const pathArr of pathCandidates) {
    try {
      const amounts = await router.getAmountsOut(amountIn, pathArr);
      const out = amounts[amounts.length - 1];
      if (!bestOut || out > bestOut) bestOut = out;
    } catch (_) {}
  }
  return bestOut;
}

function v2RouterAddr(chainKey, venue) {
  const m = ROUTERS_V2_BY_CHAIN[chainKey] || {};
  return (m[venue] || "").toLowerCase();
}

// BUY on V2: USDC -> TOKEN
async function quoteV2_STABLE_to_TOKEN_best(provider, chainKey, venue, stable, tokenAddr, stableAmount) {
  const routerAddr = v2RouterAddr(chainKey, venue);
  if (!routerAddr) throw new Error("V2 router missing for venue");

  const amountIn = ethers.parseUnits(String(stableAmount), stable.decimals);
  const t = TOKENS_BY_CHAIN[chainKey];

  const candidates = [
    [stable.addr, tokenAddr],
    t.WETH ? [stable.addr, t.WETH.addr, tokenAddr] : null,
    t.WMATIC ? [stable.addr, t.WMATIC.addr, tokenAddr] : null
  ].filter(Boolean);

  const out = await quoteV2_bestAmountsOut(provider, routerAddr, amountIn, candidates);
  if (!out) throw new Error("V2 BUY quote failed (all paths)");
  return out;
}

// SELL on V2: TOKEN -> USDC
async function quoteV2_TOKEN_to_STABLE_best(provider, chainKey, venue, stable, tokenAddr, tokenAmountIn) {
  const routerAddr = v2RouterAddr(chainKey, venue);
  if (!routerAddr) throw new Error("V2 router missing for venue");

  const t = TOKENS_BY_CHAIN[chainKey];
  const candidates = [
    [tokenAddr, stable.addr],
    t.WETH ? [tokenAddr, t.WETH.addr, stable.addr] : null,
    t.WMATIC ? [tokenAddr, t.WMATIC.addr, stable.addr] : null
  ].filter(Boolean);

  const out = await quoteV2_bestAmountsOut(provider, routerAddr, tokenAmountIn, candidates);
  if (!out) throw new Error("V2 SELL quote failed (all paths)");
  return out;
}

// Uniswap V3: exact input single
async function quoteUniV3_bestExactIn(provider, chainKey, tokenIn, tokenOut, amountIn) {
  const quoterAddr = UNI_QUOTER_V2_BY_CHAIN[chainKey];
  if (!quoterAddr) return null;

  const q = new ethers.Contract(quoterAddr, uniQuoterV2Abi, provider);
  let best = null;

  for (const fee of UNI_FEES) {
    try {
      const params = { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 };
      const res = await q.quoteExactInputSingle.staticCall(params);
      const amountOut = res[0];
      if (!best || amountOut > best.amountOut) best = { amountOut, fee };
    } catch (_) {}
  }
  return best;
}

async function quoteUni_STABLE_to_TOKEN_best(provider, chainKey, stable, tokenAddr, stableAmount) {
  const amountIn = ethers.parseUnits(String(stableAmount), stable.decimals);
  const best = await quoteUniV3_bestExactIn(provider, chainKey, stable.addr, tokenAddr, amountIn);
  if (!best) throw new Error("Uniswap BUY quote failed (no pool/fee)");
  return best.amountOut;
}

async function quoteUni_TOKEN_to_STABLE_best(provider, chainKey, stable, tokenAddr, tokenAmountIn) {
  const best = await quoteUniV3_bestExactIn(provider, chainKey, tokenAddr, stable.addr, tokenAmountIn);
  if (!best) throw new Error("Uniswap SELL quote failed (no pool/fee)");
  return best.amountOut;
}

// Odos quote
async function quoteOdos(chainId, inputAddr, inputAmountBase, outputAddr) {
  const body = {
    chainId,
    inputTokens: [{ tokenAddress: inputAddr, amount: inputAmountBase.toString() }],
    outputTokens: [{ tokenAddress: outputAddr, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000001",
    slippageLimitPercent: Number(Math.max(SLIPPAGE_BUY_PCT, SLIPPAGE_SELL_PCT, 0.1)),
    disableRFQs: true,
    compact: true
  };

  let res;
  try {
    res = await axios.post(ODOS_QUOTE_V3, body, { timeout: ODOS_TIMEOUT_MS });
  } catch (e) {
    if (e?.response?.status === 404) {
      res = await axios.post(ODOS_QUOTE_V2, body, { timeout: ODOS_TIMEOUT_MS });
    } else {
      throw e;
    }
  }

  const out = res?.data?.outAmounts?.[0];
  if (!out) throw new Error("Odos quote missing outAmounts");
  return BigInt(out);
}

async function quoteOdos_STABLE_to_TOKEN(chain, stable, tokenAddr, stableAmount) {
  const amountIn = ethers.parseUnits(String(stableAmount), stable.decimals);
  return await quoteOdos(chain.chainId, stable.addr, amountIn, tokenAddr);
}

async function quoteOdos_TOKEN_to_STABLE(chain, stable, tokenAddr, tokenAmountIn) {
  return await quoteOdos(chain.chainId, tokenAddr, tokenAmountIn, stable.addr);
}

// "Curve venue": pricing через Odos, UI — Curve
async function quoteCurve_STABLE_to_TOKEN(chain, stable, tokenAddr, stableAmount) {
  return await quoteOdos_STABLE_to_TOKEN(chain, stable, tokenAddr, stableAmount);
}
async function quoteCurve_TOKEN_to_STABLE(chain, stable, tokenAddr, tokenAmountIn) {
  return await quoteOdos_TOKEN_to_STABLE(chain, stable, tokenAddr, tokenAmountIn);
}

// ---------- COSTS / PROFIT ----------
function bpsFromPct(pctVal) {
  return Math.max(0, Math.round(Number(pctVal) * 100));
}

function haircutBase(amountBase, pctVal) {
  const bps = bpsFromPct(pctVal);
  const keep = 10000 - bps;
  return (amountBase * BigInt(keep)) / 10000n;
}

function subtractGasBase(stableOutBase, gasStable) {
  const stableDec = 6;
  const gasBase = ethers.parseUnits(String(gasStable), stableDec);
  return stableOutBase > gasBase ? stableOutBase - gasBase : 0n;
}

function netProfitPct(stableInDollars, stableOutBaseAfterCosts) {
  const stableInBase = ethers.parseUnits(String(stableInDollars), 6);
  const diff = stableOutBaseAfterCosts - stableInBase;
  return (Number(diff) / Number(stableInBase)) * 100;
}

// ---------- SIGNAL RULES ----------
function shouldSend(statePair, profitPctVal) {
  const now = nowSec();
  const lastSentAt = statePair?.lastSentAt || 0;
  const lastSentProfit = statePair?.lastSentProfit ?? -999;

  if (!Number.isFinite(profitPctVal)) return { ok: false, reason: "nan" };
  if (profitPctVal <= 0) return { ok: false, reason: "non_positive" }; // НЕ ОТПРАВЛЯЕМ ОТРИЦАТЕЛЬНЫЙ ПРОФИТ
  if (profitPctVal < MIN_PROFIT_PCT) return { ok: false, reason: "below_min" };

  const since = now - lastSentAt;
  const growth = profitPctVal - lastSentProfit;

  if (growth >= BIG_JUMP_BYPASS) return { ok: true, reason: "big_jump" };
  if (since < COOLDOWN_SEC) return { ok: false, reason: "cooldown" };
  if (growth < PROFIT_STEP_PCT) return { ok: false, reason: "no_growth" };

  return { ok: true, reason: "growth" };
}

// ---------- EMOJI (0.7% порог) ----------
function emojiForPct(p) {
  if (!Number.isFinite(p)) return "";
  if (p >= 1.5) return "🟢";
  if (p >= 1.3) return "🟠";
  if (p >= 0.7) return "🔴";
  return "❌";
}

// ---------- RISK LEVEL ----------
function riskLevelFromSamples(statePair) {
  const s = Array.isArray(statePair?.samples) ? statePair.samples : [];
  if (s.length < 2) return { level: "MED", emoji: "⚠️" };

  const lastP = s[s.length - 1].p;
  if (Number.isFinite(lastP) && lastP < 0) return { level: "HIGH", emoji: "🧨" };

  const a = s[s.length - 1].p;
  const b = s[s.length - 2].p;
  const delta = Math.abs(a - b);

  if (delta <= 0.15) return { level: "LOW", emoji: "✅" };
  if (delta <= 0.40) return { level: "MED", emoji: "⚠️" };
  return { level: "HIGH", emoji: "🧨" };
}

// ---------- EXECUTION WINDOW ----------
function updateWindowStats(statePair, profitPctVal) {
  if (!Number.isFinite(profitPctVal)) return;
  statePair.window = statePair.window || {};
  const w = statePair.window;
  const now = nowSec();

  if (profitPctVal >= MIN_PROFIT_PCT) {
    if (!w.aboveSince) w.aboveSince = now;
    w.lastAboveAt = now;
    return;
  }

  if (w.aboveSince) {
    const end = w.lastAboveAt || now;
    const dur = Math.max(0, end - w.aboveSince);
    w.hist = Array.isArray(w.hist) ? w.hist : [];
    if (dur > 0) w.hist.push(dur);
    if (w.hist.length > 30) w.hist = w.hist.slice(-30);
    w.aboveSince = 0;
    w.lastAboveAt = 0;
  }
}

function estimateWindowText(statePair) {
  const w = statePair?.window || {};
  const hist = Array.isArray(w.hist) ? w.hist : [];

  let typicalSec = QUOTE_TTL_SEC;
  if (hist.length) {
    const s = [...hist].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    typicalSec = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  const fmt = (sec) => {
    if (!Number.isFinite(sec) || sec <= 0) return "~0 sec";
    if (sec < 90) return `${Math.max(1, Math.round(sec))} sec`;
    return `~${Math.max(1, Math.round(sec / 60))} min`;
  };

  if (w.aboveSince) {
    const elapsed = nowSec() - w.aboveSince;
    const remaining = Math.max(0, typicalSec - elapsed);
    return `${fmt(remaining)} left (est.)`;
  }

  return `typical ${fmt(typicalSec)}`;
}

function pushSample(statePair, profitPctVal) {
  statePair.samples = Array.isArray(statePair.samples) ? statePair.samples : [];
  statePair.samples.push({ t: nowSec(), p: profitPctVal });
  if (statePair.samples.length > 30) statePair.samples = statePair.samples.slice(-30);
  statePair.lastAnyAt = nowSec();
}

// ---------- ROUTE SEARCH ----------
async function quoteBuy(chain, provider, venue, stable, tokenAddr, stableIn) {
  const chainKey = chain.key;
  if (venue === "Uniswap") return await quoteUni_STABLE_to_TOKEN_best(provider, chainKey, stable, tokenAddr, stableIn);
  if (venue === "Odos") return await quoteOdos_STABLE_to_TOKEN(chain, stable, tokenAddr, stableIn);
  if (venue === "Curve") return await quoteCurve_STABLE_to_TOKEN(chain, stable, tokenAddr, stableIn);
  return await quoteV2_STABLE_to_TOKEN_best(provider, chainKey, venue, stable, tokenAddr, stableIn);
}

async function quoteSell(chain, provider, venue, stable, tokenAddr, tokenInBase) {
  const chainKey = chain.key;
  if (venue === "Uniswap") return await quoteUni_TOKEN_to_STABLE_best(provider, chainKey, stable, tokenAddr, tokenInBase);
  if (venue === "Odos") return await quoteOdos_TOKEN_to_STABLE(chain, stable, tokenAddr, tokenInBase);
  if (venue === "Curve") return await quoteCurve_TOKEN_to_STABLE(chain, stable, tokenAddr, tokenInBase);
  return await quoteV2_TOKEN_to_STABLE_best(provider, chainKey, venue, stable, tokenAddr, tokenInBase);
}

// compute best route for one size
async function bestRouteForSize(chain, provider, sym, tokenAddr, stableIn) {
  let best = null;
  const chainKey = chain.key;
  const t = TOKENS_BY_CHAIN[chainKey];
  const stable = t.USDC;
  const VENUES = listVenuesForChain(chainKey);

  for (const buyVenue of VENUES) {
    let tokenOut;
    try {
      tokenOut = await quoteBuy(chain, provider, buyVenue, stable, tokenAddr, stableIn);
    } catch (_) {
      continue;
    }

    const tokenOutNet = haircutBase(tokenOut, SLIPPAGE_BUY_PCT);

    for (const sellVenue of VENUES) {
      if (sellVenue === buyVenue) continue;

      let stableOut;
      try {
        stableOut = await quoteSell(chain, provider, sellVenue, stable, tokenAddr, tokenOutNet);
      } catch (_) {
        continue;
      }

      let stableOutNet = haircutBase(stableOut, SLIPPAGE_SELL_PCT);

      const gasTotal = gasForVenue(buyVenue) + gasForVenue(sellVenue);
      stableOutNet = subtractGasBase(stableOutNet, gasTotal);

      const p = netProfitPct(stableIn, stableOutNet);

      if (!best || (Number.isFinite(p) && p > best.pct)) {
        best = {
          pct: p,
          buyVenue,
          sellVenue,
          gasTotal
        };
      }
    }
  }

  if (!best) return { pct: NaN, buyVenue: "?", sellVenue: "?", gasTotal: 0 };
  return best;
}

// доп. поиск лучшего размера вокруг исходного bestPick (лёгкий локальный поиск, без перебора 50–5000)
async function refineBestSize(chain, provider, stable, tokenAddr, basePick) {
  if (!basePick || !Number.isFinite(basePick.pct)) return basePick;

  let bestSize = basePick.size;
  let bestPct = basePick.pct;

  const buyVenue = basePick.buyVenue;
  const sellVenue = basePick.sellVenue;

  const minSize = Math.max(MIN_SIZE_USDC, bestSize * 0.4);   // не лезем сильно ниже
  const maxSize = Math.min(MAX_SIZE_USDC, bestSize * 2.5);   // и сильно выше
  let step = bestSize * 0.25;
  if (step < 10) step = 10;

  async function profitForSize(size) {
    try {
      const tokenOut = await quoteBuy(chain, provider, buyVenue, stable, tokenAddr, size);
      const tokenOutNet = haircutBase(tokenOut, SLIPPAGE_BUY_PCT);
      let stableOut = await quoteSell(chain, provider, sellVenue, stable, tokenAddr, tokenOutNet);
      let stableOutNet = haircutBase(stableOut, SLIPPAGE_SELL_PCT);
      const gasTotal = gasForVenue(buyVenue) + gasForVenue(sellVenue);
      stableOutNet = subtractGasBase(stableOutNet, gasTotal);
      const p = netProfitPct(size, stableOutNet);
      return p;
    } catch (_) {
      return NaN;
    }
  }

  for (let i = 0; i < 6; i++) {
    let improved = false;
    const candidates = [bestSize];
    const sMinus = bestSize - step;
    const sPlus = bestSize + step;
    if (sMinus >= minSize) candidates.push(sMinus);
    if (sPlus <= maxSize) candidates.push(sPlus);

    for (const s of candidates) {
      const p = await profitForSize(s);
      if (Number.isFinite(p) && p > bestPct) {
        bestPct = p;
        bestSize = s;
        improved = true;
      }
    }

    if (!improved) {
      step = step / 2;
      if (step < 1) break;
    }
  }

  return { ...basePick, size: bestSize, pct: bestPct };
}

// ---------- MESSAGE BUILDER ----------
function buildSignalMessage({
  chain,
  sym,
  bestRouteHtml,
  bestSizeText,
  perSizeLines,
  windowText,
  riskText,
  isTest
}) {
  const title = isTest
    ? `🧪 <b>TEST — ARBITRAGE SIGNAL — ${escapeHtml(chain.name)} — ${escapeHtml(sym)} / USDC</b>`
    : `🔥 <b>ARBITRAGE SIGNAL — ${escapeHtml(chain.name)} — ${escapeHtml(sym)} / USDC</b>`;

  return [
    title,
    "",
    `Best route: <b>${bestRouteHtml}</b>`,
    `Best size (max profit): <b>${escapeHtml(bestSizeText)}</b>`,
    "",
    `💰 <b>Net profit (after slippage + gas)</b>`,
    ...perSizeLines,
    "",
    `⏱ <b>Execution window:</b> ${escapeHtml(windowText)}`,
    `${riskText}`,
    "",
    `🟢 ≥ 1.50%`,
    `🟠 1.30–1.49%`,
    `🔴 0.70–1.29%`,
    `❌ below 0.70%`
  ].join("\n");
}

function venueSwapLink(chainKey, chainId, venue, tokenIn, tokenOut) {
  if (venue === "Uniswap") return linkA("Uniswap", uniswapLink(chainKey, tokenIn, tokenOut));
  if (venue === "Odos") return linkA("Odos", odosLink(chainId, tokenIn, tokenOut));
  if (venue === "Curve") return linkA("Curve", curveLink(chainKey, tokenIn, tokenOut));

  if (chainKey === "polygon") {
    if (venue === "Sushi") return linkA("SushiSwap", sushiSwapLink(tokenIn, tokenOut));
    if (venue === "QuickSwap") return linkA("QuickSwap", quickSwapLink(tokenIn, tokenOut));
  }
  if (chainKey === "base") {
    if (venue === "Aerodrome") return linkA("Aerodrome", aerodromeLink(tokenIn, tokenOut));
  }
  if (chainKey === "arbitrum") {
    if (venue === "Camelot") return linkA("Camelot", camelotLink(tokenIn, tokenOut));
  }

  return linkA(venue, uniswapLink(chainKey, tokenIn, tokenOut));
}

function bestRouteLinkHtml(chain, buyVenue, sellVenue, stableAddr, tokenAddr) {
  const chainKey = chain.key;
  const buyLink = venueSwapLink(chainKey, chain.chainId, buyVenue, stableAddr, tokenAddr);
  const sellLink = venueSwapLink(chainKey, chain.chainId, sellVenue, tokenAddr, stableAddr);
  return `${buyLink} → ${sellLink}`;
}

// ---------- DEMO ----------
async function sendDemoSignalForChain(provider, chain, sym) {
  const tAll = TOKENS_BY_CHAIN[chain.key] || {};
  const t = tAll[sym];
  const stable = tAll.USDC;
  if (!t || !stable) return;

  const perSizeLines = [];
  let bestAcrossAll = -999;
  let bestPick = null;

  for (const size of SIZES) {
    const r = await bestRouteForSize(chain, provider, sym, t.addr, size);

    const em = emojiForPct(r.pct);
    const pStr = Number.isFinite(r.pct) ? `${r.pct >= 0 ? "+" : ""}${pct(r.pct, 2)}%` : "—";
    perSizeLines.push(
      `${em} <b>$${size} USDC input</b> → <b>${pStr}</b>`
    );

    if (Number.isFinite(r.pct) && r.pct > bestAcrossAll) {
      bestAcrossAll = r.pct;
      bestPick = { ...r, size };
    }
  }

  if (bestPick) {
    try {
      bestPick = await refineBestSize(chain, provider, stable, t.addr, bestPick);
      bestAcrossAll = bestPick.pct;
    } catch (e) {
      console.error("DEMO REFINE ERROR:", chain.key, sym, e?.message || e);
    }
  }

  const bestRouteHtml = bestPick
    ? bestRouteLinkHtml(chain, bestPick.buyVenue, bestPick.sellVenue, stable.addr, t.addr)
    : escapeHtml("n/a");

  const bestSizeText = bestPick
    ? `$${bestPick.size.toFixed(2)} USDC`
    : "n/a";

  const riskText =
    Number.isFinite(bestAcrossAll) && bestAcrossAll < 0
      ? `🧨 <b>Risk:</b> HIGH`
      : `⚠️ <b>Risk:</b> MED`;

  const msg = buildSignalMessage({
    chain,
    sym,
    bestRouteHtml,
    bestSizeText,
    perSizeLines,
    windowText: "2–5 minutes",
    riskText,
    isTest: true
  });

  await tgBroadcast(msg);
}

// ---------- MAIN ----------
async function main() {
  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || {};

  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const runId = String(process.env.GITHUB_RUN_ID || "");
  const demoTag = runId || "manual";

  for (const chain of CHAINS) {
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);

    // sanity: rpc chain must match
    try {
      const net = await provider.getNetwork();
      const rpcChain = Number(net.chainId);
      if (rpcChain !== chain.chainId) {
        console.error(`RPC CHAIN_ID MISMATCH (${chain.key}): RPC=${rpcChain} EXPECTED=${chain.chainId} (fix RPC_URL_*)`);
        continue;
      }
    } catch (e) {
      console.error(`NETWORK CHECK FAILED (${chain.key}):`, e?.message || e);
      continue;
    }

    const tAll = TOKENS_BY_CHAIN[chain.key] || {};
    const stable = tAll.USDC;
    if (!stable) continue;

    // Demo once per manual run per chain
    if (eventName === "workflow_dispatch" && SEND_DEMO_ON_MANUAL) {
      if (chain.key !== "polygon") continue; // тест только для Polygon
      const tagKey = `demoSentTag:${chain.key}`;
      if (state.meta[tagKey] !== demoTag) {
        try {
          let demoSym = tAll.LINK ? "LINK" : tAll.WETH ? "WETH" : null;
          if (!demoSym) {
            for (const s of WATCH) {
              if (tAll[s]) {
                demoSym = s;
                break;
              }
            }
          }
          if (demoSym) {
            await sendDemoSignalForChain(provider, chain, demoSym);
            state.meta[tagKey] = demoTag;
            state.meta[`demoSentAt:${chain.key}`] = nowSec();
            writeState(state);
          }
        } catch (e) {
          console.error("DEMO ERROR:", chain.key, e?.response?.status, e?.response?.data || e?.message || e);
        }
      }
    }

    for (const sym of WATCH) {
      const t = tAll[sym];
      if (!t) continue;

      const primarySize = 1000;
      const primaryKey = `${chain.key}:${sym}:USDC:${primarySize}`;
      state.pairs[primaryKey] = state.pairs[primaryKey] || {};

      const perSizeLines = [];
      let bestAcrossAll = -999;
      let bestPick = null;

      for (const size of SIZES) {
        const sizeKey = `${chain.key}:${sym}:USDC:${size}`;
        state.pairs[sizeKey] = state.pairs[sizeKey] || {};

        let r;
        try {
          r = await bestRouteForSize(chain, provider, sym, t.addr, size);
        } catch (e) {
          console.error(sym, "ROUTE ERROR:", chain.key, size, e?.message || e);
          perSizeLines.push(`❌ <b>$${size} USDC input</b> → <b>—</b>`);
          continue;
        }

        const em = emojiForPct(r.pct);
        const pStr = Number.isFinite(r.pct) ? `${r.pct >= 0 ? "+" : ""}${pct(r.pct, 2)}%` : "—";
        perSizeLines.push(
          `${em} <b>$${size} USDC input</b> → <b>${pStr}</b>`
        );

        if (Number.isFinite(r.pct)) pushSample(state.pairs[sizeKey], r.pct);

        if (Number.isFinite(r.pct) && r.pct > bestAcrossAll) {
          bestAcrossAll = r.pct;
          bestPick = { ...r, size };
        }
      }

      // refine best size по лучшему маршруту
      if (bestPick && Number.isFinite(bestAcrossAll)) {
        try {
          bestPick = await refineBestSize(chain, provider, stable, t.addr, bestPick);
          if (Number.isFinite(bestPick.pct)) {
            bestAcrossAll = bestPick.pct;
          }
        } catch (e) {
          console.error("REFINE ERROR:", chain.key, sym, e?.message || e);
        }
      }

      // Track window stats on primary key (по фактическому лучшему профиту)
      if (Number.isFinite(bestAcrossAll)) {
        pushSample(state.pairs[primaryKey], bestAcrossAll);
        updateWindowStats(state.pairs[primaryKey], bestAcrossAll);
      }

      const decision = shouldSend(state.pairs[primaryKey], bestAcrossAll);
      if (!decision.ok) {
        writeState(state);
        continue;
      }

      const bestRouteHtml = bestPick
        ? bestRouteLinkHtml(chain, bestPick.buyVenue, bestPick.sellVenue, stable.addr, t.addr)
        : escapeHtml("n/a");

      const bestSizeText = bestPick
        ? `$${bestPick.size.toFixed(2)} USDC`
        : "n/a";

      const windowText = estimateWindowText(state.pairs[primaryKey]);
      const risk = riskLevelFromSamples(state.pairs[primaryKey]);
      const riskText = `${risk.emoji} <b>Risk:</b> ${risk.level}`;

      const msg = buildSignalMessage({
        chain,
        sym,
        bestRouteHtml,
        bestSizeText,
        perSizeLines,
        windowText,
        riskText,
        isTest: false
      });

      try {
        await tgBroadcast(msg);

        const ts = nowSec();
        state.pairs[primaryKey].lastSentAt = ts;
        state.pairs[primaryKey].lastSentProfit = bestAcrossAll;
        state.pairs[primaryKey].lastRoute = bestPick ? `${bestPick.buyVenue}->${bestPick.sellVenue}` : "";
        state.meta.lastAnySentAt = ts;

        writeState(state);
      } catch (e) {
        console.error("TELEGRAM ERROR:", e?.response?.data || e?.message || e);
      }
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
