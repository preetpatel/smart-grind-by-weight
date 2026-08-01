#!/usr/bin/env python3
"""Generate the encoder/decoder compatibility fixtures for test_patch_compat.

Builds two deterministic pseudo-firmware images (a base and a mutated target,
seeded so every run and every machine produces identical bytes) and creates a
heatshrink-compressed detools patch between them with the *installed* Python
detools - the same toolchain that produces real OTA patches. The C decoder
shipped in firmware (components/detools) must then reconstruct the target
byte-for-byte, which is what test_patch_compat.cpp asserts.

Run automatically by `grinder.py test`. Outputs are generated, not committed.
"""
import random
import shutil
import subprocess
import sys
from pathlib import Path

FIXTURE_DIR = Path(__file__).parent
BASE = FIXTURE_DIR / "base.bin"
TARGET = FIXTURE_DIR / "target.bin"
PATCH = FIXTURE_DIR / "patch.bin"

BASE_SIZE = 96 * 1024


def build_images() -> None:
    rng = random.Random(0xC0FFEE)
    base = bytearray(rng.randbytes(BASE_SIZE))

    # Firmware-update-shaped mutations: small in-place edits, an insertion,
    # and a deletion, leaving long common runs for the delta to exploit.
    target = bytearray(base)
    for offset in range(0, BASE_SIZE, 8 * 1024):
        target[offset:offset + 64] = rng.randbytes(64)
    target[40 * 1024:40 * 1024] = rng.randbytes(2048)   # insertion
    del target[70 * 1024:70 * 1024 + 1024]              # deletion
    target += rng.randbytes(4096)                       # growth at the end

    BASE.write_bytes(base)
    TARGET.write_bytes(target)


def find_detools() -> list:
    """Locate the detools CLI: next to this interpreter (venv) or on PATH."""
    candidate = Path(sys.executable).parent / "detools"
    if candidate.exists():
        return [str(candidate)]
    on_path = shutil.which("detools")
    if on_path:
        return [on_path]
    return []


def main() -> int:
    build_images()

    cmd = find_detools()
    if not cmd:
        print("ERROR: detools CLI not found (pip install detools==0.53.0)")
        return 1

    PATCH.unlink(missing_ok=True)
    result = subprocess.run(
        cmd + ["create_patch", "-c", "heatshrink", str(BASE), str(TARGET), str(PATCH)],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or not PATCH.exists():
        print(f"ERROR: detools create_patch failed: {result.stderr.strip()}")
        return 1

    print(f"fixtures: base={BASE.stat().st_size}B target={TARGET.stat().st_size}B "
          f"patch={PATCH.stat().st_size}B")
    return 0


if __name__ == "__main__":
    sys.exit(main())
