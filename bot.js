// bot.js (CommonJS)
// Polygon arb notifier:
// BUY = Sushi (USDC -> COIN) via router getAmountsOut
// SELL = best of (Uniswap V3 QuoterV2, Odos quote) (COIN -> USDC)
// Message shows comparison for $100 / $1000 / $3000 with 🟢🟠🔴 on each line.
// Alerts only when BEST net profit >= MIN_PROFIT_PCT, and re-alerts only when it grows by PROFIT_STEP_PCT (state.json + cooldown).
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

// We always compare these sizes in the message:
const SIZES = String(process.env.SIZES || "100,1000,3000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

// Signal tuning
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);

// “Execution window” text (we compute a smarter range, but you can keep this as default)
const QUOTE_TTL_SEC = Number(process.env.QUOTE_TTL_SEC || 120);

// IMPORTANT: We apply slippage + gas to make profit “after gas + slippage”.
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.30); // 0.30% default
const GAS_USDC_CYCLE = Number(process.env.GAS_USDC_CYCLE || 0.25); // tune if needed

// Demo behavior: send ONE demo signal message on manual run
const SEND_DEMO_ON_MANUAL = String(process.env.SEND_DEMO_ON_MANUAL || "1") === "1";

// Tokens (Polygon)
const TOKENS = {
  USDC: { symbol: "USDC", addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  LINK: { symbol: "LINK", addr: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
  WMATIC: { symbol: "WMATIC", addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  AAVE: { symbol: "AAVE", addr: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18 }
};

// Track these coins
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

// Odos quote endpoint (v3 then fallback to v2)
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
// FIX: Telegram HTML breaks if href has raw "&"
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
  const amountIn = ethers.parseUnits(String(usdcAmount), TOKENS.USDC.decimals); // bigint
  const pathArr = [TOKENS.USDC.addr, tokenAddr];
  const amounts = await router.getAmountsOut(amountIn, pathArr);
  return amounts[amounts.length - 1]; // bigint tokenOut
}

async function quoteUniV3_TOKEN_to_USDC_best(provider, tokenAddr, tokenAmountIn) {
  const q = new ethers.Contract(UNI_QUOTER_V2, uniQuoterV2Abi, provider);
  let best = null;

  for (const fee of UNI_FEES) {
    try {
      const params = {
        tokenIn: tokenAddr,
        tokenOut: TOKENS.USDC.addr,
        amountIn: tokenAmountIn,
        fee,
        sqrtPriceLimitX96: 0
      };
      const res = await q.quoteExactInputSingle(params);
      const amountOut = res[0]; // bigint
      if (!best || amountOut > best.amountOut) best = { amountOut, fee };
    } catch (_) {}
  }

  return best; // {amountOut, fee} or null
}

async function quoteOdos_TOKEN_to_USDC(tokenAddr, tokenAmountIn) {
  const body = {
    chainId: CHAIN_ID,
    inputTokens: [{ tokenAddress: tokenAddr, amount: tokenAmountIn.toString() }],
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
  return BigInt(out); // USDC out (base units)
}

// ---------- PROFIT (AFTER SLIPPAGE + GAS) ----------
function applySlippage(usdcOutBase) {
  const factor = 1 - SLIPPAGE_PCT / 100;
  const outHuman = Number(ethers.formatUnits(usdcOutBase, TOKENS.USDC.decimals)) * factor;
  return ethers.parseUnits(outHuman.toFixed(TOKENS.USDC.decimals), TOKENS.USDC.decimals);
}

function subtractGas(usdcOutBase) {
  const gasBase = ethers.parseUnits(GAS_USDC_CYCLE.toString(), TOKENS.USDC.decimals);
  return usdcOutBase > gasBase ? (usdcOutBase - gasBase) : 0n;
}

function netProfitPct(usdcInDollars, usdcOutBase) {
  const usdcInBase = ethers.parseUnits(String(usdcInDollars), TOKENS.USDC.decimals);
  const diff = usdcOutBase - usdcInBase;
  return (Number(diff) / Number(usdcInBase)) * 100;
}

// ---------- SIGNAL RULES ----------
function shouldSend(statePair, profitPctVal) {
  const now = nowSec();
  const lastSentAt = statePair?.lastSentAt || 0;
  const lastSentProfit = statePair?.lastSentProfit ?? -999;

  if (profitPctVal < MIN_PROFIT_PCT) return { ok: false, reason: "below_min" };

  const since = now - lastSentAt;
  const growth = profitPctVal - lastSentProfit;

  if (growth >= BIG_JUMP_BYPASS) return { ok: true, reason: "big_jump" };
  if (since < COOLDOWN_SEC) return { ok: false, reason: "cooldown" };
  if (growth < PROFIT_STEP_PCT) return { ok: false, reason: "no_growth" };

  return { ok: true, reason: "growth" };
}

// ---------- EMOJI FOR EACH SIZE LINE (YOUR EXACT RULES) ----------
function emojiForPct(p) {
  if (!Number.isFinite(p)) return "❌";
  if (p >= 1.5) return "🟢";
  if (p >= 1.3) return "🟠";
  if (p >= 1.0) return "🔴";
  return "❌";
}

// ---------- EXECUTION WINDOW ----------
function estimateWindowText(statePair) {
  const s = Array.isArray(statePair?.samples) ? statePair.samples : [];
  if (s.length >= 2) {
    const a = s[s.length - 1].p;
    const b = s[s.length - 2].p;
    const delta = Math.abs(a - b);
    if (delta < 0.20) return "2–6 minutes";
    if (delta < 0.50) return "1–4 minutes";
    return "30–120 seconds";
  }
  if (QUOTE_TTL_SEC >= 240) return "2–6 minutes";
  if (QUOTE_TTL_SEC >= 120) return "1–4 minutes";
  return "~1–2 minutes";
}

function pushSample(statePair, profitPctVal) {
  statePair.samples = Array.isArray(statePair.samples) ? statePair.samples : [];
  statePair.samples.push({ t: nowSec(), p: profitPctVal });
  if (statePair.samples.length > 30) statePair.samples = statePair.samples.slice(-30);
  statePair.lastAnyAt = nowSec();
}

// ---------- MESSAGE BUILDER (YOUR FORMAT) ----------
function buildSignalMessage({ sym, buyHref, sellHref, perSizeLines, windowText }) {
  return [
    `🔥 <b>ARBITRAGE SIGNAL — ${sym} / USDC</b>`,
    "",
    `Buy: ${buyHref}`,
    `Sell: ${sellHref}`,
    "",
    `💰 <b>Profit (after gas + slippage)</b>`,
    ...perSizeLines,
    "",
    `⏱ <b>Execution window:</b> ${windowText}`,
    "",
    `🟢 ≥ 1.50%`,
    `🟠 1.30–1.49%`,
    `🔴 1.00–1.29%`
  ].join("\n");
}

// ---------- DEMO ----------
async function sendDemoSignalForSym(provider, sym) {
  const t = TOKENS[sym];

  const buyHref = linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, t.addr));

  const results = [];
  for (const size of SIZES) {
    const tokenOut = await quoteSushi_USDC_to_TOKEN(provider, t.addr, size);

    const uniBest = await quoteUniV3_TOKEN_to_USDC_best(provider, t.addr, tokenOut);
    const uniOut = uniBest ? uniBest.amountOut : null;

    const odosOut = await quoteOdos_TOKEN_to_USDC(t.addr, tokenOut);

    let bestOut = null;
    let bestName = null;
    if (uniOut && (!bestOut || uniOut > bestOut)) { bestOut = uniOut; bestName = "Uniswap"; }
    if (odosOut && (!bestOut || odosOut > bestOut)) { bestOut = odosOut; bestName = "Odos"; }

    if (!bestOut || !bestName) {
      results.push({ size, pct: NaN, bestName: "?" });
      continue;
    }

    let netOut = applySlippage(bestOut);
    netOut = subtractGas(netOut);

    const p = netProfitPct(size, netOut);
    results.push({ size, pct: p, bestName });
  }

  // choose sell venue based on $1000 row if exists, else first
  const pick = results.find((r) => r.size === 1000) || results[0];
  const sellHref =
    pick?.bestName === "Odos"
      ? linkA("Odos", odosLink(t.addr, TOKENS.USDC.addr))
      : linkA("Uniswap", uniswapLink(t.addr, TOKENS.USDC.addr));

  const perSizeLines = results.map((r) => {
    const em = emojiForPct(r.pct);
    const val = Number.isFinite(r.pct) ? `${r.pct >= 0 ? "+" : ""}${pct(r.pct, 2)}%` : "n/a";
    return `${em} <b>$${r.size}</b> → <b>${val}</b>`;
  });

  const windowText = "2–5 minutes";

  const msg = buildSignalMessage({
    sym,
    buyHref,
    sellHref,
    perSizeLines,
    windowText
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

  if (eventName === "workflow_dispatch" && SEND_DEMO_ON_MANUAL) {
    try {
      await sendDemoSignalForSym(provider, "LINK");
    } catch (e) {
      console.error("DEMO ERROR:", e?.response?.status, e?.response?.data || e?.message || e);
    }
  }

  for (const sym of WATCH) {
    const t = TOKENS[sym];
    if (!t) continue;

    const primarySize = 1000;
    const primaryKey = `polygon:${sym}:USDC:${primarySize}`;
    state.pairs[primaryKey] = state.pairs[primaryKey] || {};

    let bestAcrossSizes = -999;
    let bestSellName = null;

    const perSizeLines = [];

    for (const size of SIZES) {
      const sizeKey = `polygon:${sym}:USDC:${size}`;
      state.pairs[sizeKey] = state.pairs[sizeKey] || {};

      let tokenOut, uniBest, uniOut, odosOut;
      try {
        tokenOut = await quoteSushi_USDC_to_TOKEN(provider, t.addr, size);

        uniBest = await quoteUniV3_TOKEN_to_USDC_best(provider, t.addr, tokenOut);
        uniOut = uniBest ? uniBest.amountOut : null;

        odosOut = await quoteOdos_TOKEN_to_USDC(t.addr, tokenOut);
      } catch (e) {
        console.error(sym, "QUOTE ERROR:", e?.response?.status, e?.message || e);
        perSizeLines.push(`❌ <b>$${size}</b> → <b>n/a</b>`);
        continue;
      }

      let bestOut = null;
      let sellName = null;
      if (uniOut && (!bestOut || uniOut > bestOut)) { bestOut = uniOut; sellName = "Uniswap"; }
      if (odosOut && (!bestOut || odosOut > bestOut)) { bestOut = odosOut; sellName = "Odos"; }

      if (!bestOut || !sellName) {
        perSizeLines.push(`❌ <b>$${size}</b> → <b>n/a</b>`);
        continue;
      }

      let netOut = applySlippage(bestOut);
      netOut = subtractGas(netOut);

      const p = netProfitPct(size, netOut);

      pushSample(state.pairs[sizeKey], p);

      const em = emojiForPct(p);
      perSizeLines.push(`${em} <b>$${size}</b> → <b>${p >= 0 ? "+" : ""}${pct(p, 2)}%</b>`);

      if (p > bestAcrossSizes) {
        bestAcrossSizes = p;
        bestSellName = sellName;
      }
    }

    const decision = shouldSend(state.pairs[primaryKey], bestAcrossSizes);
    if (!decision.ok) {
      writeState(state);
      continue;
    }

    const buyHref = linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, t.addr));
    const sellHref =
      (bestSellName === "Odos")
        ? linkA("Odos", odosLink(t.addr, TOKENS.USDC.addr))
        : linkA("Uniswap", uniswapLink(t.addr, TOKENS.USDC.addr));

    const windowText = estimateWindowText(state.pairs[primaryKey]);

    const msg = buildSignalMessage({
      sym,
      buyHref,
      sellHref,
      perSizeLines,
      windowText
    });

    try {
      await tgBroadcast(msg);

      const ts = nowSec();
      state.pairs[primaryKey].lastSentAt = ts;
      state.pairs[primaryKey].lastSentProfit = bestAcrossSizes;
      state.pairs[primaryKey].lastVenue = bestSellName || "Uniswap";
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
