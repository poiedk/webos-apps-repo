# webOS App Icon Standard

All apps in this monorepo should use the same TV-friendly icon shape.

- Canvas: 80 × 80 px for the base app icon.
- Shape: rounded square.
- Corner radius: 16 px (20% of the 80 px canvas), matching WiFi Watch.
- Corners outside the rounded square must be transparent.
- Keep the app artwork unchanged inside the mask; do not add a second frame just to create rounded corners.
- `icon.png` and `largeIcon.png` should use the same visual treatment.
- New apps should follow this convention from their first release.

This standard is intended to keep all poiedk webOS apps visually consistent in the launcher and Homebrew Channel.
