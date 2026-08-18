"""
BGE-only FastAPI wrapper (separate port) — forwards to Triton HTTP.

Env:
  TRITON_HTTP_URL      default: http://127.0.0.1:18090
  TRITON_BGE_MODEL     default: bge_embeddings
  BGE_API_PORT         default: 8082 (used by run script, not by the app)
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from starlette.responses import RedirectResponse

from fastapi_triton_common import (
    bge_model_name,
    parse_bge_embedding,
    triton_base_url,
    triton_infer,
    triton_ready_or_503,
)


app = FastAPI(
    title="BGE Embeddings (Triton)",
    description=(
        "Friendly REST layer for BGE embeddings on top of NVIDIA Triton HTTP. "
        f"Triton base URL: `{triton_base_url()}`."
    ),
    version="1.0.0",
)


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


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse("/docs")


@app.get("/health")
async def health() -> dict[str, str]:
    await triton_ready_or_503()
    return {"status": "ok", "service": "bge", "triton": triton_base_url(), "model": bge_model_name()}


@app.post("/embed", response_model=BgeEmbedResponse)
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

    j = await triton_infer(bge_model_name(), payload)
    try:
        embedding, dim = parse_bge_embedding(j)
    except (ValueError, TypeError, KeyError, IndexError) as e:
        raise HTTPException(status_code=502, detail=f"Bad Triton output: {e}") from e
    return BgeEmbedResponse(embedding=embedding, dimension=dim)

