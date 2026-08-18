#!/usr/bin/env python3
"""
Test Batch NLP Keyword Extraction and Google Scraping.

This script reads the first 10 keywords from `keywords_200.csv` and submits them 
as a batch request to the backend's `/batch_search` API endpoint.

Usage:
    python test_batch_search.py [options]
"""

import os
import sys
import csv
import json
import time
import argparse
import requests

def load_keywords(csv_path: str, limit: int = 10) -> list[str]:
    """Reads the first N keywords from a CSV file."""
    if not os.path.exists(csv_path):
        print(f"Error: CSV file not found at {csv_path}", file=sys.stderr)
        sys.exit(1)
        
    keywords = []
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        for row in reader:
            if not row:
                continue
            # If row has multiple columns, take the second column as the keyword/title
            if len(row) >= 2:
                kw = row[1].strip()
            else:
                kw = row[0].strip()
                
            # Skip potential header rows
            if kw.lower() in ("title", "keyword", "keywords", "source_keyword", "title_id"):
                continue
                
            if kw:
                keywords.append(kw)
                if len(keywords) >= limit:
                    break
    return keywords

def main():
    parser = argparse.ArgumentParser(description="Test batch NLP keyword extraction.")
    parser.add_argument(
        "--csv",
        type=str,
        default="keywords_200.csv",
        help="Path to the keywords CSV file (default: keywords_200.csv)"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=100,
        help="Number of keywords to extract and process (default: 10)"
    )
    parser.add_argument(
        "--url",
        type=str,
        default="http://localhost:8010",
        help="Backend base URL (default: http://localhost:8010)"
    )
    parser.add_argument(
        "--k",
        type=int,
        default=5,
        help="Number of Google search results to retrieve and scrape per keyword (default: 5)"
    )
    parser.add_argument(
        "--device",
        type=str,
        default="desktop",
        choices=["desktop", "mobile"],
        help="Device profile to emulate during scraping (default: desktop)"
    )
    args = parser.parse_args()

    print("=" * 60)
    print("           SURFOX NLP BATCH EXTRACTION TESTER")
    print("=" * 60)
    
    # 1. Load keywords
    print(f"[*] Loading first {args.limit} keywords from: {args.csv}")
    keywords = load_keywords(args.csv, limit=args.limit)
    if not keywords:
        print("[-] No valid keywords found to process.")
        return
        
    print(f"[+] Successfully loaded {len(keywords)} keywords:")
    for idx, kw in enumerate(keywords, 1):
        print(f"    {idx}. {kw}")
    print("-" * 60)

    # 2. Check backend health
    health_url = f"{args.url.rstrip('/')}/health"
    print(f"[*] Checking backend service health at: {health_url}")
    try:
        health_resp = requests.get(health_url, timeout=5)
        health_resp.raise_for_status()
        print(f"[+] Backend is ONLINE: {health_resp.json().get('message', 'OK')}")
    except Exception as e:
        print(f"[-] Error connecting to backend: {e}")
        print("    Please ensure you have started the backend services via:")
        print("    python run_services.py")
        sys.exit(1)
    print("-" * 60)

    # 3. Submit batch search request
    batch_url = f"{args.url.rstrip('/')}/batch_search"
    payload = {
        "keywords": keywords,
        "k": args.k,
        "use_proxy": False,
        "headless": True,
        "use_browser": False,
        "device": args.device
    }

    print(f"[*] Submitting batch request to: {batch_url}")
    print(f"[*] Emulating device profile: {args.device} | Scrape depth: k={args.k}")
    print("[*] Processing... (this will scrape Google and run ML ranking sequentially per keyword)")
    print("[*] Note: Processing 10 keywords may take 1-2 minutes depending on connection speeds.")
    
    start_time = time.time()
    try:
        response = requests.post(batch_url, json=payload, timeout=600)  # long timeout for large batch processing
        response.raise_for_status()
        result_data = response.json()
    except Exception as e:
        print(f"\n[-] Batch request failed: {e}")
        sys.exit(1)

    elapsed = time.time() - start_time
    print("-" * 60)
    print("                     BATCH PROCESSING RESULTS")
    print("=" * 60)
    print(f"Total Keywords Submitted : {result_data.get('total_keywords', len(keywords))}")
    print(f"Successfully Completed   : {result_data.get('completed', 0)}")
    print(f"Failed / Errored         : {result_data.get('failed', 0)}")
    print(f"Script Elapsed Time      : {elapsed:.2f} seconds")
    print(f"Backend Server Time      : {result_data.get('elapsed_seconds', 0.0):.2f} seconds")
    print("=" * 60)

    print("\nDetailed Summary:")
    for item in result_data.get("items", []):
        kw = item.get("keyword")
        err = item.get("error")
        if err:
            print(f"\n[❌] Keyword: {kw}")
            print(f"    Status: FAILED")
            print(f"    Error : {err}")
        else:
            print(f"\n[✅] Keyword: {kw}")
            print(f"    Status       : COMPLETED")
            print(f"    Session ID   : {item.get('session_id')}")
            print(f"    Total Scraped: {item.get('total_results')} results")
            
            timing = item.get("timing", {})
            if timing:
                print("    Timing Stats:")
                print(f"      - Google Search   : {timing.get('google_search_seconds', 0.0):.2f}s")
                print(f"      - Page Scraping   : {timing.get('content_scraping_seconds', 0.0):.2f}s")
                print(f"      - ML NLP Pipeline : {timing.get('nlp_total_seconds', 0.0):.2f}s")

    # 4. Save results output to file
    output_filename = "batch_test_results.json"
    with open(output_filename, "w", encoding="utf-8") as out_f:
        json.dump(result_data, out_f, indent=2)
        
    print("-" * 60)
    print(f"[+] Detailed raw batch results saved to: {output_filename}")
    print("=" * 60)

if __name__ == "__main__":
    main()
