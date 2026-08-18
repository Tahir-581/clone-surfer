import os
import json
import asyncio
import aiohttp
import re
import csv
import sys
from bs4 import BeautifulSoup
from urllib.parse import urlparse
from langdetect import detect, DetectorFactory
import time
import random
import logging
from urllib.parse import quote_plus, unquote, parse_qs, urlunparse
from playwright.async_api import async_playwright
from playwright.sync_api import sync_playwright
from dotenv import load_dotenv

from serp_captcha_recovery import SerpCaptchaError

# Load environment variables
load_dotenv()

# Ensures language detection is consistent
DetectorFactory.seed = 0

# Configure logging for Google scraper
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("google_search")

# ============================================================================
# GOOGLE SCRAPER CONFIGURATION (from google_version_2.py)
# ============================================================================
MAX_K        = 100
GOOGLE_URL   = os.getenv('GOOGLE_URL', 'https://www.google.com/search')
CHUNK_SIZE   = 10
SESSION_PATH = "google_serp_session"

TRACKING_PARAMS = {
    "srsltid", "utm_source", "utm_medium", "utm_campaign", "utm_term",
    "utm_content", "ref", "referrer", "fbclid", "gclid", "msclkid",
    "_ga", "mc_cid", "mc_eid",
}

BLOCKED_HOSTS = {
    "google.com", "webcache.googleusercontent.com", "support.google.com",
    "policies.google.com", "accounts.google.com", "translate.google.com", "play.google.com",
}

EXTRACT_JS = """
() => {
    const EXCLUDED = [
        '#kp-wp-tab-overview', '[data-initq]', '.related-question-pair',
        '.ULSxyf', '[data-text-ad]', '.commercial-unit-desktop-top',
        '.commercial-unit-desktop-rhs', '.g-blk', '#tads', '#bottomads',
        '[data-text-ad]', '.ads-ad', '#bottomads', '#tads'
    ];

    function resolveHref(raw) {
        if (!raw) return null;
        if (raw.startsWith('/url?q=') || raw.includes('google.com/url?q=')) {
            try {
                const u = new URL(raw.startsWith('/') ? 'https://google.com' + raw : raw);
                const q = u.searchParams.get('q');
                if (q && q.startsWith('http')) return decodeURIComponent(q);
            } catch(e) {}
        }
        if (raw.startsWith('http') && !raw.includes('google.com')) return raw;
        return null;
    }

    function isExcluded(el) {
        return EXCLUDED.some(sel => {
            try { return el.closest(sel) !== null; } catch(e) { return false; }
        });
    }

    const urls = [];
    const searchRoot =
        document.querySelector('div#search')   ||
        document.querySelector('div#rso')      ||
        document.querySelector('div#main')     ||
        document.querySelector('div#cnt');
    
    if (searchRoot) {
        const headings = Array.from(searchRoot.querySelectorAll(
            'h3, div[role="heading"], span[role="heading"]'
        ));

        for (const heading of headings) {
            if (isExcluded(heading)) continue;
            let el = heading.closest('a[href]');
            if (!el) {
                let p = heading.parentElement;
                let depth = 0;
                while (p && depth < 10) {
                    const anchors = Array.from(p.querySelectorAll('a[href]'));
                    const match = anchors.find(a => {
                        const h = a.getAttribute('href') || '';
                        return (h.startsWith('http') && !h.includes('google.com')) || h.startsWith('/url?q=');
                    });
                    if (match) { el = match; break; }
                    p = p.parentElement;
                    depth++;
                }
            }
            if (el) {
                const href = resolveHref(el.getAttribute('href'));
                if (href && !urls.includes(href)) urls.push(href);
            }
        }
    }

    // Fallback for mobile layouts without explicit headings
    if (urls.length === 0) {
        const allAnchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of allAnchors) {
            if (isExcluded(a)) continue;
            const href = resolveHref(a.getAttribute('href') || '');
            if (!href) continue;
            const text = (a.textContent || '').trim();
            if (text.length < 5) continue;
            if (!urls.includes(href)) urls.push(href);
        }
    }
    return urls;
}
"""

# ============================================================================
# CONFIGURATION
# ============================================================================
PROXY_URL = os.getenv('GOOGLE_PROXY_URL', 'http://108.59.14.203:13080')
GOOGLE_NAV_TIMEOUT_MS = int(os.getenv("GOOGLE_NAV_TIMEOUT_MS", "45000"))
GOOGLE_RETRY_TIMEOUT_MS = int(os.getenv("GOOGLE_RETRY_TIMEOUT_MS", "60000"))
GOOGLE_CAPTCHA_WAIT_SECONDS = int(os.getenv("GOOGLE_CAPTCHA_WAIT_SECONDS", "300"))

BASE_CHROMIUM_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-sandbox",
]


def has_display_server() -> bool:
    """Return True when a headed Linux browser has a display to attach to."""
    if sys.platform.startswith("linux"):
        return bool(os.getenv("DISPLAY") or os.getenv("WAYLAND_DISPLAY"))
    return True


def resolve_browser_headless(requested_headless: bool, logger=None) -> bool:
    """Force headless mode when headful Chromium cannot run in this environment."""
    if requested_headless:
        return True

    if has_display_server():
        return False

    message = (
        "Headful browser requested, but no DISPLAY/WAYLAND_DISPLAY is available. "
        "Falling back to headless mode. Use xvfb-run or run on a desktop session for headful mode."
    )
    if logger is not None:
        logger.warning(message)
    else:
        print(message)
    return True

# ============================================================================
# LOAD DR DATA FROM CSV
# ============================================================================

def load_dr_data(csv_path="Inputs/Data .csv"):
    """Load Domain Rating data from CSV into a dictionary"""
    dr_dict = {}
    try:
        with open(csv_path, 'r', encoding='utf-8') as f:
            reader = csv.reader(f)
            next(reader)  # Skip header
            for row in reader:
                if len(row) >= 2:
                    domain = row[0].strip()
                    try:
                        dr = float(row[1].strip())
                        dr_dict[domain] = dr
                    except ValueError:
                        continue
    except FileNotFoundError:
        print(f"Warning: {csv_path} not found. All domains will get authority=5")
    return dr_dict

DR_DATA = load_dr_data()

# ============================================================================
# GOOGLE SCRAPER HELPER FUNCTIONS (from google_version_2.py)
# ============================================================================

def normalize_url(href: str) -> str:
    """Strip fragment, tracking params, and trailing slash."""
    try:
        p = urlparse(href)
        qs_clean = "&".join(
            f"{k}={v}"
            for part in (p.query or "").split("&")
            for k, _, v in [part.partition("=")]
            if k and k not in TRACKING_PARAMS
        )
        return urlunparse((p.scheme, p.netloc, p.path.rstrip("/"), p.params, qs_clean, ""))
    except Exception:
        return href

def is_organic_host(href: str) -> bool:
    """Check if host is a legitimate search result."""
    if not href or not href.startswith("http"):
        return False
    try:
        host = urlparse(href).netloc.lower().lstrip("www.")
        return not any(host == b or host.endswith("." + b) for b in BLOCKED_HOSTS)
    except Exception:
        return False

def get_hardened_fingerprint(device_type="desktop"):
    """Generates localized and device-specific fingerprints."""
    if device_type == "mobile":
        user_agent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.96 Mobile Safari/537.36"
        viewport = {"width": 412, "height": 915}
    else:
        user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        viewport = {"width": 1280, "height": 800}

    return {
        "user_agent": user_agent,
        "viewport": viewport,
        "hardware_concurrency": random.choice([4, 8, 16]),
        "device_memory": random.choice([4, 8]),
    }

async def apply_stealth(context, fingerprint):
    """Hide automation indicators."""
    await context.add_init_script(f"""
        Object.defineProperty(navigator, 'webdriver', {{get: () => undefined}});
        Object.defineProperty(navigator, 'hardwareConcurrency', {{get: () => {fingerprint['hardware_concurrency']} }});
        Object.defineProperty(navigator, 'deviceMemory', {{get: () => {fingerprint['device_memory']} }});
    """)

def scrape_google_results(keyword, k=20, headless=False, use_proxy=False, device="desktop"):
    """Scrape Google search results using Playwright (sync wrapper)."""
    return asyncio.run(_scrape_google_results_async(keyword, k, headless, use_proxy, device))

def _build_google_search_url(keyword: str, start: int, device: str) -> str:
    if device == "mobile":
        return f"{GOOGLE_URL}?q={quote_plus(keyword)}&client=ms-android-google&sourceid=chrome-mobile&start={start}"
    return f"{GOOGLE_URL}?q={quote_plus(keyword)}&hl=en&gl=us&start={start}"


async def _goto_with_retries(page, url: str, prefix: str = "") -> bool:
    attempts = (
        ("domcontentloaded", GOOGLE_NAV_TIMEOUT_MS),
        ("load", GOOGLE_RETRY_TIMEOUT_MS),
    )

    for index, (wait_until, timeout_ms) in enumerate(attempts, start=1):
        try:
            await page.goto(url, wait_until=wait_until, timeout=timeout_ms)
            return True
        except Exception as exc:
            if index >= len(attempts):
                log.error("%sFailed to load page after retry: %s", prefix, exc)
                return False
            log.warning(
                "%sPage load failed with wait_until=%s: %s. Retrying...",
                prefix,
                wait_until,
                exc,
            )
            await asyncio.sleep(2)
    return False


def _goto_with_retries_sync(page, url: str, prefix: str = "") -> bool:
    attempts = (
        ("domcontentloaded", GOOGLE_NAV_TIMEOUT_MS),
        ("load", GOOGLE_RETRY_TIMEOUT_MS),
    )

    for index, (wait_until, timeout_ms) in enumerate(attempts, start=1):
        try:
            page.goto(url, wait_until=wait_until, timeout=timeout_ms)
            return True
        except Exception as exc:
            if index >= len(attempts):
                log.error("%sFailed to load page after retry: %s", prefix, exc)
                return False
            log.warning(
                "%sPage load failed with wait_until=%s: %s. Retrying...",
                prefix,
                wait_until,
                exc,
            )
            time.sleep(2)
    return False


def _scrape_google_results_sync(keyword, k=20, headless=False, use_proxy=False, device="desktop"):
    """Sync Playwright fallback for Windows selector loop environments."""
    fingerprint = get_hardened_fingerprint(device)
    effective_headless = resolve_browser_headless(headless, log)
    proxy_cfg = None
    if use_proxy:
        proxy_cfg = {
            "server": os.getenv('OXYLABS_PROXY_SERVER', 'http://disp.oxylabs.io:8007'),
            "username": os.getenv('OXYLABS_PROXY_USERNAME', 'user-LMX_P_N0PoY'),
            "password": os.getenv('OXYLABS_PROXY_PASSWORD', '5_vQlWT3~XfrM6S')
        }

    urls = []
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=SESSION_PATH,
            headless=effective_headless,
            proxy=proxy_cfg,
            user_agent=fingerprint['user_agent'],
            viewport=fingerprint['viewport'],
            args=BASE_CHROMIUM_ARGS
        )
        try:
            context.add_init_script(
                f"""
                Object.defineProperty(navigator, 'webdriver', {{get: () => undefined}});
                Object.defineProperty(navigator, 'hardwareConcurrency', {{get: () => {fingerprint['hardware_concurrency']} }});
                Object.defineProperty(navigator, 'deviceMemory', {{get: () => {fingerprint['device_memory']} }});
                """
            )
            page = context.new_page()
            start = 0
            while len(urls) < k:
                search_url = _build_google_search_url(keyword, start, device)

                log.info(f"[sync fallback] Fetching: {search_url}")
                if not _goto_with_retries_sync(page, search_url, "[sync fallback] "):
                    break

                    if "/sorry/" in page.url:
                        log.warning("[sync fallback] CAPTCHA hit. Solve it in browser window.")
                        if effective_headless:
                            log.warning("[sync fallback] CAPTCHA cannot be solved in headless mode.")
                            raise SerpCaptchaError(
                                message=(
                                    "Google CAPTCHA blocked this search. Start the backend with "
                                    "SURFOX_HEADFUL=1 (or run_services.py --headful) on a machine with "
                                    "a display, or use xvfb-run on Linux. Proxies may also help."
                                ),
                            )
                    captcha_deadline = time.time() + GOOGLE_CAPTCHA_WAIT_SECONDS
                    while "/sorry/" in page.url and time.time() < captcha_deadline:
                        time.sleep(1)
                    if "/sorry/" in page.url:
                        log.warning("[sync fallback] CAPTCHA timeout - moving on.")
                        break

                time.sleep(random.uniform(2, 4))
                raw_hrefs = page.evaluate(EXTRACT_JS)
                new_found = 0
                for h in raw_hrefs:
                    norm = normalize_url(h)
                    if is_organic_host(norm) and norm not in urls:
                        urls.append(norm)
                        new_found += 1

                log.info(f"[sync fallback] Found {new_found} new results (Total: {len(urls)})")
                if new_found == 0 or len(urls) >= k:
                    break
                start += CHUNK_SIZE
        finally:
            try:
                context.close()
            except Exception as close_err:
                log.warning("Ignoring sync context close error: %s", close_err)
    return urls[:k]

async def _scrape_google_results_async(keyword, k=20, headless=False, use_proxy=False, device="desktop"):
    """Async version of scrape Google search results using Playwright."""
    try:
        async with async_playwright() as p:
            fingerprint = get_hardened_fingerprint(device)
            effective_headless = resolve_browser_headless(headless, log)
            
            proxy_cfg = None
            if use_proxy:
                proxy_cfg = {
                    "server": os.getenv('OXYLABS_PROXY_SERVER', 'http://disp.oxylabs.io:8007'),
                    "username": os.getenv('OXYLABS_PROXY_USERNAME', 'user-LMX_P_N0PoY'),
                    "password": os.getenv('OXYLABS_PROXY_PASSWORD', '5_vQlWT3~XfrM6S')
                }

            urls = []
            context = None
            try:
                context = await p.chromium.launch_persistent_context(
                    user_data_dir=SESSION_PATH,
                    headless=effective_headless,
                    proxy=proxy_cfg,
                    user_agent=fingerprint['user_agent'],
                    viewport=fingerprint['viewport'],
                    args=BASE_CHROMIUM_ARGS
                )

                await apply_stealth(context, fingerprint)
                page = await context.new_page()

                start = 0

                while len(urls) < k:
                    search_url = _build_google_search_url(keyword, start, device)

                    log.info(f"Fetching: {search_url}")

                    if not await _goto_with_retries(page, search_url):
                        break

                    if "/sorry/" in page.url:
                        log.warning("CAPTCHA hit. Solve it in the browser window.")
                        if effective_headless:
                            log.warning("CAPTCHA cannot be solved in headless mode.")
                            raise SerpCaptchaError(
                                message=(
                                    "Google CAPTCHA blocked this search. Start the backend with "
                                    "SURFOX_HEADFUL=1 (or run_services.py --headful) on a machine with "
                                    "a display, or use xvfb-run on Linux. Proxies may also help."
                                ),
                            )
                        captcha_deadline = time.time() + GOOGLE_CAPTCHA_WAIT_SECONDS
                        while "/sorry/" in page.url and time.time() < captcha_deadline:
                            await asyncio.sleep(1)
                        if "/sorry/" in page.url:
                            log.warning("CAPTCHA timeout - moving to next results")
                            break

                    await asyncio.sleep(random.uniform(2, 4))

                    raw_hrefs = await page.evaluate(EXTRACT_JS)
                    new_found = 0
                    for h in raw_hrefs:
                        norm = normalize_url(h)
                        if is_organic_host(norm) and norm not in urls:
                            urls.append(norm)
                            new_found += 1

                    log.info(f"Found {new_found} new results (Total: {len(urls)})")

                    if new_found == 0 or len(urls) >= k:
                        break

                    start += CHUNK_SIZE
            finally:
                if context is not None:
                    try:
                        await context.close()
                    except Exception as close_err:
                        log.warning("Ignoring browser context close error: %s", close_err)
        return urls[:k]
    except NotImplementedError:
        log.warning("Async Playwright unavailable on current event loop; using sync fallback.")
        return await asyncio.to_thread(
            _scrape_google_results_sync,
            keyword,
            k,
            headless,
            use_proxy,
            device,
        )

# ============================================================================
# CORE FUNCTIONS
# ============================================================================

def clean_filename(name):
    return re.sub(r'[\\/*?:"<>|]', "", name).replace(" ", "_")[:50]

def get_authority(domain):
    """
    Get authority score (0-10) based on DR from CSV.
    DR scale: 0-100 -> Authority scale: 0-10
    Default to 5 if domain not found.
    
    Handles subdomains by removing 'www.' prefix for CSV lookup.
    """
    # Remove 'www.' prefix if present to match CSV format
    lookup_domain = domain.replace('www.', '', 1) if domain.startswith('www.') else domain
    
    # First try lookup_domain, then try original domain
    if lookup_domain in DR_DATA:
        dr = DR_DATA[lookup_domain]
    elif domain in DR_DATA:
        dr = DR_DATA[domain]
    else:
        return 5  # Default to 5 if domain not found
    
    authority = int(round((dr / 100) * 10))
    # Clamp to 0-10 range
    authority = max(0, min(10, authority))
    return authority

def is_english(text):
    """Returns True if the text is English, False otherwise."""
    try:
        # We check a sample of the text to save time
        return detect(text[:1000]) == 'en'
    except:
        return False

# Replace your existing scrape_page_content and update main_pipeline tasks:

async def scrape_page_content(page, url):
    """
    Uses the existing Playwright page to scrape content, 
    focusing only on title, description, headings, and paragraphs.
    """
    try:
        # Navigate to the result page
        # Using a longer timeout and waiting for domcontentloaded for speed
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        
        # Get the HTML and process with BeautifulSoup
        html = await page.content()
        soup = BeautifulSoup(html, 'html.parser')
        
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
        
        # Extract only headings and paragraphs
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
        
        # Combine relevant content
        content_parts = [title, description] + headings + paragraphs
        full_content = " ".join(content_parts)
        
        domain = urlparse(url).netloc
        authority = get_authority(domain)

        return {
            "url": url,
            "title": title,
            "description": description,
            "headings": headings,
            "paragraphs": paragraphs,
            "word_count": len(full_content.split()),
            "heading_count": len(headings),
            "para_count": len(paragraphs),
            "authority": authority,
            "content": full_content
        }
    except Exception as e:
        log.error(f"Failed to scrape {url}: {e}")
        return {"url": url, "error": str(e)}

async def main_pipeline():
    # Handle non-interactive environments (Docker/Servers)
    try:
        keyword = input("Enter Keyword/Title: ")
        device = input("Search type (mobile/desktop): ").lower() or "desktop"
        proxy_choice = input("Use proxy? (y/n): ").lower() == 'y'
        headless_choice = input("Run headless? (y/n): ").lower() != 'n'  # Default to True
    except EOFError:
        log.warning("Non-interactive environment detected. Using defaults.")
        keyword = os.getenv("SEARCH_KEYWORD", "dog breeds")
        device = "desktop"
        proxy_choice = False
        headless_choice = True
    
    folder_name = clean_filename(keyword)
    os.makedirs(folder_name, exist_ok=True)
    
    print(f"Fetching top Google search results for: {keyword}")
    
    # --- PHASE 1: GOOGLE SERP (Your original logic untouched) ---
    results = await _scrape_google_results_async(keyword, k=20, headless=headless_choice, use_proxy=proxy_choice, device=device)
    
    # --- PHASE 2: SCRAPE INDIVIDUAL PAGES (Upgraded to Playwright) ---
    print(f"Scraping {len(results)} pages using browser context...")
    
    async with async_playwright() as p:
        fingerprint = get_hardened_fingerprint(device)
        # Note: proxy is NOT used for scraping individual pages, only for SERP
        
        browser = await p.chromium.launch(headless=headless_choice)
        context = await browser.new_context(
            user_agent=fingerprint['user_agent'],
            viewport=fingerprint['viewport']
        )
        await apply_stealth(context, fingerprint)
        page = await context.new_page()

        for url in results:
            # We process sequentially to avoid overwhelming the system/proxy
            # or you can open multiple pages in tabs if your hardware allows.
            data = await scrape_page_content(page, url)
            
            domain = urlparse(data['url']).netloc
            file_id = clean_filename(domain + "_" + str(hash(data['url']))[:5])
            
            with open(f"{folder_name}/{file_id}.json", "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4)
            
            status = "Success" if "content" in data else "Error"
            print(f"Processed: {domain} -> {status}")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main_pipeline())