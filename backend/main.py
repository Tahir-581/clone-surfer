import os
import json
import secrets
import asyncio
import logging
import re
import sys
import csv
import math
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Dict, Optional, Set, Any, Union
from datetime import datetime, timedelta
from collections import defaultdict
import time
from dotenv import load_dotenv

from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import uvicorn
from bs4 import BeautifulSoup
from urllib.parse import urlparse, quote_plus
from playwright.async_api import async_playwright
from playwright.sync_api import sync_playwright
import aiohttp
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Load environment variables
load_dotenv()

# Playwright needs subprocess support on Windows; Proactor loop provides it.
if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

# Import from google_search module
from serp_captcha_recovery import SerpCaptchaError
from google_search import (
    _scrape_google_results_async,
    BASE_CHROMIUM_ARGS,
    get_hardened_fingerprint,
    apply_stealth,
    resolve_browser_headless,
    normalize_url,
    is_organic_host,
    load_dr_data,
    get_authority,
    GOOGLE_URL,
    SESSION_PATH,
    EXTRACT_JS,
)

# Import from process_entities module (used in merge/other logic if needed)
from process_entities import (
    preprocess_content,
    calculate_tfidf_scores,
    calculate_weightage,
)

# NLP extraction pipeline: GLiNER -> ranker -> deduplicator (models on ports 6000, 6005, 6010)
from NLP_Extraction_and_Ranking.pipeline import run_pipeline
from NLP_Extraction_and_Ranking.nlp_serving_urls import (
    BIENCODER_HEALTH_URL as NLP_BIENCODER_HEALTH_URL,
    CROSSENCODER_HEALTH_URL as NLP_CROSSENCODER_HEALTH_URL,
    GLINER_API_URL as NLP_GLINER_URL,
    GLINER_HEALTH_URL as NLP_GLINER_HEALTH_URL,
    BIENCODER_API_URL as NLP_BIENCODER_URL,
    CROSSENCODER_API_URL as NLP_CROSSENCODER_URL,
    SKIP_TRITON_HEALTHCHECK as NLP_SKIP_TRITON_HEALTHCHECK,
    TRITON_HTTP_URL as NLP_TRITON_URL,
)

# Import merge functionality
from merge_entities import (
    normalize_entity_text,
    get_best_display_form,
)
from database import (
    _connect,
    assign_article_permission,
    authenticate_user,
    create_user,
    get_keyword_json_output,
    get_article_history,
    get_article,
    get_user_by_id,
    import_json_outputs,
    init_db,
    list_keyword_json_outputs,
    list_users,
    delete_keyword_json_output,
    update_user_role,
    upsert_article,
    list_articles,
    delete_article,
    upsert_keyword_json_output,
    verify_email_token,
    set_reset_token,
    reset_password_with_token,
)
from email_service import send_verification_email, send_reset_password_email
import jwt

SECRET_KEY = os.getenv("JWT_SECRET", secrets.token_urlsafe(32))
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = int(os.getenv("JWT_EXPIRE_DAYS", "30"))  # 30-day sessions

search_progress = {}

security = HTTPBearer()

def create_access_token(data: dict, expires_delta: timedelta | None = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired. Please log in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token. Please log in again.")

def require_role(*allowed_roles: str):
    """Dependency factory: ensures the authenticated user has one of the specified roles."""
    def _check(current_user: dict = Depends(get_current_user)):
        user_role = (current_user.get("role") or "").strip().lower().replace(" ", "_")
        if user_role == "admin":
            return current_user  # admin bypasses all role checks
        if allowed_roles and user_role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail=f"Access denied. Required role(s): {', '.join(allowed_roles)}. Your role: {user_role}",
            )
        return current_user
    return _check

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

TRACK_CSV_PATH = Path(__file__).resolve().parent.parent / "time-track.csv"
TRACK_CSV_LOCK = threading.Lock()
TRACK_CSV_COLUMNS = [
    "sr_no",
    "timestamp",
    "session_id",
    "keyword",
    "status",
    "error",
    "requested_k",
    "google_urls_found",
    "urls_selected_for_scraping",
    "scrape_success_count",
    "scrape_failed_count",
    "total_results_returned",
    "use_proxy",
    "use_browser",
    "headless",
    "device",
    "total_time_seconds",
    "google_search_seconds",
    "content_scraping_seconds",
    "save_result_files_seconds",
    "autosave_json_seconds",
    "nlp_total_seconds",
    "nlp_preprocess_seconds",
    "nlp_gliner_seconds",
    "nlp_ranking_seconds",
    "nlp_dedup_seconds",
    "nlp_clustering_seconds",
    "avg_page_scrape_seconds",
    "avg_page_nlp_seconds",
]


def _round_seconds(value: float) -> float:
    return round(float(value or 0.0), 4)


def _ensure_tracking_csv() -> None:
    TRACK_CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    needs_header = (not TRACK_CSV_PATH.exists()) or TRACK_CSV_PATH.stat().st_size == 0
    if needs_header:
        with open(TRACK_CSV_PATH, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=TRACK_CSV_COLUMNS)
            writer.writeheader()


def _next_sr_no() -> int:
    if not TRACK_CSV_PATH.exists() or TRACK_CSV_PATH.stat().st_size == 0:
        return 1
    try:
        with open(TRACK_CSV_PATH, "r", newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
            return len(rows) + 1
    except Exception:
        return 1


def append_time_track_row(row: Dict) -> None:
    with TRACK_CSV_LOCK:
        _ensure_tracking_csv()
        row_out = {col: row.get(col, "") for col in TRACK_CSV_COLUMNS}
        row_out["sr_no"] = row_out.get("sr_no") or _next_sr_no()
        with open(TRACK_CSV_PATH, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=TRACK_CSV_COLUMNS)
            writer.writerow(row_out)


async def _probe_http_json(name: str, url: str, timeout_seconds: float = 2.5) -> Dict:
    status = {
        "name": name,
        "url": url,
        "ok": False,
        "http_status": None,
        "detail": "",
    }
    try:
        timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                url,
                headers={"Accept-Encoding": "identity"},
            ) as response:
                status["http_status"] = response.status
                text = await response.text()
                status["ok"] = 200 <= response.status < 300
                status["detail"] = text[:500]
    except Exception as exc:
        status["detail"] = str(exc)
    return status


async def _skipped_nlp_probe(name: str) -> Dict:
    return {
        "name": name,
        "url": "(skipped)",
        "ok": True,
        "http_status": None,
        "detail": "SURF_SKIP_TRITON_HEALTHCHECK is enabled",
    }


async def check_nlp_service_health() -> Dict:
    triton_probe = (
        _skipped_nlp_probe("triton")
        if NLP_SKIP_TRITON_HEALTHCHECK
        else _probe_http_json("triton", f"{NLP_TRITON_URL}/v2/health/ready")
    )
    checks = await asyncio.gather(
        triton_probe,
        _probe_http_json("gliner", NLP_GLINER_HEALTH_URL),
        _probe_http_json("biencoder", NLP_BIENCODER_HEALTH_URL),
        _probe_http_json("crossencoder", NLP_CROSSENCODER_HEALTH_URL),
    )
    required_names = {"gliner", "biencoder"}
    if not NLP_SKIP_TRITON_HEALTHCHECK:
        required_names.add("triton")
    required = [c for c in checks if c["name"] in required_names]
    return {
        "ok": all(c["ok"] for c in required),
        "checks": checks,
        "hint": (
            "For local Triton + wrappers, start Triton then run the GLiNER/BGE FastAPI scripts "
            "from your served-models repo. For remote-only NLP, set SURF_SKIP_TRITON_HEALTHCHECK=1 "
            "and configure SURF_GLINER_API_URL, SURF_BIENCODER_API_URL, and related env vars "
            "(see backend/.env)."
        ),
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Application lifecycle hook."""
    log.info(
        "Backend startup: NLP served models | Triton=%s | GLiNER=%s | BiEncoder=%s | CrossEncoder=%s",
        NLP_TRITON_URL,
        NLP_GLINER_URL,
        NLP_BIENCODER_URL,
        NLP_CROSSENCODER_URL,
    )
    try:
        health = await check_nlp_service_health()
        if health["ok"]:
            log.info("NLP service health check passed")
        else:
            bad = [
                f"{c['name']}({c['url']})={c['http_status'] or c['detail']}"
                for c in health["checks"]
                if not c["ok"]
            ]
            log.warning("NLP service health check failed: %s", " | ".join(bad))
            log.warning("%s", health["hint"])
    except Exception:
        log.exception("NLP service health check failed unexpectedly")
    try:
        await asyncio.to_thread(init_db)
    except Exception as exc:
        log.exception("PostgreSQL initialization failed")
        raise RuntimeError("Backend startup aborted: PostgreSQL initialization failed") from exc
    yield


# FastAPI app setup
app = FastAPI(title="Surfox", description="NLP-powered content analysis", lifespan=lifespan)

# CORS middleware — OPTIONS 400 on preflight means the request Origin was not allowed.
def _build_cors_allow_origins() -> list[str]:
    _default_cors_origins = [
        "http://localhost:8010",
        "http://127.0.0.1:8010",
        "http://192.168.1.200:8010",
        "http://101.53.247.91:8010",
        "http://101.53.247.91:3010",
        "http://capital.limoex.org:8010",
        "https://capital.limoex.org",
        "http://capital.limeox.com:8010",
        "https://capital.limeox.com",
    ]
    _cors_origins_env = os.getenv("CORS_ALLOW_ORIGINS", "")
    if _cors_origins_env:
        origins = {x.strip() for x in _cors_origins_env.split(",") if x.strip()}
    else:
        origins = set(_default_cors_origins)

    backend_port = os.getenv("BACKEND_PORT", os.getenv("PORT", "8010"))
    frontend_port = os.getenv("FRONTEND_PORT", "3010")
    dev_hosts = ["localhost", "127.0.0.1", "192.168.1.200", "101.53.247.91"]
    dev_ports = {frontend_port, backend_port, "3000", "3010", "3012"}
    for host in dev_hosts:
        for port in dev_ports:
            origins.add(f"http://{host}:{port}")

    return sorted(origins)


_cors_allow_origins = _build_cors_allow_origins()
_regex_env = os.getenv("CORS_ALLOW_ORIGIN_REGEX")
if _regex_env is None:
    _cors_origin_regex = r"https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}):(30\d{2}|8010)"
elif _regex_env.strip():
    _cors_origin_regex = _regex_env.strip()
else:
    _cors_origin_regex = None

_cors_middleware_kwargs: dict[str, Any] = {
    "allow_origins": _cors_allow_origins,
    "allow_credentials": True,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
}
if _cors_origin_regex:
    _cors_middleware_kwargs["allow_origin_regex"] = _cors_origin_regex

app.add_middleware(CORSMiddleware, **_cors_middleware_kwargs)

# ============================================================================
# CONFIGURATION
# ============================================================================

RESULTS_DIR = os.getenv('RESULTS_DIR', 'results')
JSON_OUTPUTS_DIR = Path(__file__).resolve().parent / "json outputs"
TARGET_TITLE = "Dog Breeds for Different Lifestyles"
PORT = int(os.getenv("BACKEND_PORT", os.getenv("PORT", "8010")))

URL_PROCESSING_BATCH_SIZE = int(os.getenv("URL_PROCESSING_BATCH_SIZE", "8"))
MAX_PAGE_NLP_TERMS = int(os.getenv("MAX_PAGE_NLP_TERMS", "100"))
MAX_FINAL_NLP_TERMS = int(os.getenv("MAX_FINAL_NLP_TERMS", "300"))
NLP_PER_ARTICLE_KEEP_RATIO = float(os.getenv("NLP_PER_ARTICLE_KEEP_RATIO", "0.80"))
GLINER_CONTEXT_SIZE = int(os.getenv("GLINER_CONTEXT_SIZE", "600"))
GLINER_STEP_SIZE = int(os.getenv("GLINER_STEP_SIZE", "400"))
SCRAPE_CONCURRENCY = int(os.getenv("SCRAPE_CONCURRENCY", "6"))
NLP_MIN_WORDS = int(os.getenv("NLP_MIN_WORDS", "30"))
NLP_THIN_CONTENT_WORDS = int(os.getenv("NLP_THIN_CONTENT_WORDS", "80"))
NLP_LOW_QUALITY_MAX_NLPS = int(os.getenv("NLP_LOW_QUALITY_MAX_NLPS", "60"))
NLP_MEDIUM_QUALITY_MAX_NLPS = int(os.getenv("NLP_MEDIUM_QUALITY_MAX_NLPS", "80"))
NLP_ERROR_TITLE_MARKERS = [
    x.strip().casefold()
    for x in os.getenv(
        "NLP_ERROR_TITLE_MARKERS",
        "404,403,access denied,captcha,web server is returning an unknown error,error",
    ).split(",")
    if x.strip()
]

FRONTEND_DIR = os.getenv(
    "FRONTEND_DIR",
    str(Path(__file__).resolve().parent.parent / "frontend" / "build"),
)
FRONTEND_INDEX = Path(FRONTEND_DIR) / "index.html"

if Path(FRONTEND_DIR).exists():
    static_dir = Path(FRONTEND_DIR) / "static"
    if static_dir.exists():
        app.mount("/static", StaticFiles(directory=static_dir), name="static")

# NLP extraction uses served models (GLiNER 6000, BiEncoder 6005, CrossEncoder 6010)

# ============================================================================
# PYDANTIC MODELS
# ============================================================================

class SearchRequest(BaseModel):
    keyword: str
    k: int = 20
    use_proxy: bool = False
    headless: bool = True
    use_browser: bool = False
    device: str = "desktop"

class BatchSearchRequest(BaseModel):
    keywords: List[str]
    k: int = 20
    use_proxy: bool = False
    headless: bool = True
    use_browser: bool = False
    device: str = "desktop"

class MergeRequest(BaseModel):
    selected_urls: List[str]
    session_id: str
    keyword: Optional[str] = None  # used for saving JSON by keyword name

class SelectNlpKeywordsRequest(BaseModel):
    source_keyword: Optional[str] = None
    keyword_output_id: Optional[int] = None
    file_name: Optional[str] = None
    json_output: Dict
    selected_keywords: Optional[Dict[str, List[str]]] = None
    results: Optional[List[Dict]] = None
    selected_urls: Optional[List[str]] = None

class RegisterUserRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str = "content_writer"

class LoginRequest(BaseModel):
    email: str
    password: str

class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

class UpdateUserRoleRequest(BaseModel):
    user_id: int
    role: str

class SaveArticleRequest(BaseModel):
    article_key: str
    session_id: Optional[str] = None
    title: str = "Untitled"
    keyword: Optional[str] = None
    keywords: Any = []
    results: List[Dict] = []
    selected_urls: List[str] = []
    content_score: int = 0
    html: str = ""
    text: str = ""
    status: Optional[str] = None
    assigned_to: Optional[int] = None
    user_id: Optional[int] = None
    diff_patch: Optional[str] = None
    content_structure: Optional[Dict] = None

class ArticlePermissionRequest(BaseModel):
    article_key: str
    user_id: int
    can_edit: bool = False
    can_update: bool = False
    assigned_by: Optional[int] = None

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def scrape_page_content(page, url):
    """Scrape content from a single page"""
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        html = await page.content()
        soup = BeautifulSoup(html, 'html.parser')

        # Rule: anchor text inside <a> should not become NLP terms.
        # Remove links before extracting text from headings/paragraphs.
        try:
            for a in soup.find_all("a"):
                a.decompose()
        except Exception:
            pass
        
        # Extract title
        title = ""
        title_tag = soup.find('title')
        if title_tag:
            title = title_tag.get_text(strip=True)
        
        # Extract meta description
        description = ""
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        if meta_desc and meta_desc.get('content'):
            description = meta_desc.get('content').strip()
        
        # Extract headings
        headings = []
        for heading in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
            heading_text = heading.get_text(strip=True)
            if heading_text:
                headings.append(heading_text)
        
        # Extract paragraphs
        paragraphs = []
        for para in soup.find_all('p'):
            para_text = para.get_text(strip=True)
            if para_text:
                paragraphs.append(para_text)
        
        # Combine content
        content_parts = [title, description] + headings + paragraphs
        full_content = " ".join(content_parts)
        
        domain = urlparse(url).netloc
        authority = get_authority(domain)

        return {
            "url": url,
            "domain": domain,
            "title": title,
            "description": description,
            "headings": headings,
            "paragraphs": paragraphs,
            "word_count": len(full_content.split()),
            "heading_count": len(headings),
            "para_count": len(paragraphs),
            "images_count": 0,
            "authority": authority,
            "content": full_content
        }
    except Exception:
        log.exception("Failed to scrape %s", url)
        return None

def scrape_page_content_sync(page, url):
    """Sync Playwright fallback scraper."""
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        html = page.content()
        soup = BeautifulSoup(html, 'html.parser')

        try:
            for a in soup.find_all("a"):
                a.decompose()
        except Exception:
            pass

        title = ""
        title_tag = soup.find('title')
        if title_tag:
            title = title_tag.get_text(strip=True)

        description = ""
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        if meta_desc and meta_desc.get('content'):
            description = meta_desc.get('content').strip()

        headings = []
        for heading in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
            heading_text = heading.get_text(strip=True)
            if heading_text:
                headings.append(heading_text)

        paragraphs = []
        for para in soup.find_all('p'):
            para_text = para.get_text(strip=True)
            if para_text:
                paragraphs.append(para_text)

        content_parts = [title, description] + headings + paragraphs
        full_content = " ".join(content_parts)

        domain = urlparse(url).netloc
        authority = get_authority(domain)

        return {
            "url": url,
            "domain": domain,
            "title": title,
            "description": description,
            "headings": headings,
            "paragraphs": paragraphs,
            "word_count": len(full_content.split()),
            "heading_count": len(headings),
            "para_count": len(paragraphs),
            "images_count": 0,
            "authority": authority,
            "content": full_content
        }
    except Exception:
        log.exception("Failed to scrape %s (sync fallback)", url)
        return None

def _scrape_pages_sync(urls: List[str], headless: bool, device: str):
    """Sync Playwright fallback for page scraping."""
    fingerprint = get_hardened_fingerprint(device)
    effective_headless = resolve_browser_headless(headless, log)
    scraped_pages = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=effective_headless,
            args=BASE_CHROMIUM_ARGS,
        )
        try:
            for idx, url in enumerate(urls):
                context = None
                try:
                    context = browser.new_context(
                        user_agent=fingerprint["user_agent"],
                        viewport=fingerprint["viewport"],
                    )
                    context.add_init_script(
                        f"""
                        Object.defineProperty(navigator, 'webdriver', {{get: () => undefined}});
                        Object.defineProperty(navigator, 'hardwareConcurrency', {{get: () => {fingerprint['hardware_concurrency']} }});
                        Object.defineProperty(navigator, 'deviceMemory', {{get: () => {fingerprint['device_memory']} }});
                        """
                    )
                    page = context.new_page()
                    log.info("[sync fallback] Scraping (%d/%d) %s", idx + 1, len(urls), url)
                    page_data = scrape_page_content_sync(page, url)
                    if page_data is not None:
                        scraped_pages.append((idx, page_data))
                except Exception:
                    log.exception("[sync fallback] Error scraping %s", url)
                finally:
                    try:
                        if context is not None:
                            context.close()
                    except Exception:
                        pass
        finally:
            browser.close()
    return scraped_pages

# ============================================================================
# ENDPOINTS
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "message": f"Surfox backend is running (NLP: GLiNER={NLP_GLINER_URL}, ranker={NLP_BIENCODER_URL})"
    }

@app.get("/search/progress")
async def get_search_progress(keyword: str):
    """Retrieve real-time search progress for a given keyword"""
    kw_key = keyword.strip()
    return search_progress.get(kw_key, {
        "step": "Idle",
        "domain": "",
        "detail": ""
    })

@app.get("/nlp-keywords")
async def get_nlp_keywords(
    source_keyword: Optional[str] = None,
    filter_type: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    user_id: Optional[int] = None,
    page: int = 1,
    limit: Optional[int] = None,
    current_user: dict = Depends(require_role("outliner", "admin")),
):
    try:
        current_role = (current_user.get("role") or "").strip().lower().replace(" ", "_")
        req_user_id = user_id
        if current_role == "outliner":
            req_user_id = current_user.get("user_id")

        res = await asyncio.to_thread(
            list_keyword_json_outputs,
            source_keyword=source_keyword,
            filter_type=filter_type,
            start_date=start_date,
            end_date=end_date,
            user_id=req_user_id,
            page=page,
            limit=limit
        )
        return res
    except Exception as exc:
        log.exception("Could not load NLP keyword JSON outputs from PostgreSQL")
        raise HTTPException(status_code=503, detail=f"Database error: {exc}") from exc

@app.post("/nlp-keywords/select")
async def save_selected_nlp_keywords(
    request: SelectNlpKeywordsRequest,
    current_user: dict = Depends(require_role("outliner", "admin")),
):
    try:
        source_keyword = (request.source_keyword or request.file_name or "search").strip()
        saved = await asyncio.to_thread(
            upsert_keyword_json_output,
            source_keyword,
            request.file_name or f"{source_keyword}.json",
            request.json_output,
            current_user.get("user_id"),
            request.results,
            request.selected_urls,
            request.keyword_output_id
        )
        return {"item": saved}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        log.exception("Could not save selected NLP keywords JSON to PostgreSQL")
        raise HTTPException(status_code=503, detail=f"Database error: {exc}") from exc

@app.post("/nlp-keywords/import-json")
async def import_saved_json_keywords():
    try:
        imported = await asyncio.to_thread(import_json_outputs, JSON_OUTPUTS_DIR)
        return {"imported": imported}
    except Exception as exc:
        log.exception("Could not import JSON output keywords into PostgreSQL")
        raise HTTPException(status_code=503, detail=f"Database error: {exc}") from exc

@app.delete("/nlp-keywords/{output_id}")
async def delete_nlp_keyword_output(
    output_id: int,
    current_user: dict = Depends(require_role("outliner", "admin")),
):
    try:
        current_role = (current_user.get("role") or "").strip().lower().replace(" ", "_")
        owner_user_id = None if current_role == "admin" else current_user.get("user_id")
        deleted = await asyncio.to_thread(delete_keyword_json_output, output_id, owner_user_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Keyword history not found")
        return {"status": "ok", "message": "Keyword history deleted"}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Could not delete NLP keyword JSON output from PostgreSQL")
        raise HTTPException(status_code=503, detail=f"Database error: {exc}") from exc

@app.post("/auth/register")
async def register_user(request: RegisterUserRequest, background_tasks: BackgroundTasks):
    try:
        user = await asyncio.to_thread(
            create_user,
            request.name,
            request.email,
            request.password,
            request.role,
            None,
        )
        token = create_access_token(data={
            "sub": user["email"],
            "user_id": user["id"],
            "role": user.get("role", "content_writer"),
        })
        return {**user, "token": token, "message": "Registration successful. You are now logged in."}
    except Exception as exc:
        log.exception("Could not register user")
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@app.get("/auth/verify-email")
async def verify_email(token: str):
    try:
        user = await asyncio.to_thread(verify_email_token, token)
        if not user:
            raise HTTPException(status_code=400, detail="Invalid or expired verification token.")
        return {**user, "message": "Email verified successfully. You can now log in."}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Could not verify email")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.post("/auth/login")
async def login_user(request: LoginRequest):
    try:
        user = await asyncio.to_thread(authenticate_user, request.email, request.password)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid email or password")
        token = create_access_token(data={
            "sub": user["email"],
            "user_id": user["id"],
            "role": user.get("role", "content_writer"),
        })
        return {**user, "token": token}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Could not login user")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.get("/auth/me")
async def get_me(current_user: dict = Depends(get_current_user)):
    """Returns the current authenticated user's profile from the JWT payload."""
    try:
        user = await asyncio.to_thread(get_user_by_id, current_user.get("user_id"))
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return user
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Could not fetch current user")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.post("/auth/forgot-password")
async def forgot_password(request: ForgotPasswordRequest, background_tasks: BackgroundTasks):
    try:
        token = secrets.token_urlsafe(32)
        found = await asyncio.to_thread(set_reset_token, request.email, token)
        if found:
            background_tasks.add_task(send_reset_password_email, request.email, "User", token)
        # Always return success to avoid email enumeration
        return {"message": "If an account exists with that email, a reset link has been sent."}
    except Exception as exc:
        log.exception("Could not process forgot password")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.post("/auth/reset-password")
async def reset_password(request: ResetPasswordRequest):
    try:
        user = await asyncio.to_thread(reset_password_with_token, request.token, request.new_password)
        if not user:
            raise HTTPException(status_code=400, detail="Invalid or expired reset token. Please request a new one.")
        return {**user, "message": "Password reset successfully. You can now log in."}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Could not reset password")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.post("/admin/users/role")
async def change_user_role(
    request: UpdateUserRoleRequest,
    current_user: dict = Depends(require_role("admin")),
):
    try:
        return await asyncio.to_thread(update_user_role, request.user_id, request.role)
    except Exception as exc:
        log.exception("Could not update user role")
        raise HTTPException(status_code=400, detail=str(exc)) from exc

@app.get("/users")
async def get_users(current_user: dict = Depends(get_current_user)):
    """Returns all users. Authenticated users can see names for assignment dropdowns."""
    try:
        users = await asyncio.to_thread(list_users)
        return {"items": users}
    except Exception as exc:
        log.exception("Could not list users")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.post("/articles")
async def save_article(request: SaveArticleRequest, current_user: dict = Depends(get_current_user)):
    try:
        return await asyncio.to_thread(upsert_article, request.dict())
    except Exception as exc:
        log.exception("Could not save article")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.get("/articles")
async def get_all_articles(current_user: dict = Depends(get_current_user)):
    try:
        articles = await asyncio.to_thread(list_articles)
        return {"items": articles}
    except Exception as exc:
        log.exception("Could not load articles")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.get("/articles/{article_key}")
async def load_article(article_key: str, current_user: dict = Depends(get_current_user)):
    try:
        article = await asyncio.to_thread(get_article, article_key)
        if not article:
            # Fallback 1: check nlp_keyword_outputs database table first
            results_data = []
            selected_urls_val = []
            keywords_val = {}
            session_id = None
            try:
                current_role = (current_user.get("role") or "").strip().lower().replace(" ", "_")
                owner_user_id = None if current_role == "admin" else current_user.get("user_id")
                row = await asyncio.to_thread(get_keyword_json_output, article_key, owner_user_id)
                if row:
                    keywords_val = row.get("keywords_json") or {}
                    results_data = row.get("results") or []
                    selected_urls_val = row.get("selected_urls") or []
            except Exception:
                log.exception("Error checking nlp_keyword_outputs fallback")

            # Fallback 2: scan RESULTS_DIR if database row didn't have results_data
            if not results_data:
                try:
                    for path in Path(RESULTS_DIR).glob("*/1.json"):
                        try:
                            with open(path, "r", encoding="utf-8") as f:
                                data = json.load(f)
                            if data.get("keyword") == article_key:
                                session_dir = path.parent
                                session_id = session_dir.name
                                for r_file in sorted(session_dir.glob("*.json")):
                                    try:
                                        with open(r_file, "r", encoding="utf-8") as f:
                                            results_data.append(json.load(f))
                                    except Exception:
                                        pass
                                break
                        except Exception:
                            pass
                except Exception:
                    log.exception("Error scanning RESULTS_DIR fallback")
                
                selected_urls_val = [r.get("url") for r in results_data if r.get("url")]

            if results_data:
                return {
                    "article_key": article_key,
                    "session_id": session_id,
                    "title": article_key,
                    "keyword": article_key,
                    "keywords_json": keywords_val,
                    "results": results_data,
                    "selected_urls": selected_urls_val,
                    "html": "",
                    "text_content": "",
                    "status": "drafting"
                }
            else:
                raise HTTPException(status_code=404, detail="Article not found")
        return article
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Could not load article")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.delete("/articles/{article_key}")
async def remove_article(article_key: str, current_user: dict = Depends(get_current_user)):
    try:
        success = await asyncio.to_thread(delete_article, article_key)
        if not success:
            raise HTTPException(status_code=404, detail="Article not found")
        return {"status": "ok", "message": "Article deleted"}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Could not delete article")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.get("/articles/{article_key}/history")
async def load_article_history(article_key: str, current_user: dict = Depends(require_role("admin"))):
    """Revision history is admin-only."""
    try:
        return await asyncio.to_thread(get_article_history, article_key)
    except Exception as exc:
        log.exception("Could not load article history")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.post("/articles/permissions")
async def save_article_permission(request: ArticlePermissionRequest, current_user: dict = Depends(get_current_user)):
    try:
        return await asyncio.to_thread(
            assign_article_permission,
            request.article_key,
            request.user_id,
            request.can_edit,
            request.can_update,
            request.assigned_by,
        )
    except Exception as exc:
        log.exception("Could not save article permission")
        raise HTTPException(status_code=400, detail=str(exc)) from exc

def is_social_media_url(url: str) -> bool:
    """Check if URL is from social media platforms (YouTube, Facebook, Reddit)"""
    social_domains = ['youtube.com', 'facebook.com', 'reddit.com', 'youtu.be', 'fb.com']
    try:
        domain = urlparse(url).netloc.lower()
        return any(social in domain for social in social_domains)
    except:
        return False


def _env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _resolve_search_headless(request: SearchRequest) -> bool:
    """Pick headless vs headful for Google SERP scraping.

    Headless is the default. Use run_services.py --headful (SURFOX_HEADFUL=1) for
    a visible browser (e.g. CAPTCHA recovery on a machine with a display).
    """
    want_headless = not _env_truthy("SURFOX_HEADFUL")
    return resolve_browser_headless(want_headless, log)


async def _search_core(request: SearchRequest, owner_user_id: Optional[int] = None) -> Dict:
    """
    Core search pipeline used by both /search and /batch_search.
    Includes auto-saving JSON outputs for the keyword.
    """
    # Start timer
    start_time = time.perf_counter()
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    error_message = ""

    # timing buckets for this query
    timing_steps = {
        "google_search_seconds": 0.0,
        "content_scraping_seconds": 0.0,
        "save_result_files_seconds": 0.0,
        "autosave_json_seconds": 0.0,
        "nlp_total_seconds": 0.0,
        "nlp_preprocess_seconds": 0.0,
        "nlp_gliner_seconds": 0.0,
        "nlp_ranking_seconds": 0.0,
        "nlp_dedup_seconds": 0.0,
        "nlp_clustering_seconds": 0.0,
    }
    page_scrape_durations: List[float] = []
    page_nlp_durations: List[float] = []
    nlp_sent_count = 0
    nlp_skipped_counts = defaultdict(int)

    # metadata for csv tracking
    target_urls = request.k + 10
    all_urls = []
    urls = []
    scraped_pages = []
    results = []
    status = "success"
    session_dir = Path(RESULTS_DIR) / session_id

    try:
        # Create session directory
        session_dir.mkdir(parents=True, exist_ok=True)

        # Step 1: Get Google search results (request more to account for social media filtering)
        log.info(f"Searching Google for: {request.keyword}")
        search_progress[request.keyword] = {
            "step": "Searching Google results",
            "domain": "google.com",
            "detail": f"Searching '{request.keyword}' on Google"
        }

        # Headless by default; SURFOX_HEADFUL=1 (run_services.py --headful) for visible browser
        effective_headless = _resolve_search_headless(request)

        google_start = time.perf_counter()
        all_urls = await _scrape_google_results_async(
            request.keyword,
            k=target_urls,
            headless=effective_headless,
            use_proxy=request.use_proxy,
            device=request.device
        )
        timing_steps["google_search_seconds"] = time.perf_counter() - google_start

        # SERP ranking map: 1 = top result in returned Google list
        rank_map = {u: i + 1 for i, u in enumerate(all_urls or [])}

        if not all_urls:
            raise HTTPException(status_code=400, detail="No URLs found")

        # IMPORTANT: Keep the exact Google SERP order.
        # Do NOT move social results (YouTube/Facebook/Reddit) to the end.
        # Also de-duplicate URLs while preserving order to avoid double scraping.
        urls = []
        seen_norm = set()
        for u in all_urls[:request.k]:
            nu = normalize_url(u)
            if nu in seen_norm:
                continue
            seen_norm.add(nu)
            urls.append(u)

        log.info("Google search completed in %.2fs", timing_steps["google_search_seconds"])
        log.info("Returning top %d results in SERP order", len(urls))

        # Step 2: Scrape content from ALL SERP URLs first
        scraping_start = time.perf_counter()
        try:
            async with async_playwright() as p:
                fingerprint = get_hardened_fingerprint(request.device)
                browser = await p.chromium.launch(
                    headless=effective_headless,
                    args=BASE_CHROMIUM_ARGS,
                )
                scrape_semaphore = asyncio.Semaphore(max(1, SCRAPE_CONCURRENCY))
                shared_context = await browser.new_context(
                    user_agent=fingerprint["user_agent"],
                    viewport=fingerprint["viewport"],
                )
                await apply_stealth(shared_context, fingerprint)

                async def scrape_single_url(url: str, idx: int):
                    async with scrape_semaphore:
                        page = None
                        step_started = time.perf_counter()
                        try:
                            page = await shared_context.new_page()
                            domain_parsed = urlparse(url).netloc
                            search_progress[request.keyword] = {
                                "step": "Reading competitor pages",
                                "domain": domain_parsed,
                                "detail": f"Scraping result {idx + 1} of {len(urls)}"
                            }
                            log.info("Scraping (%d/%d) %s", idx + 1, len(urls), url)
                            page_data = await scrape_page_content(page, url)
                            page_scrape_durations.append(time.perf_counter() - step_started)
                            return page_data
                        except Exception:
                            log.exception("Error scraping %s", url)
                            page_scrape_durations.append(time.perf_counter() - step_started)
                            return None
                        finally:
                            try:
                                if page is not None:
                                    await page.close()
                            except Exception:
                                pass

                try:
                    scraped_list = await asyncio.gather(
                        *[scrape_single_url(url, idx) for idx, url in enumerate(urls)],
                        return_exceptions=True
                    )
                except Exception:
                    log.exception("Error scraping URLs in parallel")
                    scraped_list = []

                for idx, page_data in enumerate(scraped_list or []):
                    if page_data is None or isinstance(page_data, Exception):
                        continue
                    scraped_pages.append((idx, page_data))

                try:
                    await shared_context.close()
                except Exception:
                    pass
                await browser.close()
        except NotImplementedError:
            log.warning("Async Playwright unavailable for page scraping; using sync fallback.")
            scrape_sync_started = time.perf_counter()
            scraped_pages = await asyncio.to_thread(
                _scrape_pages_sync,
                urls,
                effective_headless,
                request.device,
            )
            page_scrape_durations.append(time.perf_counter() - scrape_sync_started)
        timing_steps["content_scraping_seconds"] = time.perf_counter() - scraping_start

        # Step 3: Process scraped contents — GLiNER (6000) -> ranker (6005, 6010) -> deduplicator
        log.info(
            "[Search] Step 3/3 — NLP pipeline for %d pages (batch_size=%d | max_nlps_per_page=%d)",
            len(scraped_pages),
            URL_PROCESSING_BATCH_SIZE,
            MAX_PAGE_NLP_TERMS,
        )

        async def enrich_single_page(idx: int, page_data: Dict):
            nonlocal nlp_sent_count
            url = page_data.get("url", "")
            started = time.perf_counter()
            try:
                content = page_data.get("content", "") or ""
                word_count = int(page_data.get("word_count", 0) or 0)
                title = (page_data.get("title") or request.keyword or "").strip()
                domain = (page_data.get("domain") or "").strip().lower()

                def _domain_tokens(d: str) -> set[str]:
                    d = (d or "").strip().lower()
                    if not d:
                        return set()
                    d = d.split(":")[0]
                    parts = [p for p in d.split(".") if p and p not in {"www", "m", "amp"}]
                    toks = set(parts)
                    if len(parts) >= 2:
                        toks.add(parts[-2])
                    return toks

                banned_domain_tokens = _domain_tokens(domain)

                def _is_pure_number(txt: str) -> bool:
                    t = (txt or "").strip()
                    return bool(t) and t.isdigit()

                def _is_banned_term(txt: str) -> bool:
                    t = (txt or "").strip()
                    if not t:
                        return True
                    tl = t.casefold()
                    if tl in banned_domain_tokens:
                        return True
                    if _is_pure_number(t):
                        return True
                    return False

                nlp_terms = []
                ranking_method = "biencoder"
                clusters = None
                cluster_scores = None
                entities_list = []
                effective_max_nlps = MAX_PAGE_NLP_TERMS
                page_title_cf = title.casefold()
                has_error_title = any(marker in page_title_cf for marker in NLP_ERROR_TITLE_MARKERS)
                if not content.strip():
                    nlp_skipped_counts["empty_content"] += 1
                elif word_count < NLP_MIN_WORDS:
                    nlp_skipped_counts["too_short"] += 1
                elif has_error_title:
                    nlp_skipped_counts["error_like_title"] += 1
                else:
                    # Adaptive NLP depth by page quality to save GLiNER/BGE cycles.
                    if word_count < NLP_THIN_CONTENT_WORDS:
                        effective_max_nlps = min(MAX_PAGE_NLP_TERMS, NLP_LOW_QUALITY_MAX_NLPS)
                    elif word_count < 250:
                        effective_max_nlps = min(MAX_PAGE_NLP_TERMS, NLP_MEDIUM_QUALITY_MAX_NLPS)
                    nlp_sent_count += 1
                    domain_parsed = urlparse(url).netloc
                    search_progress[request.keyword] = {
                        "step": "Extracting NLP keywords",
                        "domain": domain_parsed,
                        "detail": f"Extracting from page {idx + 1} of {len(scraped_pages)}"
                    }
                    log.info(
                        "[NLP] Page %d/%d — url=%s | word_count=%d | max_nlps=%d | dedup_threshold=0.85 | gliner_step=%d",
                        idx + 1,
                        len(scraped_pages),
                        url[:60] + ("..." if len(url) > 60 else ""),
                        word_count,
                        effective_max_nlps,
                        GLINER_STEP_SIZE,
                    )
                    pipeline_result = await asyncio.to_thread(
                        run_pipeline,
                        content,
                        title or request.keyword,
                        max_nlps=effective_max_nlps,
                        dedup_threshold=0.85,
                        gliner_context_size=GLINER_CONTEXT_SIZE,
                        gliner_step_size=GLINER_STEP_SIZE,
                    )
                    ranking_method = pipeline_result.get("ranking_method", "biencoder")
                    entities_list = pipeline_result.get("entities", [])
                    clusters = pipeline_result.get("clusters")
                    cluster_scores = pipeline_result.get("cluster_scores")
                    pipeline_timing = pipeline_result.get("timing_seconds") or {}
                    timing_steps["nlp_preprocess_seconds"] += float(pipeline_timing.get("preprocess_seconds", 0.0) or 0.0)
                    timing_steps["nlp_gliner_seconds"] += float(pipeline_timing.get("gliner_seconds", 0.0) or 0.0)
                    timing_steps["nlp_ranking_seconds"] += float(pipeline_timing.get("ranking_seconds", 0.0) or 0.0)
                    timing_steps["nlp_dedup_seconds"] += float(pipeline_timing.get("dedup_seconds", 0.0) or 0.0)
                    timing_steps["nlp_clustering_seconds"] += float(pipeline_timing.get("clustering_seconds", 0.0) or 0.0)
                    # Keep backward compatible total accounting but include embedding time in ranking bucket.
                    timing_steps["nlp_ranking_seconds"] += float(pipeline_timing.get("embedding_seconds", 0.0) or 0.0)
                    timing_steps["nlp_total_seconds"] += float(pipeline_timing.get("total_seconds", 0.0) or 0.0)
                    log.info(
                        "[NLP] Page done — url=%s | method=%s | terms=%d",
                        url[:50] + ("..." if len(url) > 50 else ""),
                        ranking_method,
                        len(entities_list),
                    )

                anchor_title = (request.keyword or "").strip()
                if anchor_title and not _is_banned_term(anchor_title):
                    nlp_terms.append({
                        "text": anchor_title,
                        "count": 1,
                        "relevance": 1.0,
                        "weightage": 1.0,
                        "source": "gliner",
                        "label": "NLP",
                    })

                for e in entities_list:
                    score = e.get("crossencoder_score") or e.get("biencoder_score") or 0.0
                    if _is_banned_term(e.get("text")):
                        continue
                    nlp_terms.append({
                        "text": e["text"],
                        "count": e.get("count", 1),
                        "relevance": score,
                        "weightage": score,
                        "source": "gliner",
                        "label": "NLP",
                    })

                seen = set()
                deduped = []
                for t in nlp_terms:
                    key = (t.get("text") or "").strip().casefold()
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    deduped.append(t)
                nlp_terms = deduped

                result = {
                    "rank": rank_map.get(url),
                    "url": url,
                    "domain": domain,
                    "title": page_data.get("title", ""),
                    "description": page_data.get("description", ""),
                    "word_count": word_count,
                    "heading_count": int(page_data.get("heading_count", 0) or 0),
                    "para_count": int(page_data.get("para_count", 0) or 0),
                    "authority": page_data.get("authority", 0),
                    "entities": [],
                    "total_entities": 0,
                    "keyphrases": [],
                    "gpt_terms": [],
                    "nlp_terms": nlp_terms,
                    "total_nlp_terms": len(nlp_terms),
                    "ranking_method": ranking_method,
                    "nlp_clusters": clusters,
                    "nlp_cluster_scores": cluster_scores,
                    "content_preview": content[:500] if content else "",
                }
                page_nlp_durations.append(time.perf_counter() - started)
                return result
            except Exception:
                log.exception("NLP processing error for %s", url)
                page_nlp_durations.append(time.perf_counter() - started)
                return None

        def _batches(items, batch_size: int):
            size = max(1, int(batch_size or 1))
            for i in range(0, len(items), size):
                yield items[i:i + size]

        processed_results = []
        for batch in _batches(scraped_pages, URL_PROCESSING_BATCH_SIZE):
            batch_out = await asyncio.gather(
                *[enrich_single_page(idx, page_data) for idx, page_data in batch],
                return_exceptions=True,
            )
            for item in batch_out:
                if item is None or isinstance(item, Exception):
                    continue
                processed_results.append(item)

        search_progress[request.keyword] = {
            "step": "Ranking keyword groups",
            "domain": "ranking-engine",
            "detail": "Merging and sorting extracted entities"
        }
        processed_results.sort(key=lambda r: (r.get("rank") is None, r.get("rank", 10**9)))
        results = processed_results
        log.info(
            "[NLP] Dispatch summary — sent=%d | skipped=%d | reasons=%s",
            nlp_sent_count,
            sum(nlp_skipped_counts.values()),
            dict(nlp_skipped_counts),
        )

        save_start = time.perf_counter()
        for idx, result in enumerate(results, 1):
            try:
                file_path = session_dir / f"{idx}.json"
                with open(file_path, "w") as f:
                    json.dump(result, f, indent=2)
            except Exception:
                log.exception("Error saving result to file")
        timing_steps["save_result_files_seconds"] = time.perf_counter() - save_start

        autosave_start = time.perf_counter()
        try:
            entity_map = defaultdict(
                lambda: {
                    "total_count": 0,
                    "weightage_sum": 0.0,
                    "weightage_weight": 0,
                    "original_forms": [],
                }
            )

            for result_file in sorted(session_dir.glob("*.json")):
                try:
                    with open(result_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    terms = data.get("nlp_terms") or data.get("entities") or []
                    for t in terms:
                        txt = (t.get("text") or "").strip()
                        if not txt or txt.lower() == "n/a":
                            continue
                        key = normalize_entity_text(txt)
                        count = t.get("count", 1) or 1
                        try:
                            count = int(count)
                        except Exception:
                            count = 1
                        count = max(1, count)

                        score = t.get("weightage", 0) or t.get("relevance", 0) or 0
                        try:
                            entity_map[key]["weightage_sum"] += float(score) * count
                            entity_map[key]["weightage_weight"] += count
                        except Exception:
                            pass
                        entity_map[key]["total_count"] += count
                        entity_map[key]["original_forms"].append(txt.lower().strip())
                except Exception:
                    log.exception("[AutoSave] Error reading %s", result_file)

            merged = []
            for _, d in entity_map.items():
                avg_weightage = (
                    d["weightage_sum"] / d["weightage_weight"] if d["weightage_weight"] > 0 else 0.0
                )
                merged.append(
                    {
                        "text": get_best_display_form(d["original_forms"]),
                        "average_weightage": round(avg_weightage, 4),
                    }
                )

            merged.sort(key=lambda x: x.get("average_weightage") or 0, reverse=True)

            total = len(merged)
            green = []
            white = []
            orange = []
            if total > 0:
                green_count = max(1, int(total * 0.4))
                green = merged[:green_count]
                remaining = merged[green_count:]
                white_count = max(1, int(len(remaining) * 0.1)) if remaining else 0
                white = remaining[:white_count]
                orange = remaining[white_count:]

            def _texts(items):
                seen = set()
                out = []
                for it in items:
                    txt = (it.get("text") or "").strip()
                    k = txt.casefold()
                    if not txt or k in seen:
                        continue
                    seen.add(k)
                    out.append(txt)
                return out

            # Step 5: Save JSON output
            search_progress[request.keyword] = {
                "step": "Saving JSON output",
                "domain": "database-server",
                "detail": f"Persisting results for '{request.keyword}'"
            }
            keyword_for_file = (request.keyword or session_id or "search").strip()
            safe_name = re.sub(r"[^\w\s-]", "", keyword_for_file)
            safe_name = re.sub(r"[-\s]+", "_", safe_name).strip() or "search"
            JSON_OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
            out_path = JSON_OUTPUTS_DIR / f"{safe_name}.json"

            payload = {
                "Green": _texts(green),
                "Orange": _texts(orange),
                "White": _texts(white),
            }

            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            try:
                # Initial selected urls: all URLs by default
                selected_urls = [r.get("url") for r in results if r.get("url")]
                await asyncio.to_thread(
                    upsert_keyword_json_output,
                    keyword_for_file,
                    out_path.name,
                    payload,
                    owner_user_id,
                    results,
                    selected_urls
                )
                log.info("[AutoSave] Stored NLP keyword JSON and competitor domains in PostgreSQL")
            except Exception:
                log.exception("[AutoSave] Could not store NLP keyword JSON in PostgreSQL")
            log.info(
                "[AutoSave] Saved NLPs to %s (Green=%d | Orange=%d | White=%d)",
                out_path,
                len(green),
                len(orange),
                len(white),
            )
            try:
                await asyncio.to_thread(
                    upsert_article,
                    {
                        "article_key": request.keyword,
                        "session_id": session_id,
                        "title": request.keyword,
                        "keyword": request.keyword,
                        "keywords": payload,
                        "results": results,
                        "selected_urls": selected_urls,
                        "status": "drafting",
                        "user_id": owner_user_id,
                    }
                )
                log.info("[AutoSave] Auto-created/updated article draft in DB for keyword: %s", request.keyword)
            except Exception:
                log.exception("[AutoSave] Failed to auto-create/update article draft in DB")
        except Exception:
            log.exception("[AutoSave] Could not save json outputs")
        timing_steps["autosave_json_seconds"] = time.perf_counter() - autosave_start

        total_time = time.perf_counter() - start_time
        avg_page_scrape_seconds = (sum(page_scrape_durations) / len(page_scrape_durations)) if page_scrape_durations else 0.0
        avg_page_nlp_seconds = (sum(page_nlp_durations) / len(page_nlp_durations)) if page_nlp_durations else 0.0

        log.info("Scraping completed in %.2fs", timing_steps["content_scraping_seconds"])
        log.info("NLP total completed in %.2fs", timing_steps["nlp_total_seconds"])
        log.info("Total search time: %.2fs", total_time)

        return {
            "session_id": session_id,
            "keyword": request.keyword,
            "total_results": len(results),
            "timing": {
                "google_search_time_seconds": _round_seconds(timing_steps["google_search_seconds"]),
                "content_scraping_time_seconds": _round_seconds(timing_steps["content_scraping_seconds"]),
                "nlp_total_time_seconds": _round_seconds(timing_steps["nlp_total_seconds"]),
                "nlp_step_times_seconds": {
                    "preprocess": _round_seconds(timing_steps["nlp_preprocess_seconds"]),
                    "gliner": _round_seconds(timing_steps["nlp_gliner_seconds"]),
                    "ranking": _round_seconds(timing_steps["nlp_ranking_seconds"]),
                    "deduplication": _round_seconds(timing_steps["nlp_dedup_seconds"]),
                    "clustering": _round_seconds(timing_steps["nlp_clustering_seconds"]),
                },
                "save_results_time_seconds": _round_seconds(timing_steps["save_result_files_seconds"]),
                "autosave_json_time_seconds": _round_seconds(timing_steps["autosave_json_seconds"]),
                "avg_page_scrape_time_seconds": _round_seconds(avg_page_scrape_seconds),
                "avg_page_nlp_time_seconds": _round_seconds(avg_page_nlp_seconds),
                "total_time_seconds": _round_seconds(total_time),
            },
            "results": results
        }
    except Exception as exc:
        status = "failed"
        error_message = str(exc)
        raise
    finally:
        search_progress.pop(request.keyword, None)
        total_time = time.perf_counter() - start_time
        avg_page_scrape_seconds = (sum(page_scrape_durations) / len(page_scrape_durations)) if page_scrape_durations else 0.0
        avg_page_nlp_seconds = (sum(page_nlp_durations) / len(page_nlp_durations)) if page_nlp_durations else 0.0
        csv_row = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "session_id": session_id,
            "keyword": request.keyword,
            "status": status,
            "error": error_message,
            "requested_k": request.k,
            "google_urls_found": len(all_urls or []),
            "urls_selected_for_scraping": len(urls or []),
            "scrape_success_count": len(scraped_pages or []),
            "scrape_failed_count": max(0, len(urls or []) - len(scraped_pages or [])),
            "total_results_returned": len(results or []),
            "use_proxy": request.use_proxy,
            "use_browser": request.use_browser,
            "headless": effective_headless,
            "device": request.device,
            "total_time_seconds": _round_seconds(total_time),
            "google_search_seconds": _round_seconds(timing_steps["google_search_seconds"]),
            "content_scraping_seconds": _round_seconds(timing_steps["content_scraping_seconds"]),
            "save_result_files_seconds": _round_seconds(timing_steps["save_result_files_seconds"]),
            "autosave_json_seconds": _round_seconds(timing_steps["autosave_json_seconds"]),
            "nlp_total_seconds": _round_seconds(timing_steps["nlp_total_seconds"]),
            "nlp_preprocess_seconds": _round_seconds(timing_steps["nlp_preprocess_seconds"]),
            "nlp_gliner_seconds": _round_seconds(timing_steps["nlp_gliner_seconds"]),
            "nlp_ranking_seconds": _round_seconds(timing_steps["nlp_ranking_seconds"]),
            "nlp_dedup_seconds": _round_seconds(timing_steps["nlp_dedup_seconds"]),
            "nlp_clustering_seconds": _round_seconds(timing_steps["nlp_clustering_seconds"]),
            "avg_page_scrape_seconds": _round_seconds(avg_page_scrape_seconds),
            "avg_page_nlp_seconds": _round_seconds(avg_page_nlp_seconds),
        }
        try:
            append_time_track_row(csv_row)
            log.info("[TimeTrack] Query timing appended to %s", TRACK_CSV_PATH)
        except Exception:
            log.exception("[TimeTrack] Failed writing CSV row")

@app.post("/search")
async def search_and_process(
    request: SearchRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(require_role("outliner", "admin")),
):
    """
    Search Google for results and process entities.
    Restricted to outliners and admins.
    """
    try:
        return await _search_core(request, current_user.get("user_id"))
    except SerpCaptchaError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Search error")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/batch_search")
async def batch_search_and_process(
    request: BatchSearchRequest,
    current_user: dict = Depends(require_role("outliner", "admin")),
):
    """
    Run multiple searches sequentially (one-by-one) and auto-save JSON for each keyword.
    Restricted to outliners and admins.
    """
    keywords = [k.strip() for k in (request.keywords or []) if (k or "").strip()]
    if not keywords:
        raise HTTPException(status_code=400, detail="No keywords provided")

    # Hard cap for safety; user can run multiple batches.
    keywords = keywords[:50]

    MAX_RETRIES = 3
    BASE_DELAY_SEC = 4.0

    started = time.time()
    outputs = []
    for kw in keywords:
        attempt = 0
        success = False
        last_error = None
        
        while attempt < MAX_RETRIES and not success:
            attempt += 1
            try:
                if attempt > 1:
                    delay = BASE_DELAY_SEC * (attempt - 1)
                    log.info("[BatchSearch] Retrying keyword=%r (Attempt %d/%d) after %.1fs delay...", kw, attempt, MAX_RETRIES, delay)
                    await asyncio.sleep(delay)

                out = await _search_core(
                    SearchRequest(
                        keyword=kw,
                        k=request.k,
                        use_proxy=request.use_proxy,
                        headless=request.headless,
                        use_browser=request.use_browser,
                        device=request.device,
                    ),
                    current_user.get("user_id"),
                )
                outputs.append(
                    {
                        "keyword": kw,
                        "session_id": out.get("session_id"),
                        "total_results": out.get("total_results", 0),
                        "timing": out.get("timing", {}),
                        "attempts_used": attempt,
                    }
                )
                success = True
            except Exception as e:
                last_error = e
                log.warning("[BatchSearch] keyword=%r failed on attempt %d/%d: %s", kw, attempt, MAX_RETRIES, str(e))

        if not success:
            log.exception("[BatchSearch] keyword=%r completely failed after %d attempts", kw, MAX_RETRIES)
            outputs.append({
                "keyword": kw, 
                "error": str(last_error),
                "attempts_used": attempt
            })

    return {
        "total_keywords": len(keywords),
        "completed": len([o for o in outputs if not o.get("error")]),
        "failed": len([o for o in outputs if o.get("error")]),
        "elapsed_seconds": round(time.time() - started, 2),
        "items": outputs,
    }

@app.post("/merge")
async def merge_entities(request: MergeRequest):
    """
    Merge entities from selected URLs
    """
    try:
        session_dir = Path(RESULTS_DIR) / request.session_id if request.session_id else None
        log.info("[Merge] session_id=%s | keyword=%s | selected_urls=%d", request.session_id, request.keyword, len(request.selected_urls))

        entity_map = defaultdict(
            lambda: {
                "total_count": 0,
                "source_counts": defaultdict(int),
                "sources": set(),
                "relevance_sum": 0.0,
                "relevance_weight": 0,
                "weightage_sum": 0.0,
                "weightage_weight": 0,
                "keybert_score_sum": 0.0,
                "keybert_weight": 0,
                "label": None,
                "files": [],
                "original_forms": [],
            }
        )
        
        stats = {
            'total_files': 0,
            'avg_word_count': 0,
            'avg_heading_count': 0,
            'avg_para_count': 0,
            'avg_images_count': 0
        }
        
        word_count_sum = 0
        heading_count_sum = 0
        para_count_sum = 0
        images_count_sum = 0
        file_count = 0
        
        ranking_method = "biencoder"

        # Check if session directory exists and contains JSON files, or if session_id is empty
        use_db_fallback = False
        if not session_dir or not session_dir.exists() or not list(session_dir.glob("*.json")):
            use_db_fallback = True

        results_data = []
        if use_db_fallback and request.keyword:
            log.info("[Merge] Session directory empty/missing or session_id empty. Falling back to DB for keyword: %s", request.keyword)
            article = await asyncio.to_thread(get_article, request.keyword)
            if article and article.get("results"):
                results_data = article["results"]
        
        if not results_data and session_dir:
            for idx, result_file in enumerate(sorted(session_dir.glob("*.json"))):
                try:
                    with open(result_file, 'r') as f:
                        data = json.load(f)
                    results_data.append(data)
                except Exception:
                    log.exception("Error processing %s", result_file)

        # Load selected results
        for idx, data in enumerate(results_data):
            try:
                url = data.get('url')
                if url not in request.selected_urls:
                    continue
                # Use first selected file's ranking method for merge response
                if file_count == 0:
                    ranking_method = data.get("ranking_method", "biencoder")
                
                # Prefer unified terms if present; otherwise fall back to GLiNER entities.
                terms = data.get("nlp_terms")
                if not terms:
                    terms = data.get("entities", [])
                    for t in terms:
                        t.setdefault("source", "gliner")
                # Keep only the strongest per-article NLPs to prevent count blow-up
                # when merging multiple selected URLs.
                if terms:
                    keep_ratio = min(1.0, max(0.0, NLP_PER_ARTICLE_KEEP_RATIO))
                    if keep_ratio < 1.0:
                        ranked_terms = sorted(
                            terms,
                            key=lambda t: (
                                float(
                                    t.get("weightage", 0)
                                    or t.get("relevance", 0)
                                    or t.get("keybert_score", 0)
                                    or 0
                                ),
                                int(t.get("count", 1) or 1),
                            ),
                            reverse=True,
                        )
                        keep_count = max(1, int(math.ceil(len(ranked_terms) * keep_ratio)))
                        terms = ranked_terms[:keep_count]
                domain = data.get('domain', '')
                domain_lc = (domain or "").strip().lower()

                def _domain_tokens(d: str) -> set[str]:
                    d = (d or "").strip().lower()
                    if not d:
                        return set()
                    d = d.split(":")[0]
                    parts = [p for p in d.split(".") if p and p not in {"www", "m", "amp"}]
                    toks = set(parts)
                    if len(parts) >= 2:
                        toks.add(parts[-2])
                    return toks

                banned_domain_tokens = _domain_tokens(domain_lc)

                def _is_pure_number(txt: str) -> bool:
                    t = (txt or "").strip()
                    return bool(t) and t.isdigit()

                def _is_banned_term(txt: str) -> bool:
                    t = (txt or "").strip()
                    if not t:
                        return True
                    tl = t.casefold()
                    if tl in banned_domain_tokens:
                        return True
                    if _is_pure_number(t):
                        return True
                    return False
                
                word_count_sum += data.get('word_count', 0)
                heading_count_sum += data.get('heading_count', 0)
                para_count_sum += data.get('para_count', 0)
                images_count_sum += data.get('images_count', 0)
                file_count += 1
                
                for term in terms:
                    text = term.get("text")
                    label = term.get("label")
                    source = (term.get("source") or "gliner").lower()
                    count = term.get("count", 1) or 1
                    try:
                        count = int(count)
                    except Exception:
                        count = 1
                    count = max(1, count)

                    relevance = term.get("relevance", 0) or 0
                    weightage = term.get("weightage", 0) or 0
                    keybert_score = term.get("keybert_score", 0) or 0
                    
                    if text and text.lower() != 'n/a' and not _is_banned_term(text):
                        key = normalize_entity_text(text)
                        
                        entity_map[key]["sources"].add(source)
                        entity_map[key]["source_counts"][source] += count
                        entity_map[key]["total_count"] += count

                        if label and entity_map[key]["label"] is None:
                            entity_map[key]["label"] = label
                        
                        # Weighted metric aggregation (by observed count)
                        try:
                            entity_map[key]["relevance_sum"] += float(relevance) * count
                            entity_map[key]["relevance_weight"] += count
                        except Exception:
                            pass
                        try:
                            entity_map[key]["weightage_sum"] += float(weightage) * count
                            entity_map[key]["weightage_weight"] += count
                        except Exception:
                            pass
                        if source == "keybert":
                            try:
                                entity_map[key]["keybert_score_sum"] += float(keybert_score) * count
                                entity_map[key]["keybert_weight"] += count
                            except Exception:
                                pass

                        entity_map[key]["files"].append(domain)
                        entity_map[key]["original_forms"].append(text.lower().strip())
            
            except Exception:
                log.exception("Error processing %s", result_file)
                continue
        
        if file_count > 0:
            stats['total_files'] = file_count
            stats['avg_word_count'] = round(word_count_sum / file_count, 2)
            stats['avg_heading_count'] = round(heading_count_sum / file_count, 2)
            stats['avg_para_count'] = round(para_count_sum / file_count, 2)
            stats['avg_images_count'] = round(images_count_sum / file_count, 2)
        
        # Process entities
        merged_entities = []
        
        for text_lower, data in entity_map.items():
            avg_relevance = (
                data["relevance_sum"] / data["relevance_weight"] if data["relevance_weight"] > 0 else 0.0
            )
            avg_weightage = (
                data["weightage_sum"] / data["weightage_weight"] if data["weightage_weight"] > 0 else 0.0
            )
            avg_keybert = (
                data["keybert_score_sum"] / data["keybert_weight"] if data["keybert_weight"] > 0 else 0.0
            )
            
            display_text = get_best_display_form(data["original_forms"])
            
            merged_entities.append({
                'text': display_text.title() if len(display_text.split()) > 1 else display_text,
                'label': data["label"] or ("Keyphrase" if "keybert" in data["sources"] else "Other"),
                # Frequency analysis output
                'combined_count': data["total_count"],
                'sources': sorted(list(data["sources"])),
                'source_counts': {k: int(v) for k, v in data["source_counts"].items()},
                'average_relevance': round(avg_relevance, 4),
                'average_weightage': round(avg_weightage, 4),
                'average_keybert_score': round(avg_keybert, 4),
                'competitor_count': len(set(data["files"])),
                'found_in_files': list(set(data["files"]))
            })
        
        # Calculate adjusted weightage (kept for response fields; not used for ordering)
        for entity in merged_entities:
            competitor_count = entity['competitor_count']
            if competitor_count >= 3:
                multiplier = 3
            elif competitor_count == 2:
                multiplier = 2
            else:
                multiplier = 1
            entity['competitor_multiplier'] = multiplier
            entity['adjusted_weightage'] = entity['average_weightage'] * multiplier

        # Order by similarity only: highest score first, regardless of competitor count
        merged_entities.sort(key=lambda x: x['average_weightage'], reverse=True)

        # Calculate word_range
        x_value = stats['avg_word_count'] * 0.60
        total_adjusted_weightage = sum(e['adjusted_weightage'] for e in merged_entities)
        
        for entity in merged_entities:
            probability = entity['adjusted_weightage'] / total_adjusted_weightage if total_adjusted_weightage > 0 else 0
            word_range_value = probability * x_value
            entity['word_range'] = math.ceil(word_range_value)

        # Return full merged list (no hard cap)
        returned_entities = merged_entities
        log.info("[Merge] done — files=%d | unique_entities=%d | returned=%d | ranking_method=%s",
                 stats['total_files'], len(merged_entities), len(returned_entities), ranking_method)

        # Split into Green (top 40%), White (top 10% of remainder), Orange (rest) — same as frontend
        sorted_entities = sorted(returned_entities, key=lambda x: x.get('average_weightage') or 0, reverse=True)
        total = len(sorted_entities)
        green_nlps = []
        white_nlps = []
        orange_nlps = []
        if total > 0:
            green_count = max(1, int(total * 0.4))
            green_nlps = sorted_entities[:green_count]
            remaining = sorted_entities[green_count:]
            white_count = max(1, int(len(remaining) * 0.1)) if remaining else 0
            white_nlps = remaining[:white_count]
            orange_nlps = remaining[white_count:]

        # Save JSON by keyword: json outputs/<keyword>.json with Green / Orange / White
        keyword_for_file = (request.keyword or request.session_id or "merge").strip()
        if keyword_for_file:
            safe_name = re.sub(r'[^\w\s-]', '', keyword_for_file)
            safe_name = re.sub(r'[-\s]+', '_', safe_name).strip() or "merge"
            JSON_OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
            out_path = JSON_OUTPUTS_DIR / f"{safe_name}.json"
            def _texts(items):
                seen = set()
                out = []
                for it in items:
                    txt = (it.get("text") or "").strip()
                    k = txt.casefold()
                    if not txt or k in seen:
                        continue
                    seen.add(k)
                    out.append(txt)
                return out

            payload = {
                "Green": _texts(green_nlps),
                "Orange": _texts(orange_nlps),
                "White": _texts(white_nlps),
            }
            try:
                with open(out_path, 'w', encoding='utf-8') as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2)
                try:
                    await asyncio.to_thread(
                        upsert_keyword_json_output,
                        keyword_for_file,
                        out_path.name,
                        payload,
                    )
                    log.info("[Merge] Stored NLP keyword JSON in PostgreSQL")
                except Exception:
                    log.exception("[Merge] Could not store NLP keyword JSON in PostgreSQL")
                log.info("[Merge] Saved NLPs by keyword to %s (Green=%d | Orange=%d | White=%d)",
                         out_path, len(green_nlps), len(orange_nlps), len(white_nlps))
            except Exception:
                log.exception("[Merge] Could not save json outputs")

        return {
            'merge_date': datetime.now().isoformat(),
            'ranking_method': ranking_method,
            'total_files_processed': stats['total_files'],
            'average_statistics': {
                'avg_word_count': stats['avg_word_count'],
                'avg_heading_count': stats['avg_heading_count'],
                'avg_paragraph_count': stats['avg_para_count'],
                'avg_images_count': stats['avg_images_count'],
                'word_range_60_percent_value': round(x_value, 2),
                'total_adjusted_weightage': round(total_adjusted_weightage, 2)
            },
            'total_unique_entities': len(merged_entities),
            'total_entity_occurrences': sum(e['combined_count'] for e in merged_entities),
            'entities': returned_entities
        }
    
    except Exception as e:
        log.exception("Merge error")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/nlp-health")
async def nlp_health():
    health = await check_nlp_service_health()
    if not health["ok"]:
        raise HTTPException(status_code=503, detail=health)
    return health


@app.get("/", include_in_schema=False)
def serve_frontend_root():
    if FRONTEND_INDEX.exists():
        return FileResponse(FRONTEND_INDEX)
    raise HTTPException(status_code=404, detail="Frontend build not found")


@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend_paths(full_path: str):
    if not FRONTEND_INDEX.exists():
        raise HTTPException(status_code=404, detail="Frontend build not found")

    requested = Path(FRONTEND_DIR) / full_path
    if requested.exists() and requested.is_file():
        return FileResponse(requested)

    return FileResponse(FRONTEND_INDEX)

if __name__ == "__main__":
    os.makedirs(RESULTS_DIR, exist_ok=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT)
  
