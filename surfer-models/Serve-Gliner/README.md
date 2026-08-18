# GLiNER Stack (Triton + FastAPI)

Docker Triton server for `gliner_ner` plus FastAPI on port **8081** (Triton HTTP on **18090**, GPU 1).

Unit file: `triton_gliner_stack.service`  
Orchestrator: `run_triton_gliner_stack.py`

Put your Hugging Face token in `triton_gliner_bge/.env`:

```bash
HF_TOKEN=hf_your_token_here
```

## Install

```bash
bash setup_ubuntu_server.sh
```

Or manually:

```bash
python3 -m pip install -r triton_gliner_bge/scripts/requirements-gliner-api.txt
sudo cp triton_gliner_stack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable triton_gliner_stack.service
sudo systemctl start triton_gliner_stack.service
```

## Service commands

```bash
sudo systemctl start triton_gliner_stack.service
sudo systemctl stop triton_gliner_stack.service
sudo systemctl restart triton_gliner_stack.service
sudo systemctl status triton_gliner_stack.service
sudo systemctl enable triton_gliner_stack.service
sudo systemctl disable triton_gliner_stack.service
```

## Logs

```bash
sudo journalctl -u triton_gliner_stack.service -f
```

Triton container logs (when debugging model load):

```bash
docker logs -f triton-gliner-cuda1
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HF_TOKEN` | from `.env` | Faster Hugging Face downloads in Triton |
| `TRITON_CUDA_DEVICE` | `1` | Host GPU index for Triton |
| `TRITON_READY_TIMEOUT_SECONDS` | `600` | Max wait for Triton ready (stack script) |
| `GLINER_API_PORT` | `8081` | FastAPI port |

## Run without systemd

```bash
python3 run_triton_gliner_stack.py
```

## Manual deployment & API

See [readme.md](readme.md) for step-by-step Docker/Triton setup, health checks, and curl examples.

## All NLP services

To run embedding, GLiNER, and reranker together, use the parent target — see [../README.md](../README.md).
