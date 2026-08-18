import json
import os
import csv
import numpy as np
import requests

from .nlp_serving_urls import CROSSENCODER_API_URL
from .bge_client import BGETritonClient

bge_client = BGETritonClient()

def rank_entities_by_similarity(input_json_path, output_dir, title):
    """
    Rank extracted entities by similarity. Primary ranking uses CrossEncoder (Llama reranker);
    BiEncoder (BAAI/bge-large-en-v1.5) scores are also computed for reference.
    """
    
    # Load the NER results
    with open(input_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    entities = data.get("entities", [])
    
    if not entities:
        print("No entities found in input file")
        return
    
    # ========== BiEncoder Ranking (Primary) ==========
    print(f"\n{'='*70}")
    print(f"--- Loading BAAI/bge-large-en-v1.5 BiEncoder Model (via API on port 6005) ---")
    print(f"{'='*70}")

    print(f"--- Encoding Title: '{title}' ---")
    print(f"--- Encoding {len(entities)} entities for BiEncoder similarity ranking ---")

    # Encode title and all entities in one batch via API
    texts_to_encode = [title] + [entity["text"] for entity in entities]
    embeddings = bge_client.encode(texts_to_encode, is_query=False)
    title_emb = embeddings[0:1]
    entity_embeddings = embeddings[1:]
    # Cosine similarity: normalize then dot product
    norms_title = np.linalg.norm(title_emb, axis=1, keepdims=True)
    norms_ent = np.linalg.norm(entity_embeddings, axis=1, keepdims=True)
    norms_ent = np.maximum(norms_ent, 1e-9)
    sims = (entity_embeddings / norms_ent) @ (title_emb / np.maximum(norms_title, 1e-9)).T
    similarity_scores = sims.ravel()

    ranked_entities = []
    for i, entity in enumerate(entities):
        ranked_entities.append({
            "text": entity["text"],
            "count": entity["count"],
            "biencoder_score": round(float(similarity_scores[i]), 4),
            "crossencoder_score": None
        })
    
    # Do not sort by BiEncoder here; final order will be by CrossEncoder (primary)
    # Print BiEncoder scores (order is arbitrary until CrossEncoder runs)
    print("\n[BiEncoder Similarity Scores]")
    print("-" * 80)
    by_biencoder = sorted(ranked_entities, key=lambda x: x["biencoder_score"], reverse=True)
    for i, entity in enumerate(by_biencoder[:20], 1):
        print(f"{i:2}. {entity['text']:40} | BiEncoder: {entity['biencoder_score']:.4f} | Count: {entity['count']}")
    print("-" * 80)
    print(f"Total entities (BiEncoder scores): {len(ranked_entities)}\n")
    
    # ========== CrossEncoder Scoring (Comparison Only) ==========
    CROSSENCODER_MODEL_ID = "nvidia/llama-3.2-nv-rerankqa-1b-v2"
    FALLBACK_RERANKER_ID = "BAAI/bge-reranker-base"

    print(f"\n{'='*70}")
    print(f"--- Loading CrossEncoder (via API on port 6010) ---")
    print(f"{'='*70}")

    crossencoder_available = False
    crossencoder_model_used = None

    try:
        print(f"--- Computing CrossEncoder scores for {len(ranked_entities)} entities ---")
        pairs = [[title, entity["text"]] for entity in ranked_entities]
        r = requests.post(
            f"{CROSSENCODER_API_URL}/predict",
            json={"pairs": pairs},
            timeout=300,
        )
        r.raise_for_status()
        cross_encoder_scores = [round(float(s), 4) for s in r.json()["scores"]]
        for i, entity in enumerate(ranked_entities):
            entity["crossencoder_score"] = cross_encoder_scores[i]
        crossencoder_available = True
        info = requests.get(f"{CROSSENCODER_API_URL}/model_info", timeout=10)
        crossencoder_model_used = info.json().get("model", CROSSENCODER_MODEL_ID) if info.ok else CROSSENCODER_MODEL_ID
    except Exception as e:
        print(f"Warning: CrossEncoder API failed: {e}")
        print("Continuing with BiEncoder results only...\n")
    
    # Primary ranking: by CrossEncoder when available, else by BiEncoder
    if crossencoder_available:
        ranked_entities = sorted(ranked_entities, key=lambda x: x["crossencoder_score"], reverse=True)
        print("\n[Final Ranking by CrossEncoder (Primary)]")
        print("-" * 110)
        for i, entity in enumerate(ranked_entities[:20], 1):
            print(f"{i:2}. {entity['text']:40} | BiEncoder: {entity['biencoder_score']:.4f} | CrossEncoder: {entity['crossencoder_score']:.4f} | Count: {entity['count']}")
        print("-" * 110)
        print(f"CrossEncoder model used: {crossencoder_model_used}")
        print(f"Total entities ranked by CrossEncoder: {len(ranked_entities)}\n")
    else:
        ranked_entities = sorted(ranked_entities, key=lambda x: x["biencoder_score"], reverse=True)
        print("\n[Final Ranking by BiEncoder (CrossEncoder unavailable)]")
        print("-" * 80)
        for i, entity in enumerate(ranked_entities[:20], 1):
            print(f"{i:2}. {entity['text']:40} | BiEncoder: {entity['biencoder_score']:.4f} | Count: {entity['count']}")
        print("-" * 80)
        print(f"Total entities ranked by BiEncoder: {len(ranked_entities)}\n")
    
    # ========== Save JSON Results ==========
    os.makedirs(output_dir, exist_ok=True)
    
    filename = os.path.splitext(os.path.basename(input_json_path))[0] + "_ranked_final.json"
    output_json_path = os.path.join(output_dir, filename)
    
    result = {
        "source": data.get("source"),
        "title": title,
        "unique_count": len(ranked_entities),
        "total_instances": data.get("total_instances"),
        "ranking_by": "crossencoder" if crossencoder_available else "biencoder",
        "biencoder_model": "BAAI/bge-large-en-v1.5",
        "crossencoder_model": crossencoder_model_used if crossencoder_available else "Not available",
        "ranked_entities": ranked_entities
    }
    
    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    print(f"Ranked results saved to JSON: {output_json_path}")
    
    # ========== Save CSV Results ==========
    csv_filename = os.path.splitext(os.path.basename(input_json_path))[0] + "_ranked_combined.csv"
    output_csv_path = os.path.join(output_dir, csv_filename)
    
    with open(output_csv_path, "w", encoding="utf-8", newline="") as csvfile:
        if crossencoder_available:
            fieldnames = ["Rank (CrossEncoder)", "Entity Text", "Count", "BiEncoder Score", "CrossEncoder Score"]
        else:
            fieldnames = ["Rank (BiEncoder)", "Entity Text", "Count", "BiEncoder Score"]
        
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        
        writer.writeheader()
        for i, entity in enumerate(ranked_entities, 1):
            rank_key = "Rank (CrossEncoder)" if crossencoder_available else "Rank (BiEncoder)"
            row = {
                rank_key: i,
                "Entity Text": entity["text"],
                "Count": entity["count"],
                "BiEncoder Score": entity["biencoder_score"]
            }
            if crossencoder_available:
                row["CrossEncoder Score"] = entity["crossencoder_score"]
            
            writer.writerow(row)
    
    print(f"Ranked results saved to CSV: {output_csv_path}")

def main():
    INPUT_FILE = "outputs/gliner_output.json"
    OUTPUT_DIR = "outputs"
    TITLE = "Dog Breeds to Deter Intruders and Keep You Safe"
    
    if not os.path.isfile(INPUT_FILE):
        raise SystemExit(f"Input file not found: {INPUT_FILE}")
    
    rank_entities_by_similarity(INPUT_FILE, OUTPUT_DIR, TITLE)

if __name__ == "__main__":
    main()
