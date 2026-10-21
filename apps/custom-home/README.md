# LG Custom Home

Experimental launcher for LG webOS TV Lite 3.4.3. Standalone app only: **does not change the physical Home button or the system launcher**.

Uses `com.webos.applicationManager/listLaunchPoints` to populate installed applications, including HDMI bookmarks. Launches via `com.webos.applicationManager/launch` and preserves launch-point params. Favorites and sorting use localStorage. ES5 syntax for older web engine. Must be tested on physical LG TV prior to Homebrew catalog release.

Build: `ares-package --no-minify --outdir dist apps/custom-home/app`.
