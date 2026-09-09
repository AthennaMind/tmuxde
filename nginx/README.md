# mtmux — nginx configs

Two ready-to-go reverse-proxy layouts, one for each supported deployment
style.

## Standalone host (PM2 / bare Docker)

Use `mtmux.conf.example` when nginx runs on the host and mtmux is
reachable at `127.0.0.1:14100`, `:14300`, and `:14102`.

```bash
sudo cp nginx/mtmux.conf.example /etc/nginx/sites-available/mtmux.conf
sudo sed -i 's/mtmux.example.com/your-domain.com/g' \
    /etc/nginx/sites-available/mtmux.conf
sudo ln -s /etc/nginx/sites-available/mtmux.conf \
    /etc/nginx/sites-enabled/mtmux.conf

# Issue TLS certs
sudo certbot --nginx -d your-domain.com

sudo nginx -t && sudo systemctl reload nginx
```

The config terminates TLS, redirects `:80 → :443`, proxies the WebSocket at
`/ws` to the relay, `/docs` to the docs app, and `/` to the web app.

## Docker sidecar

Run nginx in the same compose stack — useful when you don't want to install
anything on the host beyond Docker:

```bash
cp .env.example .env
# edit PUBLIC_DOMAIN / ACME_EMAIL / AUTH_TOKEN …

docker compose -f docker-compose.prod.yml --profile nginx up -d
```

This brings up `web`, `relay`, `docs`, and `nginx`. By default nginx serves
HTTP only — fine for local use or if another proxy (Cloudflare, a managed
load balancer) terminates TLS in front of it.

### Adding TLS to the sidecar

TLS is bring-your-own-cert. Issue certs on the host with certbot:

```bash
sudo certbot certonly --standalone -d your-domain.com
```

Mount `/etc/letsencrypt` into the container (already wired in
`docker-compose.prod.yml`), then uncomment the HTTPS `server { … }` block in
`nginx/docker/default.conf` and replace `mtmux.example.com` with your
domain. Reload with `docker compose exec nginx nginx -s reload`.

We deliberately don't ship an automated certbot companion — one more moving
part for a small surface we'd rather keep transparent.

## Files

| File | Purpose |
|------|---------|
| `mtmux.conf.example` | Standalone-host server config |
| `docker/nginx.conf` | Base nginx.conf for the sidecar container |
| `docker/default.conf` | Per-site config for the sidecar container |

## Test a config before reloading

```bash
# Host-installed nginx
sudo nginx -t

# Docker sidecar config
docker run --rm -v "$PWD/nginx/docker:/etc/nginx/conf.d:ro" \
    nginx:1.27-alpine nginx -t -c /etc/nginx/conf.d/nginx.conf
```
