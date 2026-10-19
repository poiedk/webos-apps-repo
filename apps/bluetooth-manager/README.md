# Bluetooth Manager — experimental webOS 3.x preview

This is **unreleased** and **not validated on the LG 50UH635V**.

## Implemented
- Trusted-device listing via legacy `gap/getTrustedDevices`.
- Manual Bluetooth audio connection and disconnection.
- Audio discovery probe via `gap/findDevices` (single-response proof of concept; full subscription/discovery aggregation remains).
- Forget trusted audio device with a two-press confirmation.
- Directional remote navigation.

## Not implemented or not proven
- Full discovery subscription and reliable complete search results.
- Pair/bond workflow (the verified legacy API reference does not document a pairing call).
- Adapter power ON/OFF (no verified safe legacy API; turning off the service can break Magic Remote).
- Persistent background reconnection and boot policy.
- On-device hardware/permission test, packaging and release.

Legacy Bluetooth API: https://www.webosbrew.org/pages/luna-service-comwebosservicebluetooth

Until the LG is tested, **do not install or advertise as finished**. In particular, never kill the Bluetooth daemon or modify HID/Magic Remote connections automatically.
