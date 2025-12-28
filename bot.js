// bot.js (CommonJS)
// Odos vs Sushi (Polygon LINK/USDC) alert bot
// - Sends when profit >= MIN_PROFIT_PCT
// - Sends again ONLY when profit increases by PROFIT_STEP_PCT (no sends on drops)
// - No Telegram spam on errors
// - Uses state.json to remember last sent profit

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TG_TOKEN || process.env.tg_token;
const CHAT_ID = process.env.CHAT_ID || process.env.TG_CHAT_ID || process.env.tg_chat_id;
const RPC_URL = process.env.RPC_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID) throw new Error("CHAT_ID missing");
if (!RPC_URL) throw new Error("RPC_URL missing");

// ---- CONFIG ----
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// IMPORTANT: your previous address had a LETTER "O" in it (…DCOE6…). It must be ZERO: …DC0E6…
const SUSHI_PAIR_ADDRESS = (
  process.env.SUSHI_PAIR_ADDRESS ||
  "0x8bC8e9F621EE8bAbda8DC0E6Fc991aAf9BF8510b"
).toLowerCase();

// Tokens (Polygon)
const USDC = (process.env.USDC || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174").toLowerCase();
const LINK = (process.env.LINK || "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39").toLowerCase();

// Signal controls
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);          // start sending from >= 1.0%
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.10);       // send again only if profit rises by +0.10%
const MIN_SECONDS_BETWEEN_ANY = Number(process.env.MIN_SECONDS_BETWEEN_ANY || 60); // hard anti-spam
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);        // if profit jumps by +1% -> send (still respects MIN_SECONDS_BETWEEN_ANY)

const STATE_PATH = path.join(__dirname, "state.json");
const STATE_KEY = `polygon:${SUSHI_PAIR_ADDRESS}:LINK/USDC`;

const pairAbi = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

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

async function tgSend(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(
    url,
    { chat_id: CHAT_ID, text, disable_web_page_preview: true },
    { timeout: 15000 }
  );
}

function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

function sushiLink(tokenA, tokenB) {
  return `https://www.sushi.com/swap?chainId=${CHAIN_ID}&token0=${tokenA}&token1=${tokenB}`;
}

function odosLink(tokenIn, tokenOut) {
  return `https://app.odos.xyz/?chain=${CHAIN_ID}&tokenIn=${tokenIn}&tokenOut=${tokenOut}`;
}

// ---- Sushi price (LINK in USDC) ----
// Uses BigInt-safe conversions (NO Number(reserveBigInt) overflow)
async function getSushiPriceLinkInUsdc(provider) {
  const pair = new ethers.Contract(SUSHI_PAIR_ADDRESS, pairAbi, provider);

  const [reserves, t0Raw, t1Raw] = await Promise.all([pair.getReserves(), pair.token0(), pair.token1()]);
  const t0 = String(t0Raw).toLowerCase();
  const t1 = String(t1Raw).toLowerCase();

  // reserves are BigInt-like in ethers v6
  const r0 = reserves.reserve0;
  const r1 = reserves.reserve1;

  // We want: LINK price in USDC. (USDC 6, LINK 18)
  if (t0 === USDC && t1 === LINK) {
    const usdc = Number(ethers.formatUnits(r0, 6));
    const link = Number(ethers.formatUnits(r1, 18));
    return usdc / link;
  }

  if (t0 === LINK && t1 === USDC) {
    const link = Number(ethers.formatUnits(r0, 18));
    const usdc = Number(ethers.formatUnits(r1, 6));
    return usdc / link;
  }

  throw new Error(`Pair tokens mismatch. token0=${t0} token1=${t1}`);
}

// ---- Odos price (LINK in USDC) ----
async function getOdosPriceLinkInUsdc() {
  const amountIn = "1000000000000000000"; // 1 LINK (18)

  const url = "https://api.odos.xyz/sor/quote/v2";
  const body = {
    chainId: CHAIN_ID,
    inputTokens: [{ tokenAddress: LINK, amount: amountIn }],
    outputTokens: [{ tokenAddress: USDC, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000001",
    slippageLimitPercent: 0.3,
    referralCode: 0,
    disableRFQs: true,
    compact: true,
  };

  const res = await axios.post(url, body, { timeout: 20000 });

  const outStr = res.data?.outAmounts?.[0];
  if (!outStr) throw new Error("Odos quote missing outAmounts");

  // outStr is integer string (USDC base units). Use BigInt-safe formatting.
  const usdcOut = Number(ethers.formatUnits(BigInt(outStr), 6));
  return usdcOut;
}

// Send rules:
// - First alert: profit >= MIN_PROFIT_PCT
// - After that: alert ONLY when profit rises by PROFIT_STEP_PCT (or BIG_JUMP_BYPASS)
// - Never alert on drops
// - Anti-spam: at least MIN_SECONDS_BETWEEN_ANY seconds between any messages
function shouldSend(statePair, profitPct) {
  const now = Math.floor(Date.now() / 1000);

  const lastSentAt = statePair?.lastSentAt || 0;
  const lastSentProfit = typeof statePair?.lastSentProfit === "number" ? statePair.lastSentProfit : -999;

  if (profitPct < MIN_PROFIT_PCT) return { ok: false, reason: "below_min" };

  // hard anti-spam
  if (lastSentAt && now - lastSentAt < MIN_SECONDS_BETWEEN_ANY) return { ok: false, reason: "min_gap" };

  // first ever signal
  if (!lastSentAt) return { ok: true, reason: "first_signal" };

  const growth = profitPct - lastSentProfit;

  // only on growth
  if (growth >= BIG_JUMP_BYPASS) return { ok: true, reason: "big_jump" };
  if (growth >= PROFIT_STEP_PCT) return { ok: true, reason: "growth" };

  return { ok: false, reason: "no_growth" };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || {};
  state.pairs[STATE_KEY] = state.pairs[STATE_KEY] || {};

  // Start message ONLY when manual run
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  if (eventName === "workflow_dispatch") {
    try {
      await tgSend("✅ BOT STARTED");
    } catch (_) {}
  }

  let sushiPrice, odosPrice;
  try {
    sushiPrice = await getSushiPriceLinkInUsdc(provider);
    odosPrice = await getOdosPriceLinkInUsdc();
  } catch (e) {
    console.error("FETCH ERROR:", e?.message || e);
    return; // exit 0
  }

  const profitPct = ((odosPrice - sushiPrice) / sushiPrice) * 100;
  const decision = shouldSend(state.pairs[STATE_KEY], profitPct);

  if (!decision.ok) {
    console.log(`No send: ${decision.reason}. profit=${profitPct}`);
    return;
  }

  const msg =
`🔥 ARBITRAGE SIGNAL (LINK/USDC)

Sushi: $${fmt(sushiPrice, 6)}
Odos:  $${fmt(odosPrice, 6)}
Profit: +${fmt(profitPct, 3)}%

Sushi: ${sushiLink(USDC, LINK)}
Odos:  ${odosLink(LINK, USDC)}
`;

  try {
    await tgSend(msg);

    const now = Math.floor(Date.now() / 1000);
    state.pairs[STATE_KEY].lastSentAt = now;
    state.pairs[STATE_KEY].lastSentProfit = profitPct;
    state.pairs[STATE_KEY].lastSushi = sushiPrice;
    state.pairs[STATE_KEY].lastOdos = odosPrice;

    writeState(state);
    console.log("Sent. Reason:", decision.reason);
  } catch (e) {
    console.error("TELEGRAM ERROR:", e?.response?.data || e?.message || e);
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
