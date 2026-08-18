import json
import os
import random
import time
import requests
from collections import Counter
from typing import List, Iterable, Optional
from concurrent.futures import ThreadPoolExecutor

from requests import RequestException
from requests.adapters import HTTPAdapter

from .nlp_serving_urls import GLINER_MODEL_ID, GLINER_PREDICT_URL


class GLiNERServiceError(RuntimeError):
    """Raised when the GLiNER wrapper or its Triton backend is unavailable."""


def _response_detail(response: requests.Response) -> str:
    try:
        body = response.json() or {}
        detail = body.get("detail") or body.get("error") or body
    except ValueError:
        detail = response.text
    return str(detail)[:1000]


class GLiNERClient:
    """Thin client for GLiNER FastAPI wrapper (backed by Triton)."""

    _session: Optional[requests.Session] = None
    _pool_size: Optional[int] = None

    @classmethod
    def _get_pool_size(cls) -> int:
        # Keep pool comfortably above default parallel fan-out.
        # Example default: URL batch (8) * parallel batch requests (8) = 64.
        # We use a higher floor to avoid noisy pool churn under bursty load.
        configured = int(os.getenv("GLINER_REQUEST_CONCURRENCY", "100000"))
        return max(1, configured)

    @classmethod
    def _get_session(cls) -> requests.Session:
        # Keep-alive session to avoid TCP handshake cost per chunk.
        pool_size = cls._get_pool_size()
        if cls._session is None or cls._pool_size != pool_size:
            session = requests.Session()
            # pool_block=True prevents "Connection pool is full, discarding connection"
            # bursts by waiting for a free socket instead of dropping keep-alive reuse.
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

    def _post_json_with_retry(self, url: str, payload: dict, timeout: int = 120) -> dict:
        max_attempts = max(1, int(os.getenv("GLINER_HTTP_RETRY_ATTEMPTS", "3")))
        base_sleep = max(0.01, float(os.getenv("GLINER_HTTP_RETRY_BASE_SECONDS", "0.2")))
        last_error = ""
        for attempt in range(1, max_attempts + 1):
            try:
                r = self._get_session().post(url, json=payload, timeout=timeout)
                if r.status_code >= 500:
                    last_error = f"HTTP {r.status_code}: {_response_detail(r)}"
                    raise GLiNERServiceError(last_error)
                r.raise_for_status()
                return r.json() or {}
            except GLiNERServiceError:
                if attempt >= max_attempts:
                    raise
            except RequestException as exc:
                last_error = str(exc)
                if attempt >= max_attempts:
                    raise GLiNERServiceError(
                        f"GLiNER service request failed at {url}: {last_error}. "
                        "Check that the FastAPI wrapper is running and that its Triton backend is ready."
                    ) from exc
            sleep_for = base_sleep * (2 ** (attempt - 1)) + random.uniform(0.0, 0.05)
            time.sleep(sleep_for)

        raise GLiNERServiceError(f"GLiNER service request failed at {url}: {last_error}")

    def _post_predict_with_retry(self, payload: dict) -> list:
        max_attempts = max(1, int(os.getenv("GLINER_HTTP_RETRY_ATTEMPTS", "3")))
        base_sleep = max(0.01, float(os.getenv("GLINER_HTTP_RETRY_BASE_SECONDS", "0.2")))
        base_url = GLINER_PREDICT_URL.rsplit("/", 1)[0]
        urls = list(dict.fromkeys([
            GLINER_PREDICT_URL,
            f"{base_url}/predict_entities",
            f"{base_url}/predict",
            f"{base_url}/extract_entities",
        ]))
        for attempt in range(1, max_attempts + 1):
            try:
                last_response = None
                for url in urls:
                    r = self._get_session().post(url, json=payload, timeout=120)
                    last_response = r
                    if r.status_code in {404, 405} and url != urls[-1]:
                        continue
                    if r.status_code >= 500:
                        raise GLiNERServiceError(
                            f"GLiNER service at {url} returned HTTP {r.status_code}: {_response_detail(r)}. "
                            "The wrapper is running, but its upstream Triton backend is not healthy."
                        )
                    r.raise_for_status()
                    return (r.json() or {}).get("entities", []) or []
                if last_response is not None:
                    last_response.raise_for_status()
                return []
            except GLiNERServiceError:
                raise
            except RequestException as exc:
                if attempt >= max_attempts:
                    raise GLiNERServiceError(
                        f"GLiNER service request failed at {GLINER_PREDICT_URL}: {exc}. "
                        "Check that the FastAPI wrapper is running and that its Triton backend is ready."
                    ) from exc
                sleep_for = base_sleep * (2 ** (attempt - 1)) + random.uniform(0.0, 0.05)
                time.sleep(sleep_for)

    def predict_entities(self, text, labels, threshold=0.12):
        payload = {"text": text, "labels": list(labels), "threshold": float(threshold)}
        if GLINER_MODEL_ID:
            payload["model"] = GLINER_MODEL_ID
        return self._post_predict_with_retry(payload)

    def predict_entities_batch(self, texts: List[str], labels, threshold=0.12) -> List[list]:
        items = [t for t in list(texts) if isinstance(t, str)]
        if not items:
            return []

        # Wrapper currently exposes single-item inference; do parallel fan-out for batch.
        labels_list = list(labels)
        th = float(threshold)

        out: List[list] = [[] for _ in items]

        def _run_one(i: int, t: str) -> None:
            out[i] = self.predict_entities(t, labels_list, threshold=th) or []

        max_workers = min(max(1, int(os.getenv("GLINER_PARALLEL_BATCH_REQUESTS", "8"))), len(items))
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futures = [ex.submit(_run_one, i, t) for i, t in enumerate(items)]
            for f in futures:
                f.result()
        return out

ENTITY_LABELS = [
    # People & orgs
    "Person", "Organization", "Company", "Institution", "School", "University",
    "Author", "Artist", "Character", "Profession", "Role", "Group",
    # Places
    "Location", "City", "Country", "Address", "Region", "Place", "Building",
    "Landmark", "Continent", "Area", "Territory",
    # Time
    "Date", "Time", "Event", "Period", "Year", "Duration", "Era",
    # Things & products
    "Work of Art", "Consumer Good", "Product", "Brand", "Vehicle", "Tool",
    "Equipment", "Technology", "Software", "Food", "Dish", "Substance",
    "Chemical", "Material", "Object",
    # Abstract & concepts
    "Concept", "Theory", "Idea", "Topic", "Theme", "Category", "Type",
    "Attribute", "Quality", "Trait", "Behavior", "Activity", "Skill",
    "Method", "Technique", "Principle", "Requirement", "Feature", "Benefit",
    "Condition", "State", "Aspect", "Factor", "Criteria",
    # Legal, medical, science
    "Law", "Medical Condition", "Disease", "Scientific Term", "Award",
    "Language", "Percentage", "Price", "Phone Number",
    # Animals & nature (your domain)
    "Animal", "Animal Breed", "Dog Breed", "Breed", "Species", "Pet",
    "Nature", "Plant", "Environment", "Habitat",
    # Other
    "Title", "Position", "Facility", "Other", "Term", "Phrase", "Expression",
]

def _chunk_starts_and_ends(text, target_chunk_size=600, step_size=300):
    """Yield (start, end) indices so each chunk is aligned to word boundaries.
    This avoids cutting mid-word, which causes GLiNER to predict fragments like
    'ude', 'tion', 'attit', 'iven'.
    """
    n = len(text)
    start = 0
    while start < n:
        end = min(start + target_chunk_size, n)
        # If we're not at the end, back up to the last space so we don't cut a word
        if end < n and end > start:
            last_space = text.rfind(" ", start, end + 1)
            if last_space > start:
                end = last_space + 1
        yield start, end
        # Step forward; try to start at a word boundary
        start = start + step_size
        if start < n and text[start] not in " \n\t":
            next_space = text.find(" ", start, min(start + 80, n))
            if next_space != -1:
                start = next_space + 1
        if start >= n:
            break


def extract_entities_sliding_window(text, model, step_size=300, context_size=600):
    # Use a Counter where the key is a tuple of (text, label)
    # We'll aggregate case-insensitively: use a normalized (casefolded) text as the
    # counting key but remember the original forms so we can pick a canonical
    # display string (the most frequent original form seen).
    entity_counts = Counter()
    original_forms = {}

    PRONOUNS = {
        "i", "me", "you", "he", "him", "she", "her", "it",
        "we", "us", "they", "them", "my", "your", "his", "hers",
        "our", "their", "mine", "yours", "ours", "theirs",
        "who", "whom", "whose", "that", "this", "these", "those"
    }

    # Common word fragments GLiNER can emit when context is cut mid-word
    FRAGMENTS = {
        "tion", "ude", "ive", "nat", "iven", "attit", "ident", "itude",
        "ment", "ness", "ence", "ance", "ally", "cal", "ful", "ous",
        "ive", "ent", "ant", "est", "ity", "ive", "ly", "er", "ed",
        "al", "ic", "an", "or", "ar", "en", "on", "in", "at", "ed",
    }

    # Collect all non-empty chunks
    chunks: List[str] = []
    for start, end in _chunk_starts_and_ends(text, context_size, step_size):
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk)

    # Triton config supports up to batch size 8 for gliner_ner.
    batch_size = int(os.getenv("GLINER_CHUNK_BATCH_SIZE", "8"))
    batch_size = max(1, min(batch_size, 64))
    # Pool size can stay high, but active parallel requests should be tuned separately.
    request_concurrency = max(1, int(os.getenv("GLINER_PARALLEL_BATCH_REQUESTS", "8")))

    chunk_results: List[list] = []
    if hasattr(model, "predict_entities_batch"):
        batches = [chunks[i:i + batch_size] for i in range(0, len(chunks), batch_size)]
        batch_outputs: List[List[list]] = [[] for _ in batches]

        def _run_batch(idx: int, batch: List[str]) -> None:
            out = model.predict_entities_batch(batch, ENTITY_LABELS, threshold=0.12)
            if len(out) != len(batch):
                out = [model.predict_entities(c, ENTITY_LABELS, threshold=0.12) for c in batch]
            batch_outputs[idx] = out

        max_workers = min(request_concurrency, len(batches) or 1)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(_run_batch, i, b) for i, b in enumerate(batches)]
            for fut in futures:
                fut.result()

        for out in batch_outputs:
            chunk_results.extend(out)
    else:
        chunk_results = [model.predict_entities(c, ENTITY_LABELS, threshold=0.12) for c in chunks]

    for chunk_ents in chunk_results:
        for ent in chunk_ents:
            text_span = ent["text"].strip()

            # Pronoun filtering
            if " " not in text_span:
                token = text_span.replace("’", "'").strip("\"'()[]{}<>.,;:!?-")
                base = token.split("'")[0].lower()
                if base in PRONOUNS:
                    continue

            # Length filtering
            cleaned = "".join(ch for ch in text_span if ch.isalnum())
            if len(cleaned) <= 2:
                continue

            # Skip known word fragments (from mid-word chunk cuts) and suffix-like tokens
            base_lower = cleaned.lower()
            if base_lower in FRAGMENTS:
                continue
            if len(base_lower) <= 5 and (base_lower.endswith(("tion", "ude", "ive", "ment", "ness", "ence", "ance")) or base_lower.startswith(("nat", "ident", "iven"))):
                continue

            # Normalize text for aggregation (case-insensitive)
            norm_text = text_span.casefold()
            key = norm_text

            # Increment aggregated count by text only (ignore label differences)
            entity_counts[key] += 1

            # Track original forms so we can choose a canonical display text
            if key not in original_forms:
                original_forms[key] = Counter()
            original_forms[key][text_span] += 1

    # Convert the Counter into a list of dictionaries with a 'count' field
    final_entities = []
    for norm_text, count in entity_counts.items():
        # choose the most common original form for display
        orig_counter = original_forms.get(norm_text)
        if orig_counter:
            display_text = orig_counter.most_common(1)[0][0]
        else:
            display_text = norm_text

        final_entities.append({
            "text": display_text,
            "count": count
        })
            
    # Sort by count (descending) so the most frequent appear first
    return sorted(final_entities, key=lambda x: x['count'], reverse=True)

def main():
    INPUT_FILE = "Dog_Breeds_to_Deter_Intruders_and_Keep_You_Safe/www.wisdompanel.com_27412.json"
    OUTPUT_DIR = "outputs"
    MODEL_NAME = "urchade/gliner_large-v2.1" 
    
    if not os.path.isfile(INPUT_FILE):
        raise SystemExit(f"Input file not found: {INPUT_FILE}")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
        text = data.get("content", "")

    if not text:
        raise SystemExit("No 'content' field found in JSON file")

    print(f"--- Loading LARGE Model: {MODEL_NAME} (via API on port 6000) ---")
    model = GLiNERClient()
    
    print(f"--- Deep Scanning & Aggregating {len(text)} characters... ---")
    entities = extract_entities_sliding_window(text, model)

    total_instances = sum(ent["count"] for ent in entities)
    
    print("\n[Deep Extraction Summary]")
    print("-" * 40)
    print(f"UNIQUE ENTITIES FOUND: {len(entities)}")
    print(f"TOTAL INSTANCES FOUND: {total_instances}\n")
    print("-" * 40)

    filename = os.path.splitext(os.path.basename(INPUT_FILE))[0] + "_ner.json"
    output_path = "outputs/gliner_output.json"
    result = {
        "source": os.path.basename(INPUT_FILE), 
        "unique_count": len(entities),
        "total_instances": total_instances,
        "entities": entities
    }

    with open(output_path, "w", encoding="utf-8") as out_f:
        json.dump(result, out_f, ensure_ascii=False, indent=2)

    print(f"Aggregated results saved to: {output_path}")

if __name__ == "__main__":
    main()
