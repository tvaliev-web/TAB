// bot.js (CommonJS)
// Polygon arb notifier:
// BUY = Sushi (USDC -> COIN) via router getAmountsOut
// SELL = Uniswap V3 QuoterV2 + Odos quote (COIN -> USDC)
// Message shows comparison for $100 / $1000 / $3000 with 🟢🟠🔴 per SELL option (Uniswap vs Odos) on each line.
// Profit is AFTER slippage haircut + gas estimate (both applied in USDC base units).
// Alerts only when BEST net profit (across sizes + venues) >= MIN_PROFIT_PCT,
// and re-alerts only when it grows by PROFIT_STEP_PCT (state.json + cooldown).
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
  .filter(Boolean)
  // keep only numeric ids (prevents "chat not found" from @username or garbage)
  .filter((s) => /^-?\d+$/.test(s));

if (!CHAT_IDS.length) throw new Error("CHAT_ID parsed empty (must be numeric chat id)");

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

// “Execution window”
const QUOTE_TTL_SEC = Number(process.env.QUOTE_TTL_SEC || 120);

// IMPORTANT: Profit is “after gas + slippage”
// Slippage haircut on SELL proceeds (both Uni + Odos), in percent:
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.30); // 0.30% default
// Gas estimate per 1 full cycle (buy + sell), in USDC:
const GAS_USDC_CYCLE = Number(process.env.GAS_USDC_CYCLE || 0.25);

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
  // IMPORTANT: one bad chat id should NOT break others
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
// Telegram HTML breaks if href has raw "&" or quotes
function safeHref(url) {
  return String(url).replace(/&/g, "&amp;").replace(/"/g, "%22");
}
function linkA(text, url) {
  return `<a href="${safeHref(url)}">${escapeHtml(text)}</a>`;
}

// ---------- LINKS (clickable names, not raw URLs) ----------
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
    // Odos needs a userAddr but quote is not wallet-specific for read-only.
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

// ---------- PROFIT (AFTER SLIPPAGE + GAS) - ALL IN BASE UNITS ----------
const USDC_DEC = TOKENS.USDC.decimals;

function slippageBps() {
  // 0.30% => 30 bps
  return Math.max(0, Math.round(SLIPPAGE_PCT * 100));
}

function applySlippageBase(usdcOutBase) {
  // out * (10000 - bps) / 10000
  const bps = slippageBps();
  const keep = 10000 - bps;
  return (usdcOutBase * BigInt(keep)) / 10000n;
}

function subtractGasBase(usdcOutBase) {
  const gasBase = ethers.parseUnits(String(GAS_USDC_CYCLE), USDC_DEC);
  return usdcOutBase > gasBase ? usdcOutBase - gasBase : 0n;
}

function netProfitPct(usdcInDollars, usdcOutBaseAfterCosts) {
  const usdcInBase = ethers.parseUnits(String(usdcInDollars), USDC_DEC);
  const diff = usdcOutBaseAfterCosts - usdcInBase;
  // safe here for 100/1000/3000 (fits)
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

// ---------- EMOJI FOR EACH SIZE/OPTION (YOUR EXACT RULES) ----------
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
function buildSignalMessage({
  sym,
  buyHref,
  sellHrefUni,
  sellHrefOdos,
  perSizeLines,
  windowText
}) {
  return [
    `🔥 <b>ARBITRAGE SIGNAL — ${escapeHtml(sym)} / USDC</b>`,
    "",
    `Buy: ${buyHref}`,
    `Sell (Uniswap): ${sellHrefUni}`,
    `Sell (Odos): ${sellHrefOdos}`,
    "",
    `💰 <b>Profit (after gas + slippage)</b>`,
    ...perSizeLines,
    "",
    `⏱ <b>Execution window:</b> ${escapeHtml(windowText)}`,
    "",
    `🟢 ≥ 1.50%`,
    `🟠 1.30–1.49%`,
    `🔴 1.00–1.29%`,
    `❌ <1.00% / n/a`
  ].join("\n");
}

// ---------- COMPUTE NET PROFIT FOR ONE VENUE ----------
function computeNetPctForVenue(usdcIn, usdcOutBase) {
  if (!usdcOutBase) return { pct: NaN };
  let net = applySlippageBase(usdcOutBase);
  net = subtractGasBase(net);
  const p = netProfitPct(usdcIn, net);
  return { pct: p };
}

// ---------- DEMO (SAME FINAL FORMAT) ----------
async function sendDemoSignalForSym(provider, sym) {
  const t = TOKENS[sym];

  const buyHref = linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, t.addr));
  const sellHrefUni = linkA("Uniswap", uniswapLink(t.addr, TOKENS.USDC.addr));
  const sellHrefOdos = linkA("Odos", odosLink(t.addr, TOKENS.USDC.addr));

  const perSizeLines = [];

  for (const size of SIZES) {
    try {
      const tokenOut = await quoteSushi_USDC_to_TOKEN(provider, t.addr, size);

      const uniBest = await quoteUniV3_TOKEN_to_USDC_best(provider, t.addr, tokenOut);
      const uniOut = uniBest ? uniBest.amountOut : null;

      const odosOut = await quoteOdos_TOKEN_to_USDC(t.addr, tokenOut);

      const uni = uniOut ? computeNetPctForVenue(size, uniOut) : { pct: NaN };
      const od = odosOut ? computeNetPctForVenue(size, odosOut) : { pct: NaN };

      const uniText = Number.isFinite(uni.pct)
        ? `${emojiForPct(uni.pct)} Uniswap <b>${uni.pct >= 0 ? "+" : ""}${pct(uni.pct, 2)}%</b>`
        : `❌ Uniswap <b>n/a</b>`;

      const odText = Number.isFinite(od.pct)
        ? `${emojiForPct(od.pct)} Odos <b>${od.pct >= 0 ? "+" : ""}${pct(od.pct, 2)}%</b>`
        : `❌ Odos <b>n/a</b>`;

      perSizeLines.push(`<b>$${size}</b> → ${uniText} | ${odText}`);
    } catch (e) {
      console.error("DEMO QUOTE ERROR:", sym, size, e?.response?.status, e?.message || e);
      perSizeLines.push(`<b>$${size}</b> → ❌ Uniswap <b>n/a</b> | ❌ Odos <b>n/a</b>`);
    }
  }

  const msg = buildSignalMessage({
    sym,
    buyHref,
    sellHrefUni,
    sellHrefOdos,
    perSizeLines,
    windowText: "2–5 minutes"
  });

  await tgBroadcast(msg);
}

// ---------- MAIN ----------
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // HARD sanity check: if your RPC is NOT Polygon, your quotes will be trash
  try {
    const net = await provider.getNetwork();
    const rpcChain = Number(net.chainId);
    if (rpcChain !== CHAIN_ID) {
      console.error(`RPC CHAIN_ID MISMATCH: RPC=${rpcChain} EXPECTED=${CHAIN_ID} (fix RPC_URL)`);
      return;
    }
  } catch (e) {
    console.error("NETWORK CHECK FAILED:", e?.message || e);
    // continue anyway
  }

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

    // links
    const buyHref = linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, t.addr));
    const sellHrefUni = linkA("Uniswap", uniswapLink(t.addr, TOKENS.USDC.addr));
    const sellHrefOdos = linkA("Odos", odosLink(t.addr, TOKENS.USDC.addr));

    const perSizeLines = [];

    let bestAcrossAll = -999;

    for (const size of SIZES) {
      const sizeKey = `polygon:${sym}:USDC:${size}`;
      state.pairs[sizeKey] = state.pairs[sizeKey] || {};

      try {
        const tokenOut = await quoteSushi_USDC_to_TOKEN(provider, t.addr, size);

        const uniBest = await quoteUniV3_TOKEN_to_USDC_best(provider, t.addr, tokenOut);
        const uniOut = uniBest ? uniBest.amountOut : null;

        const odosOut = await quoteOdos_TOKEN_to_USDC(t.addr, tokenOut);

        const uni = uniOut ? computeNetPctForVenue(size, uniOut) : { pct: NaN };
        const od = odosOut ? computeNetPctForVenue(size, odosOut) : { pct: NaN };

        // track best across venues + sizes
        if (Number.isFinite(uni.pct) && uni.pct > bestAcrossAll) bestAcrossAll = uni.pct;
        if (Number.isFinite(od.pct) && od.pct > bestAcrossAll) bestAcrossAll = od.pct;

        // save samples (use BEST of the two for volatility estimate)
        const bestThisSize = Math.max(
          Number.isFinite(uni.pct) ? uni.pct : -999,
          Number.isFinite(od.pct) ? od.pct : -999
        );
        if (bestThisSize > -900) pushSample(state.pairs[sizeKey], bestThisSize);

        const uniText = Number.isFinite(uni.pct)
          ? `${emojiForPct(uni.pct)} Uniswap <b>${uni.pct >= 0 ? "+" : ""}${pct(uni.pct, 2)}%</b>`
          : `❌ Uniswap <b>n/a</b>`;

        const odText = Number.isFinite(od.pct)
          ? `${emojiForPct(od.pct)} Odos <b>${od.pct >= 0 ? "+" : ""}${pct(od.pct, 2)}%</b>`
          : `❌ Odos <b>n/a</b>`;

        perSizeLines.push(`<b>$${size}</b> → ${uniText} | ${odText}`);
      } catch (e) {
        console.error(sym, "QUOTE ERROR:", size, e?.response?.status, e?.message || e);
        perSizeLines.push(`<b>$${size}</b> → ❌ Uniswap <b>n/a</b> | ❌ Odos <b>n/a</b>`);
      }
    }

    // decision based on BEST net profit across sizes+venues
    const decision = shouldSend(state.pairs[primaryKey], bestAcrossAll);
    if (!decision.ok) {
      writeState(state);
      continue;
    }

    const windowText = estimateWindowText(state.pairs[primaryKey]);

    const msg = buildSignalMessage({
      sym,
      buyHref,
      sellHrefUni,
      sellHrefOdos,
      perSizeLines,
      windowText
    });

    try {
      await tgBroadcast(msg);

      const ts = nowSec();
      state.pairs[primaryKey].lastSentAt = ts;
      state.pairs[primaryKey].lastSentProfit = bestAcrossAll;
      state.meta.lastAnySentAt = ts;

      writeState(state);
    } catch (e) {
      console.error("TELEGRAM ERROR:", e?.response?.data || e?.message || e);
    }
  }
}

// never fail Actions
main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
