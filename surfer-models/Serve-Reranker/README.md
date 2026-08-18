# BGE Reranker Server

vLLM OpenAI-compatible API for `BAAI/bge-reranker-v2-m3` on port **8019** (GPU 0).

Unit file: `bge-reranker.service`

## Install

```bash
chmod +x bge-reranker
sudo cp bge-reranker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable bge-reranker.service
sudo systemctl start bge-reranker.service
```

Or install all services from the parent folder:

```bash
cd .. && bash setup_ubuntu_server.sh
```

## Service commands

```bash
sudo systemctl start bge-reranker.service
sudo systemctl stop bge-reranker.service
sudo systemctl restart bge-reranker.service
sudo systemctl status bge-reranker.service
sudo systemctl enable bge-reranker.service
sudo systemctl disable bge-reranker.service
```

## Logs

```bash
sudo journalctl -u bge-reranker.service -f
```

## Run without systemd

```bash
./bge-reranker
```

## All NLP services

To run embedding, GLiNER, and reranker together, use the parent target — see [../README.md](../README.md).
