# Provisioning runbook — Hetzner (the recommended path)

Target: **CX32-class VPS (~€8/mo, 4 vCPU / 8 GB / 80 GB)**, x86 or ARM (CAX21)
— the stack is multi-arch. This is the path public docs recommend: reference
infrastructure must not depend on a free tier's goodwill (the prototype's
Oracle box is documented in [deploy/oracle-free.md](./oracle-free.md)).

Same discipline: **backup bucket on a different provider than the box** (B2 or
R2 pair well with Hetzner; Hetzner object storage is fine if the *box* is
elsewhere). I4 makes the box disposable.

## ⛔ Human-first steps (~10 min)

1. Hetzner Cloud account; create a project.
2. Add your SSH key; create the server: **CX32, Ubuntu 24.04 LTS**, enable
   backups off (we have our own), pick a region near you.
3. **Hetzner Cloud Firewall** attached to the server (the outer perimeter):
   inbound **TCP 22, TCP 80, TCP 443, UDP 443**; nothing else.
4. DNS: `A setoku.<domain> → <server IP>`.

## Host setup (10 min)

```bash
ssh root@<ip>
adduser --disabled-password --gecos "" setoku
mkdir -p /home/setoku/.ssh && cp ~/.ssh/authorized_keys /home/setoku/.ssh/ \
  && chown -R setoku:setoku /home/setoku/.ssh

curl -fsSL https://get.docker.com | sh
usermod -aG docker setoku

apt-get update && apt-get install -y ufw fail2ban unattended-upgrades
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
dpkg-reconfigure -plow unattended-upgrades

mkdir -p /var/log/setoku /opt/setoku && chown setoku /var/log/setoku /opt/setoku
```

## Stack (5 min)

```bash
sudo -iu setoku
git clone https://github.com/Hedgy-Labs/setoku /opt/setoku && cd /opt/setoku
cp .env.example .env && nano .env   # domain, secrets (openssl rand -hex 24), bucket
# 8 GB box → keep the default SETOKU_CH_PRESET=small
docker compose up -d --wait
curl -s https://setoku.<domain>/healthz
crontab deploy/backup/cron.example
```

## Verify (the ACs)

Identical to the Oracle runbook's verify section: outside port scan shows only
22/80/443; tokenless ingest → 401, valid token → row in `setoku.ingest_raw`;
external uptime pinger on `/healthz`; run the restore drill for real; 24 h soak
with zero OOM kills — **this 8 GB box on the `small` preset is the
constraining case the preset is tuned for.**
