#!/usr/bin/env python3
"""
Run Surfox backend and frontend together.

Usage:
    python run_services.py              # headless (default)
    python run_services.py --headful      # visible browser for CAPTCHA / debugging
"""

from __future__ import annotations

import os
import socket
import shutil
import signal
import subprocess
import sys
import time
import argparse
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"
DEFAULT_BACKEND_PORT = 8010
DEFAULT_FRONTEND_PORT = 3010


def _is_port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _find_available_port(start_port: int) -> int:
    port = start_port
    while not _is_port_available(port):
        port += 1
    return port


def _terminate_process(proc: subprocess.Popen, name: str) -> None:
    if proc.poll() is not None:
        return

    print(f"Stopping {name} (PID: {proc.pid})...")
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        print(f"{name} did not stop in time. Killing...")
        proc.kill()
        proc.wait(timeout=3)


def main() -> int:
    if not BACKEND_DIR.exists():
        print(f"Backend directory not found: {BACKEND_DIR}")
        return 1
    if not FRONTEND_DIR.exists():
        print(f"Frontend directory not found: {FRONTEND_DIR}")
        return 1

    parser = argparse.ArgumentParser(description="Run Surfox backend and frontend together.")
    parser.add_argument(
        "--headful",
        action="store_true",
        help="Run the scraping browser in headful mode (visible). Default is headless.",
    )
    args = parser.parse_args()

    backend_cmd = [sys.executable, "main.py"]
    frontend_runner = None
    frontend_cmd = []

    # Explicitly prefer npm to run the dev script in development mode
    npm_exe = shutil.which("npm")
    pnpm_exe = shutil.which("pnpm")

    if npm_exe is not None:
        frontend_runner = npm_exe
        frontend_cmd = [frontend_runner, "run", "dev"]
    elif pnpm_exe is not None:
        frontend_runner = pnpm_exe
        frontend_cmd = [frontend_runner, "run", "dev"]
    else:
        print("Neither `npm` nor `pnpm` is available in PATH. Please install Node.js first.")
        return 1

    backend_port = _find_available_port(DEFAULT_BACKEND_PORT)
    backend_env = os.environ.copy()
    # backend/main.py reads BACKEND_PORT first, then PORT
    backend_env["BACKEND_PORT"] = str(backend_port)
    if args.headful:
        backend_env["SURFOX_HEADFUL"] = "1"
    else:
        backend_env.pop("SURFOX_HEADFUL", None)
    backend_env.pop("SURFOX_FORCE_HEADLESS", None)
    if backend_port != DEFAULT_BACKEND_PORT:
        print(
            f"Port {DEFAULT_BACKEND_PORT} is in use. "
            f"Starting backend on port {backend_port}."
        )

    browser_mode = "headful" if args.headful else "headless"
    print(f"Starting backend ({browser_mode} browser)...")
    backend_proc = subprocess.Popen(
        backend_cmd,
        cwd=BACKEND_DIR,
        env=backend_env,
    )

    # Small delay so backend logs are visible before frontend starts.
    time.sleep(1)

    frontend_port = _find_available_port(DEFAULT_FRONTEND_PORT)
    frontend_env = os.environ.copy()
    frontend_env["PORT"] = str(frontend_port)
    # Keep frontend API target in sync when backend auto-shifts to a free port.
    frontend_env["REACT_APP_API_URL"] = f"http://localhost:{backend_port}"
    if frontend_port != DEFAULT_FRONTEND_PORT:
        print(
            f"Port {DEFAULT_FRONTEND_PORT} is in use. "
            f"Starting frontend on port {frontend_port}."
        )

    print(f"Starting frontend via {Path(frontend_runner).name}...")
    frontend_proc = subprocess.Popen(
        frontend_cmd,
        cwd=FRONTEND_DIR,
        env=frontend_env,
    )

    print("\nSurfox services are running:")
    print(f" - Backend:  http://localhost:{backend_port}")
    print(f" - Frontend: http://localhost:{frontend_port}")
    print("Press Ctrl+C to stop both.\n")

    def handle_signal(signum, _frame):
        signal_name = signal.Signals(signum).name
        print(f"\nReceived {signal_name}. Shutting down services...")
        _terminate_process(frontend_proc, "frontend")
        _terminate_process(backend_proc, "backend")
        raise SystemExit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        while True:
            backend_code = backend_proc.poll()
            frontend_code = frontend_proc.poll()

            if backend_code is not None:
                print(f"\nBackend exited with code {backend_code}. Stopping frontend...")
                _terminate_process(frontend_proc, "frontend")
                return backend_code

            if frontend_code is not None:
                print(f"\nFrontend exited with code {frontend_code}. Stopping backend...")
                _terminate_process(backend_proc, "backend")
                return frontend_code

            time.sleep(1)
    except KeyboardInterrupt:
        print("\nInterrupted. Shutting down services...")
        _terminate_process(frontend_proc, "frontend")
        _terminate_process(backend_proc, "backend")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
