// bot.js (CommonJS)
// 3 pairs: LINK/USDC, WMATIC/USDC, AAVE/USDC (Polygon)
// Arbitrage model: BUY on Uniswap (USDC -> token) then SELL on Odos (token -> USDC)
// Anti-spam via state.json; demo message only on workflow_dispatch.

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RPC_URL = process.env.RPC_URL; // kept for future / consistency

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID) throw new Error("CHAT_ID missing");
if (!RPC_URL) throw new Error("RPC_URL missing");

const CHAIN_ID = Number(process.env.CHAIN_ID || 137); // Polygon

// Tokens (Polygon)
const USDC   = (process.env.USDC   || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174").toLowerCase();
const LINK   = (process.env.LINK   || "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39").toLowerCase();
const WMATIC = (process.env.WMATIC || "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270").toLowerCase();
const AAVE   = (process.env.AAVE   || "0xD6DF932A45C0f255f85145f286eA0b292B21C90B").toLowerCase();

const PAIRS = [
  { symbol: "LINK/USDC",   token: LINK,   tokenDecimals: 18, usdcDecimals: 6 },
  { symbol: "WMATIC/USDC", token: WMATIC, tokenDecimals: 18, usdcDecimals: 6 },
  { symbol: "AAVE/USDC",   token: AAVE,   tokenDecimals: 18, usdcDecimals: 6 },
];

// Signal tuning
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT || 1.0);
const PROFIT_STEP_PCT = Number(process.env.PROFIT_STEP_PCT || 0.25);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 600);
const BIG_JUMP_BYPASS = Number(process.env.BIG_JUMP_BYPASS || 1.0);
const MIN_SECONDS_BETWEEN_ANY = Number(process.env.MIN_SECONDS_BETWEEN_ANY || 60);

// Demo + window
const SEND_DEMO_ON_MANUAL = String(process.env.SEND_DEMO_ON_MANUAL || "0") === "1";
const QUOTE_TTL_SEC = Number(process.env.QUOTE_TTL_SEC || 60);

// State
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

// Telegram HTML
function esc(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

// Links (exact tokens + Polygon)
function uniswapSwapLink(input, output) {
  // Uniswap app will open on Polygon and prefill tokens
  return `https://app.uniswap.org/swap?chain=polygon&inputCurrency=${input}&outputCurrency=${output}`;
}
function odosSwapLink(tokenIn, tokenOut) {
  return `https://app.odos.xyz/?chain=${CHAIN_ID}&tokenIn=${tokenIn}&tokenOut=${tokenOut}`;
}

// ---------- Pricing ----------
// Uniswap BUY quote: how many TOKEN you get for X USDC (we’ll use 100 USDC)
async function getUniswapBuyTokenOut(token, tokenDecimals, usdcDecimals, usdcInHuman = 100) {
  const amountIn = String(Math.floor(usdcInHuman * Math.pow(10, usdcDecimals))); // USDC -> base units

  // We avoid API keys by using Odos as a router, BUT forcing “Uniswap only” is not guaranteed by Odos.
  // So we use DexScreener for Uniswap mid-price, and estimate tokenOut from that price.
  // This is the best “no-key + stable” way without hardcoding Uniswap V3 pool addresses.
  const price = await getDexScreenerPriceUsdPerToken("uniswap", token); // USDC per 1 token (approx)
  if (!price || !Number.isFinite(price) || price <= 0) throw new Error("Uniswap price unavailable");

  const usdcIn = Number(amountIn) / Math.pow(10, usdcDecimals);
  const tokenOut = usdcIn / price; // tokens for given USDC
  return { tokenOut, usdcIn, priceUsdcPerToken: price };
}

// Odos SELL quote: how many USDC you get for 1 TOKEN
async function getOdosSellUsdcOutPer1Token(token, tokenDecimals, usdcDecimals) {
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
  const usdcOut = Number(out) / Math.pow(10, usdcDecimals); // USDC per 1 token
  return usdcOut;
}

// DexScreener: get token/USDC price for a specific DEX on Polygon (no key)
async function getDexScreenerPriceUsdPerToken(dexId, tokenAddress) {
  // Returns best matching pair on Polygon for this DEX and token vs USDC/USDT (prefers USDC).
  // Endpoint returns many pairs; we filter polygon + dexId + quote in {USDC,USDT} and pick best liquidity.
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const res = await axios.get(url, { timeout: 20000 });

  const pairs = res.data?.pairs || [];
  const candidates = pairs.filter(p =>
    p?.chainId === "polygon" &&
    String(p?.dexId || "").toLowerCase().includes(dexId) &&
    (String(p?.quoteToken?.address || "").toLowerCase() === USDC ||
     String(p?.quoteToken?.symbol || "").toUpperCase() === "USDC")
  );

  if (!candidates.length) return null;

  // pick highest liquidity USD
  candidates.sort((a, b) => (Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0)));
  const best = candidates[0];

  const price = Number(best?.priceUsd);
  if (!Number.isFinite(price)) return null;

  return price;
}

// ---------- Spam rules ----------
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
  return (now - lastAny) >= MIN_SECONDS_BETWEEN_ANY;
}

function buildMessage({ symbol, uniPrice, odosPrice, profitPct, windowSec }) {
  const uniBuy = uniswapSwapLink(USDC, uniPrice.token);
  const odosSell = odosSwapLink(uniPrice.token, USDC);

  return (
`🔥 <b>ARBITRAGE SIGNAL</b> <b>${esc(symbol)}</b> <i>[Polygon]</i>

<b>Buy (Uniswap):</b> ~${esc(fmt(uniPrice.usdcPerToken, 6))} USDC per 1
<b>Sell (Odos):</b>  ${esc(fmt(odosPrice, 6))} USDC per 1
<b>Profit:</b> <b>+${esc(fmt(profitPct, 2))}%</b>

⏱ <b>Window:</b> ~${esc(windowSec)}s (estimate)

<a href="${esc(uniswapSwapLink(USDC, uniPrice.token))}">Uniswap (USDC→COIN)</a>  |  <a href="${esc(odosSwapLink(uniPrice.token, USDC))}">Odos (COIN→USDC)</a>`
  );
}

async function main() {
  const state = readState();
  state.pairs = state.pairs || {};
  state.meta = state.meta || { lastAnySentAt: 0 };

  const eventName = process.env.GITHUB_EVENT_NAME || "";

  // Manual run: send ONE demo message per run (first pair), regardless of profit
  const sendDemoNow = (eventName === "workflow_dispatch" && SEND_DEMO_ON_MANUAL);

  for (let i = 0; i < PAIRS.length; i++) {
    const p = PAIRS[i];
    const key = `polygon:${p.symbol}:UNI->ODOS`;
    state.pairs[key] = state.pairs[key] || {};

    let uniBuyInfo, odosSellPrice;
    try {
      // Uniswap price via DexScreener (approx mid)
      const uniUsdcPerToken = await getDexScreenerPriceUsdPerToken("uniswap", p.token);
      if (!uniUsdcPerToken) throw new Error("Uniswap price not found on DexScreener");

      // Odos exact quote (1 token -> USDC)
      odosSellPrice = await getOdosSellUsdcOutPer1Token(p.token, p.tokenDecimals, p.usdcDecimals);

      const profitPct = ((odosSellPrice - uniUsdcPerToken) / uniUsdcPerToken) * 100;

      const uniPriceObj = { token: p.token, usdcPerToken: uniUsdcPerToken };

      // Demo message (only once, only manual run)
      if (sendDemoNow && i === 0) {
        const html = "🧪 <b>DEMO MESSAGE</b>\n\n" + buildMessage({
          symbol: p.symbol,
          uniPrice: uniPriceObj,
          odosPrice: odosSellPrice,
          profitPct,
          windowSec: QUOTE_TTL_SEC
        });
        await tgSendHtml(html);
      }

      const decision = shouldSendPair(state.pairs[key], profitPct);
      if (!decision.ok) {
        console.log(`[${p.symbol}] No send: ${decision.reason}. profit=${profitPct}`);
        continue;
      }

      if (!shouldSendAny(state)) {
        console.log(`[${p.symbol}] Blocked by MIN_SECONDS_BETWEEN_ANY`);
        continue;
      }

      const html = buildMessage({
        symbol: p.symbol,
        uniPrice: uniPriceObj,
        odosPrice: odosSellPrice,
        profitPct,
        windowSec: QUOTE_TTL_SEC
      });

      await tgSendHtml(html);

      const now = Math.floor(Date.now() / 1000);
      state.pairs[key].lastSentAt = now;
      state.pairs[key].lastSentProfit = profitPct;
      state.pairs[key].lastUniswap = uniUsdcPerToken;
      state.pairs[key].lastOdos = odosSellPrice;

      state.meta.lastAnySentAt = now;
      writeState(state);

      console.log(`[${p.symbol}] Sent. Reason=${decision.reason}`);
    } catch (e) {
      console.error(`[${p.symbol}] ERROR:`, e?.message || e);
      continue;
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(0);
});
