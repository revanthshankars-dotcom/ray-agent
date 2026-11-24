# RAY on a free Oracle Cloud server

Render's free plan sleeps and wipes local files. Oracle Cloud's **Always Free** tier gives you a
small always-on Linux server at no cost (Arm A1: up to 2 OCPUs and 12 GB RAM, 200 GB disk,
10 TB/month traffic). RAY runs there 24/7 and keeps its memory on the VM's disk.

## 1. Create the server (about 15 minutes, once)

1. Sign up at **cloud.oracle.com** (a card is needed for identity checks; Always Free resources are not charged). Pick a home region near you (e.g. Mumbai or Hyderabad) — it can't be changed later.
2. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04** (or 22.04)
   - Shape: **Ampere → VM.Standard.A1.Flex**, 2 OCPUs, 12 GB (if Arm is "out of capacity", try again later or use **VM.Standard.E2.1.Micro**)
   - Networking: keep "Assign a public IPv4 address"
   - SSH keys: download the private key (or paste your own public key)
3. **Open the web ports**: the instance page → Subnet → Security List → **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination ports `80` and `443`.

## 2. Install RAY (one command)

SSH in (`ssh -i your-key ubuntu@<public-ip>`), then:

```bash
git clone https://github.com/revanthshankars-dotcom/ray-agent.git && bash ray-agent/deploy/oracle/setup.sh
```

Add your own domain if you have one (`bash ray-agent/deploy/oracle/setup.sh ray.example.com`, with an A record pointing to the VM). Without one, RAY gets a free address like `https://140-238-1-2.sslip.io`.

If the repository is private, clone it with a read-only GitHub token instead, and set `RAY_REPO_URL` to the same URL before running the script.

The script installs Node 24 and Caddy (automatic HTTPS), runs RAY as a service that restarts itself and starts on boot, opens the VM firewall, and updates RAY from `main` every night at 03:30.

## 3. Move your settings

```bash
sudo nano /etc/ray/ray.env      # paste the same keys you have in Render
sudo systemctl restart ray
```

- Copy **RELAY_MASTER_SECRET** from Render if you want existing pairings and saved logins to keep working.
- If Render used Cloudflare KV or Google Cloud Storage for storage (`CLOUDFLARE_API_TOKEN` / `RAY_GCS_BUCKET`), copy those keys too and RAY's memory comes along. Otherwise RAY starts fresh on the VM's disk.
- Google sign-in: add `https://<your-address>/api/accounts/google/callback` as an extra redirect URI in Google Cloud.
- Twilio phone line: nothing to change — RAY uses `PUBLIC_BASE_URL` for its webhooks.

## 4. Point your devices at the new server

Open `https://<your-address>` and reinstall the **PC bridge** and **phone bridge** from JARVIS Core / Connect, so they connect to the Oracle server instead of Render. Then you can suspend the Render service.

## Keep it from being reclaimed

Oracle can reclaim an Always Free instance that stays almost idle (CPU, network and memory all under 20% for 7 days). A quiet assistant can fall under that. The safe fix is to **upgrade the account to Pay As You Go** — Always Free resources stay free and, per Oracle's current terms, upgraded accounts are not subject to the idle reclaim. Set a **budget alert** (Billing → Budgets) at a tiny amount so you'd hear about any charge. Check Oracle's Always Free page for the latest rules.

## Useful commands

| What | Command |
|---|---|
| Live logs | `sudo journalctl -u ray -f` |
| Restart | `sudo systemctl restart ray` |
| Update now | `sudo /usr/local/bin/ray-update` |
| Re-run setup | `bash ~/ray-agent/deploy/oracle/setup.sh` (keeps settings and data) |
| RAY's data | `/opt/ray/.relay-data/` (back it up with `sudo tar czf ray-data.tgz -C /opt/ray .relay-data`) |
