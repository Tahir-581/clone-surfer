#!/usr/bin/env python3
"""Check configured NLP model dependencies."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys

import aiohttp
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "backend" / ".env")

from NLP_Extraction_and_Ranking.nlp_serving_urls import (  # noqa: E402
    BIENCODER_HEALTH_URL,
    CROSSENCODER_HEALTH_URL,
    GLINER_HEALTH_URL,
    SKIP_TRITON_HEALTHCHECK,
    TRITON_HTTP_URL,
)


async def _probe_http_json(name: str, url: str, timeout_seconds: float = 2.5) -> dict:
    status = {"name": name, "url": url, "ok": False, "http_status": None, "detail": ""}
    try:
        timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                url,
                headers={"Accept-Encoding": "identity"},
            ) as response:
                status["http_status"] = response.status
                status["ok"] = 200 <= response.status < 300
                status["detail"] = (await response.text())[:500]
    except Exception as exc:
        status["detail"] = str(exc)
    return status


async def _skipped(name: str) -> dict:
    return {
        "name": name,
        "url": "(skipped)",
        "ok": True,
        "http_status": None,
        "detail": "SURF_SKIP_TRITON_HEALTHCHECK is enabled",
    }


async def check_nlp_service_health() -> dict:
    triton_coro = (
        _skipped("triton")
        if SKIP_TRITON_HEALTHCHECK
        else _probe_http_json("triton", f"{TRITON_HTTP_URL}/v2/health/ready")
    )
    checks = await asyncio.gather(
        triton_coro,
        _probe_http_json("gliner", GLINER_HEALTH_URL),
        _probe_http_json("biencoder", BIENCODER_HEALTH_URL),
        _probe_http_json("crossencoder", CROSSENCODER_HEALTH_URL),
    )
    required_names = {"gliner", "biencoder"}
    if not SKIP_TRITON_HEALTHCHECK:
        required_names.add("triton")
    required = [c for c in checks if c["name"] in required_names]
    return {
        "ok": all(c["ok"] for c in required),
        "checks": checks,
        "hint": (
            "For local Triton + wrappers, start Triton then FastAPI GLiNER/BGE. "
            "For remote-only NLP, set SURF_SKIP_TRITON_HEALTHCHECK=1 and point "
            "SURF_GLINER_API_URL / SURF_BIENCODER_API_URL / SURF_CROSSENCODER_API_URL "
            "to your HTTP endpoints (see backend/.env)."
        ),
    }


def main() -> int:
    health = asyncio.run(check_nlp_service_health())
    print(json.dumps(health, indent=2))
    return 0 if health.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
