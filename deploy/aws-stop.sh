#!/usr/bin/env bash
# Stops the EC2 instance after a demo -- billing for compute stops the
# moment the instance state becomes "stopped" (the attached Elastic IP, if
# you set one up per SETUP.md step 3, keeps its own small idle charge if the
# instance stays stopped for a long time -- release it if you're done for good,
# keep it if you'll restart within a few days).
#
# Run this locally right after you're done demoing, so the $100 credit isn't
# burned by an instance left running overnight.
set -euo pipefail

INSTANCE_ID="${1:-${INSTANCE_ID:-}}"
if [ -z "$INSTANCE_ID" ]; then
  echo "usage: INSTANCE_ID=i-xxxxxxxx ./aws-stop.sh  (or pass as first arg)" >&2
  exit 1
fi

echo "==> stopping instance $INSTANCE_ID"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
echo "==> stopped"
