// bot.js (CommonJS)
// Polygon arb notifier:
// BUY = Sushi (USDC -> COIN) via router getAmountsOut
// SELL = show BOTH (Uniswap V3 QuoterV2, Odos quote) (COIN -> USDC)
// Message shows comparison for $100 / $1000 / $3000 with 🟢🟠🔴 for EACH venue.
// Alert triggers when BEST net profit (any size, any venue) >= MIN_PROFIT_PCT.
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

const CHAT_IDS = String(CHAT_ID_RAW).split(",").map((s) => s.trim()).filter(Boolean);
if (!CHAT_IDS.length) throw new Error("CHAT_ID parsed empty");

// ---------- CONFIG ----------
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);
const SIZES = String(process.env.SIZES || "100,1000,3000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);

const QUOTE_TTL_SEC = Number(process.env.QUOTE_TTL_SEC || 120);

// IMPORTANT COST MODEL:
// - Uniswap quote is “ideal output”; we apply SLIPPAGE_PCT haircut to be conservative.
// - Odos outAmounts is already the expected received output from their quote; DO NOT haircut again.
// - Gas is paid separately (MATIC), so if you want “after gas” you subtract GAS_USDC_CYCLE from BOTH.
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.30);     // only used for Uniswap
const GAS_USDC_CYCLE = Number(process.env.GAS_USDC_CYCLE || 0.25);  // apply to both (optional; tune)

const SEND_DEMO_ON_MANUAL = String(process.env.SEND_DEMO_ON_MANUAL || "1") === "1";

// Tokens (Polygon)
const TOKENS = {
  USDC: { symbol: "USDC", addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  LINK: { symbol: "LINK", addr: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
  WMATIC: { symbol: "WMATIC", addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  AAVE: { symbol: "AAVE", addr: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18 }
};

const WATCH = ["LINK", "WMATIC", "AAVE"];

// SushiSwap Router (Polygon)
const SUSHI_ROUTER = (process.env.SUSHI_ROUTER || "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506").toLowerCase();

// Uniswap V3 QuoterV2 (Polygon)
const UNI_QUOTER_V2 = (process.env.UNI_QUOTER_V2 || "0x61fFE014bA17989E743c5F6cB21bF9697530B21e").toLowerCase();

const UNI_FEES = (process.env.UNI_FEES || "500,3000,10000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

const ODOS_QUOTE_V3 = "https://api.odos.xyz/sor/quote/v3";
const ODOS_QUOTE_V2 = "https://api.odos.xyz/sor/quote/v2";

// ---------- STATE ----------
const STATE_PATH = path.join(__dirname, "state.json");
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { pairs: {}, meta: {} }; }
}
function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function nowSec() { return Math.floor(Date.now() / 1000); }

// ---------- TELEGRAM ----------
async function tgSendTo(chatId, html) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true
  }, { timeout: 20000 });
}
async function tgBroadcast(html) {
  for (const id of CHAT_IDS) await tgSendTo(id, html);
}

// ---------- LINKS (Telegram HTML safe) ----------
function safeHref(url) {
  return String(url).replace(/&/g, "&amp;").replace(/"/g, "%22");
}
function linkA(text, url) {
  return `<a href="${safeHref(url)}">${text}</a>`;
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

async function quoteSushi_USDC_to_TOKEN(provider, tokenAddr, usdcAmount) {
  const router = new ethers.Contract(SUSHI_ROUTER, sushiRouterAbi, provider);
  const amountIn = ethers.parseUnits(String(usdcAmount), TOKENS.USDC.decimals);
  const amounts = await router.getAmountsOut(amountIn, [TOKENS.USDC.addr, tokenAddr]);
  return amounts[amounts.length - 1];
}

async function quoteUniV3_TOKEN_to_USDC_best(provider, tokenAddr, tokenAmountIn) {
  const q = new ethers.Contract(UNI_QUOTER_V2, uniQuoterV2Abi, provider);
  let best = null;
  for (const fee of UNI_FEES) {
    try {
      const params = { tokenIn: tokenAddr, tokenOut: TOKENS.USDC.addr, amountIn: tokenAmountIn, fee, sqrtPriceLimitX96: 0 };
      const res = await q.quoteExactInputSingle(params);
      const amountOut = res[0];
      if (!best || amountOut > best.amountOut) best = { amountOut, fee };
    } catch (_) {}
  }
  return best;
}

async function quoteOdos_TOKEN_to_USDC(tokenAddr, tokenAmountIn) {
  const body = {
    chainId: CHAIN_ID,
    inputTokens: [{ tokenAddress: tokenAddr, amount: tokenAmountIn.toString() }],
    outputTokens: [{ tokenAddress: TOKENS.USDC.addr, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000001",
    disableRFQs: true,
    compact: true
  };

  let res;
  try {
    res = await axios.post(ODOS_QUOTE_V3, body, { timeout: 25000 });
  } catch (e) {
    if (e?.response?.status === 404) res = await axios.post(ODOS_QUOTE_V2, body, { timeout: 25000 });
    else throw e;
  }

  const out = res?.data?.outAmounts?.[0];
  if (!out) throw new Error("Odos quote missing outAmounts");
  return BigInt(out); // USDC base units (6 decimals)
}

// ---------- COST / PROFIT ----------
function haircutUniswap(usdcOutBase) {
  // only Uniswap gets conservative slippage haircut
  const factor = 1 - SLIPPAGE_PCT / 100;
  const outHuman = Number(ethers.formatUnits(usdcOutBase, TOKENS.USDC.decimals)) * factor;
  return ethers.parseUnits(outHuman.toFixed(TOKENS.USDC.decimals), TOKENS.USDC.decimals);
}

function subtractGas(usdcOutBase) {
  const gasBase = ethers.parseUnits(String(GAS_USDC_CYCLE), TOKENS.USDC.decimals);
  return usdcOutBase > gasBase ? (usdcOutBase - gasBase) : 0n;
}

function profitPct(sizeUsd, usdcOutBase) {
  const inBase = ethers.parseUnits(String(sizeUsd), TOKENS.USDC.decimals);
  const diff = usdcOutBase - inBase;
  return (Number(diff) / Number(inBase)) * 100;
}

// ---------- YOUR EMOJIS ----------
function emojiForPct(p) {
  if (!Number.isFinite(p)) return "❌";
  if (p >= 1.5) return "🟢";
  if (p >= 1.3) return "🟠";
  if (p >= 1.0) return "🔴";
  return "❌";
}

// ---------- ALERT RULES ----------
function shouldSend(statePair, bestPct) {
  const now = nowSec();
  const lastSentAt = statePair?.lastSentAt || 0;
  const lastSentProfit = statePair?.lastSentProfit ?? -999;

  if (bestPct < MIN_PROFIT_PCT) return { ok: false, reason: "below_min" };

  const since = now - lastSentAt;
  const growth = bestPct - lastSentProfit;

  if (growth >= BIG_JUMP_BYPASS) return { ok: true, reason: "big_jump" };
  if (since < COOLDOWN_SEC) return { ok: false, reason: "cooldown" };
  if (growth < PROFIT_STEP_PCT) return { ok: false, reason: "no_growth" };

  return { ok: true, reason: "growth" };
}

// ---------- MESSAGE ----------
function estimateWindowText() {
  if (QUOTE_TTL_SEC >= 240) return "2–6 minutes";
  if (QUOTE_TTL_SEC >= 120) return "1–4 minutes";
  return "~1–2 minutes";
}

function lineForSize(size, uniPct, odosPct) {
  const uniEm = emojiForPct(uniPct);
  const odosEm = emojiForPct(odosPct);

  const u = Number.isFinite(uniPct) ? `${uniPct >= 0 ? "+" : ""}${uniPct.toFixed(2)}%` : "n/a";
  const o = Number.isFinite(odosPct) ? `${odosPct >= 0 ? "+" : ""}${odosPct.toFixed(2)}%` : "n/a";

  return `<b>$${size}</b> → ${uniEm} <b>Uniswap</b> ${u} | ${odosEm} <b>Odos</b> ${o}`;
}

function buildMsg(sym, buyA, uniA, odosA, lines, windowText) {
  return [
    `🔥 <b>ARBITRAGE SIGNAL — ${sym} / USDC</b>`,
    "",
    `Buy: ${buyA}`,
    `Sell: ${uniA}  |  ${odosA}`,
    "",
    `💰 <b>Profit (after gas + slippage)</b>`,
    ...lines,
    "",
    `⏱ <b>Execution window:</b> ${windowText}`,
    "",
    `🟢 ≥ 1.50%   🟠 1.30–1.49%   🔴 1.00–1.29%   ❌ < 1.00%`
  ].join("\n");
}

// ---------- MAIN ----------
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || {};

  const eventName = process.env.GITHUB_EVENT_NAME || "";

  // (Optional) DEMO: runs REAL quotes so you can sanity check numbers
  if (eventName === "workflow_dispatch" && SEND_DEMO_ON_MANUAL) {
    try {
      const sym = "LINK";
      const t = TOKENS[sym];
      const buyA = linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, t.addr));
      const uniA = linkA("Uniswap", uniswapLink(t.addr, TOKENS.USDC.addr));
      const odosA = linkA("Odos", odosLink(t.addr, TOKENS.USDC.addr));

      const lines = [];
      for (const size of SIZES) {
        const tokenOut = await quoteSushi_USDC_to_TOKEN(provider, t.addr, size);

        const uniBest = await quoteUniV3_TOKEN_to_USDC_best(provider, t.addr, tokenOut);
        const uniRaw = uniBest ? uniBest.amountOut : null;
        const odosRaw = await quoteOdos_TOKEN_to_USDC(t.addr, tokenOut);

        // Uni net: haircut + gas
        let uniNetPct = NaN;
        if (uniRaw) {
          let uniNet = haircutUniswap(uniRaw);
          uniNet = subtractGas(uniNet);
          uniNetPct = profitPct(size, uniNet);
        }

        // Odos net: DO NOT haircut again, only gas
        let odosNet = subtractGas(odosRaw);
        const odosNetPct = profitPct(size, odosNet);

        lines.push(lineForSize(size, uniNetPct, odosNetPct));
      }

      const msg = buildMsg(sym, buyA, uniA, odosA, lines, "2–5 minutes");
      await tgBroadcast(msg);
    } catch (e) {
      console.error("DEMO ERROR:", e?.response?.status, e?.response?.data || e?.message || e);
    }
  }

  for (const sym of WATCH) {
    const t = TOKENS[sym];
    if (!t) continue;

    const primaryKey = `polygon:${sym}:USDC:1000`;
    state.pairs[primaryKey] = state.pairs[primaryKey] || {};

    let bestPctSeen = -999;

    const buyA = linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, t.addr));
    const uniA = linkA("Uniswap", uniswapLink(t.addr, TOKENS.USDC.addr));
    const odosA = linkA("Odos", odosLink(t.addr, TOKENS.USDC.addr));

    const lines = [];

    for (const size of SIZES) {
      try {
        const tokenOut = await quoteSushi_USDC_to_TOKEN(provider, t.addr, size);

        const uniBest = await quoteUniV3_TOKEN_to_USDC_best(provider, t.addr, tokenOut);
        const uniRaw = uniBest ? uniBest.amountOut : null;

        const odosRaw = await quoteOdos_TOKEN_to_USDC(t.addr, tokenOut);

        // Uni net: haircut + gas
        let uniNetPct = NaN;
        if (uniRaw) {
          let uniNet = haircutUniswap(uniRaw);
          uniNet = subtractGas(uniNet);
          uniNetPct = profitPct(size, uniNet);
          if (uniNetPct > bestPctSeen) bestPctSeen = uniNetPct;
        }

        // Odos net: DO NOT haircut again, only gas
        const odosNet = subtractGas(odosRaw);
        const odosNetPct = profitPct(size, odosNet);
        if (odosNetPct > bestPctSeen) bestPctSeen = odosNetPct;

        lines.push(lineForSize(size, uniNetPct, odosNetPct));
      } catch (e) {
        console.error(sym, "QUOTE ERROR:", e?.response?.status, e?.message || e);
        lines.push(`<b>$${size}</b> → ❌ Uniswap n/a | ❌ Odos n/a`);
      }
    }

    const decision = shouldSend(state.pairs[primaryKey], bestPctSeen);
    if (!decision.ok) {
      writeState(state);
      continue;
    }

    const msg = buildMsg(sym, buyA, uniA, odosA, lines, estimateWindowText());

    try {
      await tgBroadcast(msg);

      const ts = nowSec();
      state.pairs[primaryKey].lastSentAt = ts;
      state.pairs[primaryKey].lastSentProfit = bestPctSeen;
      state.meta.lastAnySentAt = ts;

      writeState(state);
    } catch (e) {
      console.error("TELEGRAM ERROR:", e?.response?.data || e?.message || e);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
