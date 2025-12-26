import axios from "axios";
import { ethers } from "ethers";

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const CHAT_ID = (process.env.CHAT_ID || "").trim();
const RPC_URL = (process.env.RPC_URL || "").trim();

const PROFIT_MIN_PCT = 1.5;     // твой минимум
const BUFFER_PCT = 0.30;        // буфер на проскальзывание/мелкие потери
const USDC_IN = 1000;           // считаем на 1000 USDC

// Polygon
const LINK = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"; // LINK (18)
const USDCe = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e (6)

// Sushi V2 factory on Polygon (официальный)
const SUSHI_FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";

// ABIs
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

// UniswapV2 fee 0.30%
const FEE_NUM = 997n;
const FEE_DEN = 1000n;

function getAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn * FEE_NUM;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * FEE_DEN + amountInWithFee;
  return numerator / denominator;
}

async function tgSend(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await axios.post(url, { chat_id: CHAT_ID, text, disable_web_page_preview: true }, { timeout: 15000 });
  if (!r?.data?.ok) throw new Error(`Telegram error: ${JSON.stringify(r.data)}`);
}

async function odosQuoteLinkToUsdc(linkAmountWei) {
  // Odos quote v3 (public)
  const url = "https://api.odos.xyz/sor/quote/v3";
  const body = {
    chainId: 137,
    inputTokens: [{ tokenAddress: LINK, amount: linkAmountWei.toString() }],
    outputTokens: [{ tokenAddress: USDCe, proportion: 1 }],
    slippageLimitPercent: 0.3,
    compact: true
  };

  const r = await axios.post(url, body, { timeout: 20000 });
  const out = r.data?.outAmounts?.[0];
  if (!out) throw new Error("Odos quote: no outAmounts");
  return BigInt(out);
}

(async () => {
  if (!BOT_TOKEN || !CHAT_ID || !RPC_URL) {
    console.error("Missing BOT_TOKEN / CHAT_ID / RPC_URL");
    process.exit(1);
  }

  // 1) Sushi price via reserves
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const factory = new ethers.Contract(SUSHI_FACTORY, FACTORY_ABI, provider);
  const pairAddr = await factory.getPair(LINK, USDCe);
  if (!pairAddr || pairAddr === ethers.ZeroAddress) throw new Error("Sushi pair LINK/USDC not found");

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);

  const [t0, t1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
  const r0 = BigInt(reserves[0]);
  const r1
