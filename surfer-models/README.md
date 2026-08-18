# Surfox NLP Models

Systemd units for embedding, GLiNER NER, and reranker services. A single **target** starts all three together.

| Service | Unit | Port | GPU |
|---------|------|------|-----|
| BGE-M3 embeddings | `bge_m3_server.service` | 8245 | 0 |
| GLiNER (Triton + FastAPI) | `triton_gliner_stack.service` | 8081 | 1 |
| BGE reranker | `bge-reranker.service` | 8019 | 0 |

## Install everything

From this directory:

```bash
bash setup_ubuntu_server.sh
```

That copies all unit files, enables `surfox-nlp-models.target`, and starts the group.

## Manual install (target only)

```bash
sudo cp surfox-nlp-models.target /etc/systemd/system/
sudo cp Serve-Embedding/bge_m3_server.service /etc/systemd/system/
sudo cp Serve-Gliner/triton_gliner_stack.service /etc/systemd/system/
sudo cp Serve-Reranker/bge-reranker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable surfox-nlp-models.target
sudo systemctl start surfox-nlp-models.target
```

## Target commands (`surfox-nlp-models.target`)

```bash
# Start all three services
sudo systemctl start surfox-nlp-models.target

# Stop all three services
sudo systemctl stop surfox-nlp-models.target

# Restart all three services
sudo systemctl restart surfox-nlp-models.target

# Status
sudo systemctl status surfox-nlp-models.target

# Enable at boot
sudo systemctl enable surfox-nlp-models.target

# Disable at boot
sudo systemctl disable surfox-nlp-models.target

# Status of each child service
sudo systemctl status bge_m3_server.service triton_gliner_stack.service bge-reranker.service
```

## Logs

```bash
sudo journalctl -u bge_m3_server.service -f
sudo journalctl -u triton_gliner_stack.service -f
sudo journalctl -u bge-reranker.service -f
```

## Per-service docs

- [Serve-Embedding/README.md](Serve-Embedding/README.md) — `bge_m3_server.service`
- [Serve-Gliner/README.md](Serve-Gliner/README.md) — `triton_gliner_stack.service`
- [Serve-Reranker/README.md](Serve-Reranker/README.md) — `bge-reranker.service`
