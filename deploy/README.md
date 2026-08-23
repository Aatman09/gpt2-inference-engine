# What we did — the EC2 deploy, explained

This is a plain-language walkthrough of everything we set up to get `achat`
running on a real server with a real URL. If you're reading this later and
forgot why some piece exists, this is the place to look.

## The big picture

We're running your app on a **rented computer** (an AWS EC2 instance)
instead of your laptop. That computer needs:

1. To exist and be reachable on the internet (the instance itself, plus a
   fixed address)
2. A stable web address people can type instead of a raw IP number (the
   subdomain)
3. A way to keep it secure (HTTPS/TLS, so traffic is encrypted)
4. A way to actually get your code running on it (Docker, plus nginx to
   route traffic to it)
5. A way to update it later without SSHing in by hand every time (GitHub
   Actions)

Each section below is one of those pieces.

## 1. The EC2 instance itself

An EC2 instance is just a virtual computer AWS rents you by the hour. We
picked **Amazon Linux 2023** as the operating system and, for now, a small
free-tier CPU instance (`t3.micro`) to prove the whole pipeline works before
spending real money on a GPU one later.

**Why CPU first, GPU later:** the GPU instance type (`g4dn.xlarge`) needs a
quota AWS grants manually, and that got denied on first request (a normal
anti-abuse thing new accounts hit, not something wrong with your account —
we appealed it, still pending). Rather than sit blocked, we're proving out
everything else — nginx, HTTPS, the deploy pipeline — on a plain CPU
instance that needs no special permission at all. When the GPU quota
clears, swapping is just launching a new instance with a bigger type; none
of the setup below changes.

## 2. The Elastic IP — why a "normal" IP isn't good enough

Every time you stop and restart an EC2 instance, AWS normally hands it a
**new** public IP address. That's a problem for us because our whole plan
is "stop the server when not demoing it, start it before an interview" —
if the address changed every time, you'd have to give interviewers a new
link constantly.

An **Elastic IP** is a fixed address you reserve once and attach to your
instance. It stays the same no matter how many times you stop/start the
instance. Yours: `98.95.14.151`.

(Small cost note: Elastic IPs are free *while attached to a running
instance*, but AWS charges a tiny fee — a few cents — for the hours the
instance is stopped but the IP is still reserved. Not worth worrying about
at this scale.)

## 3. The subdomain — why we need a name, not just a number

`98.95.14.151` works as a web address, but nobody wants to memorize or
share a raw IP, and it looks unprofessional on a CV. We used **DuckDNS**, a
free service that gives you a subdomain (`cachegpt.duckdns.org`) and lets
you point it at any IP address you want — in our case, the Elastic IP above.

Think of DNS (Domain Name System) as the internet's phone book: when
someone types `cachegpt.duckdns.org` into a browser, their computer asks
"what IP does this name point to?", gets back `98.95.14.151`, and connects
there. DuckDNS is just a free, simple version of that phone-book entry.

## 4. HTTPS / TLS — what a certificate actually is, and why we need one

Right now, if someone visits `http://cachegpt.duckdns.org`, their
connection to your server is **unencrypted** — anyone on the same network
could theoretically read what's being sent, including login passwords. This
also breaks modern browser security features and looks untrustworthy
(browsers actively warn "Not Secure").

**HTTPS** fixes this, but understanding *how* means understanding what a
certificate actually is: two mathematically linked files, a **private key**
(`privkey.pem`) that only your server ever holds, and a **public
certificate** (`fullchain.pem`) that anyone can see. The certificate
contains your domain name and is **digitally signed** by a Certificate
Authority (here, Let's Encrypt) — a signature the browser can independently
verify without ever contacting Let's Encrypt itself, because your browser
already trusts Let's Encrypt's own signing key (that trust ships baked into
every OS/browser).

Two separate things happen when someone visits your `https://` site:

1. **Identity check** — the browser reads the certificate, verifies Let's
   Encrypt's signature on it, and confirms the domain name inside it
   matches the address bar. This is what stops someone from impersonating
   your site.
2. **Encryption setup** — the browser and server use the certificate's
   public key to agree on a temporary, one-time encryption key for that
   specific connection (this handshake is why the very first request to a
   new HTTPS site takes an extra moment). Everything sent afterward —
   your login form, your chat messages — is scrambled to anyone
   intercepting it, only the two ends of that connection can read it.

The private key is what makes this secure: anyone who steals it could
impersonate your server, which is exactly why it lives only on the box
(`/etc/letsencrypt/live/cachegpt.duckdns.org/privkey.pem`), is never
committed to git, and is one of the two files nginx loads to actually serve
HTTPS.

Getting a certificate normally costs money or requires manual renewal every
90 days. We used **Let's Encrypt**, a free certificate authority, via a
tool called **certbot**. Certbot does two things automatically: it proves
to Let's Encrypt that you actually control the domain (by briefly serving a
special file that only the real server could serve), and it gets you a
certificate valid for 90 days — plus it can auto-renew before it expires.

**A real detour worth remembering:** on our first `certbot --nginx` run,
certbot successfully got the certificate — the private key and certificate
files were genuinely issued and saved to disk — but failed the *last* step,
"install it into nginx automatically," with "could not automatically find
a matching server block." This wasn't a real failure of the certificate
itself, just certbot's nginx-editing step getting confused, because at that
moment nginx was still running its plain default config (we hadn't put our
own `achat.conf` in place yet, since it had a chicken-and-egg problem — see
below). The fix was simple once we understood it: the certificate files
already existed at the right paths, so we just copied our own
`achat.conf` (which already knows the exact right paths) back into place
and reloaded nginx — no need for certbot's auto-install step at all.

**The chicken-and-egg problem, explained:** our `achat.conf` references the
certificate files by their expected final path
(`/etc/letsencrypt/live/cachegpt.duckdns.org/fullchain.pem`). But nginx
*validates its entire config* before it will even start — including
checking that every certificate file it references actually exists. Before
certbot ran, that file didn't exist yet, so nginx refused to start at all
with our config in place — not just refuse to reload, refuse to *start*.
And certbot's nginx plugin needs nginx already running to do its
domain-ownership check. So: our config needs the certificate to exist to
start, but certbot needs nginx started to get the certificate. We broke the
cycle by temporarily removing our config, letting nginx start with its
harmless plain default, getting the certificate that way, then putting our
real config back in — now valid, since the files it needs finally exist.

## 5. nginx — the traffic director

Your actual app (FastAPI + the built React frontend) runs inside a Docker
container, listening only on `127.0.0.1:7860` — meaning it's **not**
directly reachable from the internet, only from other things running on the
same machine. This is deliberate: nothing external should be able to hit
your app directly, bypassing HTTPS.

**nginx** sits in front of it and does the actual internet-facing work:

- Listens on the real HTTPS port (443) and the plain HTTP port (80)
- Holds the TLS certificate from certbot and handles all the encryption/
  decryption
- Forwards (`proxy_pass`) real requests to the app container's internal
  address (`127.0.0.1:7860`)
- Redirects any plain `http://` visitor straight to `https://`, so nobody
  accidentally uses the unencrypted version

This pattern — a small, fast, well-tested proxy in front of your actual
application — is standard practice, not unique to this project. The reason
your app itself doesn't handle HTTPS directly is that certificate
management, redirects, and connection handling are exactly the kind of
thing you don't want to hand-roll in your own code when a battle-tested
tool already does it.

**One specific setting worth knowing:** your app streams chat replies
token-by-token (Server-Sent Events, or SSE) so the user sees text appear
live instead of waiting for the whole reply. nginx normally *buffers*
responses — collects a chunk before forwarding it — which would turn that
smooth live-typing effect into words arriving in bursts. We turned buffering
off (`proxy_buffering off`) specifically so streaming stays smooth.

## 6. Docker — how the app actually runs

Docker packages your entire app (Python, all its dependencies, the built
frontend, everything) into one self-contained unit called an **image**,
which then runs as a **container** — an isolated running instance of that
image. The advantage: "it works on my machine" stops being a problem,
because the container carries its own complete environment; it behaves
identically on your laptop, on this EC2 box, or anywhere else Docker runs.

Your `Dockerfile` builds this in two stages: first it builds the React
frontend (turns your source code into static HTML/CSS/JS files), then it
sets up Python, installs all backend dependencies, and copies the built
frontend files in so FastAPI can serve them directly. The result is one
image containing everything needed to run the whole app.

**Another real detour: "permission denied" talking to Docker.** Running
`deploy.sh` first failed with:

```
ERROR: permission denied while trying to connect to the Docker daemon
socket at unix:///var/run/docker.sock: ... connect: permission denied
```

Docker on Linux runs as a background service (the **daemon**) controlled
through a special file called a **socket**
(`/var/run/docker.sock`) — every `docker` command you type is really just
a message sent through that file to the daemon, which does the actual
work. By default, only the `root` user (or anyone using `sudo`) can write
to that socket. Since `deploy.sh` runs plain `docker build`/`docker run`
without `sudo`, it needs your regular user (`ec2-user`) to be allowed to
use that socket too — which is exactly what the **`docker` group** is for:
anyone added to it gets that permission, without needing `sudo` for every
single Docker command.

The setup steps included `sudo usermod -aG docker ec2-user` for exactly
this reason — but adding a user to a group only takes effect for **new**
login sessions, not the one you're already in when you run the command.
This tripped us up twice: first, we reconnected but the error persisted,
which turned out to mean the `usermod` command itself hadn't actually
applied (checked with `getent group docker`, which showed the group with
no members listed at all — `docker:x:993:` with nothing after the last
colon). Re-running `sudo usermod -aG docker ec2-user` and confirming with
`getent group docker` again (this time showing `docker:x:993:ec2-user`)
proved it actually took. Only *then* did disconnecting and reconnecting
with a fresh SSH session pick up the new group membership and let
`deploy.sh` talk to Docker without `sudo`.

**The lesson, generalized:** a Linux group change never applies to a shell
session that was already open when you made it — always verify the change
actually happened (`getent group <name>`) before assuming a fresh login
will fix things, since re-logging in only helps if the underlying change
actually took effect in the first place.

## 7. `deploy.sh` — putting it all together

This script is what actually updates the running app. Every time it runs,
it:

1. Pulls the latest code from GitHub (`git fetch` + `git reset --hard`)
2. Rebuilds the Docker image with that new code
3. Stops the old running container and starts a new one from the fresh
   image
4. Waits and checks the app actually responds before declaring success

**One detail worth knowing:** it automatically detects whether the machine
has a GPU (by checking if the `nvidia-smi` tool exists) and builds the
image differently depending on the answer — a GPU machine gets the full
CUDA-enabled version of PyTorch, a CPU-only machine gets a much smaller
CPU-only version. This is why the exact same script works on this small
test instance today and on the real GPU instance later, with zero changes
needed.

**Why we needed this fix in the first place:** PyTorch's default install
bundles GPU support libraries even when there's no GPU to use — like
carrying a full toolbox everywhere even when you only ever use one
screwdriver. That was making our Docker image an unnecessarily huge 15.8GB.
Splitting the CPU and GPU versions apart brought it down to 2.76GB on a
CPU-only build.

## 8. GitHub Actions — deploying without SSHing in every time

Right now, we're SSHing into the server by hand to set it up for the first
time. But going forward, the plan is: every time you `git push` to `main`
on GitHub, a workflow automatically:

1. Starts the EC2 instance if it's currently stopped (since we're not
   leaving it running 24/7, to save cost)
2. Waits until it's actually reachable
3. Connects over SSH and runs `deploy.sh` for you

This means updating the live app becomes "push my code" — no manual server
work needed after this initial setup. Doing this safely required a
dedicated, narrowly-permissioned AWS user (see below) whose only power is
starting this one instance — nothing else.

## 9. The IAM user — a key with only one door it can open

To let GitHub Actions start your EC2 instance automatically, it needs some
AWS credentials. Rather than giving it your own full AWS login (which could
do *anything* in your account — delete resources, spend money, change
settings), we created a separate, restricted **IAM user** whose permissions
are limited to exactly two things: start this one instance, and check its
status. It cannot stop it, terminate it, create new instances, or touch any
other AWS service. If those credentials ever leaked, the blast radius is
tiny — starting an instance you already own, nothing more.

## 10. The SSH key and file permissions

To connect to the server securely, you use a **private key** file
(`achat-deploy.pem`) instead of a password. This key is proof of identity —
anyone holding it can log in as you, which is why SSH refuses to even use
it if the file's permissions are too loose (readable by other users on your
own machine, not just you). Running `chmod 400` on it locks it down to
"only you can read this, nobody can write to it, not even you" — the
strictest setting, and the only one SSH will accept for a private key.

## Where things stand right now

- EC2 instance running (CPU test instance, `t3.micro`)
- Elastic IP attached (`98.95.14.151`)
- Subdomain pointing at it (`cachegpt.duckdns.org`)
- nginx installed and configured to proxy to the app
- Docker installed
- Working through: issuing the real TLS certificate via certbot, then the
  first actual deploy

## Still ahead

- Finish certbot (real HTTPS certificate)
- Run `deploy.sh` for the first time — this builds and starts the actual
  app
- Set up the IAM user + GitHub secrets so future pushes deploy automatically
- Once everything's verified working: swap the CPU test instance for the
  real GPU instance (same steps, bigger instance type) once the AWS quota
  appeal clears
- Rotate the Neon database password (its connection string was exposed in
  an earlier chat, flagged as outstanding since)

See `deploy/SETUP.md` for the exact commands, in order.
