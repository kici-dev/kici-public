# Hetzner autoscale reaper

The host-side backstop for workflow-driven autoscaling on Hetzner Cloud. Your
teardown workflow deletes a server when its agent scales down, and the server
powers itself off at its lifetime cap. This reaper covers what both can miss — a
crashed orchestrator, a killed run, a server that never booted — by deleting
every server with the managed label that is older than a TTL.

It depends on nothing but the Hetzner API and the clock, so run it on a host
that is not one of the servers it reaps, such as the orchestrator host.

## Files

| File                                       | What it is                                                         |
| ------------------------------------------ | ------------------------------------------------------------------ |
| [`reap.ts`](./reap.ts)                     | The reaper: list by label, delete what is older than the TTL       |
| [`hetzner-client.ts`](./hetzner-client.ts) | The `fetch` wrapper over the Hetzner Cloud API that `reap.ts` uses |

Copy both into one directory. Node.js 22.18 or later runs the TypeScript directly,
so nothing needs installing:

```bash
HCLOUD_TOKEN=<project-token> node reap.ts
```

A delete that fails does not stop the run: the reaper tries every expired server,
logs each failure, and exits with status 1 when any delete failed.

## Environment

| Variable                           | Default                          | Meaning                                                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HCLOUD_TOKEN`                     | (required)                       | Hetzner Cloud API token for the project the servers live in                                                                                                                                                               |
| `HCLOUD_ENDPOINT`                  | `https://api.hetzner.cloud/v1`   | The API base URL                                                                                                                                                                                                          |
| `KICI_HETZNER_MANAGED_LABEL`       | `kici-managed=hetzner-autoscale` | The label your provisioning workflow sets; only servers carrying it are deleted                                                                                                                                           |
| `KICI_HETZNER_REAP_TTL_MIN`        | `30`                             | Delete managed servers older than this many minutes. Set it above your longest job                                                                                                                                        |
| `KICI_HETZNER_SWEEP_WHOLE_PROJECT` | (unset)                          | `1` deletes every server older than the TTL, labelled or not — only for a project that holds nothing else                                                                                                                 |
| `KICI_HETZNER_REAP_METRIC_FILE`    | (unset)                          | Write the run's Prometheus gauges, `kici_hetzner_reaper_last_run_deleted` and `kici_hetzner_reaper_last_run_failed`, to this path. For node-exporter, use a name that ends in `.prom` in its textfile-collector directory |

## Run it on a timer

A systemd service and timer that run the reaper every five minutes, with the files
in `/opt/kici-hetzner-reaper/` and the token in a root-only environment file:

```ini
# /etc/systemd/system/kici-hetzner-reaper.service
[Unit]
Description=Delete leaked Hetzner autoscale servers

[Service]
Type=oneshot
# HCLOUD_TOKEN=... (chmod 600)
EnvironmentFile=/etc/kici-hetzner-reaper.env
Environment=KICI_HETZNER_REAP_TTL_MIN=30
Environment=KICI_HETZNER_REAP_METRIC_FILE=/var/lib/node-exporter/textfile/kici-hetzner-reaper.prom
ExecStart=/usr/bin/env node /opt/kici-hetzner-reaper/reap.ts
```

```ini
# /etc/systemd/system/kici-hetzner-reaper.timer
[Unit]
Description=Run the Hetzner autoscale reaper every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kici-hetzner-reaper.timer
```

Alert on these conditions:

- **A leak was cleaned up** — `max_over_time(kici_hetzner_reaper_last_run_deleted[1h]) > 0`.
  In steady state the teardown workflow has already removed every server, so a
  deletion here means a teardown path failed.
- **A leak could not be cleaned up** — `max_over_time(kici_hetzner_reaper_last_run_failed[1h]) > 0`.
  A server is still running because Hetzner refused its delete.
- **The reaper stopped reporting** —
  `time() - node_textfile_mtime_seconds{file=~".*/kici-hetzner-reaper\\.prom"} > 900`.
  A run that fails before it lists anything, such as with an invalid token,
  writes no file, so the last values would otherwise look healthy.

The [teardown and reaper runbook](https://docs.kici.dev/operator/orchestrator/hetzner-autoscale-reaper)
covers the full model.
