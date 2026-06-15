import os
import requests

nvidia_api_key = "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"

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = True

headers = {
  "Authorization": f"Bearer {nvidia_api_key}",
  "Accept": "text/event-stream" if stream else "application/json"
}

payload = {
  "model": "minimaxai/minimax-m3",
  "messages": [{"role":"user","content":"Hello"}],
  "max_tokens": 1024,
  "temperature": 1.00,
  "top_p": 0.95,
  "stream": stream,
  "chat_template_kwargs": {"thinking_mode":"enabled"},
}

response = requests.post(invoke_url, headers=headers, json=payload, stream=stream)
if stream:
    for line in response.iter_lines():
        if line:
            print(line.decode("utf-8"))
else:
    print(response.json())
