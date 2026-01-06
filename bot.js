// bot.js (CommonJS)
// Polygon arb notifier (3 venues):
// BUY  = best of Sushi (router getAmountsOut) / Uniswap V3 QuoterV2 / Odos quote  (USDC -> COIN)
// SELL = best of Sushi (router getAmountsOut) / Uniswap V3 QuoterV2 / Odos quote  (COIN -> USDC)
//
// Finds best BUY venue and best SELL venue (can be different), for each size.
// Profit is AFTER: buy-slippage haircut + sell-slippage haircut + gas (all in USDC base units).
//
// Alerts only when BEST net profit (across sizes + routes) >= MIN_PROFIT_PCT,
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
  .filter((s) => /^-?\d+$/.test(s));

if (!CHAT_IDS.length) throw new Error("CHAT_ID parsed empty (must be numeric chat id)");

// ---------- CONFIG ----------
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// sizes shown in message
const SIZES = String(process.env.SIZES || "100,1000,3000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

// Signal tuning
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 0.8); // <<< REQUIRED: 0.8% net
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);

// “Execution window”
const QUOTE_TTL_SEC = Number(process.env.QUOTE_TTL_SEC || 120);

// Slippage haircuts (our own model, applied consistently to ALL venues)
// (If you want 0.30% total, set 0.15+0.15, etc)
const SLIPPAGE_BUY_PCT = Number(process.env.SLIPPAGE_BUY_PCT || 0.15);
const SLIPPAGE_SELL_PCT = Number(process.env.SLIPPAGE_SELL_PCT || 0.15);

// Gas model per swap leg (USDC). Total cycle gas = buyGas + sellGas
const GAS_USDC_SUSHI = Number(process.env.GAS_USDC_SUSHI || 0.03);
const GAS_USDC_UNI = Number(process.env.GAS_USDC_UNI || 0.05);
const GAS_USDC_ODOS = Number(process.env.GAS_USDC_ODOS || 0.05);

// Demo behavior: send ONE demo signal message on manual run
const SEND_DEMO_ON_MANUAL = String(process.env.SEND_DEMO_ON_MANUAL || "1") === "1";

// Tokens (Polygon)
const TOKENS = {
  USDC: { symbol: "USDC", addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  LINK: { symbol: "LINK", addr: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
  WMATIC: { symbol: "WMATIC", addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  WETH: { symbol: "WETH", addr: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
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

function gasForVenue(venue) {
  if (venue === "Sushi") return GAS_USDC_SUSHI;
  if (venue === "Uniswap") return GAS_USDC_UNI;
  if (venue === "Odos") return GAS_USDC_ODOS;
  return 0;
}

// Sushi: pick best path for amountsOut
async function quoteSushi_bestAmountsOut(provider, amountIn, pathCandidates) {
  const router = new ethers.Contract(SUSHI_ROUTER, sushiRouterAbi, provider);
  let bestOut = null;

  for (const pathArr of pathCandidates) {
    try {
      const amounts = await router.getAmountsOut(amountIn, pathArr);
      const out = amounts[amounts.length - 1];
      if (!bestOut || out > bestOut) bestOut = out;
    } catch (_) {}
  }
  return bestOut; // bigint or null
}

// BUY on Sushi: USDC -> TOKEN (best path)
async function quoteSushi_USDC_to_TOKEN_best(provider, tokenAddr, usdcAmount) {
  const amountIn = ethers.parseUnits(String(usdcAmount), TOKENS.USDC.decimals);
  const candidates = [
    [TOKENS.USDC.addr, tokenAddr],
    [TOKENS.USDC.addr, TOKENS.WMATIC.addr, tokenAddr],
    [TOKENS.USDC.addr, TOKENS.WETH.addr, tokenAddr]
  ];
  const out = await quoteSushi_bestAmountsOut(provider, amountIn, candidates);
  if (!out) throw new Error("Sushi BUY quote failed (all paths)");
  return out;
}

// SELL on Sushi: TOKEN -> USDC (best path)
async function quoteSushi_TOKEN_to_USDC_best(provider, tokenAddr, tokenAmountIn) {
  const candidates = [
    [tokenAddr, TOKENS.USDC.addr],
    [tokenAddr, TOKENS.WMATIC.addr, TOKENS.USDC.addr],
    [tokenAddr, TOKENS.WETH.addr, TOKENS.USDC.addr]
  ];
  const out = await quoteSushi_bestAmountsOut(provider, tokenAmountIn, candidates);
  if (!out) throw new Error("Sushi SELL quote failed (all paths)");
  return out; // USDC base units
}

// Uniswap V3: exact input single for both directions
async function quoteUniV3_bestExactIn(provider, tokenIn, tokenOut, amountIn) {
  const q = new ethers.Contract(UNI_QUOTER_V2, uniQuoterV2Abi, provider);
  let best = null;

  for (const fee of UNI_FEES) {
    try {
      const params = { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 };
      const res = await q.quoteExactInputSingle.staticCall(params);
      const amountOut = res[0];
      if (!best || amountOut > best.amountOut) best = { amountOut, fee };
    } catch (_) {}
  }
  return best; // {amountOut, fee} or null
}

async function quoteUni_USDC_to_TOKEN_best(provider, tokenAddr, usdcAmount) {
  const amountIn = ethers.parseUnits(String(usdcAmount), TOKENS.USDC.decimals);
  const best = await quoteUniV3_bestExactIn(provider, TOKENS.USDC.addr, tokenAddr, amountIn);
  if (!best) throw new Error("Uniswap BUY quote failed (no pool/fee)");
  return best.amountOut; // token base units
}

async function quoteUni_TOKEN_to_USDC_best(provider, tokenAddr, tokenAmountIn) {
  const best = await quoteUniV3_bestExactIn(provider, tokenAddr, TOKENS.USDC.addr, tokenAmountIn);
  if (!best) throw new Error("Uniswap SELL quote failed (no pool/fee)");
  return best.amountOut; // USDC base units
}

// Odos quote: generic (inputTokens -> outputTokens)
async function quoteOdos(inputAddr, inputAmountBase, outputAddr) {
  const body = {
    chainId: CHAIN_ID,
    inputTokens: [{ tokenAddress: inputAddr, amount: inputAmountBase.toString() }],
    outputTokens: [{ tokenAddress: outputAddr, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000001",
    // keep it >= our model so route exists; we still apply our own haircuts consistently
    slippageLimitPercent: Number(Math.max(SLIPPAGE_BUY_PCT, SLIPPAGE_SELL_PCT, 0.1)),
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

async function quoteOdos_USDC_to_TOKEN(provider, tokenAddr, usdcAmount) {
  const amountIn = ethers.parseUnits(String(usdcAmount), TOKENS.USDC.decimals);
  return await quoteOdos(TOKENS.USDC.addr, amountIn, tokenAddr);
}

async function quoteOdos_TOKEN_to_USDC(provider, tokenAddr, tokenAmountIn) {
  return await quoteOdos(tokenAddr, tokenAmountIn, TOKENS.USDC.addr);
}

// ---------- COSTS / PROFIT (BASE UNITS) ----------
const USDC_DEC = TOKENS.USDC.decimals;

function bpsFromPct(pct) {
  return Math.max(0, Math.round(Number(pct) * 100)); // 0.15% => 15 bps
}

function haircutBase(amountBase, pct) {
  const bps = bpsFromPct(pct);
  const keep = 10000 - bps;
  return (amountBase * BigInt(keep)) / 10000n;
}

function subtractGasBase(usdcOutBase, gasUsdc) {
  const gasBase = ethers.parseUnits(String(gasUsdc), USDC_DEC);
  return usdcOutBase > gasBase ? usdcOutBase - gasBase : 0n;
}

function netProfitPct(usdcInDollars, usdcOutBaseAfterCosts) {
  const usdcInBase = ethers.parseUnits(String(usdcInDollars), USDC_DEC);
  const diff = usdcOutBaseAfterCosts - usdcInBase;
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
  if (p >= 0.8) return "🔴"; // adjusted to match your MIN=0.8
  return "❌";
}

// ---------- RISK LEVEL ----------
function riskLevelFromSamples(statePair) {
  const s = Array.isArray(statePair?.samples) ? statePair.samples : [];
  if (s.length < 2) return { level: "MED", emoji: "⚠️" };

  const a = s[s.length - 1].p;
  const b = s[s.length - 2].p;
  const delta = Math.abs(a - b);

  // tighter => lower risk
  if (delta <= 0.15) return { level: "LOW", emoji: "✅" };
  if (delta <= 0.40) return { level: "MED", emoji: "⚠️" };
  return { level: "HIGH", emoji: "🧨" };
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

// ---------- ROUTE SEARCH ----------
const VENUES = ["Sushi", "Uniswap", "Odos"];

async function quoteBuy(provider, venue, tokenAddr, usdcIn) {
  if (venue === "Sushi") return await quoteSushi_USDC_to_TOKEN_best(provider, tokenAddr, usdcIn);
  if (venue === "Uniswap") return await quoteUni_USDC_to_TOKEN_best(provider, tokenAddr, usdcIn);
  if (venue === "Odos") return await quoteOdos_USDC_to_TOKEN(provider, tokenAddr, usdcIn);
  throw new Error("unknown buy venue");
}

async function quoteSell(provider, venue, tokenAddr, tokenInBase) {
  if (venue === "Sushi") return await quoteSushi_TOKEN_to_USDC_best(provider, tokenAddr, tokenInBase);
  if (venue === "Uniswap") return await quoteUni_TOKEN_to_USDC_best(provider, tokenAddr, tokenInBase);
  if (venue === "Odos") return await quoteOdos_TOKEN_to_USDC(provider, tokenAddr, tokenInBase);
  throw new Error("unknown sell venue");
}

// compute best route for one size
async function bestRouteForSize(provider, sym, tokenAddr, usdcIn) {
  let best = null;

  for (const buyVenue of VENUES) {
    let tokenOut;
    try {
      tokenOut = await quoteBuy(provider, buyVenue, tokenAddr, usdcIn);
    } catch (_) {
      continue;
    }

    // apply BUY slippage haircut on tokenOut
    const tokenOutNet = haircutBase(tokenOut, SLIPPAGE_BUY_PCT);

    for (const sellVenue of VENUES) {
      if (sellVenue === buyVenue) continue; // FIX: no VENUE->same VENUE (ODOS->ODOS etc)

      let usdcOut;
      try {
        usdcOut = await quoteSell(provider, sellVenue, tokenAddr, tokenOutNet);
      } catch (_) {
        continue;
      }

      // apply SELL slippage haircut on USDC out
      let usdcOutNet = haircutBase(usdcOut, SLIPPAGE_SELL_PCT);

      // subtract gas for both legs
      const gasTotal = gasForVenue(buyVenue) + gasForVenue(sellVenue);
      usdcOutNet = subtractGasBase(usdcOutNet, gasTotal);

      const p = netProfitPct(usdcIn, usdcOutNet);

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

// ---------- MESSAGE BUILDER ----------
function buildSignalMessage({
  sym,
  bestRouteText,
  buyHref,
  sellHref,
  perSizeLines,
  windowText,
  riskText
}) {
  return [
    `🔥 <b>ARBITRAGE SIGNAL — ${escapeHtml(sym)} / USDC</b>`,
    "",
    `Best route: <b>${escapeHtml(bestRouteText)}</b>`,
    `Buy: ${buyHref}`,
    `Sell: ${sellHref}`,
    "",
    `💰 <b>Net profit (after slippage + gas)</b>`,
    ...perSizeLines,
    "",
    `⏱ <b>Execution window:</b> ${escapeHtml(windowText)}`,
    `${riskText}`,
    "",
    `🟢 ≥ 1.50%`,
    `🟠 1.30–1.49%`,
    `🔴 0.80–1.29%`,
    `❌ below 0.80% / n/a`
  ].join("\n");
}

function venueBuyLink(venue, tokenAddr) {
  if (venue === "Sushi") return linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, tokenAddr));
  if (venue === "Uniswap") return linkA("Uniswap", uniswapLink(TOKENS.USDC.addr, tokenAddr));
  if (venue === "Odos") return linkA("Odos", odosLink(TOKENS.USDC.addr, tokenAddr));
  return linkA("?", sushiSwapLink(TOKENS.USDC.addr, tokenAddr));
}

function venueSellLink(venue, tokenAddr) {
  if (venue === "Sushi") return linkA("SushiSwap", sushiSwapLink(tokenAddr, TOKENS.USDC.addr));
  if (venue === "Uniswap") return linkA("Uniswap", uniswapLink(tokenAddr, TOKENS.USDC.addr));
  if (venue === "Odos") return linkA("Odos", odosLink(tokenAddr, TOKENS.USDC.addr));
  return linkA("?", sushiSwapLink(tokenAddr, TOKENS.USDC.addr));
}

// ---------- DEMO ----------
async function sendDemoSignalForSym(provider, sym) {
  const t = TOKENS[sym];

  const perSizeLines = [];
  let bestAcrossAll = -999;
  let bestPick = null;

  for (const size of SIZES) {
    const r = await bestRouteForSize(provider, sym, t.addr, size);

    const em = emojiForPct(r.pct);
    const val = Number.isFinite(r.pct) ? `${r.pct >= 0 ? "+" : ""}${pct(r.pct, 2)}%` : "n/a";
    perSizeLines.push(
      `${em} <b>$${size}</b> → <b>${val}</b> | Buy: <b>${r.buyVenue}</b> → Sell: <b>${r.sellVenue}</b>`
    );

    if (Number.isFinite(r.pct) && r.pct > bestAcrossAll) {
      bestAcrossAll = r.pct;
      bestPick = { ...r, size };
    }
  }

  const buyHref = venueBuyLink(bestPick?.buyVenue || "Sushi", t.addr);
  const sellHref = venueSellLink(bestPick?.sellVenue || "Uniswap", t.addr);

  const msg = buildSignalMessage({
    sym,
    bestRouteText: bestPick ? `${bestPick.buyVenue} → ${bestPick.sellVenue} (size $${bestPick.size})` : `n/a`,
    buyHref,
    sellHref,
    perSizeLines,
    windowText: "2–5 minutes",
    riskText: `⚠️ <b>Risk:</b> MED`
  });

  await tgBroadcast(msg);
}

// ---------- MAIN ----------
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // sanity: rpc chain must match polygon
  try {
    const net = await provider.getNetwork();
    const rpcChain = Number(net.chainId);
    if (rpcChain !== CHAIN_ID) {
      console.error(`RPC CHAIN_ID MISMATCH: RPC=${rpcChain} EXPECTED=${CHAIN_ID} (fix RPC_URL)`);
      return;
    }
  } catch (e) {
    console.error("NETWORK CHECK FAILED:", e?.message || e);
  }

  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || {};

  const eventName = process.env.GITHUB_EVENT_NAME || "";

  // FIX: demo only ONCE per manual workflow run (no spam across the 8 ticks)
  if (eventName === "workflow_dispatch" && SEND_DEMO_ON_MANUAL) {
    const runId = String(process.env.GITHUB_RUN_ID || "");
    const demoTag = runId || "manual";
    if (state.meta.demoSentTag !== demoTag) {
      try {
        await sendDemoSignalForSym(provider, "LINK");
        state.meta.demoSentTag = demoTag;
        state.meta.demoSentAt = nowSec();
        writeState(state);
      } catch (e) {
        console.error("DEMO ERROR:", e?.response?.status, e?.response?.data || e?.message || e);
      }
    }
  }

  for (const sym of WATCH) {
    const t = TOKENS[sym];
    if (!t) continue;

    const primarySize = 1000;
    const primaryKey = `polygon:${sym}:USDC:${primarySize}`;
    state.pairs[primaryKey] = state.pairs[primaryKey] || {};

    const perSizeLines = [];
    let bestAcrossAll = -999;
    let bestPick = null;

    for (const size of SIZES) {
      const sizeKey = `polygon:${sym}:USDC:${size}`;
      state.pairs[sizeKey] = state.pairs[sizeKey] || {};

      let r;
      try {
        r = await bestRouteForSize(provider, sym, t.addr, size);
      } catch (e) {
        console.error(sym, "ROUTE ERROR:", size, e?.message || e);
        perSizeLines.push(`❌ <b>$${size}</b> → <b>n/a</b> | Buy: <b>?</b> → Sell: <b>?</b>`);
        continue;
      }

      const em = emojiForPct(r.pct);
      const val = Number.isFinite(r.pct) ? `${r.pct >= 0 ? "+" : ""}${pct(r.pct, 2)}%` : "n/a";
      perSizeLines.push(
        `${em} <b>$${size}</b> → <b>${val}</b> | Buy: <b>${r.buyVenue}</b> → Sell: <b>${r.sellVenue}</b>`
      );

      if (Number.isFinite(r.pct)) pushSample(state.pairs[sizeKey], r.pct);

      if (Number.isFinite(r.pct) && r.pct > bestAcrossAll) {
        bestAcrossAll = r.pct;
        bestPick = { ...r, size };
      }
    }

    const decision = shouldSend(state.pairs[primaryKey], bestAcrossAll);
    if (!decision.ok) {
      writeState(state);
      continue;
    }

    const buyHref = venueBuyLink(bestPick?.buyVenue || "Sushi", t.addr);
    const sellHref = venueSellLink(bestPick?.sellVenue || "Uniswap", t.addr);

    const windowText = estimateWindowText(state.pairs[primaryKey]);
    const risk = riskLevelFromSamples(state.pairs[primaryKey]);
    const riskText = `${risk.emoji} <b>Risk:</b> ${risk.level}`;

    const msg = buildSignalMessage({
      sym,
      bestRouteText: bestPick ? `${bestPick.buyVenue} → ${bestPick.sellVenue} (size $${bestPick.size})` : `n/a`,
      buyHref,
      sellHref,
      perSizeLines,
      windowText,
      riskText
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

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
