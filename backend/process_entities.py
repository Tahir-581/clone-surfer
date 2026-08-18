import json
import os
import sys
import time
import torch
import re
import math
from collections import Counter
from gliner import GLiNER
from sentence_transformers import SentenceTransformer, util
from nltk.corpus import stopwords
import nltk

# Download stopwords if not already present
try:
    stopwords.words('english')
except LookupError:
    nltk.download('stopwords')

# Configuration
INPUT_FOLDER = None  # Will be set from command line argument
OUTPUT_DIR = None    # Will be generated based on input folder
TARGET_TITLE = "Top 9 Dog Breeds Under 45 Pounds: Find Your Match"

ENTITY_LABELS = [
    "Person", "Organization", "Location", "City", "Country", "Address",
    "Date", "Time", "Event", "Work of Art", "Consumer Good", "Other",
    "Price", "Phone Number", "Law", "Language", "Percentage", 
    "Scientific Term", "Title", "Position", "Product", "Brand",
    "Concept", "Theory", "Medical Condition", "Chemical", "Award",
    "Animal Breed", "Nature", "Substance", "Vehicle", "Facility", "dog breeds"
]

def preprocess_content(text):
    """
    Preprocess content by removing stop words, pronouns, and other noise.
    This helps improve entity extraction quality.
    """
    # Get English stop words
    stop_words = set(stopwords.words('english'))
    
    # Define pronouns and weak words
    pronouns = {
        "i", "me", "you", "he", "him", "she", "her", "it",
        "we", "us", "they", "them", "my", "your", "his", "hers",
        "our", "their", "mine", "yours", "ours", "theirs",
        "who", "whom", "whose", "this", "that", "these", "those",
        "myself", "yourself", "himself", "herself", "itself",
        "ourselves", "yourselves", "themselves"
    }
    
    # Combine stop words and pronouns
    words_to_remove = stop_words | pronouns
    
    # Split text into words while preserving structure
    words = text.split()
    filtered_words = []
    
    for word in words:
        # Remove punctuation from edges
        cleaned_word = word.strip("\"'()[]{}<>.,;:!?-")
        
        # Convert to lowercase for comparison
        lower_word = cleaned_word.lower()
        
        # Skip if it's a stop word or pronoun
        if lower_word in words_to_remove or len(cleaned_word) <= 3:
            continue
        
        # Keep the original word (preserving case)
        if cleaned_word:
            filtered_words.append(word)
    
    # Reconstruct text
    preprocessed_text = " ".join(filtered_words)
    
    return preprocessed_text


def extract_entities_sliding_window(text, model, step_size=300, context_size=600):
    """Extract entities from text using sliding window approach"""
    entity_counts = Counter()
    original_forms = {}

    PRONOUNS = {
        "i", "me", "you", "he", "him", "she", "her", "it",
        "we", "us", "they", "them", "my", "your", "his", "hers",
        "our", "their", "mine", "yours", "ours", "theirs",
        "who", "whom", "whose"
    }
    
    for i in range(0, len(text), step_size):
        chunk = text[i : i + context_size]
        if not chunk.strip():
            continue
            
        chunk_ents = model.predict_entities(chunk, ENTITY_LABELS, threshold=0.30)
        
        for ent in chunk_ents:
            text_span = ent["text"].strip()

            # Pronoun filtering
            if " " not in text_span:
                token = text_span.replace("'", "'").strip("\"'()[]{}<>.,;:!?-")
                base = token.split("'")[0].lower()
                if base in PRONOUNS:
                    continue

            # Length filtering
            cleaned = "".join(ch for ch in text_span if ch.isalnum())
            if len(cleaned) <= 2:
                continue

            # Normalize text for aggregation (case-insensitive)
            norm_text = text_span.casefold()
            # Use only text as key (ignore label to avoid duplicates with different labels)
            key = norm_text

            # Increment aggregated count
            entity_counts[key] += 1

            # Track original forms and labels
            if key not in original_forms:
                original_forms[key] = {"text": Counter(), "labels": Counter()}
            original_forms[key]["text"][text_span] += 1
            original_forms[key]["labels"][ent["label"]] += 1
            
        if i + context_size >= len(text):
            break
            
    # Convert the Counter into a list of dictionaries
    final_entities = []
    for norm_text, count in entity_counts.items():
        form_counter = original_forms.get(norm_text)
        if form_counter:
            display_text = form_counter["text"].most_common(1)[0][0]
            # Get the most common label for this text
            label_val = form_counter["labels"].most_common(1)[0][0]
        else:
            display_text = norm_text
            label_val = "Other"

        final_entities.append({
            "text": display_text,
            "label": label_val,
            "count": count
        })
            
    return sorted(final_entities, key=lambda x: x['count'], reverse=True)


def calculate_relevance_scores(entities, target_title):
    """Calculate relevance scores for entities using semantic similarity on GPU"""
    # Initialize model directly on cuda:1 to avoid cuda:0 allocation
    model = SentenceTransformer('all-MiniLM-L6-v2', device='cuda:1')
    
    if not entities:
        return entities
    
    entity_texts = [ent["text"] for ent in entities]
    
    # Encode title and entities on GPU
    title_embedding = model.encode(target_title, convert_to_tensor=True)
    entity_embeddings = model.encode(entity_texts, convert_to_tensor=True)
    
    # Calculate cosine similarity
    cosine_scores = util.cos_sim(title_embedding, entity_embeddings)[0]
    
    # Map scores back to entities
    for i, entity in enumerate(entities):
        entity["relevance"] = round(float(cosine_scores[i]), 4)
    
    return entities


def calculate_tfidf_scores(entities, content):
    """
    Calculate TF-IDF scores for entities.
    TF (Term Frequency) = count of entity / total words in content
    IDF (Inverse Document Frequency) = log(total_entities / entities_containing_term) 
    TF-IDF = TF × IDF
    """
    total_words = len(content.split())
    total_entities = len(entities)
    
    if total_words == 0 or total_entities == 0:
        return entities
    
    for entity in entities:
        count = entity.get("count", 0)
        
        # TF = term frequency (count of entity / total words)
        tf = count / total_words if total_words > 0 else 0
        
        # IDF = log(total unique entities / 1) - simplified as log(total_entities)
        # Using 1 as denominator since each entity appears at least once
        idf = math.log(total_entities + 1)  # +1 to avoid log(1)=0
        
        # TF-IDF score
        tfidf = tf * idf
        entity["tfidf"] = round(tfidf, 4)
    
    return entities


def check_proximity(entity_text, title, description, content):
    """
    Check if entity is in proximity (title, description, or first 10% of content).
    Returns 1 if in proximity, 0 otherwise.
    Note: Uses preprocessed versions for consistent matching since entities are extracted from preprocessed content.
    Uses word-based matching for multi-word entities.
    """
    # Split entity into individual words for flexible matching
    entity_words = entity_text.lower().split()
    if not entity_words:
        return 0
    
    # Preprocess title, description, and content for consistent matching
    preprocessed_title = preprocess_content(title)
    preprocessed_description = preprocess_content(description) if description else ""
    preprocessed_content = preprocess_content(content)
    
    # Helper function to check if entity words appear consecutively in text
    def entity_in_text(words, text):
        text_words = text.lower().split()
        if not text_words or len(words) > len(text_words):
            return False
        
        for i in range(len(text_words) - len(words) + 1):
            if text_words[i:i+len(words)] == words:
                return True
        return False
    
    # Check if entity is in title
    if entity_in_text(entity_words, preprocessed_title):
        return 1
    
    # Check if entity is in description
    if preprocessed_description and entity_in_text(entity_words, preprocessed_description):
        return 1
    
    # Check if entity is in first 10% of content
    words = preprocessed_content.split()
    first_10_percent_count = max(1, len(words) // 10)  # At least 1 word
    first_10_percent_text = " ".join(words[:first_10_percent_count])
    
    if entity_in_text(entity_words, first_10_percent_text):
        return 1
    return 0


def calculate_weightage(entities, authority, title="", description="", content=""):
    """
    Calculate weightage for each entity using weighted percentages:
    - Relevance: 50%
    - Authority: 20%
    - TF-IDF: 10%
    - Count (normalized): 10%
    
    All values are normalized to 0-1 range before calculation.
    """
    if not entities:
        return entities
    
    # Step 1: Normalize authority to 0-1 range (assuming it's typically 1-10)
    normalized_authority = min(authority / 10, 1.0) if authority > 0 else 0
    
    # Step 2: Normalize count to 0-1 range (divide by max count)
    max_count = max([e.get("count", 0) for e in entities])
    
    # Step 3: Normalize TF-IDF to 0-1 range (divide by max tfidf)
    max_tfidf = max([e.get("tfidf", 0) for e in entities])
    
    # Step 4: Calculate normalized weightage (proximity removed)
    for entity in entities:
        count = entity.get("count", 0)
        relevance = entity.get("relevance", 0)  # Already 0-1
        tfidf = entity.get("tfidf", 0)
        
        # Normalize all values to 0-1 range
        normalized_count = count / max_count if max_count > 0 else 0
        normalized_tfidf = tfidf / max_tfidf if max_tfidf > 0 else 0
        
        # Weighted calculation: all values now on same 0-1 scale
        # 60% relevance + 25% authority + 10% tfidf + 5% count
        entity["weightage"] = round(
            (relevance * 0.60) + (normalized_authority * 0.25) + (normalized_tfidf * 0.10) + (normalized_count * 0.05),
            4
        )
    
    return entities


def process_json_file(input_path, gliner_model):
    """Process a single JSON file: extract entities, calculate relevance and weightage"""
    
    # Load input JSON
    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Extract metadata
    authority = data.get("authority", 1)
    content = data.get("content", "")
    url = data.get("url", "")
    title = data.get("title", "")
    description = data.get("description", "")
    
    print(f"\n[Processing] {url}")
    print(f"Content length: {len(content)} characters")
    
    # Check if content has at least 30 words
    word_count = len(content.split())
    print(f"Word count: {word_count}")
    
    if word_count < 30:
        print(f"  ⚠️  Warning: Content has less than 30 words. Returning N/A.")
        output_data = {
            "url": url,
            "word_count": data.get("word_count"),
            "heading_count": data.get("heading_count"),
            "para_count": data.get("para_count"),
            "images_count": data.get("images_count"),
            "authority": authority,
            "target_title": TARGET_TITLE,
            "status": "N/A",
            "reason": f"Content too short: only {word_count} words (minimum 30 required)",
            "total_entities": 0,
            "entities": []
        }
        
        # Generate output filename
        filename = os.path.basename(input_path)
        output_path = os.path.join(OUTPUT_DIR, filename)
        
        # Save output JSON
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, ensure_ascii=False, indent=2)
        
        print(f"  → Saved to: {output_path}")
        return output_data
    
    # Step 0: Preprocess content (remove stop words and pronouns)
    print("  → Preprocessing content (removing stop words and pronouns)...")
    preprocessed_content = preprocess_content(content)
    preprocessed_word_count = len(preprocessed_content.split())
    print(f"  → After preprocessing: {preprocessed_word_count} words")
    
    # Step 1: Extract entities using GLiNER on preprocessed content
    print("  → Extracting entities...")
    entities = extract_entities_sliding_window(preprocessed_content, gliner_model)
    print(f"  → Found {len(entities)} unique entities")
    
    # Step 2: Calculate relevance scores
    print("  → Calculating relevance scores...")
    entities = calculate_relevance_scores(entities, TARGET_TITLE)
    
    # Step 3: Calculate TF-IDF scores
    print("  → Calculating TF-IDF scores...")
    entities = calculate_tfidf_scores(entities, preprocessed_content)
    
    # Step 4: Calculate weightage
    print("  → Calculating weightage...")
    entities = calculate_weightage(entities, authority, title, description, content)
    
    # Sort by weightage descending
    entities = sorted(entities, key=lambda x: x['weightage'], reverse=True)
    
    # Create output structure
    output_data = {
        "url": url,
        "word_count": data.get("word_count"),
        "heading_count": data.get("heading_count"),
        "para_count": data.get("para_count"),
        "images_count": data.get("images_count"),
        "authority": authority,
        "target_title": TARGET_TITLE,
        "total_entities": len(entities),
        "entities": entities
    }
    
    # Generate output filename
    filename = os.path.basename(input_path)
    output_path = os.path.join(OUTPUT_DIR, filename)
    
    # Save output JSON
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)
    
    print(f"  → Saved to: {output_path}")
    
    return output_data


def main():
    global INPUT_FOLDER, OUTPUT_DIR
    
    # Get folder path from command line argument
    if len(sys.argv) < 2:
        print("Usage: python process_entities.py <folder_path>")
        print("Example: python process_entities.py Top_9_Dog_Breeds_Under_45_Pounds_Find_Your_Match")
        sys.exit(1)
    
    INPUT_FOLDER = sys.argv[1]
    
    # Validate folder exists
    if not os.path.isdir(INPUT_FOLDER):
        print(f"Error: Folder '{INPUT_FOLDER}' does not exist!")
        sys.exit(1)
    
    # Create output directory with folder name
    folder_name = os.path.basename(INPUT_FOLDER.rstrip('/'))
    OUTPUT_DIR = f"outputs_{folder_name}"
    
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        print(f"✓ Created output directory: {OUTPUT_DIR}")
    
    start_time = time.time()
    
    print("=" * 60)
    print("ENTITY EXTRACTION & WEIGHTAGE CALCULATION")
    print("=" * 60)
    
    # Check GPU availability
    print("\n[GPU Check]")
    print(f"  CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"  CUDA device: {torch.cuda.get_device_name(1)}")
        torch.cuda.set_device(1)
    
    # Load GLiNER model once on GPU
    print("\n[1] Loading GLiNER model on GPU (cuda:1)...")
    gliner_model = GLiNER.from_pretrained("urchade/gliner_large-v2.1")
    gliner_model = gliner_model.to('cuda:1')
    print("    ✓ GLiNER model loaded on GPU")
    
    # Get all JSON files from input folder
    print(f"\n[2] Scanning folder: {INPUT_FOLDER}")
    json_files = [f for f in os.listdir(INPUT_FOLDER) if f.endswith('.json')]
    
    if not json_files:
        print(f"  ✗ No JSON files found in {INPUT_FOLDER}")
        sys.exit(1)
    
    print(f"  ✓ Found {len(json_files)} JSON files")
    
    # Process each JSON file
    print(f"\n[3] Processing JSON files...")
    results = []
    for json_file in json_files:
        input_path = os.path.join(INPUT_FOLDER, json_file)
        result = process_json_file(input_path, gliner_model)
        results.append(result)
    
    # Summary
    end_time = time.time()
    elapsed_time = end_time - start_time
    
    print("\n" + "=" * 60)
    print("PROCESSING COMPLETE")
    print("=" * 60)
    print(f"✓ Processed {len(results)} JSON files")
    print(f"✓ Results saved to: {OUTPUT_DIR}/")
    print("\nOutput files:")
    for json_file in json_files:
        print(f"  - {json_file}")
    print("\n" + "=" * 60)
    print(f"⏱️  Total time taken: {elapsed_time:.2f} seconds ({elapsed_time/60:.2f} minutes)")
    print("=" * 60)


if __name__ == "__main__":
    main()