// bot.js (CommonJS)
// Polygon arb notifier (Telegram)
// BUY  = Sushi (USDC -> COIN) via router getAmountsOut
// SELL = Uniswap V3 QuoterV2 and Odos quote (COIN -> USDC)
//
// Message format (PLAIN TEXT, no parse_mode):
// - Buy link (SushiSwap)
// - Sell links (Uniswap + Odos) ALWAYS shown
// - Comparison for $100 / $1000 / $3000
//   Each size line shows BOTH venues: Uni +pct +emoji, Odos +pct +emoji
//
// Emojis per your rules (after gas + slippage):
//   🟢 >= 1.50%
//   🟠 1.30–1.49%
//   🔴 1.00–1.29%
//   ❌ < 1.00% or n/a
//
// Alerts only when BEST net profit (across sizes + venues) >= MIN_PROFIT_PCT
// Re-alert only if profit grows by PROFIT_STEP_PCT, with COOLDOWN_SEC.
//
// CHAT_ID supports multiple IDs: "id1,id2,id3"

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");

// ---------- ENV ----------
const BOT_TOKEN =
  process.env.BOT_TOKEN || process.env.TG_TOKEN || process.env.tg_token;
const CHAT_ID_RAW =
  process.env.CHAT_ID || process.env.TG_CHAT_ID || process.env.tg_chat_id;
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

// Compare sizes in message:
const SIZES = String(process.env.SIZES || "100,1000,3000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

// Signal tuning
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);

// Execution window hint
const QUOTE_TTL_SEC = Number(process.env.QUOTE_TTL_SEC || 120);

// “After gas + slippage” knobs
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.30); // 0.30%
const GAS_USDC_CYCLE = Number(process.env.GAS_USDC_CYCLE || 0.25); // $0.25

// Demo behavior
const SEND_DEMO_ON_MANUAL =
  String(process.env.SEND_DEMO_ON_MANUAL || "1") === "1";

// Tokens (Polygon)
const TOKENS = {
  USDC: {
    symbol: "USDC",
    addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    decimals: 6
  },
  LINK: {
    symbol: "LINK",
    addr: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
    decimals: 18
  },
  WMATIC: {
    symbol: "WMATIC",
    addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    decimals: 18
  },
  AAVE: {
    symbol: "AAVE",
    addr: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
    decimals: 18
  }
};

// Track these coins
const WATCH = ["LINK", "WMATIC", "AAVE"];

// SushiSwap Router (Polygon)
const SUSHI_ROUTER = (
  process.env.SUSHI_ROUTER ||
  "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"
).toLowerCase();

// Uniswap V3 QuoterV2 (Polygon)
const UNI_QUOTER_V2 = (
  process.env.UNI_QUOTER_V2 ||
  "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"
).toLowerCase();

// Try fee tiers
const UNI_FEES = (process.env.UNI_FEES || "500,3000,10000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

// Odos quote endpoints
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

// ---------- TELEGRAM (PLAIN TEXT, NO parse_mode) ----------
async function tgSendTo(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(
    url,
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    },
    { timeout: 20000 }
  );
}

async function tgBroadcast(text) {
  for (const id of CHAT_IDS) {
    await tgSendTo(id, text);
  }
}

// ---------- LINKS ----------
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
  const pathArr = [TOKENS.USDC.addr, tokenAddr];
  const amounts = await router.getAmountsOut(amountIn, pathArr);
  return amounts[amounts.length - 1];
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
      const amountOut = res[0];
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
  return BigInt(out);
}

// ---------- PROFIT (AFTER SLIPPAGE + GAS) - BigInt only ----------
const SLIPPAGE_BPS = Math.max(0, Math.min(5000, Math.round(SLIPPAGE_PCT * 100))); // 0.30% => 30
const ONE_BPS = 10000n;

function applySlippage(usdcOutBase) {
  const factor = ONE_BPS - BigInt(SLIPPAGE_BPS);
  return (usdcOutBase * factor) / ONE_BPS;
}

function subtractGas(usdcOutBase) {
  const gasBase = ethers.parseUnits(
    Number(GAS_USDC_CYCLE).toFixed(TOKENS.USDC.decimals),
    TOKENS.USDC.decimals
  );
  return usdcOutBase > gasBase ? usdcOutBase - gasBase : 0n;
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

// ---------- EMOJI ----------
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
  return "1–2 minutes";
}

function pushSample(statePair, profitPctVal) {
  statePair.samples = Array.isArray(statePair.samples) ? statePair.samples : [];
  statePair.samples.push({ t: nowSec(), p: profitPctVal });
  if (statePair.samples.length > 30) statePair.samples = statePair.samples.slice(-30);
  statePair.lastAnyAt = nowSec();
}

// ---------- QUOTE BOTH VENUES FOR ONE SIZE ----------
async function quoteForSize(provider, token, sizeUsd) {
  const tokenOut = await quoteSushi_USDC_to_TOKEN(provider, token.addr, sizeUsd);

  const uniBest = await quoteUniV3_TOKEN_to_USDC_best(provider, token.addr, tokenOut);
  const uniOut = uniBest ? uniBest.amountOut : null;

  const odosOut = await quoteOdos_TOKEN_to_USDC(token.addr, tokenOut);

  let uniPct = NaN;
  let odosPct = NaN;

  if (uniOut) {
    let net = applySlippage(uniOut);
    net = subtractGas(net);
    uniPct = netProfitPct(sizeUsd, net);
  }

  if (odosOut) {
    let net = applySlippage(odosOut);
    net = subtractGas(net);
    odosPct = netProfitPct(sizeUsd, net);
  }

  return {
    sizeUsd,
    uni: { pct: uniPct, fee: uniBest?.fee ?? null },
    odos: { pct: odosPct }
  };
}

// ---------- MESSAGE BUILDER (PLAIN TEXT) ----------
function buildSignalMessage({
  sym,
  buyUrl,
  uniUrl,
  odosUrl,
  perSizeLines,
  windowText
}) {
  return [
    `🔥 ARBITRAGE SIGNAL — ${sym} / USDC`,
    "",
    `Buy (SushiSwap): ${buyUrl}`,
    `Sell (Uniswap): ${uniUrl}`,
    `Sell (Odos):    ${odosUrl}`,
    "",
    `💰 Profit (after gas + slippage)`,
    ...perSizeLines,
    "",
    `⏱ Execution window: ${windowText}`,
    "",
    `🟢 >= 1.50%`,
    `🟠 1.30–1.49%`,
    `🔴 1.00–1.29%`,
    `❌ < 1.00% / n/a`
  ].join("\n");
}

// ---------- DEMO ----------
async function sendDemoSignalForSym(provider, sym) {
  const t = TOKENS[sym];

  const buyUrl = sushiSwapLink(TOKENS.USDC.addr, t.addr);
  const uniUrl = uniswapLink(t.addr, TOKENS.USDC.addr);
  const odosUrl = odosLink(t.addr, TOKENS.USDC.addr);

  const rows = [];
  for (const size of SIZES) {
    try {
      const r = await quoteForSize(provider, t, size);

      const eu = emojiForPct(r.uni.pct);
      const eo = emojiForPct(r.odos.pct);

      const uniTxt = Number.isFinite(r.uni.pct)
        ? `${r.uni.pct >= 0 ? "+" : ""}${pct(r.uni.pct, 2)}%`
        : "n/a";

      const odosTxt = Number.isFinite(r.odos.pct)
        ? `${r.odos.pct >= 0 ? "+" : ""}${pct(r.odos.pct, 2)}%`
        : "n/a";

      rows.push(`$${size} → Uniswap ${eu} ${uniTxt}   |   Odos ${eo} ${odosTxt}`);
    } catch (_) {
      rows.push(`$${size} → Uniswap ❌ n/a   |   Odos ❌ n/a`);
    }
  }

  const msg = buildSignalMessage({
    sym,
    buyUrl,
    uniUrl,
    odosUrl,
    perSizeLines: rows,
    windowText: "2–5 minutes"
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

    const buyUrl = sushiSwapLink(TOKENS.USDC.addr, t.addr);
    const uniUrl = uniswapLink(t.addr, TOKENS.USDC.addr);
    const odosUrl = odosLink(t.addr, TOKENS.USDC.addr);

    const perSizeLines = [];
    let bestAcrossAll = -999;

    for (const size of SIZES) {
      const sizeKey = `polygon:${sym}:USDC:${size}`;
      state.pairs[sizeKey] = state.pairs[sizeKey] || {};

      try {
        const r = await quoteForSize(provider, t, size);

        const eu = emojiForPct(r.uni.pct);
        const eo = emojiForPct(r.odos.pct);

        const uniTxt = Number.isFinite(r.uni.pct)
          ? `${r.uni.pct >= 0 ? "+" : ""}${pct(r.uni.pct, 2)}%`
          : "n/a";

        const odosTxt = Number.isFinite(r.odos.pct)
          ? `${r.odos.pct >= 0 ? "+" : ""}${pct(r.odos.pct, 2)}%`
          : "n/a";

        perSizeLines.push(`$${size} → Uniswap ${eu} ${uniTxt}   |   Odos ${eo} ${odosTxt}`);

        const bestThisSize = Math.max(
          Number.isFinite(r.uni.pct) ? r.uni.pct : -999,
          Number.isFinite(r.odos.pct) ? r.odos.pct : -999
        );

        if (bestThisSize > -900) pushSample(state.pairs[sizeKey], bestThisSize);

        if (Number.isFinite(r.uni.pct)) bestAcrossAll = Math.max(bestAcrossAll, r.uni.pct);
        if (Number.isFinite(r.odos.pct)) bestAcrossAll = Math.max(bestAcrossAll, r.odos.pct);
      } catch (e) {
        console.error(sym, "QUOTE ERROR:", e?.response?.status, e?.message || e);
        perSizeLines.push(`$${size} → Uniswap ❌ n/a   |   Odos ❌ n/a`);
      }
    }

    const decision = shouldSend(state.pairs[primaryKey], bestAcrossAll);
    if (!decision.ok) {
      writeState(state);
      continue;
    }

    const windowText = estimateWindowText(state.pairs[primaryKey]);

    const msg = buildSignalMessage({
      sym,
      buyUrl,
      uniUrl,
      odosUrl,
      perSizeLines,
      windowText
    });

    try {
      await tgBroadcast(msg);

      const ts = nowSec();
      state.pairs[primaryKey].lastSentAt = ts;
      state.pairs[primaryKey].lastSentProfit = bestAcrossAll;
      state.pairs[primaryKey].lastVenue = "best_of_uni_odos";
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
