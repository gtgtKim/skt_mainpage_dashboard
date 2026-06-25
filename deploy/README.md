# GCP VM Deployment

This project is designed to run on one Compute Engine VM with Docker Compose.

## 1. VM Setup

Create an Ubuntu VM with a static external IP. Recommended starting size:

- Machine: `e2-medium`
- Disk: 50GB standard persistent disk
- Firewall: allow TCP `80`

Install Git and Docker on the VM, then clone the GitHub repository.

## 2. GitHub Connection

Use a GitHub deploy key for VM access:

```bash
ssh-keygen -t ed25519 -C "gcp-vm-skt-mainpage-dashboard" -f ~/.ssh/skt_mainpage_dashboard
cat ~/.ssh/skt_mainpage_dashboard.pub
```

Add the public key in GitHub:

```text
Repository -> Settings -> Deploy keys -> Add deploy key
```

Leave `Allow write access` unchecked.

Then clone:

```bash
GIT_SSH_COMMAND='ssh -i ~/.ssh/skt_mainpage_dashboard' \
  git clone git@github.com:gtgtKim/skt_mainpage_dashboard.git
```

## 3. Service Account Key

Upload the GA4 service account JSON to the repository directory on the VM:

```text
skt-otw-ua-44615111-2-34043f78264e.json
```

This file is ignored by git and mounted read-only into the container.

## 4. Start Services Behind HTTPS

```bash
cd skt_mainpage_dashboard
docker compose build
APP_BIND=127.0.0.1 APP_PORT=4173 DASHBOARD_REQUIRE_HTTPS=true docker compose up -d app scheduler
```

Install Nginx and obtain a Let's Encrypt IP certificate, then install `deploy/nginx-dashboard.conf`.
The public endpoint should be:

```text
https://<STATIC_EXTERNAL_IP>/snapshots/index.html
```

The dashboard password is configured with `DASHBOARD_PASSWORD`; the current default is `jellyfish`.

Check:

```bash
docker compose ps
docker compose logs --tail=50 scheduler
```

Open:

```text
https://<STATIC_EXTERNAL_IP>/snapshots/index.html
```

## 5. Deploy Updates

```bash
cd skt_mainpage_dashboard
git pull --ff-only
docker compose build
APP_BIND=127.0.0.1 APP_PORT=4173 DASHBOARD_REQUIRE_HTTPS=true docker compose up -d app scheduler
```

## 6. Manual Capture

```bash
docker compose run --rm --no-deps capture
```

The capture command retries failures and keeps only one successful run per day.
