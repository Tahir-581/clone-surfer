import os
import random
import time
from typing import List, Optional
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from requests import RequestException
from requests.adapters import HTTPAdapter

from .nlp_serving_urls import (
    BGE_API_STYLE,
    BGE_EMBED_URL,
    BGE_EMBEDDING_DIM,
    BGE_MODEL_ID,
)


def _openai_auth_headers() -> dict:
    key = (os.getenv("SURF_BGE_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
    if not key:
        return {}
    return {"Authorization": f"Bearer {key}"}


class BGETritonClient:
    """HTTP client for BGE: local FastAPI /embed or OpenAI-compatible /v1/embeddings."""

    _session: Optional[requests.Session] = None
    _pool_size: Optional[int] = None
    _cached_dim: Optional[int] = None

    @classmethod
    def _get_pool_size(cls) -> int:
        configured = int(os.getenv("BGE_REQUEST_CONCURRENCY", "100000"))
        return max(1, configured)

    @classmethod
    def _get_session(cls) -> requests.Session:
        pool_size = cls._get_pool_size()
        if cls._session is None or cls._pool_size != pool_size:
            session = requests.Session()
            adapter = HTTPAdapter(
                pool_connections=pool_size,
                pool_maxsize=pool_size,
                pool_block=True,
                max_retries=0,
            )
            session.mount("http://", adapter)
            session.mount("https://", adapter)
            cls._session = session
            cls._pool_size = pool_size
        return cls._session

    def _embedding_dim_fallback(self) -> int:
        if self._cached_dim is not None:
            return self._cached_dim
        return BGE_EMBEDDING_DIM

    def _set_cached_dim(self, dim: int) -> None:
        if dim > 0:
            self._cached_dim = dim

    def _post_openai_embeddings_batch(self, texts: List[str]) -> np.ndarray:
        """POST OpenAI-style embeddings for a batch of strings; returns (n, dim)."""
        max_attempts = max(1, int(os.getenv("BGE_HTTP_RETRY_ATTEMPTS", "3")))
        base_sleep = max(0.01, float(os.getenv("BGE_HTTP_RETRY_BASE_SECONDS", "0.2")))
        headers = {"Content-Type": "application/json", **_openai_auth_headers()}
        payload = {"model": BGE_MODEL_ID, "input": texts}
        # Some gateways accept optional encoding hints; keep minimal for compatibility.
        last_exc: Optional[Exception] = None
        for attempt in range(1, max_attempts + 1):
            try:
                r = self._get_session().post(
                    BGE_EMBED_URL,
                    json=payload,
                    headers=headers,
                    timeout=300,
                )
                r.raise_for_status()
                body = r.json() or {}
                rows = body.get("data") or []
                if not isinstance(rows, list) or not rows:
                    raise RequestException("OpenAI embeddings response missing data[]")
                # Sort by index when present
                try:
                    rows = sorted(rows, key=lambda x: int(x.get("index", 0)))
                except (TypeError, ValueError):
                    pass
                vectors: List[List[float]] = []
                for item in rows:
                    emb = item.get("embedding")
                    if isinstance(emb, list):
                        vectors.append(emb)
                if len(vectors) != len(texts):
                    raise RequestException(
                        f"OpenAI embeddings count mismatch: got {len(vectors)}, expected {len(texts)}"
                    )
                arr = np.array(vectors, dtype=np.float32)
                if arr.ndim == 2 and arr.shape[1] > 0:
                    self._set_cached_dim(int(arr.shape[1]))
                return arr
            except RequestException as exc:
                last_exc = exc
                if attempt >= max_attempts:
                    raise
                sleep_for = base_sleep * (2 ** (attempt - 1)) + random.uniform(0.0, 0.05)
                time.sleep(sleep_for)
        assert last_exc is not None
        raise last_exc

    def _post_embed_with_retry(self, text: str, is_query: bool) -> list:
        """Single-text legacy /embed (and /encode fallback). is_query ignored for OpenAI batch path."""
        if BGE_API_STYLE == "openai":
            row = self._post_openai_embeddings_batch([text])
            return row[0].tolist() if row.shape[0] else []

        max_attempts = max(1, int(os.getenv("BGE_HTTP_RETRY_ATTEMPTS", "3")))
        base_sleep = max(0.01, float(os.getenv("BGE_HTTP_RETRY_BASE_SECONDS", "0.2")))
        encode_url = BGE_EMBED_URL.rsplit("/", 1)[0] + "/encode"
        for attempt in range(1, max_attempts + 1):
            try:
                r = self._get_session().post(
                    BGE_EMBED_URL,
                    json={"text": text, "is_query": bool(is_query)},
                    timeout=300,
                )
                if r.status_code in {404, 405}:
                    r = self._get_session().post(
                        encode_url,
                        json={"texts": [text]},
                        timeout=300,
                    )
                    r.raise_for_status()
                    body = r.json() or {}
                    embeddings = body.get("embeddings") or []
                    vec = embeddings[0] if embeddings else []
                    if vec:
                        self._set_cached_dim(len(vec))
                    return vec
                r.raise_for_status()
                body = r.json() or {}
                vec = body.get("embedding") or []
                if vec:
                    self._set_cached_dim(len(vec))
                return vec
            except RequestException:
                if attempt >= max_attempts:
                    raise
                sleep_for = base_sleep * (2 ** (attempt - 1)) + random.uniform(0.0, 0.05)
                time.sleep(sleep_for)
        return []

    def encode(self, texts: List[str], is_query: bool = False) -> np.ndarray:
        if not texts:
            return np.empty((0, self._embedding_dim_fallback()), dtype=np.float32)

        if BGE_API_STYLE == "openai":
            max_batch = max(1, int(os.getenv("BGE_MAX_BATCH_SIZE", "64")))
            parallel_requests = max(1, int(os.getenv("BGE_PARALLEL_INFER_REQUESTS", "8")))
            chunks = [texts[i : i + max_batch] for i in range(0, len(texts), max_batch)]
            chunk_arrays: List[np.ndarray] = []

            def _run_chunk(chunk: List[str]) -> np.ndarray:
                return self._post_openai_embeddings_batch(chunk)

            workers = min(parallel_requests, len(chunks) or 1)
            with ThreadPoolExecutor(max_workers=workers) as executor:
                chunk_arrays = list(executor.map(_run_chunk, chunks))
            if not chunk_arrays:
                return np.empty((0, self._embedding_dim_fallback()), dtype=np.float32)
            out = np.vstack(chunk_arrays)
            if out.ndim == 2 and out.shape[1] > 0:
                self._set_cached_dim(int(out.shape[1]))
            return out

        # Legacy: wrapper exposes single-item inference; parallel fan-out within chunks.
        max_batch = max(1, int(os.getenv("BGE_MAX_BATCH_SIZE", "64")))
        parallel_requests = max(1, int(os.getenv("BGE_PARALLEL_INFER_REQUESTS", "8")))
        chunks = [texts[i : i + max_batch] for i in range(0, len(texts), max_batch)]
        chunk_rows: List[np.ndarray] = [np.empty((0, self._embedding_dim_fallback()), dtype=np.float32) for _ in chunks]

        def _encode_chunk(idx: int, chunk: List[str]) -> None:
            rows: List[np.ndarray] = [
                np.empty((0, self._embedding_dim_fallback()), dtype=np.float32) for _ in chunk
            ]

            def _one(i: int, text: str) -> None:
                emb = self._post_embed_with_retry(text=text, is_query=is_query)
                rows[i] = np.array(emb, dtype=np.float32).reshape(1, -1)

            per_chunk_workers = min(len(chunk), max(1, int(os.getenv("BGE_PER_CHUNK_WORKERS", "16"))))
            with ThreadPoolExecutor(max_workers=per_chunk_workers) as ex:
                futures = [ex.submit(_one, i, t) for i, t in enumerate(chunk)]
                for f in futures:
                    f.result()
            chunk_rows[idx] = np.vstack(rows) if rows else np.empty((0, self._embedding_dim_fallback()), dtype=np.float32)

        workers = min(parallel_requests, len(chunks) or 1)
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(_encode_chunk, i, c) for i, c in enumerate(chunks)]
            for fut in futures:
                fut.result()

        stacked = np.vstack(chunk_rows) if chunk_rows else np.empty((0, self._embedding_dim_fallback()), dtype=np.float32)
        if stacked.ndim == 2 and stacked.shape[1] > 0:
            self._set_cached_dim(int(stacked.shape[1]))
        return stacked
