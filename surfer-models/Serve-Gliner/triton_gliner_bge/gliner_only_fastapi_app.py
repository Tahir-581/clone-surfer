"""
GLiNER-only FastAPI wrapper (separate port) — forwards to Triton HTTP.

Env:
  TRITON_HTTP_URL        default: http://127.0.0.1:18090
  TRITON_GLINER_MODEL    default: gliner_ner
  GLINER_API_PORT        default: 8081 (used by run script, not by the app)
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from starlette.responses import RedirectResponse

from fastapi_triton_common import (
    gliner_model_name,
    parse_gliner_entities,
    triton_base_url,
    triton_infer,
    triton_ready_or_503,
)


app = FastAPI(
    title="GLiNER (Triton)",
    description=(
        "Friendly REST layer for GLiNER on top of NVIDIA Triton HTTP. "
        f"Triton base URL: `{triton_base_url()}`."
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


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse("/docs")


@app.get("/health")
async def health() -> dict[str, str]:
    await triton_ready_or_503()
    return {"status": "ok", "service": "gliner", "triton": triton_base_url(), "model": gliner_model_name()}


@app.post("/predict", response_model=GlinerPredictResponse)
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

    j = await triton_infer(gliner_model_name(), payload)
    try:
        entities = parse_gliner_entities(j)
    except (ValueError, json.JSONDecodeError, KeyError, IndexError) as e:
        raise HTTPException(status_code=502, detail=f"Bad Triton output: {e}") from e
    return GlinerPredictResponse(entities=entities)

