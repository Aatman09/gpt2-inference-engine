const API_BASE = "http://localhost:8010";

// Calls the real backend. Note: /predict currently returns the full
// completion in one response (no server-side streaming yet), so we can't
// token-stream from the network — App.jsx fakes the typing effect locally
// once the full reply arrives, same as it did with mock data.
export async function fetchCompletion(promptText, modelName = "gpt2") {
  const res = await fetch(`${API_BASE}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_name: modelName, predict: promptText  }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Backend returned ${res.status}: ${detail || res.statusText}`);
  }

  const data = await res.json();
  return data.predicted;
}
