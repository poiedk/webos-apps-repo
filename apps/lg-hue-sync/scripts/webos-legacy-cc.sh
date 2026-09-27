#!/bin/bash
set -euo pipefail

SDK_ROOT="${WEBOS_SDK_ROOT:-/opt/webos-sdk/arm-webos-linux-gnueabi_sdk-buildroot}"
SYSROOT="$SDK_ROOT/arm-webos-linux-gnueabi/sysroot"
COMPILER="$SDK_ROOT/bin/arm-webos-linux-gnueabi-gcc"

if [ ! -x "$COMPILER" ]; then
    echo "webOS legacy compiler not found: $COMPILER" >&2
    exit 1
fi
if [ ! -d "$SYSROOT" ]; then
    echo "webOS legacy sysroot not found: $SYSROOT" >&2
    exit 1
fi

filtered=()
for arg in "$@"; do
    case "$arg" in
        -fuse-ld=lld|-pie|-Wl,-z,relro,-z,now)
            ;;
        *)
            filtered+=("$arg")
            ;;
    esac
done

exec "$COMPILER" --sysroot="$SYSROOT" -no-pie "${filtered[@]}"
