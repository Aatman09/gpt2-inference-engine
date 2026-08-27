import { Link } from "react-router-dom";
import { useTheme } from "../context/ThemeContext";
import { ArrowRightIcon, SunIcon, MoonIcon } from "../components/icons";

// Static sample of a real metrics readout -- the same shape /generate streams
// back, used here to show what the demo actually measures.
const CACHE_COMPARISON = [
  { label: "KV cache on", tokensPerSec: 47, ttft: 312, tone: "accent" },
  { label: "KV cache off", tokensPerSec: 11, ttft: 340, tone: "muted" },
];

export default function LandingPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="landing-brand">cachegpt</span>
        <div className="landing-nav-actions">
          <button
            type="button"
            className="rail-link"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <Link to="/login" className="btn btn-ghost">Log in</Link>
          <Link to="/signup" className="btn btn-primary">Sign up</Link>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <p className="landing-eyebrow">GPT-2 · from scratch · with a hand-written KV cache</p>
          <h1>
            A chat app where you can watch the inference engine work.
          </h1>
          <p className="landing-lede">
            cachegpt serves GPT-2 through a transformer and KV-cache implementation written
            from scratch in PyTorch — no <code>transformers</code> generate loop. Every reply
            reports its own tokens/sec, time-to-first-token, and peak memory, and you can
            switch the cache off mid-conversation to watch those numbers fall apart.
          </p>
          <div className="landing-cta">
            <Link to="/signup" className="btn btn-primary">
              Try it
              <ArrowRightIcon />
            </Link>
            <a
              className="btn btn-ghost"
              href="https://github.com/Aatman09/gpt2-inference-engine"
              target="_blank"
              rel="noreferrer"
            >
              Read the code
            </a>
          </div>
        </section>

        <section className="landing-demo" aria-label="Sample metrics">
          <div className="landing-demo-head">
            <span>Same prompt, same model, cache toggled</span>
          </div>
          <div className="landing-demo-rows">
            {CACHE_COMPARISON.map((row) => (
              <div key={row.label} className="landing-demo-row">
                <span className="landing-demo-label">{row.label}</span>
                <span
                  className={`landing-demo-value${row.tone === "accent" ? " is-accent" : ""}`}
                >
                  {row.tokensPerSec}
                  <span className="landing-demo-unit">tok/s</span>
                </span>
                <span className="landing-demo-bar-track">
                  <span
                    className={`landing-demo-bar${row.tone === "accent" ? " is-accent" : ""}`}
                    style={{ width: `${(row.tokensPerSec / 47) * 100}%` }}
                  />
                </span>
                <span className="landing-demo-ttft">TTFT {row.ttft}ms</span>
              </div>
            ))}
          </div>
          <p className="landing-demo-note">
            Cached decoding reuses every previous token's attention state. Without it, each
            new token re-encodes the entire sequence from scratch — quadratic work instead
            of linear.
          </p>
        </section>

        <section className="landing-features">
          <article>
            <h2>The engine is the project</h2>
            <p>
              Attention, the MLP, the block stack, weight loading from the pretrained
              checkpoint, and the cache itself are all written out by hand. The cache is a
              list of key/value tensors per layer — prefill fills it with the whole prompt,
              then every decode step passes exactly one token and concatenates onto what's
              already stored.
            </p>
          </article>
          <article>
            <h2>Metrics on every message</h2>
            <p>
              Tokens per second, time-to-first-token, and peak memory are measured on the
              server as tokens stream out, then attached to the reply. They're real
              measurements from your request, not benchmarks quoted from somewhere else.
            </p>
          </article>
          <article>
            <h2>Three models, one interface</h2>
            <p>
              GPT-2 runs on the hand-written engine. Qwen2.5-0.5B and SmolLM2-360M run
              through HuggingFace <code>transformers</code>. All three sit behind one
              <code>Engine</code> interface, so swapping between them changes nothing about
              how the app streams or persists a conversation.
            </p>
          </article>
          <article>
            <h2>Base model, honestly</h2>
            <p>
              GPT-2 was never instruction-tuned. It continues text rather than answering
              questions, and it will happily ramble. That contrast against the two
              instruction-tuned models is the most useful thing the model switcher shows.
            </p>
          </article>
        </section>

        <section className="landing-foot-cta">
          <h2>Sign up and send it a prompt.</h2>
          <p>Conversations are saved to your account. Nothing is shared with anyone else.</p>
          <Link to="/signup" className="btn btn-primary">
            Create an account
            <ArrowRightIcon />
          </Link>
        </section>
      </main>

      <footer className="landing-footer">
        <span>Built by Aatman Soni</span>
        <a
          href="https://github.com/Aatman09/gpt2-inference-engine"
          target="_blank"
          rel="noreferrer"
        >
          github.com/Aatman09/gpt2-inference-engine
        </a>
      </footer>
    </div>
  );
}
