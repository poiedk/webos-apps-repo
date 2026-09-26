# poiedk webOS Apps

Personal monorepo and Homebrew catalog for webOS applications maintained by **poiedk**.

## Homebrew repository URL

```
https://raw.githubusercontent.com/poiedk/webos-apps-repo/main/repo.json
```

## Apps

- **WiFi Watch** — `apps/wifi-watch/`
- **WLED Fix** — `apps/wled-fix/`

## Layout

```
apps/
  wifi-watch/
    app/
    service/
  wled-fix/
    app/
manifests/
repo.json
scripts/
.github/workflows/
```

Each app keeps independent versioning. Release tags are:

- `wifi-watch-vX.Y.Z`
- `wled-fix-vX.Y.Z`

The old per-app repositories are kept only as backups during migration.
