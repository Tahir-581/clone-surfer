"""NLP serving URLs.

Supports:
  - Local FastAPI wrappers (legacy): GLiNER /predict, BiEncoder /embed, optional Triton.
  - Remote OpenAI-compatible embeddings (SURF_BGE_API_STYLE=openai).
  - Remote vLLM-style rerank (SURF_RERANK_PATH, e.g. /v2/rerank).

Environment (see repo .env / backend/.env):
  GLiNER: SURF_GLINER_API_URL, SURF_GLINER_PREDICT_PATH, SURF_GLINER_MODEL_ID
  BiEncoder: SURF_BIENCODER_API_URL, SURF_BGE_ENCODE_PATH, SURF_BGE_MODEL_ID, SURF_BGE_API_STYLE
  Rerank: SURF_CROSSENCODER_API_URL, SURF_RERANK_PATH, SURF_RERANK_MODEL_ID
"""
import os


DEFAULT_TRITON_HTTP_PORT = "18090"


def _url_join(base: str, path: str) -> str:
    """Join base URL and path (path must start with /)."""
    b = (base or "").strip().rstrip("/")
    p = (path or "").strip()
    if not p:
        return b
    if not p.startswith("/"):
        p = "/" + p
    return f"{b}{p}"


def _compose(host_or_base: str, port: str) -> str:
    h = (host_or_base or "localhost").strip() or "localhost"
    p = (port or "").strip()
    if h.startswith("http://") or h.startswith("https://"):
        h = h.rstrip("/")
        return f"{h}:{p}" if p else h
    return f"http://{h}:{p}"


def _legacy_url(
    explicit_env: str,
    port_env: str,
    default_port: str,
) -> str:
    explicit = os.getenv(explicit_env, "").strip().rstrip("/")
    if explicit:
        return explicit
    host = os.getenv("SURF_NLP_MODELS_HOST", "localhost").strip() or "localhost"
    port = os.getenv(port_env, default_port).strip() or default_port
    return _compose(host, port)


TRITON_HTTP_URL = (
    os.getenv("TRITON_HTTP_URL", "").strip().rstrip("/")
    or _compose(
        os.getenv("SURF_NLP_MODELS_HOST", "localhost"),
        os.getenv("TRITON_HTTP_PORT", DEFAULT_TRITON_HTTP_PORT),
    )
)

TRITON_GLINER_MODEL_NAME = os.getenv("TRITON_GLINER_MODEL_NAME", "gliner_ner").strip() or "gliner_ner"
TRITON_BGE_MODEL_NAME = os.getenv("TRITON_BGE_MODEL_NAME", "bge_embeddings").strip() or "bge_embeddings"

TRITON_GLINER_INFER_URL = f"{TRITON_HTTP_URL}/v2/models/{TRITON_GLINER_MODEL_NAME}/infer"
TRITON_BGE_INFER_URL = f"{TRITON_HTTP_URL}/v2/models/{TRITON_BGE_MODEL_NAME}/infer"

# --- GLiNER HTTP wrapper -------------------------------------------------
GLINER_API_URL = _legacy_url("SURF_GLINER_API_URL", "SURF_GLINER_PORT", "8081")
GLINER_PREDICT_PATH = (os.getenv("SURF_GLINER_PREDICT_PATH", "/predict").strip() or "/predict")
GLINER_PREDICT_URL = _url_join(GLINER_API_URL, GLINER_PREDICT_PATH)
GLINER_MODEL_ID = (os.getenv("SURF_GLINER_MODEL_ID", "").strip())

_explicit_gliner_health = os.getenv("SURF_GLINER_HEALTH_URL", "").strip().rstrip("/")
GLINER_HEALTH_URL = _explicit_gliner_health or _url_join(GLINER_API_URL, "/health")

# --- BiEncoder / BGE -----------------------------------------------------
BIENCODER_API_URL = _legacy_url("SURF_BIENCODER_API_URL", "SURF_BIENCODER_PORT", "8082")

BGE_API_STYLE = (os.getenv("SURF_BGE_API_STYLE", "legacy").strip().lower() or "legacy")
_default_bge_path = "/v1/embeddings" if BGE_API_STYLE == "openai" else "/embed"
BGE_ENCODE_PATH = (os.getenv("SURF_BGE_ENCODE_PATH", _default_bge_path).strip() or _default_bge_path)
BGE_EMBED_URL = _url_join(BIENCODER_API_URL, BGE_ENCODE_PATH)
BGE_MODEL_ID = (os.getenv("SURF_BGE_MODEL_ID", "BAAI/bge-m3").strip() or "BAAI/bge-m3")
def _safe_positive_int(env_name: str, default: int) -> int:
    raw = (os.getenv(env_name, str(default)) or str(default)).strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return default


BGE_EMBEDDING_DIM = _safe_positive_int("BGE_EMBEDDING_DIM", 1024)

_explicit_biencoder_health = os.getenv("SURF_BIENCODER_HEALTH_URL", "").strip().rstrip("/")
if _explicit_biencoder_health:
    BIENCODER_HEALTH_URL = _explicit_biencoder_health
elif BGE_API_STYLE == "openai":
    # OpenAI-compatible stacks usually expose models here.
    BIENCODER_HEALTH_URL = _url_join(BIENCODER_API_URL, "/v1/models")
else:
    BIENCODER_HEALTH_URL = _url_join(BIENCODER_API_URL, "/health")

# --- Cross-encoder / rerank (vLLM /v2/rerank style) ----------------------
CROSSENCODER_API_URL = _legacy_url("SURF_CROSSENCODER_API_URL", "SURF_CROSSENCODER_PORT", "6010")
RERANK_PATH = (os.getenv("SURF_RERANK_PATH", "/v2/rerank").strip() or "/v2/rerank")
RERANK_URL = _url_join(CROSSENCODER_API_URL, RERANK_PATH)
RERANK_MODEL_ID = (os.getenv("SURF_RERANK_MODEL_ID", "BAAI/bge-reranker-v2-m3").strip() or "BAAI/bge-reranker-v2-m3")

_explicit_cross_health = os.getenv("SURF_CROSSENCODER_HEALTH_URL", "").strip().rstrip("/")
CROSSENCODER_HEALTH_URL = _explicit_cross_health or _url_join(CROSSENCODER_API_URL, "/health")

USE_RERANKER = os.getenv("SURF_USE_RERANKER", "true").strip().lower() in ("1", "true", "yes", "on")

# Skip Triton readiness probe when using only remote HTTP NLP (no local Triton).
SKIP_TRITON_HEALTHCHECK = os.getenv("SURF_SKIP_TRITON_HEALTHCHECK", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
