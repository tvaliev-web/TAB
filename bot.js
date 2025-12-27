import { ethers } from "ethers";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RPC_URL = process.env.RPC_URL;

const STARTUP_MESSAGE = process.env.STARTUP_MESSAGE === "1";

// Polygon addresses (ты их уже использовал)
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"; // USDC (Polygon)
const LINK = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"; // LINK (Polygon)

// Sushi V2 LINK/USDC pair (у тебя в телеге уже был этот)
const SUSHI_V2_PAIR = "0x8bC8e9F621EE8bAbda8DC0E6Fc991aAf9BF8510b";

// Settings
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT ?? "1.5"); // >=1.5%
const SUSHI_FEE_BPS = Number(process.env.SUSHI_FEE_BPS ?? "30");    // 0.30%
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? "50");      // 0.50% (оценка)
const GAS_BPS = Number(process.env.GAS_BPS ?? "0");                 // если хочешь, поставь 5-10 bps

const ODOS_API = (process.env.ODOS_API ?? "https://api.odos.xyz").replace(/\/$/, "");

function nowStr() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function tgSend(text) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("BOT_TOKEN or CHAT_ID missing");
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(`Telegram send failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
}

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

function formatUsd(x) {
  return `$${x.toFixed(4)}`;
}

async function getSushiMidPrice_LinkInUsdc(provider) {
  const pair = new ethers.Contract(SUSHI_V2_PAIR, PAIR_ABI, provider);
  const [r0, r1] = await pair.getReserves();
  const t0 = (await pair.token0()).toLowerCase();
  const t1 = (await pair.token1()).toLowerCase();

  const usdc = USDC.toLowerCase();
  const link = LINK.toLowerCase();

  // reserves are raw token units
  const reserve0 = BigInt(r0);
  const reserve1 = BigInt(r1);

  // decimals: USDC=6, LINK=18
  const USDC_DEC = 6n;
  const LINK_DEC = 18n;

  // price = USDC per 1 LINK
  let usdcReserveRaw, linkReserveRaw;

  if (t0 === usdc && t1 === link) {
    usdcReserveRaw = reserve0;
    linkReserveRaw = reserve1;
  } else if (t0 === link && t1 === usdc) {
    usdcReserveRaw = reserve1;
    linkReserveRaw = reserve0;
  } else {
    throw new Error(`Pair tokens mismatch. token0=${t0}, token1=${t1}`);
  }

  // Normalize to same scale using bigint math:
  // usdcReserve = usdcReserveRaw / 10^6
  // linkReserve = linkReserveRaw / 10^18
  // price = usdcReserve / linkReserve
  // => price = (usdcReserveRaw * 10^18) / (linkReserveRaw * 10^6)
  const num = usdcReserveRaw * (10n ** LINK_DEC);
  const den = linkReserveRaw * (10n ** USDC_DEC);
  if (den === 0n) throw new Error("Zero reserve");

  // get price with 8 decimals
  const SCALE = 10n ** 8n;
  const priceScaled = (num * SCALE) / den; // USDC per LINK * 1e8
  const price = Number(priceScaled) / 1e8;
  return { price, token0: t0, token1: t1 };
}

async function getOdosSellPrice_LinkToUsdc() {
  // 1 LINK -> USDC quote
  const amountIn = "1000000000000000000"; // 1 LINK (18 decimals)

  const body = {
    chainId: 137,
    inputTokens: [{ tokenAddress: LINK, amount: amountIn }],
    outputTokens: [{ tokenAddress: USDC, proportion: 1 }],
    userAddr: "0x0000000000000000000000000000000000000000",
    slippageLimitPercent: 0.5
  };

  // Most common Odos endpoint used by bots:
  const url = `${ODOS_API}/sor/quote/v2`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Odos quote failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }

  // Odos responses differ; try common shapes:
  let outAmountRaw =
    data?.outAmounts?.[0] ??
    data?.outputTokens?.[0]?.amount ??
    data?.outputTokens?.[0]?.amountOut ??
    null;

  if (!outAmountRaw) {
    throw new Error(`Odos quote missing out amount: ${JSON.stringify(data).slice(0, 300)}`);
  }

  // USDC is 6 decimals
  const out = BigInt(outAmountRaw);
  const usdc = Number(out) / 1e6;
  return usdc; // USDC received for 1 LINK
}

function applyBps(x, bps, direction /* "plus"|"minus" */) {
  const k = bps / 10000;
  return direction === "plus" ? x * (1 + k) : x * (1 - k);
}

async function main() {
  if (!BOT_TOKEN || !CHAT_ID || !RPC_URL) {
    throw new Error("Missing env: BOT_TOKEN / CHAT_ID / RPC_URL");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, 137);

  if (STARTUP_MESSAGE) {
    await tgSend(`BOT STARTED ✅\n${nowStr()}`);
  }

  // 1) Sushi mid price (USDC per LINK)
  const sushi = await getSushiMidPrice_LinkInUsdc(provider);
  const sushiBuy = applyBps(applyBps(sushi.price, SUSHI_FEE_BPS, "plus"), SLIPPAGE_BPS, "plus");
  const sushiBuyWithGas = applyBps(sushiBuy, GAS_BPS, "plus");

  // 2) Odos sell (USDC per LINK)
  const odosSell = await getOdosSellPrice_LinkToUsdc();
  const odosSellAfterSlip = applyBps(odosSell, SLIPPAGE_BPS, "minus"); // консервативно

  // Profit
  const profitPct = ((odosSellAfterSlip - sushiBuyWithGas) / sushiBuyWithGas) * 100;

  console.log("Sushi mid:", sushi.price, "Sushi buy est:", sushiBuyWithGas, "Odos sell est:", odosSellAfterSlip, "Profit%:", profitPct);

  if (profitPct >= MIN_PROFIT_PCT) {
    const sushiUrl = `https://www.sushi.com/polygon/swap?token0=${USDC}&token1=${LINK}`;
    const odosUrl = `https://app.odos.xyz/?chain=polygon&inputCurrency=${LINK}&outputCurrency=${USDC}`;

    const msg =
      `🚀 ARBITRAGE SIGNAL\n` +
      `Profit: ${profitPct.toFixed(2)}%\n` +
      `Sushi BUY LINK: ${formatUsd(sushiBuyWithGas)}\n` +
      `Odos  SELL LINK: ${formatUsd(odosSellAfterSlip)}\n` +
      `\nSushi: ${sushiUrl}\nOdos: ${odosUrl}\n` +
      `${nowStr()}`;

    await tgSend(msg);
  }
}

// IMPORTANT: не шлём ошибки в телегу — только в логи GitHub
main().catch((e) => {
  console.error("BOT ERROR:", e?.message ?? e);
  process.exit(1);
});
