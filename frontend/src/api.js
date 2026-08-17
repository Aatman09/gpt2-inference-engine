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
      // required for the browser to send the httpOnly auth cookie -- fetch
      // omits cookies on cross-origin requests by default (Vite :5173 vs
      // FastAPI :8010 in dev), and /generate is auth-protected
      credentials: "include",
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

export async function createConversation(title) {
  const res = await fetch(`${API_BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to create conversation: ${res.status}`);
  }
  return res.json();
}

// Sidebar list view -- no messages payload (kept light server-side too, see
// ConversationSummary in schemas.py).
export async function listConversations() {
  const res = await fetch(`${API_BASE}/conversations`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to list conversations: ${res.status}`);
  }
  return res.json();
}

// Full conversation including messages -- fetched lazily when a sidebar item
// is selected, not eagerly for every conversation on load.
export async function getConversation(id) {
  const res = await fetch(`${API_BASE}/conversations/${id}`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load conversation: ${res.status}`);
  }
  return res.json();
}

export async function deleteConversation(id) {
  const res = await fetch(`${API_BASE}/conversations/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to delete conversation: ${res.status}`);
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
    credentials: "include",
  }).catch(() => {});
}

// --- Phase 3: auth (see docs/ROADMAP.md) ---

async function _authRequest(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function signup(email, password, name) {
  return _authRequest("/auth/signup", { email, password, name });
}

export function login(email, password) {
  return _authRequest("/auth/login", { email, password });
}

export async function logout() {
  await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
}

// Returns the current user, or null if not authenticated -- used on app
// mount to decide login-screen vs. chat UI. A 401 here is an expected,
// routine outcome (not logged in yet), not an error to surface.
export async function getCurrentUser() {
  const res = await fetch(`${API_BASE}/auth/me`, { credentials: "include" });
  if (!res.ok) return null;
  return res.json();
}
