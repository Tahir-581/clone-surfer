# Triton client integration — GLiNER & BGE

**Audience:** engineers and AI agents (e.g. Cursor) integrating **another repository** with these models served by **NVIDIA Triton Inference Server**.

**Official protocol reference:** Triton uses the KServe-compatible HTTP/gRPC API (`/v2/...`). See [NVIDIA Triton User Guide](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/index.html).

---

## 1. Mental model

| Concept | Meaning |
|--------|---------|
| **One server, one HTTP port** | All models share the same host and port (e.g. `http://localhost:8010`). You choose the model per request via **model name** in the URL or client API. |
| **Two models** | `gliner_ner` (named entity recognition) and `bge_embeddings` (1024-d embeddings). |
| **Concurrency** | Many simultaneous HTTP requests to the **same** port are normal; use connection pooling or async clients for efficiency. |

Default Triton ports **inside** the container are `8000` (HTTP), `8001` (gRPC), `8002` (metrics). Your deployment may map host ports differently (e.g. host `8010` → container `8000`). Always configure **base URL** via environment variables in the consuming app.

---

## 2. Configuration for the consuming repo

Define these in the **other** codebase (e.g. `.env`, settings module, or CI secrets):

| Variable | Example | Description |
|----------|---------|-------------|
| `TRITON_HTTP_URL` | `http://localhost:8010` | Full HTTP base URL **including scheme**. Use the host port your ops team exposes. |
| `TRITON_GRPC_URL` | `localhost:8011` | Optional; host:port **without** `http://` for gRPC client. |

**Do not** hardcode ports: production may use `8000`, dev may use `8010` if `8000` is busy.

**Health checks (before heavy traffic):**

```http
GET {TRITON_HTTP_URL}/v2/health/live
GET {TRITON_HTTP_URL}/v2/health/ready
GET {TRITON_HTTP_URL}/v2/models/gliner_ner/ready
GET {TRITON_HTTP_URL}/v2/models/bge_embeddings/ready
```

Expect **HTTP 200** when ready.

---

## 3. Model: `gliner_ner`

**Purpose:** Open-type NER using GLiNER (`urchade/gliner_large-v2.1`).

### Contract (Triton `config.pbtxt`)

| Direction | Name | Type (HTTP JSON) | Shape | Notes |
|-----------|------|------------------|-------|--------|
| Input | `text` | `BYTES` | `[batch, 1]` | One string per batch row; UTF-8. |
| Input | `labels` | `BYTES` | `[batch, 1]` | One JSON **array of label strings** per row, e.g. `["person","organization"]`. |
| Input | `threshold` | `FP32` | `[batch, 1]` | Detection threshold (e.g. `0.5`). |
| Output | `entities` | `BYTES` | `[batch, 1]` | JSON **array of objects** per row: `start`, `end`, `text`, `label`, `score`. |

**Triton config datatype** is `TYPE_STRING`; HTTP clients still declare tensors as **`BYTES`** for strings (Triton convention).

**`max_batch_size`:** `8` — you may send up to 8 rows in one request; all three inputs must have matching batch dimension.

**Inference URL:**

```text
POST {TRITON_HTTP_URL}/v2/models/gliner_ner/infer
Content-Type: application/json
```

### Minimal JSON body (batch = 1)

Use flat `data` arrays matching `shape`:

```json
{
  "inputs": [
    {
      "name": "text",
      "datatype": "BYTES",
      "shape": [1, 1],
      "data": ["Apple Inc. was founded by Steve Jobs."]
    },
    {
      "name": "labels",
      "datatype": "BYTES",
      "shape": [1, 1],
      "data": ["[\"organization\", \"person\"]"]
    },
    {
      "name": "threshold",
      "datatype": "FP32",
      "shape": [1, 1],
      "data": [0.5]
    }
  ],
  "outputs": [{ "name": "entities" }]
}
```

Parse `outputs[0].data[0]` as a UTF-8 string, then `json.loads` → list of entity dicts.

### Python (sync) — `tritonclient`

```bash
pip install "tritonclient[http]" numpy
```

```python
import json
import os
import numpy as np
import tritonclient.http as httpclient

base = os.environ["TRITON_HTTP_URL"]  # e.g. http://localhost:8010
url = base.replace("http://", "").replace("https://", "")
client = httpclient.InferenceServerClient(url=url)

text = "Apple Inc. was founded by Steve Jobs in Cupertino."
labels = json.dumps(["organization", "person", "location"])

text_np = np.array([[text]], dtype=object)
labels_np = np.array([[labels]], dtype=object)
threshold_np = np.array([[0.5]], dtype=np.float32)

inputs = [
    httpclient.InferInput("text", text_np.shape, "BYTES"),
    httpclient.InferInput("labels", labels_np.shape, "BYTES"),
    httpclient.InferInput("threshold", threshold_np.shape, "FP32"),
]
inputs[0].set_data_from_numpy(text_np)
inputs[1].set_data_from_numpy(labels_np)
inputs[2].set_data_from_numpy(threshold_np)

outputs = [httpclient.InferRequestedOutput("entities")]
resp = client.infer("gliner_ner", inputs, outputs=outputs)
raw = resp.as_numpy("entities").reshape(-1)[0]
entities = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
```

### Python (async) — high concurrency

Use `tritonclient.http.aio` with one shared client, **`conn_limit` ≥ peak concurrency**, and `asyncio.Semaphore` to cap in-flight requests if needed. Reuse the client across calls; do not create a new client per request.

---

## 4. Model: `bge_embeddings`

**Purpose:** Dense embeddings with **BAAI/bge-large-en-v1.5** (1024 dimensions, **L2-normalized** for cosine similarity).

### Contract

| Direction | Name | Type (HTTP JSON) | Shape | Notes |
|-----------|------|------------------|-------|--------|
| Input | `text` | `BYTES` | `[batch, 1]` | Raw sentence or passage; see `is_query`. |
| Input | `is_query` | `BOOL` | `[batch, 1]` | If `true`, server prepends BGE **query** instruction to that row’s text. |
| Output | `embeddings` | `FP32` | `[batch, 1024]` | One vector per row. |

**Query instruction** (prepended only when `is_query` is true for that row):

```text
Represent this sentence for searching relevant passages: 
```

Use **`is_query=true`** for short retrieval **queries**; use **`false`** for **documents / passages** you index (aligns with common BGE retrieval usage).

**`max_batch_size`:** `64` — up to 64 texts per single infer for best throughput when the app can batch.

**Inference URL:**

```text
POST {TRITON_HTTP_URL}/v2/models/bge_embeddings/infer
Content-Type: application/json
```

### Minimal JSON (batch = 2)

```json
{
  "inputs": [
    {
      "name": "text",
      "datatype": "BYTES",
      "shape": [2, 1],
      "data": [
        "What is NVIDIA Triton?",
        "Triton serves multiple models on one HTTP port."
      ]
    },
    {
      "name": "is_query",
      "datatype": "BOOL",
      "shape": [2, 1],
      "data": [true, false]
    }
  ],
  "outputs": [{ "name": "embeddings" }]
}
```

Response `outputs[0].shape` should be `[2, 1024]`; `data` is row-major flat float array.

### Python (sync)

```python
import os
import numpy as np
import tritonclient.http as httpclient

base = os.environ["TRITON_HTTP_URL"]
url = base.replace("http://", "").replace("https://", "")
client = httpclient.InferenceServerClient(url=url)

texts = ["What is Triton?", "Triton is an inference server."]
flags = [True, False]

text_np = np.array([[t] for t in texts], dtype=object)
flag_np = np.array([[f] for f in flags], dtype=bool)

inputs = [
    httpclient.InferInput("text", text_np.shape, "BYTES"),
    httpclient.InferInput("is_query", flag_np.shape, "BOOL"),
]
inputs[0].set_data_from_numpy(text_np)
inputs[1].set_data_from_numpy(flag_np)

resp = client.infer(
    "bge_embeddings",
    inputs,
    outputs=[httpclient.InferRequestedOutput("embeddings")],
)
emb = resp.as_numpy("embeddings")  # shape (2, 1024), float32
```

---

## 5. Calling both models “at the same time”

Same `TRITON_HTTP_URL`, different paths or `model_name`:

- Fire **parallel** `infer("gliner_ner", ...)` and `infer("bge_embeddings", ...)` tasks (asyncio, thread pool, or multiple workers).
- Or interleave sequential calls on **one** shared HTTP client with keep-alive.

Triton schedules both; GPU memory and compute are shared according to server and model instance configuration.

---

## 6. Efficiency checklist (for agents implementing clients)

1. **Reuse one `InferenceServerClient`** (or a small pool) per process; tune `connection_timeout`, `network_timeout`, and async `conn_limit`.
2. **Batch** rows up to `max_batch_size` per model instead of N× batch-1 calls when latency allows.
3. **Prefer async + semaphore** for many concurrent single-row requests (pattern in `triton_gliner_bge/scripts/stress_*.py`).
4. **Readiness:** poll `/v2/health/ready` and per-model `/v2/models/<name>/ready` on startup and after deploys.
5. **Metrics:** if metrics port is mapped (e.g. host `8012` → `8002`), scrape `GET .../metrics` for `nv_inference_*` counters (optional).
6. **Errors:** map non-200 HTTP and Triton error JSON to retries with backoff for transient failures; do not retry 4xx schema errors without fixing the request.

---

## 7. Repository layout reference (this repo)

| Path | Role |
|------|------|
| `triton_gliner_bge/model_repository/gliner_ner/` | GLiNER Triton model package |
| `triton_gliner_bge/model_repository/bge_embeddings/` | BGE Triton model package |
| `triton_gliner_bge/scripts/stress_gliner_ner.py` | Example async load for `gliner_ner` |
| `triton_gliner_bge/scripts/stress_bge_embeddings.py` | Example async load for `bge_embeddings` |
| `triton_gliner_bge/scripts/requirements-stress.txt` | `tritonclient[http]` + `numpy` |

---

## 8. Quick copy-paste for Cursor rules / AGENTS.md

```markdown
When calling remote NLP inference:
- Use env `TRITON_HTTP_URL` (e.g. http://localhost:8010).
- GLiNER model name: `gliner_ner` — inputs: text (BYTES), labels (BYTES JSON array), threshold (FP32); output: entities (BYTES JSON array).
- BGE model name: `bge_embeddings` — inputs: text (BYTES), is_query (BOOL); output: embeddings FP32 [N, 1024], L2-normalized.
- HTTP: POST `{TRITON_HTTP_URL}/v2/models/<model_name>/infer` with KServe JSON body.
- Install: `pip install "tritonclient[http]" numpy`.
- Reuse HTTP client; batch when possible; use async for high concurrency.
```

---

*This document describes the model contract as deployed in this repository; ops may change host ports or GPU assignment without changing tensor names or shapes.*
