---
title: DAAS Sidecar
summary: Run the DAAS Paperclip fork beside the DAAS control plane
---

The DAAS fork runs as a sidecar. DAAS remains the infrastructure authority; Paperclip keeps its own AgentOps database and calls DAAS through the governed mission adapter.

Use the sidecar Compose file when you want a local Paperclip fork next to a DAAS stack without merging schemas.

```sh
read -r PAPERCLIP_DB_PASSWORD <<EOF
$(openssl rand -hex 24)
EOF
export PAPERCLIP_DB_PASSWORD
export PAPERCLIP_WEBHOOK_SECRET="$(openssl rand -hex 32)"
export DAAS_API_SHARED_SECRET="$(openssl rand -hex 32)"
export PAPERCLIP_BETTER_AUTH_SECRET="$(openssl rand -hex 32)"

docker compose -f docker/docker-compose.daas-sidecar.yml up --build
```

Open `http://localhost:3101`.

## Defaults

| Setting | Default |
|---|---|
| Paperclip URL | `http://localhost:3101` |
| Paperclip database | `paperclip-db:5432/paperclip` |
| DAAS API URL | `http://host.docker.internal:8000` |
| Telemetry | disabled and policy-enforced |
| Feedback sharing | disabled |

Override the defaults without editing the file:

```sh
PAPERCLIP_SIDECAR_PORT=3201 \
PAPERCLIP_BASE_URL=http://localhost:3201 \
DAAS_BASE_URL=http://daas-api:8000 \
docker compose -f docker/docker-compose.daas-sidecar.yml up --build
```

## Health Check

After startup, verify the fork health signal from an authenticated board session or from container logs:

```sh
docker compose -f docker/docker-compose.daas-sidecar.yml ps
docker compose -f docker/docker-compose.daas-sidecar.yml logs paperclip-sidecar
```

The DAAS fork health status must report:

- `telemetry.enabled=false`
- dangerous connectors disabled
- `safe=true`
- `paperclipVersion` and `daasPatchVersion`

Anonymous health probes in authenticated deployments stay redacted and do not expose version or connector inventory.

## Separation Rules

- Use a separate Paperclip database. Do not point `DATABASE_URL` at the DAAS database or a shared schema.
- Keep `PAPERCLIP_WEBHOOK_SECRET`, `DAAS_API_SHARED_SECRET`, `PAPERCLIP_DB_PASSWORD`, and `PAPERCLIP_BETTER_AUTH_SECRET` outside the repository.
- Keep `PAPERCLIP_TELEMETRY_DISABLED=1`, `PAPERCLIP_ENTERPRISE_TELEMETRY_POLICY=enforce_disabled`, and `DO_NOT_TRACK=1` unless the owner explicitly changes the fork policy.
- Route infrastructure work through DAAS; Paperclip must not open direct SSH or raw infrastructure execution paths.
