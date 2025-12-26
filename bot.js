import axios from "axios";
import { ethers } from "ethers";

const TG_TOKEN = (process.env.TG_TOKEN || "").trim();
const TG_CHAT_ID = (process.env.TG_CHAT_ID || "").trim();
const RPC_URL = (process.env.RPC_URL || "").trim();

async function tgSend(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await axios.post(url, { chat_id: TG_CHAT_ID, text });
  if (!res?.data?.ok) throw new Error(`Telegram: ${JSON.stringify(res.data)}`);
}

const LINK = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"; // LINK on Polygon
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC on Polygon

// SushiSwap V2 factory on Polygon
const FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

async function getLinkUsd() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const pairAddr = await factory.getPair(LINK, USDC);

  if (!pairAddr || pairAddr === ethers.ZeroAddress) {
    throw new Error("No Sushi V2 pair for LINK/USDC on Polygon (factory returned 0x0)");
  }

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [r0, r1] = await pair.getReserves();
  const t0 = (await pair.token0()).toLowerCase();
  const t1 = (await pair.token1()).toLowerCase();

  const usdcAddr = USDC.toLowerCase();
  let usdcRaw, linkRaw;

  if (t0 === usdcAddr) { usdcRaw = r0; linkRaw = r1; }
  else if (t1 === usdcAddr) { usdcRaw = r1; linkRaw = r0; }
  else throw new Error("Pair tokens mismatch (not USDC/LINK)");

  const usdc = Number(usdcRaw) / 1e6;
  const link = Number(linkRaw) / 1e18;

  if (!usdc || !link) throw new Error("Zero reserves");
  return { price: usdc / link, pairAddr };
}

(async () => {
  try {
    if (!TG_TOKEN) throw new Error("TG_TOKEN missing");
    if (!TG_CHAT_ID) throw new Error("TG_CHAT_ID missing");
    if (!RPC_URL) throw new Error("RPC_URL missing");

    await tgSend("BOT STARTED ✅");

    const { price, pairAddr } = await getLinkUsd();
    await tgSend(`Sushi V2 LINK/USDC pair: ${pairAddr}\nLINK price: $${price.toFixed(4)}`);

    console.log("OK");
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
})();
