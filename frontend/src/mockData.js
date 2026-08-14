// Mock conversation data — stands in for the real backend until it's ready.
// Shape mirrors the API contract in API_CONTRACT.md so swapping to real
// fetch calls later is a drop-in change, not a rewrite.

let nextConvId = 4;
let nextMsgId = 100;

export const initialConversations = [
  {
    id: "1",
    title: "KV-cache speedup ideas",
    updatedAt: "2026-07-12T10:00:00Z",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "Why does my no-cache generation get slower every token?",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "Because without a KV cache, every new token recomputes attention over the entire sequence so far — that's quadratic work as the sequence grows. A KV cache stores each layer's keys and values once they're computed, so each new token only does the attention work for itself against the cached past. Quadratic becomes linear.",
      },
    ],
  },
  {
    id: "2",
    title: "TF32 vs bf16 autocast",
    updatedAt: "2026-07-13T09:30:00Z",
    messages: [
      {
        id: "m3",
        role: "user",
        content: "Do I need both TF32 and bf16 autocast, or is that redundant?",
      },
      {
        id: "m4",
        role: "assistant",
        content:
          "They're complementary, not redundant. Autocast controls precision inside the block you wrap explicitly (your forward pass). set_float32_matmul_precision controls plain float32 matmuls everywhere else. Setting it to 'high' keeps Tensor Core speed without stacking an extra, uncontrolled precision cut on top of your deliberate bf16 choice.",
      },
    ],
  },
  {
    id: "3",
    title: "New chat",
    updatedAt: "2026-07-13T14:00:00Z",
    messages: [],
  },
];

export function createConversation() {
  const id = String(nextConvId++);
  return {
    id,
    title: "New chat",
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

export function createMessage(role, content) {
  return { id: `m${nextMsgId++}`, role, content };
}

// Fake assistant reply — deterministic-ish, no network call.
// Swap this out for a real streaming fetch to POST /conversations/:id/messages.
export function mockReply(userText) {
  const canned = [
    "That's a good question — once the real backend is wired up, I'll actually reason about this instead of giving you a canned line.",
    "Right now I'm just a mock response. Ask me again once the FastAPI endpoint is live.",
    `You said: "${userText.slice(0, 60)}${userText.length > 60 ? "…" : ""}" — noted, but I'm not a real model yet.`,
  ];
  return canned[Math.floor(Math.random() * canned.length)];
}
