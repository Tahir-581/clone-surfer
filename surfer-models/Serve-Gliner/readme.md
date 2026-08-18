# GLiNER Serving

For **systemd service commands**, see [README.md](README.md).

This repo already includes a GLiNER-only Triton launcher and a GLiNER-only FastAPI app.

## 1. Build the Triton image

Run from the repo root:

```bash
docker build -t triton-gliner-bge:latest -f triton_gliner_bge/Dockerfile triton_gliner_bge
```

## 2. Start Triton with only the `gliner_ner` model

This script serves only GLiNER from Triton and maps Triton HTTP to `http://127.0.0.1:18090`.

The GLiNER Triton model is configured to start a single GPU instance. This avoids CUDA out-of-memory failures on shared GPUs.

```bash
bash triton_gliner_bge/scripts/run_triton_gliner_cuda1.sh
```

Optional GPU selection:

```bash
TRITON_CUDA_DEVICE=1 bash triton_gliner_bge/scripts/run_triton_gliner_cuda1.sh
```

## 3. Install FastAPI requirements

```bash
python3 -m pip install -r triton_gliner_bge/scripts/requirements-gliner-api.txt
```

## 4. Start only the GLiNER FastAPI service

This FastAPI app forwards requests to Triton. Use this if you want GLiNER to be accessed only through FastAPI.

```bash
bash triton_gliner_bge/scripts/run_gliner_fastapi.sh
```

## Troubleshooting

If FastAPI `/health` returns `500`, check whether Triton actually started. In this repo, that usually means the Triton container exited during GLiNER model load because GPU memory was exhausted.

That starts the GLiNER API on:

```text
http://127.0.0.1:8081
```

Swagger docs:

```text
http://127.0.0.1:8081/docs
```

## 5. Test the GLiNER FastAPI endpoint

```bash
curl -X POST "http://127.0.0.1:8081/predict" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Apple Inc. was founded by Steve Jobs in Cupertino.",
    "labels": ["organization", "person", "location"],
    "threshold": 0.5
  }'
```

## Exact command flow

```bash
docker build -t triton-gliner-bge:latest -f triton_gliner_bge/Dockerfile triton_gliner_bge
bash triton_gliner_bge/scripts/run_triton_gliner_cuda1.sh
python3 -m pip install -r triton_gliner_bge/scripts/requirements-gliner-api.txt
bash triton_gliner_bge/scripts/run_gliner_fastapi.sh
```

```
  # IMPORTANT: watch logs until you see BOTH:
  # "successfully loaded 'gliner_ner'"
  # "Started HTTPService at 0.0.0.0:8000"
  docker logs -f triton-gliner-cuda1
```
