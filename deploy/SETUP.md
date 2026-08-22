# EC2 deploy setup — one-time steps

Run these in order. Steps 1-2 are console clicks only you can do (I don't
have AWS access). Everything after step 2 I can drive once you give me the
values this generates.

## 1. Check GPU quota (do this first — blocks everything else if it fails)

AWS Console → **Service Quotas** → search "EC2" → click **Amazon Elastic
Compute Cloud (Amazon EC2)** → find **"Running On-Demand G and VT
instances"** in that service's quota list → note the **Applied quota**
value (in vCPUs).

- **Non-zero** (e.g. 4 or more): you can launch a `g4dn.xlarge` (needs 4
  vCPUs) today. Continue to step 2.
- **Zero**: request an increase from that same page (button: "Request
  increase at account level"). Ask for at least 4. AWS approval can take
  anywhere from minutes to ~24 hours. You'll get an email when it's
  approved — come back here once it is.

## 2. Launch the instance

EC2 Console → **Launch instance**:

- **AMI**: search "Deep Learning AMI" (specifically one with "Base" and
  "GPU" and "Ubuntu" or "Amazon Linux" in the name — it comes with
  NVIDIA drivers, CUDA, and Docker preinstalled, saving a lot of manual
  setup). If in doubt about exact naming, screenshot the search results and
  I'll tell you which one to pick.
- **Instance type**: `g4dn.xlarge` (4 vCPU, 16GB RAM, 1x T4 GPU, ~$0.53/hr)
- **Key pair**: create a new one, name it something like `achat-deploy`,
  **download the .pem file and don't lose it** — AWS won't let you
  re-download it later.
- **Network settings → Security group**: allow inbound
  - SSH (port 22) — source: "My IP" (not 0.0.0.0/0 — no reason to expose
    SSH to the whole internet)
  - HTTP (port 80) — source: Anywhere (needed for the Let's Encrypt
    challenge and the HTTPS redirect)
  - HTTPS (port 443) — source: Anywhere
  - Leave port 7860 **closed** to the public — nginx is the only thing
    that should reach it, and it does that over `127.0.0.1` (localhost),
    not the public interface (see `deploy/deploy.sh`'s `-p 127.0.0.1:7860:7860`).
- **Storage**: bump to at least 40GB (the default 8-30GB may be tight once
  the Docker image + model cache + system packages are on disk).
- Launch it.

Once it's running, note down and send me:
- **Instance ID** (looks like `i-0123456789abcdef0`)
- The **region** you launched it in (e.g. `us-east-1`)

## 3. Attach an Elastic IP

EC2 Console → **Elastic IPs** → **Allocate Elastic IP address** → allocate
one → select it → **Actions → Associate Elastic IP address** → pick your
instance.

This IP stays the same across stop/start cycles (a bare instance's public IP
does not). Note it down — this is what the subdomain will point at.

**Cost note**: an Elastic IP is free *while attached to a running instance*.
AWS charges a small hourly fee if it's allocated but the instance is
stopped, or if it's unattached. Since we're stopping the instance between
demos, you'll see a tiny charge during stopped periods — a few cents, not
worth worrying about, but release the IP entirely if you ever tear this down
for good.

## 4. Free subdomain

Go to [duckdns.org](https://www.duckdns.org), sign in (GitHub/Google login),
pick a subdomain (e.g. `achat` → `achat.duckdns.org`), point it at your
Elastic IP from step 3.

Tell me the subdomain you picked and I'll fill it into
`deploy/nginx/achat.conf` (currently has `DOMAIN` as a placeholder) and the
OAuth/CORS config that needs to know the real production URL.

## 5. IAM user for GitHub Actions

IAM Console → **Users → Create user** → name it `achat-deploy-bot` → **no
console access needed**, programmatic only → attach a custom policy (not an
AWS-managed one — this should only ever be able to start/stop/describe your
one instance):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:StartInstances",
        "ec2:DescribeInstances"
      ],
      "Resource": "*"
    }
  ]
}
```

(`Resource: "*"` is broader than ideal — EC2's IAM conditions don't let you
scope `StartInstances` to one instance ID as cleanly as other services, so
this is the practical tradeoff. It still can't do anything except start
instances and read their state — no stop, no terminate, no launch, no
access to any other AWS service.)

Create an **access key** for this user (Security credentials tab →
Create access key → "Third-party service" use case). Save the Access Key ID
and Secret Access Key — the secret is only shown once.

## 6. GitHub repo secrets

Repo → **Settings → Secrets and variables → Actions → New repository
secret**, add all of these:

| Secret name | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | from step 5 |
| `AWS_SECRET_ACCESS_KEY` | from step 5 |
| `AWS_REGION` | e.g. `us-east-1`, from step 2 |
| `EC2_INSTANCE_ID` | from step 2 |
| `EC2_SSH_USER` | `ubuntu` (Ubuntu AMI) or `ec2-user` (Amazon Linux AMI) — depends what you picked in step 2 |
| `EC2_SSH_PRIVATE_KEY` | the full contents of the `.pem` file from step 2 |

## 7. First-time server setup (SSH in manually, once)

```bash
ssh -i achat-deploy.pem ubuntu@<elastic-ip>   # or ec2-user@ for Amazon Linux

# clone the repo
git clone https://github.com/Aatman09/gpt2-inference-engine.git ~/achat
cd ~/achat

# the three production secrets -- same three as the HF Spaces plan, this
# file is never committed (see .dockerignore's **/.env)
cat > .env <<'EOF'
DATABASE_URL="<your Neon connection string, postgresql+asyncpg://...>"
JWT_SECRET="<a random 64-char hex string>"
ENVIRONMENT="production"

# only needed if Google sign-in is configured -- omit both and the button
# just stays hidden (see AuthScreen.jsx's google_enabled check)
GOOGLE_CLIENT_ID="<from Google Cloud Console, if using Google sign-in>"
GOOGLE_CLIENT_SECRET="<same>"
# MUST match the redirect URI registered in Google Cloud Console exactly --
# swap in your real subdomain from step 4, and note it's https:// here,
# not http:// like the local-dev default in .env.example
GOOGLE_REDIRECT_URI="https://<your-subdomain>/auth/google/callback"
EOF

# verify Docker can actually see the GPU -- if this fails, the app will
# still start but silently fall back to CPU (torch.cuda.is_available() just
# returns False, no error), which is a confusing thing to debug later.
# Deep Learning AMIs usually have the NVIDIA Container Toolkit preinstalled;
# if this command fails, install it: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi

# install nginx + certbot (Deep Learning AMI has Docker already; this adds
# the reverse proxy pieces)
sudo apt-get update && sudo apt-get install -y nginx certbot python3-certbot-nginx

# put the proxy config in place -- DOMAIN placeholder gets swapped for real
# once you've told me the subdomain from step 4
sudo cp deploy/nginx/achat.conf /etc/nginx/sites-available/achat.conf
sudo ln -s /etc/nginx/sites-available/achat.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# issue the real certificate -- this also rewrites achat.conf's HTTP block
# to redirect to HTTPS automatically
sudo certbot --nginx -d <your-subdomain>

# first deploy, by hand
bash deploy/deploy.sh
```

After this, every `git push` to `main` triggers the GitHub Actions workflow
automatically — no more manual SSH needed for routine updates.

## Rotate the Neon password

Flagged from an earlier session and still outstanding: the Neon connection
string (including its password) was pasted into a chat at one point. Once
this deploy is verified working end to end, rotate it in the Neon dashboard
(Connection Details → Reset password) and update the `.env` on the box.
