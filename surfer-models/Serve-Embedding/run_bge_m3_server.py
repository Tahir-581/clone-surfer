#!/usr/bin/env python3

import os
import subprocess
import sys


def main() -> int:
    env = os.environ.copy()
    env["CUDA_VISIBLE_DEVICES"] = "0"

    cmd = [
        "python3",
        "-m",
        "vllm.entrypoints.openai.api_server",
        "--model",
        "BAAI/bge-m3",
        "--runner",
        "pooling",
        "--trust-remote-code",
        "--host",
        "0.0.0.0",
        "--port",
        "8245",
        "--gpu-memory-utilization",
        "0.10",
        "--enforce-eager",
    ]

    print("Running command:")
    print("CUDA_VISIBLE_DEVICES=1 " + " ".join(cmd))

    result = subprocess.run(cmd, env=env)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
