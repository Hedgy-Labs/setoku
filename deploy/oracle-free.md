# Provisioning runbook — Oracle Cloud Always Free (the prototype path)

Target: `VM.Standard.A1.Flex`, **4 OCPU / 24 GB / ~150 GB**, $0/mo, arm64.
The whole Setoku stack is arm64-clean. The *recommended* path for users is a
Hetzner-class VPS ([deploy/hetzner.md](./hetzner.md)) — reference infrastructure
must not depend on a free tier's goodwill; this doc is how the prototype runs.

**The discipline, bluntly:** the backup bucket lives on a **different
provider** than this box (B2/R2/Hetzner object storage). I4 makes the box
disposable — treat it that way. If Oracle reclaims or breaks it, you rebuild in
30 minutes from this doc plus the bucket (`deploy/backup/restore-drill.sh`).

## ⛔ Human-first steps (no agent, ~15 min + card verification)

1. **Tenancy signup** at cloud.oracle.com. **Pick the home region deliberately**
   — always-free A1 capacity provisions *only* in your home region, chosen
   forever at signup. From LA: `us-sanjose-1` or `us-phoenix-1` are sensible.
2. **Convert the tenancy to Pay-As-You-Go** (Billing → Upgrade and Manage
   Payment). This fixes the A1 "out of capacity" lottery and exempts the
   instance from idle reclamation. Expect a temporary card-verification hold.
   You will still pay $0 while inside the always-free allowance.
3. **Budget alert ~$1** (Billing → Budgets) — pages you if anything ever bills.

## Instance (10 min)

4. Compute → Create instance: **VM.Standard.A1.Flex, 4 OCPU, 24 GB**,
   **Ubuntu 24.04 LTS (aarch64)**, your SSH public key. Boot volume ≥100 GB
   (the 200 GB always-free block allowance covers boot + data).
5. **Reserved public IP** (Networking → Reserved IPs, then attach): the box can
   be rebuilt without DNS churn.
6. **OCI Security List** for the subnet (this is the real perimeter — OCI's
   default rules, not the OS firewall): ingress **TCP 22, TCP 443, UDP 443**
   (HTTP/3) — and TCP 80 if you want ACME HTTP-01 + redirects — from 0.0.0.0/0.
   Nothing else. Egress: allow all.
7. DNS: `A setoku.<domain> → <reserved IP>`.

## Host setup (10 min)

```bash
ssh ubuntu@<ip>
# deploy user
sudo adduser --disabled-password --gecos "" setoku
sudo usermod -aG docker setoku 2>/dev/null || true
sudo mkdir -p /home/setoku/.ssh && sudo cp ~/.ssh/authorized_keys /home/setoku/.ssh/ \
  && sudo chown -R setoku:setoku /home/setoku/.ssh

# docker + compose plugin (official convenience script is fine here)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker setoku

# host firewall — defense in depth BEHIND the OCI security list.
# Ubuntu images on OCI ship iptables REJECT rules; ufw is cleaner to manage:
sudo apt-get update && sudo apt-get install -y ufw fail2ban unattended-upgrades
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable
sudo dpkg-reconfigure -plow unattended-upgrades   # accept

sudo mkdir -p /var/log/setoku && sudo chown setoku /var/log/setoku
```

## Stack (5 min)

```bash
sudo -iu setoku
sudo mkdir -p /opt/setoku && sudo chown setoku /opt/setoku
git clone https://github.com/Hedgy-Labs/setoku /opt/setoku && cd /opt/setoku
cp .env.example .env && nano .env   # domain, secrets (openssl rand -hex 24), bucket
echo 'SETOKU_CH_PRESET=roomy' >> .env   # this is the 24 GB box
docker compose up -d --wait
curl -s https://setoku.<domain>/healthz   # expect {"ok":true,...}
crontab deploy/backup/cron.example        # edit paths first if not /opt/setoku
```

## Verify (the ACs)

- **Port scan from outside** (I1): `nmap -p- <ip>` from your laptop → only
  22 and 443 (and 80 if opened) respond. 5432/8123 must be unreachable.
- `curl -X POST https://setoku.<domain>/ingest/events` without a token → 401;
  with `Authorization: Bearer $SETOKU_INGEST_TOKEN` → 200 and a row in
  `setoku.ingest_raw`.
- Register `https://setoku.<domain>/healthz` with an **external** uptime pinger
  (the box cannot report its own death).
- Within the first week: run `deploy/backup/restore-drill.sh` on a scratch VM
  **for real**, and watch a 24 h soak on the lake (`docker stats`, zero OOM
  kills — the `small` preset on Hetzner is the constraining case).
