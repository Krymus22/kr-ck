import dotenv from "dotenv";
dotenv.config();

async function main() {
  const apiKey = "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";
  const url = "https://integrate.api.nvidia.com/v1/chat/completions";

  const payload = {
    model: "minimaxai/minimax-m3",
    messages: [{"role":"user","content":"Hello"}],
    max_tokens: 1024,
    temperature: 1.00,
    top_p: 0.95,
    stream: false,
    chat_template_kwargs: {"thinking_mode":"enabled"},
  };

  console.log("Sending payload...");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    console.log("Status:", response.status);
    const body = await response.json();
    console.log("Response body:", JSON.stringify(body, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}

main();
