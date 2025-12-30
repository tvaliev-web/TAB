// bot.js (CommonJS)
// Polygon arbitrage alerts:
// BUY always on Sushi (USDC -> TOKEN)
// SELL chooses best of Uniswap or Odos (TOKEN -> USDC)
// Profit is computed for a concrete trade size (default $1000 USDC)
// Anti-spam via state.json: send >= MIN_PROFIT_PCT, re-send only on profit growth steps.

const fs = require("fs");
const path = require("path");
const axios = require("axios"); // FIXED (your pasted file had a broken require line) :contentReference[oaicite:1]{index=1}
const { ethers } = require("ethers");

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TG_TOKEN;
const CHAT_ID = process.env.CHAT_ID || process.env.TG_CHAT_ID; // can be "id1,id2,id3"
const RPC_URL = process.env.RPC_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID) throw new Error("CHAT_ID missing");
if (!RPC_URL) throw new Error("RPC_URL missing");

// ✅ ONLY CHANGE: allow multiple recipients (comma-separated CHAT_ID secret)
const CHAT_IDS = String(CHAT_ID)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// --- trade sizing ---
const TRADE_USDC = Number(process.env.TRADE_USDC || 1000); // PROFIT for EXACTLY this size
if (!Number.isFinite(TRADE_USDC) || TRADE_USDC <= 0) throw new Error("TRADE_USDC invalid");

// --- signal tuning ---
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 10 * 60);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);
const MIN_SECONDS_BETWEEN_ANY = Number(process.env.MIN_SECONDS_BETWEEN_ANY || 60);

// --- contracts / addresses (Polygon) ---
const USDC = (process.env.USDC || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174").toLowerCase();

// Sushi Router (Polygon)
const SUSHI_ROUTER = (process.env.SUSHI_ROUTER || "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506").toLowerCase();

// Uniswap V3 Factory (same across chains)
const UNI_V3_FACTORY = (process.env.UNI_V3_FACTORY || "0x1F98431c8aD98523631AE4a59f267346ea31F984").toLowerCase();
// Quoter (Polygon) — use env to override if needed
const UNI_V3_QUOTER = (process.env.UNI_V3_QUOTER || "0x5e55c9e631fdc92c1f3b31cce0fd3a2c11d8f9da").toLowerCase();

// Tokens (Polygon)
const TOKENS = [
  {
    symbol: "LINK",
    address: (process.env.LINK || "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39").toLowerCase(),
    decimals: 18,
  },
  {
    symbol: "MATIC", // we trade WMATIC contract, but show MATIC
    address: (process.env.WMATIC || "0x0d500B1d8E8ef31E21C99d1Db9A6444d3ADf1270").toLowerCase(),
    decimals: 18,
  },
  {
    symbol: "AAVE",
    address: (process.env.AAVE || "0xd6df932a45c0f255f85145f286ea0b292b21c90b").toLowerCase(),
    decimals: 18,
  },
];

// Uniswap fee tiers to try
const UNI_FEES = [500, 3000, 10000];

// --- state ---
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

// --- helpers ---
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

// ✅ ONLY CHANGE: send to ALL chat IDs
async function tgSend(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const ids = String(CHAT_ID)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  for (const id of ids) {
    await axios.post(
      url,
      {
        chat_id: id,
        text,
        disable_web_page_preview: true,
      },
      { timeout: 15000 }
    );
  }
}

function sushiSwapLink(tokenIn, tokenOut) {
  // Sushi UI
  return `https://www.sushi.com/swap?chainId=${CHAIN_ID}&token0=${tokenIn}&token1=${tokenOut}`;
}

function uniswapSwapLink(inputCurrency, outputCurrency) {
  // Uniswap UI
  return `https://app.uniswap.org/swap?chain=polygon&inputCurrency=${inputCurrency}&outputCurrency=${outputCurrency}`;
}

function odosSwapLink(tokenIn, tokenOut) {
  // Odos UI — IMPORTANT: tokenIn/tokenOut are correct direction
  return `https://app.odos.xyz/?chain=${CHAIN_ID}&tokenIn=${tokenIn}&tokenOut=${tokenOut}`;
}

// --- ABIs ---
const sushiRouterAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
];

const uniFactoryAbi = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const uniQuoterAbi = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
];

// --- quoting ---
async function quoteSushiBuyUSDCToToken(provider, token) {
  const router = new ethers.Contract(SUSHI_ROUTER, sushiRouterAbi, provider);

  const amountIn = BigInt(Math.round(TRADE_USDC * 1e6)); // USDC 6 decimals
  const path = [USDC, token.address];

  const amounts = await router.getAmountsOut(amountIn, path);
  const tokenOut = amounts[1]; // BigInt
  return { usdcIn: amountIn, tokenOut };
}

async function quoteOdosSellTokenToUSDC(token, tokenAmountIn) {
  // tokenAmountIn is BigInt (token decimals)
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
  const usdcOut = BigInt(out); // USDC 6 decimals
  return usdcOut;
}

async function quoteUniswapSellTokenToUSDC(provider, token, tokenAmountIn) {
  const factory = new ethers.Contract(UNI_V3_FACTORY, uniFactoryAbi, provider);
  const quoter = new ethers.Contract(UNI_V3_QUOTER, uniQuoterAbi, provider);

  for (const fee of UNI_FEES) {
    let pool;
    try {
      pool = await factory.getPool(token.address, USDC, fee);
    } catch {
      pool = "0x0000000000000000000000000000000000000000";
    }
    if (!pool || pool === "0x0000000000000000000000000000000000000000") continue;

    try {
      // quoteExactInputSingle is NOT view on many deployments -> must call as normal call
      const out = await quoter.quoteExactInputSingle(token.address, USDC, fee, tokenAmountIn, 0);
      if (out && BigInt(out.toString()) > 0n) return { usdcOut: BigInt(out.toString()), fee };
    } catch {
      // try next fee tier
    }
  }

  throw new Error("No Uniswap V3 pool/quote available for this pair");
}

// --- window estimate (heuristic based on last samples trend) ---
function estimateWindowSeconds(samples, minProfitPct) {
  // samples: [{t, p}] sorted asc, p in %
  if (!samples || samples.length < 3) return null;

  const last3 = samples.slice(-3);
  const t0 = last3[0].t, p0 = last3[0].p;
  const t2 = last3[2].t, p2 = last3[2].p;

  const dt = t2 - t0;
  if (dt <= 0) return null;

  const slope = (p2 - p0) / dt; // % per sec
  if (slope >= 0) {
    // not decaying -> give typical range
    return 240; // ~4 min
  }

  const last = last3[2];
  const remaining = (last.p - minProfitPct) / (-slope);
  if (!Number.isFinite(remaining)) return null;

  // clamp to sane range
  return Math.max(30, Math.min(600, remaining));
}

// --- anti-spam decision ---
function shouldSend(statePair, profitPct) {
  const now = nowSec();

  const lastAnyAt = statePair?.lastAnyAt || 0;
  if (now - lastAnyAt < MIN_SECONDS_BETWEEN_ANY) return { ok: false, reason: "min_between_any" };

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

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || {};

  const eventName = process.env.GITHUB_EVENT_NAME || "";

  // Manual-run "started" message: once per hour max
  if (eventName === "workflow_dispatch") {
    const last = state.meta.lastStartedAt || 0;
    if (nowSec() - last > 3600) {
      await tgSendHTML("✅ <b>BOT STARTED</b>");
      state.meta.lastStartedAt = nowSec();
      writeState(state);
    }
  }

  for (const token of TOKENS) {
    const key = `polygon:${token.symbol}:USDC:${TRADE_USDC}`;
    state.pairs[key] = state.pairs[key] || {};
    const st = state.pairs[key];

    let sushiBuy, odosSellUSDC, uniSell, best;

    try {
      // 1) BUY on Sushi (USDC -> TOKEN) for exact $TRADE_USDC
      sushiBuy = await quoteSushiBuyUSDCToToken(provider, token);

      // 2) SELL on Odos (TOKEN -> USDC)
      odosSellUSDC = await quoteOdosSellTokenToUSDC(token, sushiBuy.tokenOut);

      // 3) SELL on Uniswap (TOKEN -> USDC)
      let uniOk = false;
      try {
        uniSell = await quoteUniswapSellTokenToUSDC(provider, token, sushiBuy.tokenOut);
        uniOk = true;
      } catch (e) {
        uniSell = null;
      }

      // choose best sell venue
      const uniOut = uniOk ? uniSell.usdcOut : 0n;
      const odosOut = odosSellUSDC;

      if (uniOk && uniOut > odosOut) {
        best = { venue: "UNISWAP", usdcOut: uniOut, fee: uniSell.fee };
      } else {
        best = { venue: "ODOS", usdcOut: odosOut, fee: null };
      }
    } catch (e) {
      console.error(`[${token.symbol}/USDC] FETCH ERROR:`, e?.message || e);
      continue; // no Telegram spam on errors
    }

    const usdcIn = sushiBuy.usdcIn; // BigInt, 6 decimals
    const profitUSDC = Number(best.usdcOut - usdcIn) / 1e6;
    const profitPct = (profitUSDC / TRADE_USDC) * 100;

    // keep history samples for window estimate
    st.samples = st.samples || [];
    st.samples.push({ t: nowSec(), p: profitPct });
    if (st.samples.length > 30) st.samples = st.samples.slice(-30);

    const decision = shouldSend(st, profitPct);
    st.lastAnyAt = nowSec(); // anti-spam floor (any check)
    writeState(state); // persist samples + lastAnyAt even if no send

    if (!decision.ok) {
      console.log(`[${token.symbol}/USDC] No send: ${decision.reason}. profit=${profitPct}`);
      continue;
    }

    const windowSec = estimateWindowSeconds(st.samples, MIN_PROFIT_PCT);
    const windowText =
      windowSec == null
        ? "~2–6 min"
        : `${Math.round(windowSec / 60)} min ${Math.round(windowSec % 60)} sec`;

    const tokenOutHuman = Number(sushiBuy.tokenOut.toString()) / Math.pow(10, token.decimals);
    const usdcOutHuman = Number(best.usdcOut.toString()) / 1e6;

    // Links (correct direction, Polygon, pair prefilled)
    const sushiBuyUrl = sushiSwapLink(USDC, token.address);           // buy USDC -> token
    const uniSellUrl = uniswapSwapLink(token.address, USDC);          // sell token -> USDC
    const odosSellUrl = odosSwapLink(token.address, USDC);            // sell token -> USDC

    const venueLine =
      best.venue === "UNISWAP"
        ? `Sell: <b>Uniswap</b> (fee ${best.fee})`
        : `Sell: <b>Odos</b>`;

    const msg =
`🔥 <b>ARBITRAGE SIGNAL</b> (${token.symbol}/USDC) <b>[Polygon]</b>

Trade size: <b>$${fmt(TRADE_USDC, 0)}</b>
Buy: <b>Sushi</b> (USDC → ${token.symbol})
${venueLine} (${token.symbol} → USDC)

Buy output: <b>${fmt(tokenOutHuman, 6)} ${token.symbol}</b>
Sell output: <b>${fmt(usdcOutHuman, 2)} USDC</b>

Profit: <b>+${fmt(profitUSDC, 2)} USDC</b> (<b>+${fmt(profitPct, 2)}%</b>)
Swap window (est): <b>${windowText}</b>

<a href="${sushiBuyUrl}">Sushi (buy)</a> | <a href="${uniSellUrl}">Uniswap (sell)</a> | <a href="${odosSellUrl}">Odos (sell)</a>`;

    try {
      await tgSendHTML(msg);

      // update state ONLY when we successfully sent
      st.lastSentAt = nowSec();
      st.lastSentProfit = profitPct;
      st.lastSentVenue = best.venue;
      st.lastSentTradeUSDC = TRADE_USDC;
      st.lastSentTokenOut = sushiBuy.tokenOut.toString();
      st.lastSentUSDCOut = best.usdcOut.toString();

      writeState(state);
      console.log(`[${token.symbol}/USDC] Sent. Reason: ${decision.reason}. Venue=${best.venue}`);
    } catch (e) {
      console.error("TELEGRAM ERROR:", e?.response?.data || e?.message || e);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0); // don’t fail Actions
});
