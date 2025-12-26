import axios from "axios";
await axios.get(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
  params: { chat_id: process.env.TG_CHAT_ID, text: "Bot started!" }
});
console.log("TG message sent");
