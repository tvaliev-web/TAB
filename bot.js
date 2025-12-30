// bot.js (CommonJS)
// LINK/USDC + WMATIC/USDC + AAVE/USDC arbitrage alerts (Polygon)
// Sushi V2 price from reserves, Odos price from quote API.
// Anti-spam via state.json: send at >= MIN_PROFIT_PCT, resend only if profit grows by PROFIT_STEP_PCT,
// cooldown COOLDOWN_SEC, and BIG_JUMP_BYPASS can bypass cooldown.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RPC_URL = process.env.RPC_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID) throw new Error("CHAT_ID missing");
if (!RPC_URL) throw new Error("RPC_URL missing");

// ---- Chain / DEX config ----
const CHAIN_ID = Number(process.env.CHAIN_ID || 137); // Polygon

// SushiSwap V2 (Polygon)
const SUSHI_V2_FACTORY = (process.env.SUSHI_V2_FACTORY || "0xc35DADB65012eC5796536bD9864eD8773aBc74C4").toLowerCase();

// Tokens (Polygon)
const USDC  = (process.env.USDC  || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174").toLowerCase();
const LINK  = (process.env.LINK  || "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39").toLowerCase();
const WMATIC= (process.env.WMATIC|| "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270").toLowerCase();
const AAVE  = (process.env.AAVE  || "0xD6DF932A45C0f255f85145f286eA0b292B21C90B").toLowerCase();

// Pairs to watch (token -> USDC)
const PAIRS = [
  { symbol: "LINK/USDC",  token: LINK,   tokenDecimals: 18, usdcDecimals: 6 },
  { symbol: "WMATIC/USDC",token: WMATIC, tokenDecimals: 18, usdcDecimals: 6 },
  { symbol: "AAVE/USDC",  token: AAVE,   tokenDecimals: 18, usdcDecimals: 6 },
];

// ---- Signal tuning ----
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 10 * 60);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);
const MIN_SECONDS_BETWEEN_ANY = Number(process.env.MIN_SECONDS_BETWEEN_ANY || 60);

// ---- State ----
const STATE_PATH = path.join(__dirname, "state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { pairs: {}, meta: { lastAnySentAt: 0 } };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---- Telegram ----
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function tgSendHtml(html) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(
    url,
    {
      chat_id: CHAT_ID,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    { timeout: 15000 }
  );
}

// ---- Helpers ----
function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

function sushiPairLink(token0, token1) {
  // Sushi UI expects token0/token1; will open exact pair on Polygon
  return `https://www.sushi.com/swap?chainId=${CHAIN_ID}&token0=${token0}&token1=${token1}`;
}

function odosSwapLink(tokenIn, tokenOut) {
  return `https://app.odos.xyz/?chain=${CHAIN_ID}&tokenIn=${tokenIn}&tokenOut=${tokenOut}`;
}

const factoryAbi = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

const pairAbi = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

async function getSushiPriceTokenInUsdc(provider, token, tokenDecimals, usdcDecimals) {
  const factory = new ethers.Contract(SUSHI_V2_FACTORY, factoryAbi, provider);
  const pairAddr = (await factory.getPair(token, USDC)).toLowerCase();

  if (pairAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No Sushi pair for token=${token} vs USDC`);
  }

  const pair = new ethers.Contract(pairAddr, pairAbi, provider);
  const [r0, r1] = await pair.getReserves();
  const t0 = (await pair.token0()).toLowerCase();
  const t1 = (await pair.token1()).toLowerCase();

  const r0n = Number(r0.toString());
  const r1n = Number(r1.toString());

  // We want: token price in USDC (USDC per 1 token)
  if (t0 === USDC && t1 === token) {
    const usdc = r0n / Math.pow(10, usdcDecimals);
    const tok = r1n / Math.pow(10, tokenDecimals);
    return { price: usdc / tok, pairAddr };
  }
  if (t0 === token && t1 === USDC) {
    const tok = r0n / Math.pow(10, tokenDecimals);
    const usdc = r1n / Math.pow(10, usdcDecimals);
    return { price: usdc / tok, pairAddr };
  }

  throw new Error(`Pair token mismatch for ${pairAddr}`);
}

async function getOdosPriceTokenInUsdc(token, tokenDecimals, usdcDecimals) {
  // Quote: 1 token -> USDC
  const amountIn = String(BigInt(10) ** BigInt(tokenDecimals)); // 1 token

  const url = "https://api.odos.xyz/sor/quote/v2";
  const body = {
    chainId: CHAIN_ID,
    inputTokens: [{ tokenAddress: token, amount: amountIn }],
    outputTokens: [{ tokenAddress: USDC, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000001",
    slippageLimitPercent: 0.3,
    referralCode: 0,
    disableRFQs: true,
    compact: true,
  };

  const res = await axios.post(url, body, { timeout: 20000 });
  const out = res.data?.outAmounts?.[0];
  if (!out) throw new Error("Odos quote missing outAmounts");
  const usdcOut = Number(out) / Math.pow(10, usdcDecimals);
  return usdcOut;
}

function shouldSendPair(statePair, profitPct) {
  const now = Math.floor(Date.now() / 1000);

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

function shouldSendAny(state) {
  const now = Math.floor(Date.now() / 1000);
  const lastAny = state?.meta?.lastAnySentAt || 0;
  if (now - lastAny < MIN_SECONDS_BETWEEN_ANY) return false;
  return true;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || { lastAnySentAt: 0 };

  // BOT STARTED only on manual run
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  if (eventName === "workflow_dispatch") {
    await tgSendHtml("✅ <b>BOT STARTED</b>");
  }

  for (const p of PAIRS) {
    const key = `polygon:${p.symbol}`;
    state.pairs[key] = state.pairs[key] || {};

    let sushi, odos, pairAddr;
    try {
      const s = await getSushiPriceTokenInUsdc(provider, p.token, p.tokenDecimals, p.usdcDecimals);
      sushi = s.price;
      pairAddr = s.pairAddr;
      odos = await getOdosPriceTokenInUsdc(p.token, p.tokenDecimals, p.usdcDecimals);
    } catch (e) {
      console.error(`[${p.symbol}] FETCH ERROR:`, e?.message || e);
      continue; // no spam
    }

    const profitPct = ((odos - sushi) / sushi) * 100;
    const decision = shouldSendPair(state.pairs[key], profitPct);

    if (!decision.ok) {
      console.log(`[${p.symbol}] No send: ${decision.reason}. profit=${profitPct}`);
      continue;
    }

    if (!shouldSendAny(state)) {
      console.log(`[${p.symbol}] Blocked by MIN_SECONDS_BETWEEN_ANY`);
      continue;
    }

    const sushiUrl = sushiPairLink(USDC, p.token); // USDC -> token
    const odosUrl = odosSwapLink(p.token, USDC);   // token -> USDC

    const html =
`🔥 <b>ARBITRAGE SIGNAL</b> <b>${escapeHtml(p.symbol)}</b> <i>[Polygon]</i>

<b>Sushi:</b> ${escapeHtml(fmt(sushi, 6))} USDC per 1
<b>Odos:</b>  ${escapeHtml(fmt(odos, 6))} USDC per 1
<b>Profit:</b> <b>+${escapeHtml(fmt(profitPct, 2))}%</b>

<a href="${escapeHtml(sushiUrl)}">SushiSwap</a>  |  <a href="${escapeHtml(odosUrl)}">Odos</a>
`;

    try {
      await tgSendHtml(html);

      const now = Math.floor(Date.now() / 1000);
      state.pairs[key].lastSentAt = now;
      state.pairs[key].lastSentProfit = profitPct;
      state.pairs[key].lastSushi = sushi;
      state.pairs[key].lastOdos = odos;
      state.pairs[key].lastSushiPair = pairAddr;

      state.meta.lastAnySentAt = now;

      writeState(state);
      console.log(`[${p.symbol}] Sent. Reason=${decision.reason}`);
    } catch (e) {
      console.error(`[${p.symbol}] TELEGRAM ERROR:`, e?.response?.data || e?.message || e);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0); // don't fail Actions
});
