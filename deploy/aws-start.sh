#!/usr/bin/env bash
# Starts the EC2 instance if it's stopped, and blocks until SSH is actually
# reachable -- not just until AWS reports the instance state as "running",
# which happens well before sshd inside it has finished booting.
#
# Run locally (needs AWS CLI configured with your credentials) before a demo,
# or by .github/workflows/deploy.yml before it tries to SSH in and deploy.
#
# Requires: INSTANCE_ID env var (or pass as $1), aws CLI, an SSH key that
# matches the instance's key pair.
set -euo pipefail

INSTANCE_ID="${1:-${INSTANCE_ID:-}}"
if [ -z "$INSTANCE_ID" ]; then
  echo "usage: INSTANCE_ID=i-xxxxxxxx ./aws-start.sh  (or pass as first arg)" >&2
  exit 1
fi

STATE=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)

if [ "$STATE" = "running" ]; then
  echo "==> instance already running"
else
  echo "==> starting instance (was: $STATE)"
  aws ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
  echo "==> waiting for instance state: running"
  aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
fi

PUBLIC_IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "==> public IP: $PUBLIC_IP"

echo "==> waiting for SSH to accept connections"
for i in $(seq 1 30); do
  if nc -z -w2 "$PUBLIC_IP" 22 2>/dev/null; then
    echo "==> SSH is up"
    echo "$PUBLIC_IP"
    exit 0
  fi
  sleep 5
done

echo "==> SSH did not come up within 150s" >&2
exit 1
