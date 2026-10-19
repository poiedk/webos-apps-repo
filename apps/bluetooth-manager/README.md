# Bluetooth Manager (hardware compatibility preview)

**Not a release**. The existing LG 50UH635V on webOS 3.x has not yet been tested with these calls. Requires root and Homebrew Channel exec. Do not enable an auto-disable Bluetooth service: it may disconnect Magic Remote.

The prototype shows trusted audio/HID devices and supports explicit user-initiated connect/disconnect calls via the legacy `com.webos.service.bluetooth` Luna API. The Scan button is a capability probe; discovery results vary by firmware and may require a subscribed backend. Pairing and power ON/OFF are deliberately **not** enabled until TV hardware and private API permissions have been verified.

Source: https://www.webosbrew.org/pages/luna-service-comwebosservicebluetooth

## Before shipping

- Probe actual available methods and permissions on device (webOS 3.4.3).
- Confirm Bluetooth hardware and Magic Remote behavior.
- Implement scan subscription, pairing/bonding and confirmed unpair flow.
- Add opt-in reconnection to previously trusted audio devices only, with backoff and no HID auto-disconnect.
- Test navigation with Magic Remote and package a PNG icon before IPK release.
