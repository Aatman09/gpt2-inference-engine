// In dev, Vite runs on :5173 and FastAPI on :8010, so requests need an
// absolute URL. In production (HF Spaces), FastAPI serves the built
// frontend itself -- same origin, same port -- so requests should be
// relative; hardcoding localhost:8010 there would try to reach the
// visitor's own machine instead of the Space.
const API_BASE = import.meta.env.DEV ? "http://localhost:8010" : "";

// The browser's native EventSource only supports GET, and /generate needs a
// JSON body (model_name, session_id, etc.), so SSE frames are parsed by hand
// off a fetch() ReadableStream instead of using EventSource.
//
// onToken(text, metrics) fires per generated token.
// onDone(metrics) fires once, after the stream's final "done" frame.
// Returns nothing; throws if the request itself fails (network error, non-2xx),
// UNLESS the failure is the AbortController firing from stopStream() -- that's
// a deliberate cancel, not an error, so it resolves quietly instead of throwing.
export async function streamCompletion(
  { modelName, promptText, sessionId, useCache = true, maxNewTokens = 256 },
  { onToken, onDone },
  { signal } = {}
) {
  let res;
  try {
    res = await fetch(`${API_BASE}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_name: modelName,
        predict: promptText,
        session_id: sessionId,
        use_cache: useCache,
        max_new_tokens: maxNewTokens,
      }),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    throw err;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Backend returned ${res.status}: ${detail || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      if (err.name === "AbortError") return;
      throw err;
    }
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame may arrive split
    // across multiple reads, so only consume complete "data: ...\n\n" chunks
    // and leave any partial trailing frame in the buffer for the next read.
    const frames = buffer.split("\n\n");
    buffer = frames.pop();

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;

      const payload = JSON.parse(line.slice("data:".length).trim());

      if (payload.type === "token") {
        onToken(payload.text, payload);
      } else if (payload.type === "done") {
        onDone(payload);
      } else if (payload.type === "error") {
        throw new Error(payload.message || "Generation failed");
      }
    }
  }
}

// Tells the backend to stop the in-flight generation for this session (sets
// its stop_event), so the server frees the CPU instead of running to
// max_new_tokens for a stream the client already walked away from. Call
// alongside aborting the client-side fetch (via AbortController), not
// instead of it -- this only stops the server; the abort stops the client
// from waiting on it.
export async function stopStream(sessionId) {
  await fetch(`${API_BASE}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(() => {});
}
