// bot.js (CommonJS)
// Polygon arb notifier (NO BS version)
//
// BUY  = SushiSwap Router getAmountsOut (USDC -> COIN)
// SELL = BOTH:
//   - Uniswap V3 QuoterV2 quoteExactInputSingle (COIN -> USDC)
//   - Odos quote API (COIN -> USDC)
//
// Telegram message requirements (YOUR RULES):
// - Links MUST be inside swapper names (clickable) => use Telegram HTML <a>
// - Compare sizes: $100 / $1000 / $3000 (configurable)
// - Show BOTH sell options on Uniswap and Odos in every signal (if available)
// - For each size line show 🟢🟠🔴 (and ❌ if <1% or n/a)
//   🟢 >= 1.50%   🟠 1.30–1.49%   🔴 1.00–1.29%   ❌ < 1.00% / n/a
// - Profit MUST be AFTER GAS + SLIPPAGE (your chosen estimates)
// - Execution window text simple: "2–5 minutes" (or computed)
//
// IMPORTANT FIXES:
// - NO float math on USDC base units => use bigint math (prevents -90% nonsense)
// - Safe HTML escaping so Telegram never breaks with “can't parse entities”
// - Send to multiple CHAT_IDs "id1,id2,id3" safely

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");

// -------------------- ENV --------------------
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

// -------------------- CONFIG --------------------
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// Comparison sizes (you wanted these exact defaults)
const SIZES = String(process.env.SIZES || "100,1000,3000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

// Alert gating (keep your existing behavior)
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);

// “after gas + slippage” estimates (YOU tune these)
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 0.50); // percent, applied to SELL proceeds
const GAS_USDC_CYCLE = Number(process.env.GAS_USDC_CYCLE || 0.20); // USDC per full cycle (buy+sell)

// Execution window text (simple)
const EXEC_WINDOW_TEXT = String(process.env.EXEC_WINDOW_TEXT || "2–5 minutes");

// Demo behavior (manual workflow_dispatch)
const SEND_DEMO_ON_MANUAL = String(process.env.SEND_DEMO_ON_MANUAL || "1") === "1";

// Tokens (Polygon)
const TOKENS = {
  USDC: { symbol: "USDC", addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  LINK: { symbol: "LINK", addr: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
  WMATIC: { symbol: "WMATIC", addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  AAVE: { symbol: "AAVE", addr: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18 }
};

// Watch list
const WATCH = ["LINK", "WMATIC", "AAVE"];

// Sushi Router (Polygon)
const SUSHI_ROUTER = (process.env.SUSHI_ROUTER || "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506").toLowerCase();

// Uniswap V3 QuoterV2 (Polygon)
const UNI_QUOTER_V2 = (process.env.UNI_QUOTER_V2 || "0x61fFE014bA17989E743c5F6cB21bF9697530B21e").toLowerCase();

// Fee tiers to try
const UNI_FEES = (process.env.UNI_FEES || "500,3000,10000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

// Odos quote endpoints
const ODOS_QUOTE_V3 = "https://api.odos.xyz/sor/quote/v3";
const ODOS_QUOTE_V2 = "https://api.odos.xyz/sor/quote/v2";

// -------------------- STATE --------------------
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

// -------------------- SAFE HTML (TELEGRAM) --------------------
// Telegram HTML supports only a small set of tags.
// If ANY stray "<" appears => message fails.
// So: escape text + escape href.
function escText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function safeHref(url) {
  return String(url).replace(/&/g, "&amp;").replace(/"/g, "%22");
}
function linkA(text, url) {
  return `<a href="${safeHref(url)}">${escText(text)}</a>`;
}

// -------------------- TELEGRAM --------------------
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

// -------------------- LINKS --------------------
function sushiSwapLink(token0, token1) {
  return `https://www.sushi.com/polygon/swap?token0=${token0}&token1=${token1}`;
}
function uniswapLink(input, output) {
  return `https://app.uniswap.org/swap?chain=polygon&inputCurrency=${input}&outputCurrency=${output}`;
}
function odosLink(input, output) {
  return `https://app.odos.xyz/?chain=${CHAIN_ID}&tokenIn=${input}&tokenOut=${output}`;
}

// -------------------- ONCHAIN QUOTES --------------------
const sushiRouterAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const uniQuoterV2Abi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
];

async function quoteSushi_USDC_to_TOKEN(provider, tokenAddr, usdcAmountDollars) {
  const router = new ethers.Contract(SUSHI_ROUTER, sushiRouterAbi, provider);
  const amountIn = ethers.parseUnits(String(usdcAmountDollars), TOKENS.USDC.decimals);
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
      const amountOut = res[0]; // bigint USDC out
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
  return BigInt(out); // bigint USDC out
}

// -------------------- AFTER GAS + SLIPPAGE (BIGINT ONLY) --------------------
const SLIPPAGE_BPS = Math.max(0, Math.min(5000, Math.round(SLIPPAGE_PCT * 100))); // 0.50% => 50 bps
const ONE = 10000n;

function applySlippageBps(usdcOutBase) {
  // out * (10000 - bps) / 10000
  const factor = ONE - BigInt(SLIPPAGE_BPS);
  return (usdcOutBase * factor) / ONE;
}

function subtractGas(usdcOutBase) {
  const gasBase = ethers.parseUnits(GAS_USDC_CYCLE.toFixed(6), TOKENS.USDC.decimals); // USDC 6 decimals
  return usdcOutBase > gasBase ? (usdcOutBase - gasBase) : 0n;
}

function profitPct(usdcInDollars, usdcOutBaseNet) {
  const inBase = ethers.parseUnits(String(usdcInDollars), TOKENS.USDC.decimals);
  const diff = usdcOutBaseNet - inBase;
  return (Number(diff) / Number(inBase)) * 100;
}

// -------------------- SEND RULES --------------------
function shouldSend(statePair, bestProfitPct) {
  const now = nowSec();
  const lastSentAt = statePair?.lastSentAt || 0;
  const lastSentProfit = statePair?.lastSentProfit ?? -999;

  if (bestProfitPct < MIN_PROFIT_PCT) return { ok: false, reason: "below_min" };

  const since = now - lastSentAt;
  const growth = bestProfitPct - lastSentProfit;

  if (growth >= BIG_JUMP_BYPASS) return { ok: true, reason: "big_jump" };
  if (since < COOLDOWN_SEC) return { ok: false, reason: "cooldown" };
  if (growth < PROFIT_STEP_PCT) return { ok: false, reason: "no_growth" };

  return { ok: true, reason: "growth" };
}

// -------------------- COLORS (YOUR EXACT RULES) --------------------
function emojiForPct(p) {
  if (!Number.isFinite(p)) return "❌";
  if (p >= 1.5) return "🟢";
  if (p >= 1.3) return "🟠";
  if (p >= 1.0) return "🔴";
  return "❌";
}
function fmtPct(p) {
  if (!Number.isFinite(p)) return "n/a";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(2)}%`;
}

// -------------------- MESSAGE (YOUR FORMAT) --------------------
function buildMessage({ sym, buyLinkHtml, uniSellHtml, odosSellHtml, lines, windowText }) {
  return [
    `🔥 <b>ARBITRAGE SIGNAL — ${escText(sym)} / USDC</b>`,
    "",
    `Buy: ${buyLinkHtml}`,
    `Sell (Uniswap): ${uniSellHtml}`,
    `Sell (Odos): ${odosSellHtml}`,
    "",
    `💰 <b>Profit (after gas + slippage)</b>`,
    ...lines,
    "",
    `⏱ <b>Execution window:</b> ${escText(windowText)}`,
    "",
    `🟢 ≥ 1.50%`,
    `🟠 1.30–1.49%`,
    `🔴 1.00–1.29%`,
    `❌ < 1.00% / n/a`
  ].join("\n");
}

// -------------------- QUOTE + COMPUTE FOR ONE SIZE --------------------
async function computeForSize(provider, token, size) {
  // BUY: Sushi USDC -> TOKEN
  const tokenOut = await quoteSushi_USDC_to_TOKEN(provider, token.addr, size);

  // SELL candidates:
  // Uni
  const uniBest = await quoteUniV3_TOKEN_to_USDC_best(provider, token.addr, tokenOut);
  const uniOut = uniBest ? uniBest.amountOut : null;

  // Odos
  const odosOut = await quoteOdos_TOKEN_to_USDC(token.addr, tokenOut);

  // Apply slippage+gas to each SELL output (bigint only)
  function netOut(outBase) {
    let x = outBase;
    x = applySlippageBps(x);
    x = subtractGas(x);
    return x;
  }

  const uniNet = uniOut ? netOut(uniOut) : null;
  const odosNet = odosOut ? netOut(odosOut) : null;

  const uniPct = uniNet ? profitPct(size, uniNet) : NaN;
  const odosPct = odosNet ? profitPct(size, odosNet) : NaN;

  // best for alert gating
  let bestPct = -999;
  let bestVenue = null;
  if (Number.isFinite(uniPct) && uniPct > bestPct) {
    bestPct = uniPct;
    bestVenue = uniBest ? `Uniswap(fee ${uniBest.fee})` : "Uniswap";
  }
  if (Number.isFinite(odosPct) && odosPct > bestPct) {
    bestPct = odosPct;
    bestVenue = "Odos";
  }

  return {
    size,
    uniPct,
    odosPct,
    bestPct,
    bestVenue
  };
}

// -------------------- DEMO (MANUAL RUN) --------------------
async function sendDemo(provider) {
  const sym = "LINK";
  const t = TOKENS[sym];

  const buyLinkHtml = linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, t.addr));
  const uniSellHtml = linkA("Uniswap", uniswapLink(t.addr, TOKENS.USDC.addr));
  const odosSellHtml = linkA("Odos", odosLink(t.addr, TOKENS.USDC.addr));

  const lines = [];

  for (const size of SIZES) {
    try {
      const r = await computeForSize(provider, t, size);
      const eU = emojiForPct(r.uniPct);
      const eO = emojiForPct(r.odosPct);

      // both shown on the same line (YOUR REQUEST)
      lines.push(
        `<b>$${size}</b>  Uniswap ${eU} <b>${escText(fmtPct(r.uniPct))}</b>  |  Odos ${eO} <b>${escText(
          fmtPct(r.odosPct)
        )}</b>`
      );
    } catch (e) {
      lines.push(`<b>$${size}</b>  Uniswap ❌ <b>n/a</b>  |  Odos ❌ <b>n/a</b>`);
      console.error("DEMO SIZE ERROR:", size, e?.response?.status, e?.response?.data || e?.message || e);
    }
  }

  const msg = buildMessage({
    sym,
    buyLinkHtml,
    uniSellHtml,
    odosSellHtml,
    lines,
    windowText: EXEC_WINDOW_TEXT
  });

  await tgBroadcast(msg);
}

// -------------------- MAIN --------------------
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || {};

  const eventName = process.env.GITHUB_EVENT_NAME || "";

  // Manual: send demo once
  if (eventName === "workflow_dispatch" && SEND_DEMO_ON_MANUAL) {
    try {
      await sendDemo(provider);
    } catch (e) {
      console.error("DEMO ERROR:", e?.response?.status, e?.response?.data || e?.message || e);
    }
  }

  for (const sym of WATCH) {
    const t = TOKENS[sym];
    if (!t) continue;

    const primaryKey = `polygon:${sym}:USDC:1000`;
    state.pairs[primaryKey] = state.pairs[primaryKey] || {};

    const buyLinkHtml = linkA("SushiSwap", sushiSwapLink(TOKENS.USDC.addr, t.addr));
    const uniSellHtml = linkA("Uniswap", uniswapLink(t.addr, TOKENS.USDC.addr));
    const odosSellHtml = linkA("Odos", odosLink(t.addr, TOKENS.USDC.addr));

    const lines = [];

    // Track best profit across all sizes and venues (for send decision)
    let bestAcross = -999;
    let bestVenue = null;

    for (const size of SIZES) {
      try {
        const r = await computeForSize(provider, t, size);

        const eU = emojiForPct(r.uniPct);
        const eO = emojiForPct(r.odosPct);

        lines.push(
          `<b>$${size}</b>  Uniswap ${eU} <b>${escText(fmtPct(r.uniPct))}</b>  |  Odos ${eO} <b>${escText(
            fmtPct(r.odosPct)
          )}</b>`
        );

        if (Number.isFinite(r.bestPct) && r.bestPct > bestAcross) {
          bestAcross = r.bestPct;
          bestVenue = r.bestVenue;
        }
      } catch (e) {
        lines.push(`<b>$${size}</b>  Uniswap ❌ <b>n/a</b>  |  Odos ❌ <b>n/a</b>`);
        console.error(sym, "QUOTE ERROR:", e?.response?.status, e?.message || e);
      }
    }

    // Decide send based on BEST net profit (after gas+slippage)
    const decision = shouldSend(state.pairs[primaryKey], bestAcross);
    if (!decision.ok) {
      writeState(state);
      continue;
    }

    const msg = buildMessage({
      sym,
      buyLinkHtml,
      uniSellHtml,
      odosSellHtml,
      lines,
      windowText: EXEC_WINDOW_TEXT
    });

    try {
      await tgBroadcast(msg);

      const ts = nowSec();
      state.pairs[primaryKey].lastSentAt = ts;
      state.pairs[primaryKey].lastSentProfit = bestAcross;
      state.pairs[primaryKey].lastVenue = bestVenue || "n/a";
      state.meta.lastAnySentAt = ts;

      writeState(state);
    } catch (e) {
      console.error("TELEGRAM ERROR:", e?.response?.data || e?.message || e);
      // never fail actions
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
