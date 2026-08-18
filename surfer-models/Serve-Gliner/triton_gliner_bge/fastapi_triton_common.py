from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import HTTPException


def triton_base_url() -> str:
    return os.environ.get("TRITON_HTTP_URL", "http://127.0.0.1:18090").rstrip("/")


def gliner_model_name() -> str:
    return os.environ.get("TRITON_GLINER_MODEL", "gliner_ner").strip() or "gliner_ner"


def bge_model_name() -> str:
    return os.environ.get("TRITON_BGE_MODEL", "bge_embeddings").strip() or "bge_embeddings"


def _decode_bytes(raw: Any) -> str:
    if isinstance(raw, bytes):
        return raw.decode("utf-8")
    return str(raw)


def parse_gliner_entities(triton_body: dict[str, Any]) -> list[dict[str, Any]]:
    outputs = triton_body.get("outputs") or []
    if not outputs:
        raise ValueError("no outputs in Triton response")
    data = outputs[0].get("data")
    if data is None or len(data) == 0:
        raise ValueError("no output data")
    raw0 = data[0]
    if isinstance(raw0, list) and len(raw0) == 1:
        raw0 = raw0[0]
    parsed = json.loads(_decode_bytes(raw0))
    if not isinstance(parsed, list):
        raise ValueError("entities JSON is not a list")
    return parsed


def parse_bge_embedding(triton_body: dict[str, Any]) -> tuple[list[float], int]:
    outputs = triton_body.get("outputs") or []
    if not outputs:
        raise ValueError("no outputs in Triton response")
    out0 = outputs[0]
    data = out0.get("data")
    shape = out0.get("shape") or []
    if data is None:
        raise ValueError("no output data")
    dim = int(shape[-1]) if len(shape) >= 2 else len(data)
    embedding = [float(x) for x in data[:dim]]
    return embedding, dim


async def triton_ready_or_503(timeout_s: float = 15.0) -> None:
    base = triton_base_url()
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        r = await client.get(f"{base}/v2/health/ready")
    if r.status_code != 200:
        raise HTTPException(
            status_code=503,
            detail=f"Triton not ready (HTTP {r.status_code}): {r.text[:500]}",
        )


async def triton_infer(model_name: str, payload: dict[str, Any], timeout_s: float = 300.0) -> dict[str, Any]:
    base = triton_base_url()
    url = f"{base}/v2/models/{model_name}/infer"
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        r = await client.post(url, json=payload)
    try:
        body = r.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail=r.text[:2000]) from None
    if r.status_code != 200:
        err = body.get("error") if isinstance(body, dict) else str(body)
        raise HTTPException(status_code=r.status_code, detail=str(err)[:2000])
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail=f"Unexpected Triton response type: {type(body)}")
    return body

