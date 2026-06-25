# SKT Mainpage Dashboard

GA attributes snapshot dashboard for the T world Shop main pages.

## Local Docker

```bash
docker compose build
APP_PORT=4176 docker compose up -d app scheduler
```

Open:

```text
http://127.0.0.1:4176/snapshots/index.html
```

Default dashboard password:

```text
jellyfish
```

Run a manual capture with retry:

```bash
docker compose run --rm --no-deps capture
```

Check the daily scheduler:

```bash
docker compose logs --tail=50 scheduler
```

## Secrets And Data

Do not commit these files or folders:

- `skt-otw-ua-*.json`
- `snapshots/`
- `.env`

The GA4 service account JSON must exist on the host and is mounted into the container as read-only.

## Production On GCP VM

The intended production pattern is:

```text
GitHub private repository
  -> GCP Compute Engine VM git pull
  -> docker compose build
  -> docker compose up -d app scheduler
```

Use a GitHub read-only deploy key on the VM for private repository access.

For production without a domain, keep the app bound to localhost and put Nginx HTTPS in front:

```bash
APP_BIND=127.0.0.1 APP_PORT=4173 DASHBOARD_REQUIRE_HTTPS=true docker compose up -d app scheduler
```

The scheduler runs capture every day at `10:00 Asia/Seoul` and retries failures.
