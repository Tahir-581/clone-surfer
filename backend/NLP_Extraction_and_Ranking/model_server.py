"""
Serve all models over FastAPI: GLiNER (8081), BiEncoder (8082), CrossEncoder (6010).
Run: python model_server.py
Then run Gliner_.py, rank_entities.py, deduplicate_nlps.py as usual; they call these endpoints.
"""
import multiprocessing
import os
import uvicorn


def create_gliner_app():
    """Factory for the GLiNER FastAPI app (used by uvicorn with workers)."""
    from fastapi import FastAPI
    from pydantic import BaseModel
    from gliner import GLiNER
    import torch
    import flair

    MODEL_NAME = "urchade/gliner_large-v2.1"
    DEVICE = "cuda:1"
    flair.device = torch.device(DEVICE)

    app = FastAPI()
    print(f"Loading GLiNER: {MODEL_NAME} on {DEVICE}...")
    model = GLiNER.from_pretrained(MODEL_NAME)
    model.model.to(torch.device(DEVICE))
    port = int(os.getenv("SURF_GLINER_PORT", "8081"))
    print(f"GLiNER ready on port {port}")

    class PredictRequest(BaseModel):
        text: str
        labels: list[str]
        threshold: float = 0.12

    class PredictBatchRequest(BaseModel):
        texts: list[str]
        labels: list[str]
        threshold: float = 0.12

    @app.post("/predict_entities")
    def predict_entities(req: PredictRequest):
        with torch.inference_mode():
            entities = model.predict_entities(req.text, req.labels, threshold=req.threshold)
            return {"entities": entities}

    @app.post("/predict")
    def predict(req: PredictRequest):
        return predict_entities(req)


    return app


def run_gliner():
    # Run GLiNER with multiple workers (processes) for parallel requests.
    # Default to 3 as requested; can be overridden via GLINER_WORKERS env var.
    workers = int(os.getenv("GLINER_WORKERS", "3"))
    # IMPORTANT: use import string + factory so uvicorn can safely spawn workers without warnings.
    uvicorn.run(
        "model_server:create_gliner_app",
        host="0.0.0.0",
        port=int(os.getenv("SURF_GLINER_PORT", "8081")),
        workers=workers,
        factory=True,
    )


def run_biencoder():
    from fastapi import FastAPI
    from pydantic import BaseModel
    from sentence_transformers import SentenceTransformer

    MODEL_NAME = "BAAI/bge-large-en-v1.5"
    DEVICE = "cuda:1"

    app = FastAPI()
    print(f"Loading BiEncoder: {MODEL_NAME} on {DEVICE}...")
    model = SentenceTransformer(MODEL_NAME, device=DEVICE)
    port = int(os.getenv("SURF_BIENCODER_PORT", "8082"))
    print(f"BiEncoder ready on port {port}")

    class EncodeRequest(BaseModel):
        texts: list[str]

    class EmbedRequest(BaseModel):
        text: str
        is_query: bool = False

    @app.post("/encode")
    def encode(req: EncodeRequest):
        embeddings = model.encode(req.texts, convert_to_tensor=False)
        return {"embeddings": embeddings.tolist()}

    @app.post("/embed")
    def embed(req: EmbedRequest):
        embedding = model.encode(req.text, convert_to_tensor=False)
        return {"embedding": embedding.tolist()}

    uvicorn.run(app, host="0.0.0.0", port=port)


def run_crossencoder():
    from fastapi import FastAPI
    from pydantic import BaseModel
    from sentence_transformers import CrossEncoder

    CROSSENCODER_MODEL_ID = "BAAI/bge-reranker-base"
    DEVICE = "cuda:1"

    app = FastAPI()
    print(f"Loading CrossEncoder: {CROSSENCODER_MODEL_ID} on {DEVICE}...")
    ce_model = CrossEncoder(CROSSENCODER_MODEL_ID, device=DEVICE)
    print(f"CrossEncoder ({CROSSENCODER_MODEL_ID}) ready on port 6010")

    class PredictRequest(BaseModel):
        pairs: list[list[str]]

    @app.get("/model_info")
    def model_info():
        return {"model": CROSSENCODER_MODEL_ID}

    @app.post("/predict")
    def predict(req: PredictRequest):
        scores = ce_model.predict(req.pairs)
        return {"scores": [float(s) for s in scores]}

    uvicorn.run(app, host="0.0.0.0", port=6010)


if __name__ == "__main__":
    p1 = multiprocessing.Process(target=run_gliner)
    p2 = multiprocessing.Process(target=run_biencoder)
    p3 = multiprocessing.Process(target=run_crossencoder)
    p1.start()
    p2.start()
    p3.start()
    print("All model servers starting (8081, 8082, 6010 by default). Press Ctrl+C to stop.")
    p1.join()
    p2.join()
    p3.join()
