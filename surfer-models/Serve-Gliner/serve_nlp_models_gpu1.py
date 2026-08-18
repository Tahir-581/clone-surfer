#!/usr/bin/env python3
"""
Serve NLP models on GPU 1 (or configurable CUDA device) with FastAPI + Uvicorn.

Usage:
  python serve_nlp_models_gpu1.py

Environment variables:
  CUDA_DEVICE      (default: cuda:1)
  GLINER_WORKERS   (default: 2)
  GLINER_PORT      (default: 6000)
  BIENCODER_PORT   (default: 6005)
  CROSSENCODER_PORT(default: 6010)

Expected ports:
  GLiNER NER service         -> 6000 (default)
  Bi-encoder embedding       -> 6005 (default)
  Cross-encoder reranker     -> 6010 (default)

Sample curl:
  # GLiNER single-text NER
  curl -X POST "http://127.0.0.1:6000/predict_entities" \
    -H "Content-Type: application/json" \
    -d '{"text":"John works at Acme in New York","labels":["person","organization","location"],"threshold":0.12}'

  # GLiNER batch NER
  curl -X POST "http://127.0.0.1:6000/predict_entities_batch" \
    -H "Content-Type: application/json" \
    -d '{"texts":["John works at Acme","Alice lives in Paris"],"labels":["person","organization","location"],"threshold":0.12}'

  # Bi-encoder embeddings
  curl -X POST "http://127.0.0.1:6005/encode" \
    -H "Content-Type: application/json" \
    -d '{"texts":["hello world","semantic search text"]}'

  # Cross-encoder reranker
  curl -X POST "http://127.0.0.1:6010/predict" \
    -H "Content-Type: application/json" \
    -d '{"pairs":[["what is fastapi?","FastAPI is a modern web framework"],["what is fastapi?","Bananas are yellow"]]}'
"""

from __future__ import annotations

import logging
import multiprocessing as mp
import os
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from gliner import GLiNER
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder, SentenceTransformer


GLINER_MODEL_NAME = "urchade/gliner_large-v2.1"
BIENCODER_MODEL_NAME = "BAAI/bge-large-en-v1.5"
CROSSENCODER_MODEL_NAME = "BAAI/bge-reranker-base"

CUDA_DEVICE = os.getenv("CUDA_DEVICE", "cuda:1")
GLINER_WORKERS = int(os.getenv("GLINER_WORKERS", "2"))
GLINER_PORT = int(os.getenv("GLINER_PORT", "6000"))
BIENCODER_PORT = int(os.getenv("BIENCODER_PORT", "6005"))
CROSSENCODER_PORT = int(os.getenv("CROSSENCODER_PORT", "6010"))

HOST = "0.0.0.0"
LOG_LEVEL = "info"


class GlinerPredictRequest(BaseModel):
    text: str = Field(..., description="Input text to extract entities from.")
    labels: list[str] = Field(..., description="Entity labels to predict.")
    threshold: float = Field(default=0.12, ge=0.0, le=1.0)


class GlinerBatchPredictRequest(BaseModel):
    texts: list[str] = Field(..., description="Batch of texts.")
    labels: list[str] = Field(..., description="Entity labels to predict.")
    threshold: float = Field(default=0.12, ge=0.0, le=1.0)


class EncodeRequest(BaseModel):
    texts: list[str] = Field(..., description="Input texts to embed.")


class PredictPairsRequest(BaseModel):
    pairs: list[list[str]] = Field(..., description="List of [query, document] pairs.")


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(processName)s | %(message)s",
    )


def ensure_cuda_or_die(device: str) -> None:
    if not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA is unavailable. This server requires a CUDA device (expected default: cuda:1)."
        )
    if not device.startswith("cuda:"):
        raise RuntimeError(f"Invalid CUDA_DEVICE '{device}'. Expected format like 'cuda:1'.")
    try:
        index = int(device.split(":", maxsplit=1)[1])
    except (IndexError, ValueError) as exc:
        raise RuntimeError(f"Invalid CUDA device index in '{device}'.") from exc

    count = torch.cuda.device_count()
    if index < 0 or index >= count:
        raise RuntimeError(
            f"Requested device '{device}' not available. Found {count} CUDA device(s)."
        )


def _validate_non_empty_text(text: str, field_name: str = "text") -> None:
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=422, detail=f"'{field_name}' must be a non-empty string.")


def _validate_non_empty_list(values: list[Any], field_name: str) -> None:
    if not isinstance(values, list) or len(values) == 0:
        raise HTTPException(status_code=422, detail=f"'{field_name}' must be a non-empty list.")


def create_gliner_app() -> FastAPI:
    app = FastAPI(title="GLiNER NER Service")
    app.state.model = None
    app.state.device = CUDA_DEVICE

    @app.on_event("startup")
    def startup() -> None:
        try:
            ensure_cuda_or_die(app.state.device)
            logging.info(
                "Starting GLiNER service | model=%s | device=%s | port=%s",
                GLINER_MODEL_NAME,
                app.state.device,
                GLINER_PORT,
            )
            model = GLiNER.from_pretrained(GLINER_MODEL_NAME)
            if hasattr(model, "to"):
                model = model.to(app.state.device)
            app.state.model = model
            logging.info("GLiNER model loaded successfully.")
        except Exception as exc:
            logging.exception("Failed to initialize GLiNER service.")
            raise RuntimeError(f"GLiNER startup failed: {exc}") from exc

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "gliner",
            "model": GLINER_MODEL_NAME,
            "device": app.state.device,
            "port": GLINER_PORT,
            "model_loaded": app.state.model is not None,
        }

    @app.post("/predict_entities")
    def predict_entities(req: GlinerPredictRequest) -> dict[str, Any]:
        _validate_non_empty_text(req.text, "text")
        _validate_non_empty_list(req.labels, "labels")
        for idx, label in enumerate(req.labels):
            _validate_non_empty_text(label, f"labels[{idx}]")

        try:
            with torch.inference_mode():
                entities = app.state.model.predict_entities(
                    req.text,
                    req.labels,
                    threshold=req.threshold,
                )
            return {"entities": entities}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"GLiNER inference failed: {exc}") from exc

    @app.post("/predict_entities_batch")
    def predict_entities_batch(req: GlinerBatchPredictRequest) -> dict[str, Any]:
        _validate_non_empty_list(req.texts, "texts")
        _validate_non_empty_list(req.labels, "labels")
        for idx, text in enumerate(req.texts):
            _validate_non_empty_text(text, f"texts[{idx}]")
        for idx, label in enumerate(req.labels):
            _validate_non_empty_text(label, f"labels[{idx}]")

        try:
            with torch.inference_mode():
                if hasattr(app.state.model, "batch_predict_entities"):
                    entities_per_text = app.state.model.batch_predict_entities(
                        req.texts,
                        req.labels,
                        threshold=req.threshold,
                    )
                else:
                    entities_per_text = [
                        app.state.model.predict_entities(text, req.labels, threshold=req.threshold)
                        for text in req.texts
                    ]
            return {"entities_per_text": entities_per_text}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"GLiNER batch inference failed: {exc}"
            ) from exc

    return app


def create_biencoder_app(device: str) -> FastAPI:
    app = FastAPI(title="Bi-encoder Embedding Service")
    app.state.device = device
    app.state.model = None

    @app.on_event("startup")
    def startup() -> None:
        try:
            ensure_cuda_or_die(app.state.device)
            logging.info(
                "Starting bi-encoder service | model=%s | device=%s | port=%s",
                BIENCODER_MODEL_NAME,
                app.state.device,
                BIENCODER_PORT,
            )
            app.state.model = SentenceTransformer(BIENCODER_MODEL_NAME, device=app.state.device)
            logging.info("Bi-encoder model loaded successfully.")
        except Exception as exc:
            logging.exception("Failed to initialize bi-encoder service.")
            raise RuntimeError(f"Bi-encoder startup failed: {exc}") from exc

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "biencoder",
            "model": BIENCODER_MODEL_NAME,
            "device": app.state.device,
            "port": BIENCODER_PORT,
            "model_loaded": app.state.model is not None,
        }

    @app.post("/encode")
    def encode(req: EncodeRequest) -> dict[str, Any]:
        _validate_non_empty_list(req.texts, "texts")
        for idx, text in enumerate(req.texts):
            _validate_non_empty_text(text, f"texts[{idx}]")

        try:
            with torch.inference_mode():
                embeddings = app.state.model.encode(
                    req.texts,
                    convert_to_tensor=True,
                    show_progress_bar=False,
                )
                if hasattr(embeddings, "cpu"):
                    embeddings = embeddings.cpu().tolist()
                else:
                    embeddings = embeddings.tolist()
            return {"embeddings": embeddings}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"Bi-encoder inference failed: {exc}"
            ) from exc

    return app


def create_crossencoder_app(device: str) -> FastAPI:
    app = FastAPI(title="Cross-encoder Reranker Service")
    app.state.device = device
    app.state.model = None

    @app.on_event("startup")
    def startup() -> None:
        try:
            ensure_cuda_or_die(app.state.device)
            logging.info(
                "Starting cross-encoder service | model=%s | device=%s | port=%s",
                CROSSENCODER_MODEL_NAME,
                app.state.device,
                CROSSENCODER_PORT,
            )
            app.state.model = CrossEncoder(CROSSENCODER_MODEL_NAME, device=app.state.device)
            logging.info("Cross-encoder model loaded successfully.")
        except Exception as exc:
            logging.exception("Failed to initialize cross-encoder service.")
            raise RuntimeError(f"Cross-encoder startup failed: {exc}") from exc

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "crossencoder",
            "model": CROSSENCODER_MODEL_NAME,
            "device": app.state.device,
            "port": CROSSENCODER_PORT,
            "model_loaded": app.state.model is not None,
        }

    @app.post("/predict")
    def predict(req: PredictPairsRequest) -> dict[str, Any]:
        _validate_non_empty_list(req.pairs, "pairs")
        validated_pairs: list[tuple[str, str]] = []
        for idx, pair in enumerate(req.pairs):
            if not isinstance(pair, list) or len(pair) != 2:
                raise HTTPException(
                    status_code=422, detail=f"pairs[{idx}] must be a [query, doc] list of length 2."
                )
            query, doc = pair
            _validate_non_empty_text(query, f"pairs[{idx}][0]")
            _validate_non_empty_text(doc, f"pairs[{idx}][1]")
            validated_pairs.append((query, doc))

        try:
            with torch.inference_mode():
                scores = app.state.model.predict(validated_pairs, show_progress_bar=False)
                scores_list = [float(score) for score in scores]
            return {"scores": scores_list}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"Cross-encoder inference failed: {exc}"
            ) from exc

    return app


def run_gliner_server() -> None:
    uvicorn.run(
        "serve_nlp_models_gpu1:create_gliner_app",
        host=HOST,
        port=GLINER_PORT,
        factory=True,
        workers=GLINER_WORKERS,
        log_level=LOG_LEVEL,
    )


def run_biencoder_server() -> None:
    app = create_biencoder_app(CUDA_DEVICE)
    uvicorn.run(app, host=HOST, port=BIENCODER_PORT, log_level=LOG_LEVEL)


def run_crossencoder_server() -> None:
    app = create_crossencoder_app(CUDA_DEVICE)
    uvicorn.run(app, host=HOST, port=CROSSENCODER_PORT, log_level=LOG_LEVEL)


def main() -> None:
    configure_logging()
    ensure_cuda_or_die(CUDA_DEVICE)
    logging.info(
        "Launching NLP services on device=%s | gliner_port=%s | biencoder_port=%s | crossencoder_port=%s",
        CUDA_DEVICE,
        GLINER_PORT,
        BIENCODER_PORT,
        CROSSENCODER_PORT,
    )

    gliner_proc = mp.Process(target=run_gliner_server, name="gliner-service", daemon=False)
    biencoder_proc = mp.Process(target=run_biencoder_server, name="biencoder-service", daemon=False)
    crossencoder_proc = mp.Process(
        target=run_crossencoder_server,
        name="crossencoder-service",
        daemon=False,
    )

    processes = [gliner_proc, biencoder_proc, crossencoder_proc]
    for proc in processes:
        proc.start()
        logging.info("Started process %s with pid=%s", proc.name, proc.pid)

    for proc in processes:
        proc.join()


if __name__ == "__main__":
    try:
        mp.set_start_method("spawn", force=True)
    except RuntimeError:
        # Start method may already be set by parent interpreter.
        pass
    main()
