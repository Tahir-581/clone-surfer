"""
FastAPI wrapper with OpenAPI at /docs — forwards GLiNER/BGE calls to Triton HTTP.

  export TRITON_HTTP_URL=http://127.0.0.1:18090
  uvicorn gliner_fastapi_app:app --host 0.0.0.0 --port 8080

Run from this directory: triton_gliner_bge/
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field
from starlette.responses import RedirectResponse

TRITON_BASE = os.environ.get("TRITON_HTTP_URL", "http://127.0.0.1:18090").rstrip("/")
GLINER_MODEL_NAME = os.environ.get("TRITON_GLINER_MODEL", "gliner_ner")
BGE_MODEL_NAME = os.environ.get("TRITON_BGE_MODEL", "bge_embeddings")
GLINER_INFER_PATH = f"/v2/models/{GLINER_MODEL_NAME}/infer"
BGE_INFER_PATH = f"/v2/models/{BGE_MODEL_NAME}/infer"

app = FastAPI(
    title="GLiNER + BGE (Triton)",
    description=(
        "Friendly REST layer on top of NVIDIA Triton HTTP. "
        f"Triton base URL: `{TRITON_BASE}`."
    ),
    version="1.0.0",
)


class GlinerPredictBody(BaseModel):
    text: str = Field(..., examples=["Apple Inc. was founded by Steve Jobs."])
    labels: list[str] = Field(
        ...,
        description='Entity types to extract, e.g. ["organization", "person"].',
        examples=[["organization", "person", "location"]],
    )
    threshold: float = Field(0.5, ge=0.0, le=1.0)


class GlinerPredictResponse(BaseModel):
    entities: list[dict[str, Any]]


class BgeEmbedBody(BaseModel):
    text: str = Field(..., examples=["What is machine learning?"])
    is_query: bool = Field(
        True,
        description=(
            "If true, query instruction prefix is applied before encoding "
            "(recommended for search queries)."
        ),
    )


class BgeEmbedResponse(BaseModel):
    embedding: list[float]
    dimension: int


def _decode_out(raw: Any) -> str:
    if isinstance(raw, bytes):
        return raw.decode("utf-8")
    return str(raw)


def _entities_from_triton_json(body: dict[str, Any]) -> list[dict[str, Any]]:
    outputs = body.get("outputs") or []
    if not outputs:
        raise ValueError("no outputs in Triton response")
    data = outputs[0].get("data")
    if data is None:
        raise ValueError("no output data")
    raw0 = data[0]
    if isinstance(raw0, list) and len(raw0) == 1:
        raw0 = raw0[0]
    parsed = json.loads(_decode_out(raw0))
    if not isinstance(parsed, list):
        raise ValueError("entities JSON is not a list")
    return parsed


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse("/docs")


@app.get("/health")
async def health() -> dict[str, str]:
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{TRITON_BASE}/v2/health/ready")
    if r.status_code != 200:
        raise HTTPException(
            status_code=503,
            detail=f"Triton not ready (HTTP {r.status_code}): {r.text[:500]}",
        )
    return {"status": "ok", "triton": TRITON_BASE}


@app.get("/v2/health/live")
async def triton_live_passthrough() -> Any:
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{TRITON_BASE}/v2/health/live")
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=r.text[:2000])
    return {"status": "live"}


@app.get("/v2/health/ready")
async def triton_ready_passthrough() -> Any:
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{TRITON_BASE}/v2/health/ready")
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=r.text[:2000])
    return {"status": "ready"}


@app.get("/v2/models/{model_name}/ready")
async def triton_model_ready_passthrough(model_name: str) -> Any:
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{TRITON_BASE}/v2/models/{model_name}/ready")
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=r.text[:2000])
    return {"model": model_name, "status": "ready"}


@app.post("/gliner/predict", response_model=GlinerPredictResponse)
async def gliner_predict(body: GlinerPredictBody) -> GlinerPredictResponse:
    payload = {
        "inputs": [
            {
                "name": "text",
                "datatype": "BYTES",
                "shape": [1, 1],
                "data": [body.text],
            },
            {
                "name": "labels",
                "datatype": "BYTES",
                "shape": [1, 1],
                "data": [json.dumps(body.labels)],
            },
            {
                "name": "threshold",
                "datatype": "FP32",
                "shape": [1, 1],
                "data": [body.threshold],
            },
        ],
        "outputs": [{"name": "entities"}],
    }
    url = f"{TRITON_BASE}{GLINER_INFER_PATH}"
    async with httpx.AsyncClient(timeout=300.0) as client:
        r = await client.post(url, json=payload)
    try:
        j = r.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail=r.text[:2000]) from None
    if r.status_code != 200:
        err = j.get("error") if isinstance(j, dict) else str(j)
        raise HTTPException(status_code=r.status_code, detail=str(err)[:2000])
    try:
        entities = _entities_from_triton_json(j)
    except (ValueError, json.JSONDecodeError, KeyError, IndexError) as e:
        raise HTTPException(status_code=502, detail=f"Bad Triton output: {e}") from e
    return GlinerPredictResponse(entities=entities)


@app.post("/bge/embed", response_model=BgeEmbedResponse)
async def bge_embed(body: BgeEmbedBody) -> BgeEmbedResponse:
    payload = {
        "inputs": [
            {
                "name": "text",
                "datatype": "BYTES",
                "shape": [1, 1],
                "data": [body.text],
            },
            {
                "name": "is_query",
                "datatype": "BOOL",
                "shape": [1, 1],
                "data": [body.is_query],
            },
        ],
        "outputs": [{"name": "embeddings"}],
    }
    url = f"{TRITON_BASE}{BGE_INFER_PATH}"
    async with httpx.AsyncClient(timeout=300.0) as client:
        r = await client.post(url, json=payload)
    try:
        j = r.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail=r.text[:2000]) from None
    if r.status_code != 200:
        err = j.get("error") if isinstance(j, dict) else str(j)
        raise HTTPException(status_code=r.status_code, detail=str(err)[:2000])

    outputs = j.get("outputs") or []
    if not outputs:
        raise HTTPException(status_code=502, detail="Bad Triton output: no outputs")
    data = outputs[0].get("data")
    shape = outputs[0].get("shape") or []
    if data is None:
        raise HTTPException(status_code=502, detail="Bad Triton output: no output data")
    if len(shape) >= 2:
        dim = int(shape[-1])
    else:
        dim = len(data)
    try:
        embedding = [float(x) for x in data[:dim]]
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Bad embedding values: {e}") from e
    return BgeEmbedResponse(embedding=embedding, dimension=dim)


@app.post("/v2/models/{model_name}/infer")
async def triton_infer_passthrough(
    model_name: str, payload: dict[str, Any] = Body(...)
) -> Any:
    # Compatibility endpoint so Triton HTTP clients can target this wrapper port.
    url = f"{TRITON_BASE}/v2/models/{model_name}/infer"
    async with httpx.AsyncClient(timeout=300.0) as client:
        r = await client.post(url, json=payload)
    try:
        body = r.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail=r.text[:2000]) from None
    if r.status_code != 200:
        err = body.get("error") if isinstance(body, dict) else str(body)
        raise HTTPException(status_code=r.status_code, detail=str(err)[:2000])
    return body
