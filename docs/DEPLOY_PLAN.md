# Deploy plan — what we're doing and why

You asked to deploy the app, and the conversation went down a rabbit hole of
options. This doc is the reset: where we started, what got ruled out, where
we landed, and exactly what's left to do.

## The original goal

Turn `achat` from "code in a repo" into "a live URL you can hand an
interviewer." That's it. Everything below is just working out *how*.

## Why this got complicated: three moving pieces, not one

Deploying this app means deciding three separate things, and each one
constrains the others:

1. **Where does the code run?** (hosting)
2. **Does it run on CPU or GPU?** (speed — GPT-2/Qwen/SmolLM2 generate text
   much faster on GPU, but free GPU is hard to get)
3. **Does it get a real HTTPS URL, or a bare IP?** (this turned out to be
   forced by decision #1, not optional — see below)

We kept re-opening decision 1-2 because the first plan (Hugging Face Spaces,
CPU-only, free) was working, until you mentioned you have **40 min/day of
ZeroGPU quota** and **$100 in AWS credits**. Both are real resources worth
using — but each one drags in new constraints, which is why the questions
kept multiplying. Let's walk through every option that got discussed and why
each was kept or dropped.

---

## Option A: Hugging Face Spaces, CPU only (the original plan)

**What it is:** one Docker container, your existing FastAPI + React app,
running on HF's free CPU tier.

**Status:** almost done. We built the Dockerfile, production config, SPA
serving, Neon Postgres connection, Google OAuth — all of it works today in
local testing. The one unfinished piece: `torch` in `backend/pyproject.toml`
resolves to the CUDA build, making the Docker image 15.8GB when it should be
~3GB on a CPU-only box. That's a 10-minute fix (point uv at the CPU wheel
index) that we started and paused.

**Tradeoff:** CPU inference is slow — GPT-2's replies stream at maybe 5-15
tok/s on a shared free CPU, versus 50-100+ tok/s on a GPU. Functionally
complete, just not fast.

**Why we moved on from finishing this first:** you mentioned the ZeroGPU
quota mid-conversation, and it seemed worth checking before finishing the
CPU path. In hindsight — this was a reasonable thing to check, but we should
have finished option A as a working baseline *first*, then explored GPU
as a separate upgrade. That's the mistake in how I ran this: I let "let's
check if something better is possible" block "let's ship the thing that
already works."

---

## Option B: HF Spaces + ZeroGPU (explored, then ruled out)

**What it is:** HF's ZeroGPU gives free, quota-metered *real* GPU time (your
40 min/day), but only through a specific programming model: a Python
function decorated `@spaces.GPU`, called from a **Gradio** app. It is not a
GPU you attach to an arbitrary long-running server.

**Why it doesn't fit this app directly:** your FastAPI backend is a
persistent process — it holds a database connection pool, serves the React
SPA, handles login sessions, and streams tokens over Server-Sent Events. GPU
Spaces expect short, bounded function calls, not "hold a GPU across an
open-ended server process." You cannot just drop `@spaces.GPU` into
`app.py`.

**The workaround we designed:** split into two Hugging Face Spaces —

- **Space 1 (unchanged):** your FastAPI + React app, CPU-only, does auth,
  Postgres, serving the UI.
- **Space 2 (new):** a small Gradio app on ZeroGPU that *only* does model
  generation. Space 1 calls Space 2 over the network (via `gradio_client`)
  for every message, streams the tokens back through its own SSE endpoint.

This is a legitimate, real-world pattern (separating an API tier from an
inference tier is literally what large-scale LLM serving looks like in
industry — your own `docs/ROADMAP.md` "future-state" section already
describes this exact split as the eventual target). It's a good story for an
interview.

**Why we didn't build it:** it's a genuinely bigger change than "deploy the
thing" — new Space, new client integration, the Stop button's cancellation
mechanism has to change (a `threading.Event` can't cross a network
boundary), and ZeroGPU calls are time-capped (~60-120s), which constrains
how long a single reply can take. You paused here to ask if there was a
simpler way to get GPU without restructuring the app — which was the right
question to ask, and led to option C.

---

## Option C: AWS EC2 with a GPU instance (where we are now)

**What it is:** rent an actual GPU virtual machine from AWS, run your
existing Docker container on it exactly as-is — no architecture change, no
splitting into two services. Your Dockerfile already checks
`torch.cuda.is_available()`, so it will automatically use the GPU if one is
present. This is the *simplest* architecture of all three options — it's
just no longer free.

**What it costs:** GPU instances are billed per hour, no free tier.
- `g4dn.xlarge` (1x NVIDIA T4, 16GB VRAM): ~$0.53/hour
- Your AWS credit balance (confirmed from your screenshot): **$100**,
  expiring **Feb 22, 2027**
- $100 ÷ $0.53/hr ≈ **190 hours** of GPU time total

**Why "start/stop around demos" instead of leaving it on:** left running
24/7, $100 lasts about 8 days. Started only before an interview/demo and
stopped after, $100 can realistically last the whole placement season. You
already agreed to this pattern. It does mean the URL isn't live 24/7 — it's
live when you turn it on. That's a normal, explainable tradeoff ("I manage
GPU lifecycle to control cost" is a fine thing to say to an interviewer).

**The domain problem this creates:** EC2 instances get a new public IP every
time you stop and restart them (unless you attach an Elastic IP, which is
free *while attached to a running instance*). Since we're stopping/starting
around demos, we need an Elastic IP so the URL doesn't change every time —
otherwise you'd have to hand out a new link before every interview.

**The frontend-hosting tangent:** you asked about GitHub Pages, then
Vercel, for hosting the React frontend separately from the backend.

- **GitHub Pages**: ruled out — it only serves static files, cannot run
  Python/FastAPI/database connections at all. Would only ever host the
  frontend half.
- **Vercel**: a real, good option — free, instant HTTPS, exactly the kind of
  thing companies actually use. But splitting frontend (Vercel) and backend
  (EC2) onto different domains breaks your login cookie. Your JWT cookie is
  `httpOnly` + `SameSite=Lax`, which browsers refuse to send on cross-origin
  requests. Fixing that means `SameSite=None; Secure` — and browsers refuse
  *that* unless the cookie's origin (the backend) is served over real HTTPS,
  not a bare `http://<ip>:7860`.

  **This is why the HTTPS/domain question suddenly became mandatory instead
  of optional** — it wasn't optional polish anymore once Vercel was in the
  picture, it became a hard requirement for login to work at all.

- **Where we landed:** get a free subdomain (e.g. DuckDNS gives you
  something like `achat.duckdns.org` for free), point it at the EC2
  instance's Elastic IP, run Caddy (or nginx) in front of FastAPI for
  automatic free TLS via Let's Encrypt. This gets you real HTTPS at zero
  cost, and keeps the door open to still do the Vercel split later if you
  want — but it also means you *don't have to*: this same setup works fine
  as a single-origin deploy (FastAPI serving the built React app directly,
  like your current Dockerfile already does), with no cross-origin cookie
  problem at all.

---

## Where this actually stands right now

We were mid-way through one more fact-finding step — checking whether your
AWS account's **GPU instance quota** is 0 (new AWS accounts often start
blocked from launching GPU instances until you request a limit increase,
which can take AWS anywhere from minutes to about a day to approve). That
question got interrupted by you asking for this explanation, which is a
completely fair thing to want before answering more questions.

### The decisions actually locked in so far:
1. GPU via **AWS EC2** (`g4dn.xlarge` or similar), not ZeroGPU — keeps your
   current single-container architecture unchanged.
2. **Start/stop around demos**, not always-on — stretches the $100 credit.
3. **Free subdomain + Let's Encrypt** for HTTPS on the backend, not a bare
   IP — because it's needed either way (interview-friendly URL, and a
   prerequisite if you ever want the Vercel split).
4. Frontend/backend split (Vercel) — **discussed, not committed.** The
   simpler and currently-recommended default is still: FastAPI serves the
   built React app itself, same origin, on the EC2 box behind the subdomain.
   Vercel is an optional later upgrade, not a requirement.

### What's actually left to do, in order:
1. **You check the EC2 GPU quota** (Service Quotas console → EC2 → "Running
   On-Demand G and VT instances"). This determines whether we can launch
   today or need to file a quota increase request first.
2. **Launch the EC2 instance** (Deep Learning AMI has CUDA/Docker
   preinstalled, saves setup work) + attach an Elastic IP.
3. **Set up the free subdomain** (DuckDNS or similar) pointing at that
   Elastic IP.
4. **Deploy the app** — clone the repo onto the instance, add a reverse
   proxy (Caddy, for automatic TLS) in front of the existing Dockerfile, set
   the `.env` secrets (same three as the HF Spaces plan: `DATABASE_URL`,
   `JWT_SECRET`, `ENVIRONMENT=production`), `docker build && docker run`.
5. **Write a start/stop script** so turning the GPU on/off before a demo is
   one command, not a console click-through.
6. **Rotate the Neon database password** — flagged since an earlier session
   and still outstanding, since it was pasted into a chat at one point.
7. *(Optional, later)* Move the frontend to Vercel if you want the faster
   iteration/preview-deploy workflow it gives you — not required for a
   working deploy.

### What's still sitting half-finished from the original CPU plan:
The `torch` CPU-wheel fix for HF Spaces is now moot if we're going the EC2
GPU route (a GPU box *should* have the CUDA build of torch — that's the
whole point). If EC2 falls through for any reason (quota denied, etc.), the
HF Spaces CPU path is still the fallback and is genuinely ~10 minutes from
done.

---

## My mistake in how I ran this

I should have either (a) finished the CPU Spaces deploy first as a working
baseline before entertaining GPU options, or (b) asked you up front "do you
want to explore paid/quota-based GPU options before I finish the free CPU
path, knowing it'll mean more back-and-forth?" instead of chaining five
back-to-back multiple-choice questions once you mentioned ZeroGPU. Slower,
more deliberate would have served you better here.
