#!/usr/bin/env python3
"""Lightweight smoke tests without live SERP/NLP/Postgres."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def test_nlp_imports() -> None:
    from NLP_Extraction_and_Ranking.pipeline import run_pipeline  # noqa: F401
    from NLP_Extraction_and_Ranking.reranker_client import RerankerClient  # noqa: F401
    from NLP_Extraction_and_Ranking.nlp_serving_urls import USE_RERANKER, RERANK_URL  # noqa: F401
    assert isinstance(USE_RERANKER, bool)
    assert RERANK_URL


def test_merge_filter() -> None:
    from merge_entities import normalize_entity_text, get_best_display_form  # noqa: F401

    session_dir = ROOT / "backend" / "results" / "_smoke_session"
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "1.json").write_text(
        json.dumps(
            {
                "url": "https://example.com/a",
                "domain": "example.com",
                "nlp_terms": [{"text": "dog breeds", "weightage": 0.9, "count": 1}],
            }
        ),
        encoding="utf-8",
    )
    (session_dir / "2.json").write_text(
        json.dumps(
            {
                "url": "https://other.com/b",
                "domain": "other.com",
                "nlp_terms": [{"text": "cat food", "weightage": 0.8, "count": 1}],
            }
        ),
        encoding="utf-8",
    )

    selected = {"https://example.com/a"}
    texts = []
    for result_file in sorted(session_dir.glob("*.json")):
        data = json.loads(result_file.read_text(encoding="utf-8"))
        if data.get("url") not in selected:
            continue
        for t in data.get("nlp_terms") or []:
            texts.append(t.get("text"))
    assert texts == ["dog breeds"]

    for f in session_dir.glob("*.json"):
        f.unlink()
    session_dir.rmdir()


def test_app_routes() -> None:
    from main import app

    paths = {getattr(r, "path", None) for r in app.routes}
    for required in (
        "/search",
        "/merge",
        "/articles",
        "/nlp-keywords",
        "/auth/login",
        "/health",
        "/nlp-health",
    ):
        assert required in paths, f"missing route {required}"


def main() -> int:
    test_nlp_imports()
    test_merge_filter()
    test_app_routes()
    print("smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
