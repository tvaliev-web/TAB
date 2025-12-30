// bot.js (CommonJS)
// Polygon arb notifier:
// BUY = Sushi (USDC -> COIN) using router getAmountsOut
// SELL = best of (Uniswap V3 QuoterV2, Odos quote) (COIN -> USDC)
// Sends Telegram alerts when profit >= MIN_PROFIT_PCT
// Re-sends only if profit increases by PROFIT_STEP_PCT (state.json), with cooldown.
//
// CHAT_ID supports multiple IDs: "id1,id2,id3"

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TG_TOKEN || process.env.tg_token;
const CHAT_ID_RAW = process.env.CHAT_ID || process.env.TG_CHAT_ID || process.env.tg_chat_id;
const RPC_URL = process.env.RPC_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID_RAW) throw new Error("CHAT_ID missing");
if (!RPC_URL) throw new Error("RPC_URL missing");

const CHAT_IDS = String(CHAT_ID_RAW)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!CHAT_IDS.length) throw new Error("CHAT_ID parsed empty");

// ---------- CONFIG ----------
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// Trade sizing
const USDC_IN = Number(process.env.USDC_IN || 1000); // in dollars
const USDC_DECIMALS = 6;

// Signal tuning
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);
const QUOTE_TTL_SEC = Number(process.env.QUOTE_TTL_SEC || 120);

// Demo behavior
const SEND_DEMO_ON_MANUAL = String(process.env.SEND_DEMO_ON_MANUAL || "0") === "1";

// Tokens (Polygon)
const TOKENS = {
  USDC: { symbol: "USDC", addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  LINK: { symbol: "LINK", addr: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
  WMATIC: { symbol: "WMATIC", addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  AAVE: { symbol: "AAVE", addr: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18 }
};

// Track these coins (edit if you want)
const WATCH = ["LINK", "WMATIC", "AAVE"];

// SushiSwap Router (Polygon)
const SUSHI_ROUTER = (process.env.SUSHI_ROUTER || "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506").toLowerCase();

// Uniswap V3 QuoterV2 (Polygon)
const UNI_QUOTER_V2 = (process.env.UNI_QUOTER_V2 || "0x61fFE014bA17989E743c5F6cB21bF9697530B21e").toLowerCase();

// Try these fee tiers (in order) for Uniswap V3
const UNI_FEES = (process.env.UNI_FEES || "500,3000,10000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

// Odos quote endpoint (use v3 first; fallback to v2)
const ODOS_QUOTE_V3 = "https://api.odos.xyz/sor/quote/v3";
const ODOS_QUOTE_V2 = "https://api.odos.xyz/sor/quote/v2";

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

function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

function pct(n, d = 2) {
  if (!Number.isFinite(n)) return "n/a";
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
    await tgSendTo(id, html);
  }
}

// ---------- LINKS (clickable names, not raw URLs) ----------
function linkA(text, url) {
  return `<a href="${url}">${text}</a>`;
}

function sushiSwapLink(token0, token1) {
  return `https://www.sushi.com/polygon/swap?token0=${token0}&token1=${token1}`;
}

function uniswapLink(input, output) {
  return `https://app.uniswap.org/swap?chain=polygon&inputCurrency=${input}&outputCurrency=${output}`;
}

function odosLink(input, output) {
  return `https://app.odos.xyz/?chain=${CHAIN_ID}&tokenIn=${input}&tokenOut=${output}`;
}

// ---------- ONCHAIN QUOTES ----------
const sushiRouterAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const uniQuoterV2Abi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
];

async function quoteSushiExactOutUSDCtoToken(provider, tokenAddr, amountUsdc) {
  const router = new ethers.Contract(SUSHI_ROUTER, sushiRouterAbi, provider);
  const amountIn = ethers.parseUnits(String(amountUsdc), USDC_DECIMALS);
  const pathArr = [TOKENS.USDC.addr, tokenAddr];
  const amounts = await router.getAmountsOut(amountIn, pathArr);
  return amounts[amounts.length - 1];
}

async function quoteUniV3TokenToUSDC_best(provider, tokenAddr, tokenAmountIn) {
  const q = new ethers.Contract(UNI_QUOTER_V2, uniQuoterV2Abi, provider);

  let best = null;

  for (const fee of UNI_FEES) {
    try {
      const params = {
        tokenIn: tokenAddr,
        tokenOut: TOKENS.USDC.addr,
        amountIn: tokenAmountIn,
        fee: fee,
        sqrtPriceLimitX96: 0
      };
      const res = await q.quoteExactInputSingle(params);
      const amountOut = res[0];
      if (!best || amountOut > best.amountOut) best = { amountOut, fee };
    } catch (_) {}
  }

  return best;
}

async function quoteOdosTokenToUSDC(tokenAddr, tokenAmountIn) {
  const amountStr = tokenAmountIn.toString();

  const body = {
    chainId: CHAIN_ID,
    inputTokens: [{ tokenAddress: tokenAddr, amount: amountStr }],
    outputTokens: [{ tokenAddress: TOKENS.USDC.addr, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000001",
    slippageLimitPercent: 0.30,
    disableRFQs: true,
    compact: true
  };

  let res;
  try {
    res = await axios.post(ODOS_QUOTE_V3, body, { timeout: 25000 });
  } catch (e) {
    if (e?.response?.status === 404) {
      res = await axios.post(ODOS_QUOTE_V2, body, { timeout: 25000 });
    } else {
      throw e;
    }
  }

  const out = res?.data?.outAmounts?.[0];
  if (!out) throw new Error("Odos quote missing outAmounts");
  return BigInt(out);
}

// ---------- SIGNAL RULES ----------
function shouldSend(statePair, profitPct) {
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

// ---------- MESSAGE BUILDER ----------
function buildSignalMessage({
  sym,
  usdcIn,
  tokenBought,
  bestVenue,
  usdcOut,
  profitPctVal,
  reason,
  buyLink,
  sellLink
}) {
  const windowText = `~${QUOTE_TTL_SEC}s`;

  return [
    "🔥 <b>ARBITRAGE SIGNAL</b>  <b>" + sym + "/USDC</b>",
    "",
    `Size: <b>$${usdcIn}</b>`,
    `Buy (Sushi): <b>$${usdcIn}</b> → <b>${fmt(tokenBought, 6)} ${sym}</b>`,
    `Best sell: <b>${bestVenue}</b> → <b>$${fmt(usdcOut, 2)}</b>`,
    "",
    `Profit: <b>+${pct(profitPctVal, 2)}%</b>`,
    `Execution window: <b>${windowText}</b>`,
    "",
    `${buyLink}`,
    `${sellLink}`,
    "",
    `<i>Reason: ${reason}</i>`
  ].join("\n");
}

// ---------- DEMO SIGNAL (ALWAYS SENDS ON MANUAL RUN) ----------
async function sendDemoSignal() {
  // Use WMATIC demo so you see exact format + links
  const sym = "WMATIC";
  const t = TOKENS[sym];

  const buyLink = linkA(`Sushi (buy USDC→${sym})`, sushiSwapLink(TOKENS.USDC.addr, t.addr));
  const uniSellLink = linkA(`Uniswap (sell ${sym}→USDC)`, uniswapLink(t.addr, TOKENS.USDC.addr));
  const odosSellLink = linkA(`Odos (sell ${sym}→USDC)`, odosLink(t.addr, TOKENS.USDC.addr));

  // Fake numbers just for preview (does not depend on profit threshold)
  const msg = buildSignalMessage({
    sym,
    usdcIn: USDC_IN,
    tokenBought: 100.0,
    bestVenue: "Odos (DEMO)",
    usdcOut: USDC_IN * 1.03,
    profitPctVal: 3.0,
    reason: "demo_preview",
    buyLink,
    sellLink: `${uniSellLink} | ${odosSellLink}`
  });

  await tgBroadcast(msg);
}

// ---------- MAIN ----------
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || {};

  const eventName = process.env.GITHUB_EVENT_NAME || "";

  // Manual run: send BOT STARTED + DEMO SIGNAL EXAMPLE
  if (eventName === "workflow_dispatch" && SEND_DEMO_ON_MANUAL) {
    const demo = [
      "✅ <b>BOT STARTED</b>",
      `Sizing: <b>$${USDC_IN}</b>`,
      `Threshold: <b>${MIN_PROFIT_PCT}%</b> (step ${PROFIT_STEP_PCT}%)`,
      `Recipients: <b>${CHAT_IDS.join(",")}</b>`
    ].join("\n");
    await tgBroadcast(demo);

    // THIS is the "пример сигнала" you asked for
    await sendDemoSignal();
  }

  for (const sym of WATCH) {
    const t = TOKENS[sym];
    if (!t) continue;

    // IMPORTANT: keep compatible state keys (no reset)
    // You already have entries like: "polygon:LINK:USDC:1000"
    const key = `polygon:${sym}:USDC:${USDC_IN}`;
    state.pairs[key] = state.pairs[key] || {};

    let tokenOutSushi, usdcBackUni, usdcBackOdos;
    let uniBest = null;

    try {
      // BUY: Sushi USDC -> TOKEN (for $USDC_IN)
      tokenOutSushi = await quoteSushiExactOutUSDCtoToken(provider, t.addr, USDC_IN);

      // SELL candidates: TOKEN -> USDC
      uniBest = await quoteUniV3TokenToUSDC_best(provider, t.addr, tokenOutSushi);
      if (uniBest) usdcBackUni = uniBest.amountOut;

      usdcBackOdos = await quoteOdosTokenToUSDC(t.addr, tokenOutSushi);
    } catch (e) {
      console.error(sym, "QUOTE ERROR:", e?.response?.status, e?.message || e);
      continue;
    }

    // choose best sell
    let bestVenue = null;
    let bestUsdcOut = null;

    if (usdcBackUni && (!bestUsdcOut || usdcBackUni > bestUsdcOut)) {
      bestUsdcOut = usdcBackUni;
      bestVenue = uniBest ? `UniswapV3 (fee ${uniBest.fee})` : "UniswapV3";
    }
    if (usdcBackOdos && (!bestUsdcOut || usdcBackOdos > bestUsdcOut)) {
      bestUsdcOut = usdcBackOdos;
      bestVenue = "Odos";
    }

    if (!bestUsdcOut || !bestVenue) continue;

    const usdcInBase = ethers.parseUnits(String(USDC_IN), USDC_DECIMALS);
    const profitPctVal = (Number(bestUsdcOut - usdcInBase) / Number(usdcInBase)) * 100;

    const decision = shouldSend(state.pairs[key], profitPctVal);
    if (!decision.ok) {
      console.log(`${sym}: no send (${decision.reason}) profit=${profitPctVal}`);
      continue;
    }

    const tokenBought = Number(ethers.formatUnits(tokenOutSushi, t.decimals));
    const usdcOut = Number(ethers.formatUnits(bestUsdcOut, USDC_DECIMALS));

    const buyLink = linkA(`Sushi (buy USDC→${sym})`, sushiSwapLink(TOKENS.USDC.addr, t.addr));
    const uniSellLink = linkA(`Uniswap (sell ${sym}→USDC)`, uniswapLink(t.addr, TOKENS.USDC.addr));
    const odosSellLink = linkA(`Odos (sell ${sym}→USDC)`, odosLink(t.addr, TOKENS.USDC.addr));
    const sellLink = bestVenue.startsWith("Odos") ? odosSellLink : uniSellLink;

    const msg = buildSignalMessage({
      sym,
      usdcIn: USDC_IN,
      tokenBought,
      bestVenue,
      usdcOut,
      profitPctVal,
      reason: decision.reason,
      buyLink,
      sellLink
    });

    try {
      await tgBroadcast(msg);

      // update state only on successful send
      const ts = nowSec();
      state.pairs[key].lastSentAt = ts;
      state.pairs[key].lastSentProfit = profitPctVal;
      state.pairs[key].lastVenue = bestVenue;

      writeState(state);
      console.log(`${sym}: sent (${decision.reason}) profit=${profitPctVal}`);
    } catch (e) {
      console.error("TELEGRAM ERROR:", e?.response?.data || e?.message || e);
    }
  }
}

// never fail Actions (no red X spam)
main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
