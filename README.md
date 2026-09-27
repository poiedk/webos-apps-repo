# poiedk webOS Apps

Personal monorepo and Homebrew catalog for webOS applications maintained by **poiedk**.

## Homebrew repository URL

```
https://raw.githubusercontent.com/poiedk/webos-apps-repo/main/repo.json
```

## Apps

- **WiFi Watch** — `apps/wifi-watch/`
- **WLED Fix** — `apps/wled-fix/`
- **LG Hue Sync** — `apps/lg-hue-sync/` — native ambient sync for Hue, Nanoleaf and WLED, including legacy webOS 3.x support

## Layout

```
apps/
  wifi-watch/
    app/
    service/
  wled-fix/
    app/
  lg-hue-sync/
    src/
    webos-app/
    docker/
    scripts/
manifests/
repo.json
scripts/
.github/workflows/
```

Each app keeps independent versioning. Release tags are:

- `wifi-watch-vX.Y.Z`
- `wled-fix-vX.Y.Z`
- `lg-hue-sync-vX.Y.Z`

The old per-app repositories are kept only as backups during migration.
