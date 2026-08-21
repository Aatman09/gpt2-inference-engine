---
title: achat
emoji: 💬
colorFrom: orange
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# achat

GPT-2 served by a hand-written KV-cache inference engine, with live tokens/sec,
time-to-first-token, and peak-memory readouts on every reply.

Source: https://github.com/Aatman09/gpt2-inference-engine

**Notes on this deployment**

- Free CPU tier, so generation is slow compared to GPU serving — the point is the
  engine and the metrics, not raw throughput.
- The Space sleeps after 48h idle; the first request after a sleep pays a 30–90s
  cold start while the container and model weights load.
- GPT-2 loads at startup. Qwen2.5-0.5B-Instruct and SmolLM2-360M-Instruct download
  on first use, so the first message to either is slower than subsequent ones.
