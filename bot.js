import axios from "axios";

async function sendTG(message) {
  try {
    await axios.get(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
      params: { chat_id: process.env.TG_CHAT_ID, text: message }
    });
    console.log("TG message sent:", message);
  } catch (e) {
    console.log("TG Error:", e.message);
  }
}

// Send message on start
await sendTG("Bot started!");

// Simple loop to simulate price check every 60s
let lastSentPrice = 0;
setInterval(async () => {
  try {
    // Placeholder prices
    const buyPrice = Math.random() * 10 + 20;   // simulate SushiSwap price
    const sellPrice = buyPrice * (1 + Math.random() * 0.05); // simulate Odos price
    const profit = ((sellPrice - buyPrice)/buyPrice)*100;

    if(profit >= 1.5 && buyPrice !== lastSentPrice){
      await sendTG(`Arb alert! Buy: ${buyPrice.toFixed(2)}, Sell: ${sellPrice.toFixed(2)}, Profit: ${profit.toFixed(2)}%`);
      lastSentPrice = buyPrice;
    }
  } catch(e) {
    console.log("Price check error:", e.message);
  }
}, 60000);
