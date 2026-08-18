# BGE-M3 Embedding Server

vLLM OpenAI-compatible API for `BAAI/bge-m3` on port **8245** (GPU 0).

Unit file: `bge_m3_server.service`

## Install

```bash
bash setup_ubuntu_server.sh
```

Or manually:

```bash
sudo cp bge_m3_server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable bge_m3_server.service
sudo systemctl start bge_m3_server.service
```

## Service commands

```bash
sudo systemctl start bge_m3_server.service
sudo systemctl stop bge_m3_server.service
sudo systemctl restart bge_m3_server.service
sudo systemctl status bge_m3_server.service
sudo systemctl enable bge_m3_server.service
sudo systemctl disable bge_m3_server.service
```

## Logs

```bash
sudo journalctl -u bge_m3_server.service -f
```

## Run without systemd

```bash
python3 run_bge_m3_server.py
```

## All NLP services

To run embedding, GLiNER, and reranker together, use the parent target — see [../README.md](../README.md).
