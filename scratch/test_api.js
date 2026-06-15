import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

async function main() {
  try {
    console.log("Testing stream call with OpenAI SDK, max_tokens and chat_template_kwargs...");
    console.log("Request sent, waiting for stream to return...");
    const stream = await client.chat.completions.create({
      model: "minimaxai/minimax-m3",
      messages: [{ role: "user", content: "Hello, what model are you?" }],
      max_tokens: 4096,
      stream: true,
      chat_template_kwargs: {
        thinking_mode: "enabled"
      }
    });
    console.log("Stream object received:", typeof stream);
    for await (const chunk of stream) {
      console.log("RAW CHUNK:", JSON.stringify(chunk));
    }
    console.log("\nStream finished successfully!");
  } catch (err) {
    console.error("Error:", err);
  }
}

main();
