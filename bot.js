// bot.js (CommonJS) — Polygon
// BUY: Sushi (USDC -> TOKEN) exact TRADE_USDC
// SELL: best of (Uniswap v3) vs (Odos) for TOKEN -> USDC
// Alerts to multiple Telegram IDs: CHAT_ID="id1,id2"
// Anti-spam via state.json: >= MIN_PROFIT_PCT, resend only on growth.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TG_TOKEN || process.env.tg_token;
const CHAT_ID_RAW = process.env.CHAT_ID || process.env.TG_CHAT_ID || process.env.tg_chat_id;
const RPC_URL = process.env.RPC_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID_RAW) throw new Error("CHAT_ID missing");
if (!RPC_URL) throw new Error("RPC_URL missing");

// Multi recipients: "id1,id2"
const CHAT_IDS = String(CHAT_ID_RAW).split(",").map(s => s.trim()).filter(Boolean);

const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// Trade sizing
const TRADE_USDC = Number(process.env.TRADE_USDC || 1000);
if (!Number.isFinite(TRADE_USDC) || TRADE_USDC <= 0) throw new Error("TRADE_USDC invalid");

// Signal tuning
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);
const MIN_SECONDS_BETWEEN_ANY = Number(process.env.MIN_SECONDS_BETWEEN_ANY || 60);

// Manual-only message
const SEND_DEMO_ON_MANUAL = String(process.env.SEND_DEMO_ON_MANUAL || "0") === "1";

// ===== Addresses (Polygon) =====
const USDC = (process.env.USDC || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174").toLowerCase();

// Sushi router (Polygon)
const SUSHI_ROUTER = (process.env.SUSHI_ROUTER || "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506").toLowerCase();

// Uniswap v3 QuoterV2 (Polygon official deployments)
const UNI_QUOTER_V2 = (process.env.UNI_QUOTER_V2 || "0x61fFE014bA17989E743c5F6cB21bF9697530B21e").toLowerCase();

// Tokens
const TOKENS = [
  { symbol: "LINK",  address: (process.env.LINK  || "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39").toLowerCase(), decimals: 18 },
  { symbol: "MATIC", address: (process.env.WMATIC|| "0x0d500B1d8E8ef31E21C99d1Db9A6444d3ADf1270").toLowerCase(), decimals: 18 }, // WMATIC on-chain, show as MATIC
  { symbol: "AAVE",  address: (process.env.AAVE  || "0xd6df932a45c0f255f85145f286ea0b292b21c90b").toLowerCase(), decimals: 18 },
];

// Uniswap fee tiers to try (0.05%, 0.3%, 1%)
const UNI_FEES = [500, 3000, 10000];

// ===== State =====
const STATE_PATH = path.join(__dirname, "state.json");

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { pairs: {} }; }
}
function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function nowSec() { return Math.floor(Date.now() / 1000); }
function fmt(n, d = 4) { return Number.isFinite(n) ? n.toFixed(d) : "n/a"; }

// ===== Telegram HTML =====
async function tgSendHTML(html) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  for (const id of CHAT_IDS) {
    await axios.post(url, {
      chat_id: id,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }, { timeout: 20000 });
  }
}

// ===== Links =====
function sushiSwapLink(tokenOut) {
  return `https://www.sushi.com/swap?chainId=${CHAIN_ID}&token0=${USDC}&token1=${tokenOut}`;
}
function uniswapSwapLink(tokenIn) {
  // Uniswap UI: TOKEN -> USDC on Polygon
  return `https://app.uniswap.org/swap?chain=polygon&inputCurrency=${tokenIn}&outputCurrency=${USDC}`;
}
function odosSwapLink(tokenIn) {
  return `https://app.odos.xyz/?chain=${CHAIN_ID}&tokenIn=${tokenIn}&tokenOut=${USDC}`;
}

// ===== Sushi quote =====
const sushiRouterAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

async function quoteSushiBuy(provider, token) {
  const router = new ethers.Contract(SUSHI_ROUTER, sushiRouterAbi, provider);
  const usdcIn = BigInt(Math.round(TRADE_USDC * 1e6)); // USDC 6d
  const path = [USDC, token.address];
  const amounts = await router.getAmountsOut(usdcIn, path);
  const tokenOut = BigInt(amounts[1].toString());
  return { usdcIn, tokenOut };
}

// ===== Uniswap v3 QuoterV2 quoteExactInputSingle =====
const uniQuoterV2Abi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)"
];

async function quoteUniswapSell(provider, token, tokenAmountIn) {
  const q = new ethers.Contract(UNI_QUOTER_V2, uniQuoterV2Abi, provider);

  let bestOut = 0n;
  let bestFee = null;

  for (const fee of UNI_FEES) {
    try {
      const params = {
        tokenIn: token.address,
        tokenOut: USDC,
        amountIn: tokenAmountIn,
        fee,
        sqrtPriceLimitX96: 0
      };
      const out = await q.quoteExactInputSingle(params);
      const outBI = BigInt(out.toString());
      if (outBI > bestOut) {
        bestOut = outBI;
        bestFee = fee;
      }
    } catch (_) {
      // ignore fee tier failures (pool missing etc.)
    }
  }

  if (bestOut === 0n) throw new Error("Uniswap quote failed (no pool/fees)");
  return { usdcOut: bestOut, fee: bestFee };
}

// ===== Odos quote =====
async function quoteOdosSell(token, tokenAmountIn) {
  const url = "https://api.odos.xyz/sor/quote/v2";
  const body = {
    chainId: CHAIN_ID,
    inputTokens: [{ tokenAddress: token.address, amount: tokenAmountIn.toString() }],
    outputTokens: [{ tokenAddress: USDC, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000001",
    slippageLimitPercent: 0.3,
    referralCode: 0,
    disableRFQs: true,
    compact: true,
  };
  const res = await axios.post(url, body, { timeout: 25000 });
  const out = res.data?.outAmounts?.[0];
  if (!out) throw new Error("Odos quote missing outAmounts");
  return BigInt(out); // USDC 6d
}

// ===== Anti-spam decision =====
function shouldSend(st, profitPct) {
  const now = nowSec();

  const lastAnyAt = st?.lastAnyAt || 0;
  if (now - lastAnyAt < MIN_SECONDS_BETWEEN_ANY) return { ok: false, reason: "min_between_any" };

  const lastSentAt = st?.lastSentAt || 0;
  const lastSentProfit = st?.lastSentProfit ?? -999;

  if (profitPct < MIN_PROFIT_PCT) return { ok: false, reason: "below_min" };

  const since = now - lastSentAt;
  const growth = profitPct - lastSentProfit;

  if (growth >= BIG_JUMP_BYPASS) return { ok: true, reason: "big_jump" };
  if (since < COOLDOWN_SEC) return { ok: false, reason: "cooldown" };
  if (growth < PROFIT_STEP_PCT) return { ok: false, reason: "no_growth" };

  return { ok: true, reason: "growth" };
}

// ===== Main =====
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const state = readState();
  state.pairs = state.pairs || {};

  const eventName = process.env.GITHUB_EVENT_NAME || "";
  if (eventName === "workflow_dispatch") {
    await tgSendHTML("✅ <b>BOT STARTED</b>");
    if (SEND_DEMO_ON_MANUAL) {
      await tgSendHTML(`🧪 <b>DEMO</b>\nTrade size: <b>$${fmt(TRADE_USDC, 0)}</b>\nMin profit: <b>${fmt(MIN_PROFIT_PCT, 2)}%</b>`);
    }
  }

  for (const token of TOKENS) {
    const key = `polygon:${token.symbol}:trade=${TRADE_USDC}`;
    state.pairs[key] = state.pairs[key] || {};
    const st = state.pairs[key];

    let buy, odosOut, uni;
    try {
      // BUY on Sushi
      buy = await quoteSushiBuy(provider, token);

      // SELL candidates
      // Odos
      odosOut = await quoteOdosSell(token, buy.tokenOut);

      // Uniswap
      uni = await quoteUniswapSell(provider, token, buy.tokenOut);

    } catch (e) {
      console.error(`[${token.symbol}] QUOTE ERROR:`, e?.message || e);
      // do not telegram spam errors
      st.lastAnyAt = nowSec();
      writeState(state);
      continue;
    }

    // choose best SELL
    const uniOut = uni.usdcOut;
    const best = (uniOut > odosOut)
      ? { venue: "Uniswap", usdcOut: uniOut, link: uniswapSwapLink(token.address), extra: `fee=${uni.fee}` }
      : { venue: "Odos", usdcOut: odosOut, link: odosSwapLink(token.address), extra: "" };

    const usdcIn = buy.usdcIn;
    const profitUSDC = Number(best.usdcOut - usdcIn) / 1e6;
    const profitPct = (profitUSDC / TRADE_USDC) * 100;

    const decision = shouldSend(st, profitPct);
    st.lastAnyAt = nowSec();
    writeState(state);

    if (!decision.ok) {
      console.log(`[${token.symbol}] no send: ${decision.reason} profit=${profitPct}`);
      continue;
    }

    const tokenOutHuman = Number(buy.tokenOut.toString()) / Math.pow(10, token.decimals);
    const usdcOutHuman = Number(best.usdcOut.toString()) / 1e6;

    const msg =
`🔥 <b>ARBITRAGE SIGNAL</b> (${token.symbol}/USDC) <b>[Polygon]</b>

Trade size: <b>$${fmt(TRADE_USDC, 0)}</b>

Buy: <b><a href="${sushiSwapLink(token.address)}">Sushi</a></b> (USDC → ${token.symbol})
Sell: <b><a href="${best.link}">${best.venue}</a></b> (${token.symbol} → USDC) ${best.extra ? `<i>${best.extra}</i>` : ""}

Buy output: <b>${fmt(tokenOutHuman, 6)} ${token.symbol}</b>
Sell output: <b>${fmt(usdcOutHuman, 2)} USDC</b>

Profit: <b>+${fmt(profitUSDC, 2)} USDC</b> (<b>+${fmt(profitPct, 2)}%</b>)`;

    try {
      await tgSendHTML(msg);

      st.lastSentAt = nowSec();
      st.lastSentProfit = profitPct;
      st.lastSentProfitUSDC = profitUSDC;
      st.lastVenue = best.venue;

      writeState(state);

      console.log(`[${token.symbol}] SENT (${decision.reason}) profit=${profitPct}`);
    } catch (e) {
      console.error("TELEGRAM ERROR:", e?.response?.data || e?.message || e);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
