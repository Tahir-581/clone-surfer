#!/usr/bin/env python3
"""
Build the Triton GLiNER image, start the container, follow logs, then launch FastAPI.

Run from Serve-Gliner:

  python3 run_triton_gliner_stack.py

Steps:
  1. docker build -t triton-gliner-bge:latest -f triton_gliner_bge/Dockerfile triton_gliner_bge
  2. bash triton_gliner_bge/scripts/run_triton_gliner_cuda1.sh
  3. docker logs -f triton-gliner-cuda1 until Triton reports ready (or timeout)
  4. bash triton_gliner_bge/scripts/run_gliner_fastapi.sh
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONTAINER_NAME = os.getenv("TRITON_CONTAINER_NAME", "triton-gliner-cuda1")
READY_TIMEOUT_SECONDS = int(os.getenv("TRITON_READY_TIMEOUT_SECONDS", "600"))

GLINER_LOADED_MARKER = "successfully loaded 'gliner_ner'"
HTTP_SERVICE_MARKER = "Started HTTPService at 0.0.0.0:8000"


def run_command(cmd: list[str]) -> None:
    print(f"\n>>> {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR, check=False)
    if result.returncode != 0:
        print(f"Command failed with exit code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)


def wait_for_triton_ready(timeout_seconds: int) -> None:
    cmd = ["docker", "logs", "-f", CONTAINER_NAME]
    print(
        f"\n>>> {' '.join(cmd)} "
        f"(waiting for Triton ready signals, timeout {timeout_seconds}s)"
    )
    proc = subprocess.Popen(
        cmd,
        cwd=SCRIPT_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    gliner_loaded = False
    http_started = False
    deadline = time.monotonic() + timeout_seconds

    try:
        assert proc.stdout is not None
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if line:
                print(line, end="", flush=True)
                if GLINER_LOADED_MARKER in line:
                    gliner_loaded = True
                if HTTP_SERVICE_MARKER in line:
                    http_started = True
                if gliner_loaded and http_started:
                    print("\n>>> Triton is ready")
                    return
                continue

            if proc.poll() is not None:
                print(
                    f"\nContainer '{CONTAINER_NAME}' exited before becoming ready.",
                    file=sys.stderr,
                )
                sys.exit(1)

            time.sleep(0.2)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    missing = []
    if not gliner_loaded:
        missing.append(GLINER_LOADED_MARKER)
    if not http_started:
        missing.append(HTTP_SERVICE_MARKER)
    print(
        f"\nTimed out after {timeout_seconds}s waiting for: {', '.join(missing)}",
        file=sys.stderr,
    )
    sys.exit(1)


def main() -> int:
    run_command(
        [
            "docker",
            "build",
            "-t",
            "triton-gliner-bge:latest",
            "-f",
            "triton_gliner_bge/Dockerfile",
            "triton_gliner_bge",
        ]
    )

    run_command(["bash", "triton_gliner_bge/scripts/run_triton_gliner_cuda1.sh"])

    wait_for_triton_ready(READY_TIMEOUT_SECONDS)

    print("\n>>> Starting GLiNER FastAPI")
    result = subprocess.run(
        ["bash", "triton_gliner_bge/scripts/run_gliner_fastapi.sh"],
        cwd=SCRIPT_DIR,
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
