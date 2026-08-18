import json
import logging
import os
import hashlib
import secrets
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse, unquote
from dotenv import load_dotenv

try:
    import psycopg2
    from psycopg2 import sql
    from psycopg2.extras import Json, RealDictCursor
except ImportError:  # pragma: no cover - handled at runtime with a clear error
    psycopg2 = None
    sql = None
    Json = None
    RealDictCursor = None


log = logging.getLogger(__name__)

load_dotenv()
load_dotenv(Path(__file__).resolve().parent / ".env")

def _get_env(*names: str, default: Optional[str] = None) -> Optional[str]:
    for name in names:
        value = os.getenv(name)
        if value is not None and str(value).strip() != "":
            return value
    return default

DB_HOST = _get_env("POSTGRES_HOST", "DB_HOST", default="localhost")
DB_PORT = int(_get_env("POSTGRES_PORT", "DB_PORT", default="5432"))
DB_NAME = _get_env("POSTGRES_DB", "DB_NAME", default="serfox_db")
DB_USER = _get_env("POSTGRES_USER", "DB_USER", default="postgres")
DB_PASSWORD = _get_env("POSTGRES_PASSWORD", "DB_PASSWORD", default="1234")
DATABASE_URL = _get_env("DATABASE_URL")
_ARTICLE_COLUMNS_READY = False


def _get_db_connect_kwargs(dbname: Optional[str] = None) -> Dict[str, object]:
    if DATABASE_URL:
        parsed = urlparse(DATABASE_URL)
        if not parsed.scheme.startswith("postgres"):
            raise RuntimeError("DATABASE_URL must use a PostgreSQL scheme.")
        return {
            "host": parsed.hostname or DB_HOST,
            "port": parsed.port or DB_PORT,
            "dbname": dbname or (parsed.path or "").lstrip("/") or DB_NAME,
            "user": unquote(parsed.username) if parsed.username else DB_USER,
            "password": unquote(parsed.password) if parsed.password else DB_PASSWORD,
            "options": "-c search_path=public",
            "connect_timeout": 5,
        }
    return {
        "host": DB_HOST,
        "port": DB_PORT,
        "dbname": dbname or DB_NAME,
        "user": DB_USER,
        "password": DB_PASSWORD,
        "options": "-c search_path=public",
        "connect_timeout": 5,
    }

def _require_driver() -> None:
    if psycopg2 is None:
        raise RuntimeError("psycopg2-binary is not installed. Run: pip install -r backend/requirements.txt")


def _connect(dbname: Optional[str] = None):
    _require_driver()
    return psycopg2.connect(**_get_db_connect_kwargs(dbname))


def ensure_database_exists() -> None:
    try:
        with _connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        log.info("Using existing PostgreSQL database %s at %s:%s", DB_NAME, DB_HOST, DB_PORT)
        return
    except Exception as target_exc:
        log.warning("Direct connection to target PostgreSQL database failed: %s", target_exc)

    try:
        with _connect("postgres") as conn:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (DB_NAME,))
                if cur.fetchone():
                    log.info("PostgreSQL database %s exists and is reachable", DB_NAME)
                    return
                cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(DB_NAME)))
                log.info("Created PostgreSQL database %s", DB_NAME)
    except Exception as admin_exc:
        raise RuntimeError(
            "Could not connect to the configured PostgreSQL database and automatic creation also failed. "
            "Check DATABASE_URL/POSTGRES_* settings and make sure the target database already exists."
        ) from admin_exc


def wait_for_database(max_attempts: int = 10, delay_seconds: int = 2) -> None:
    last_error = None
    for attempt in range(1, max_attempts + 1):
        try:
            ensure_database_exists()
            return
        except Exception as exc:
            last_error = exc
            if attempt == max_attempts:
                break
            log.warning(
                "PostgreSQL is not ready yet (attempt %s/%s). Retrying in %ss.",
                attempt,
                max_attempts,
                delay_seconds,
            )
            time.sleep(delay_seconds)
    raise RuntimeError("PostgreSQL did not become ready in time.") from last_error


def init_db() -> None:
    wait_for_database()
    with _connect() as conn:
        with conn.cursor() as cur:
            # 1. Create app_users table first since other tables reference it
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS app_users (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    role TEXT NOT NULL DEFAULT 'writer',
                    password_hash TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
                    verification_token TEXT,
                    reset_token TEXT,
                    reset_token_expiry TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            
            # 2. Create nlp_keyword_outputs table
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS nlp_keyword_outputs (
                    id SERIAL PRIMARY KEY,
                    source_keyword TEXT NOT NULL UNIQUE,
                    file_name TEXT NOT NULL,
                    keywords_json JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute("ALTER TABLE nlp_keyword_outputs ADD COLUMN IF NOT EXISTS keywords_json JSONB")
            cur.execute(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'nlp_keyword_outputs'
                  AND column_name = 'json_output'
                """
            )
            if cur.fetchone():
                cur.execute(
                    """
                    UPDATE nlp_keyword_outputs
                    SET keywords_json = json_output
                    WHERE keywords_json IS NULL
                    """
                )
            cur.execute("UPDATE nlp_keyword_outputs SET keywords_json = '{}'::jsonb WHERE keywords_json IS NULL")
            cur.execute("ALTER TABLE nlp_keyword_outputs ALTER COLUMN keywords_json SET NOT NULL")
            cur.execute("ALTER TABLE nlp_keyword_outputs DROP COLUMN IF EXISTS selected_keywords")
            cur.execute("ALTER TABLE nlp_keyword_outputs DROP COLUMN IF EXISTS selected_at")
            cur.execute("ALTER TABLE nlp_keyword_outputs DROP COLUMN IF EXISTS json_output")
            cur.execute("ALTER TABLE nlp_keyword_outputs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL")
            cur.execute("ALTER TABLE nlp_keyword_outputs ADD COLUMN IF NOT EXISTS results JSONB DEFAULT '[]'::jsonb")
            cur.execute("ALTER TABLE nlp_keyword_outputs ADD COLUMN IF NOT EXISTS selected_urls JSONB DEFAULT '[]'::jsonb")
            cur.execute("ALTER TABLE nlp_keyword_outputs DROP CONSTRAINT IF EXISTS nlp_keyword_outputs_source_keyword_key")
            cur.execute(
                """
                DELETE FROM nlp_keyword_outputs a
                USING nlp_keyword_outputs b
                WHERE a.id < b.id
                  AND LOWER(a.source_keyword) = LOWER(b.source_keyword)
                  AND COALESCE(a.user_id, 0) = COALESCE(b.user_id, 0)
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_nlp_keyword_outputs_source_keyword
                ON nlp_keyword_outputs (LOWER(source_keyword))
                """
            )
            cur.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_nlp_keyword_outputs_keyword_user_unique
                ON nlp_keyword_outputs (LOWER(source_keyword), COALESCE(user_id, 0))
                """
            )

            # 3. Create articles table
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS articles (
                    id SERIAL PRIMARY KEY,
                    article_key TEXT NOT NULL UNIQUE,
                    session_id TEXT,
                    title TEXT NOT NULL,
                    keyword TEXT,
                    keywords_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                    results JSONB NOT NULL DEFAULT '[]'::jsonb,
                    selected_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
                    content_score INTEGER NOT NULL DEFAULT 0,
                    html TEXT NOT NULL DEFAULT '',
                    text_content TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'drafting',
                    assigned_to INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                    created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                    updated_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )

            # 4. Create article_revisions table
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS article_revisions (
                    id SERIAL PRIMARY KEY,
                    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
                    diff_patch TEXT NOT NULL DEFAULT '',
                    changed_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """ 
            )
            # Migrate existing table: add diff_patch if missing
            cur.execute("ALTER TABLE article_revisions ADD COLUMN IF NOT EXISTS diff_patch TEXT NOT NULL DEFAULT ''")

            # 5. Create article_permissions table
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS article_permissions (
                    id SERIAL PRIMARY KEY,
                    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
                    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                    can_edit BOOLEAN NOT NULL DEFAULT FALSE,
                    can_update BOOLEAN NOT NULL DEFAULT FALSE,
                    assigned_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(article_id, user_id)
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_articles_article_key ON articles (article_key)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_article_revisions_article_id ON article_revisions (article_id)")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_score INTEGER NOT NULL DEFAULT 0")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_structure JSONB DEFAULT '{}'::jsonb")

            # Migrate existing app_users table with new auth columns if needed
            cur.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE")
            cur.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS verification_token TEXT")
            cur.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS reset_token TEXT")
            cur.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMPTZ")
            # Fail fast if the auth table is not visible in the current schema search path.
            cur.execute("SELECT to_regclass('public.app_users')")
            if cur.fetchone()[0] is None:
                raise RuntimeError("Database initialization did not create public.app_users")
    log.info("PostgreSQL ready at %s:%s/%s", DB_HOST, DB_PORT, DB_NAME)


def ensure_article_columns() -> None:
    global _ARTICLE_COLUMNS_READY
    if _ARTICLE_COLUMNS_READY:
        return
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS keywords_json JSONB NOT NULL DEFAULT '[]'::jsonb")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS results JSONB NOT NULL DEFAULT '[]'::jsonb")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS selected_urls JSONB NOT NULL DEFAULT '[]'::jsonb")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_score INTEGER NOT NULL DEFAULT 0")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS html TEXT NOT NULL DEFAULT ''")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS text_content TEXT NOT NULL DEFAULT ''")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'drafting'")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES app_users(id) ON DELETE SET NULL")
            cur.execute("ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_structure JSONB DEFAULT '{}'::jsonb")
    _ARTICLE_COLUMNS_READY = True


def _coerce_content_score(value) -> int:
    try:
        return max(0, min(100, int(round(float(value or 0)))))
    except (TypeError, ValueError):
        return 0


def _hash_password(password: str, salt: Optional[str] = None) -> Dict[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), salt.encode("utf-8"), 120000)
    return {"salt": salt, "hash": digest.hex()}


def create_user(name: str, email: str, password: str, role: str = "writer", verification_token: Optional[str] = None) -> Dict:
    password_data = _hash_password(password)
    email_verified = verification_token is None  # if no token, mark verified immediately
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO app_users (name, email, role, password_hash, password_salt, email_verified, verification_token)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id, name, email, role, email_verified, created_at, updated_at
                """,
                (name.strip(), email.strip().lower(), role.strip() or "writer",
                 password_data["hash"], password_data["salt"], email_verified, verification_token),
            )
            return dict(cur.fetchone())


def authenticate_user(email: str, password: str) -> Optional[Dict]:
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM app_users WHERE email = %s", (email.strip().lower(),))
            user = cur.fetchone()
            if not user:
                return None
            password_data = _hash_password(password, user["password_salt"])
            if not secrets.compare_digest(password_data["hash"], user["password_hash"]):
                return None
            return {k: user[k] for k in ("id", "name", "email", "role", "email_verified", "created_at", "updated_at")}

def get_user_by_id(user_id: int) -> Optional[Dict]:
    """Fetch a single user by primary key (used by /auth/me)."""
    if not user_id:
        return None
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, name, email, role, email_verified, created_at, updated_at FROM app_users WHERE id = %s",
                (int(user_id),),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def list_users() -> List[Dict]:
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, name, email, role, created_at FROM app_users ORDER BY name ASC")
            return [dict(row) for row in cur.fetchall()]


def verify_email_token(token: str) -> Optional[Dict]:
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, email FROM app_users WHERE verification_token = %s AND email_verified = FALSE",
                (token,)
            )
            user = cur.fetchone()
            if not user:
                return None
            cur.execute(
                "UPDATE app_users SET email_verified = TRUE, verification_token = NULL, updated_at = NOW() WHERE id = %s RETURNING id, name, email, role",
                (user["id"],)
            )
            return dict(cur.fetchone())


def set_reset_token(email: str, token: str) -> bool:
    from datetime import timezone, timedelta
    expiry = datetime.now(timezone.utc) + timedelta(hours=1)
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE app_users SET reset_token = %s, reset_token_expiry = %s, updated_at = NOW() WHERE email = %s",
                (token, expiry, email.strip().lower())
            )
            return cur.rowcount > 0


def reset_password_with_token(token: str, new_password: str) -> Optional[Dict]:
    from datetime import timezone
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id FROM app_users WHERE reset_token = %s AND reset_token_expiry > %s",
                (token, datetime.now(timezone.utc))
            )
            user = cur.fetchone()
            if not user:
                return None
            password_data = _hash_password(new_password)
            cur.execute(
                """
                UPDATE app_users
                SET password_hash = %s, password_salt = %s, reset_token = NULL,
                    reset_token_expiry = NULL, updated_at = NOW()
                WHERE id = %s
                RETURNING id, name, email, role
                """,
                (password_data["hash"], password_data["salt"], user["id"])
            )
            return dict(cur.fetchone())


def update_user_role(user_id: int, role: str) -> Dict:
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE app_users
                SET role = %s, updated_at = NOW()
                WHERE id = %s
                RETURNING id, name, email, role, created_at, updated_at
                """,
                (role.strip(), user_id),
            )
            row = cur.fetchone()
            if not row:
                raise ValueError("User not found")
            return dict(row)


def upsert_article(payload: Dict) -> Dict:
    article_key = (payload.get("article_key") or payload.get("key") or payload.get("session_id") or payload.get("title") or "untitled").strip()
    user_id = payload.get("user_id")
    ensure_article_columns()
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, html FROM articles WHERE article_key = %s", (article_key,))
            existing = cur.fetchone()
            cur.execute(
                """
                INSERT INTO articles (
                    article_key, session_id, title, keyword, keywords_json, results, selected_urls, content_score, html, text_content, status, assigned_to, created_by, updated_by, content_structure
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (article_key)
                DO UPDATE SET
                    session_id = COALESCE(EXCLUDED.session_id, articles.session_id),
                    title = EXCLUDED.title,
                    keyword = COALESCE(EXCLUDED.keyword, articles.keyword),
                    keywords_json = EXCLUDED.keywords_json,
                    results = EXCLUDED.results,
                    selected_urls = EXCLUDED.selected_urls,
                    content_score = EXCLUDED.content_score,
                    html = EXCLUDED.html,
                    text_content = EXCLUDED.text_content,
                    status = COALESCE(EXCLUDED.status, articles.status),
                    assigned_to = COALESCE(EXCLUDED.assigned_to, articles.assigned_to),
                    content_structure = COALESCE(EXCLUDED.content_structure, articles.content_structure),
                    updated_by = EXCLUDED.updated_by,
                    updated_at = NOW()
                RETURNING *
                """,
                (
                    article_key,
                    payload.get("session_id"),
                    payload.get("title") or "Untitled",
                    payload.get("keyword"),
                    Json(payload.get("keywords") or []),
                    Json(payload.get("results") or []),
                    Json(payload.get("selected_urls") or []),
                    _coerce_content_score(payload.get("content_score")),
                    payload.get("html") or "",
                    payload.get("text") or payload.get("text_content") or "",
                    payload.get("status") or "drafting",
                    payload.get("assigned_to"),
                    user_id,
                    user_id,
                    Json(payload.get("content_structure") or {}),
                ),
            )
            article = dict(cur.fetchone())
            # Only store revision if the article already existed and content changed
            # diff_patch is computed on the frontend to avoid storing duplicate full HTML
            diff_patch = payload.get("diff_patch", "")
            if existing and diff_patch:
                cur.execute(
                    """
                    INSERT INTO article_revisions (article_id, diff_patch, changed_by)
                    VALUES (%s, %s, %s)
                    """,
                    (article["id"], diff_patch, user_id),
                )
                # Cleanup: Enforce bounded storage by keeping only the last 30 revisions per article
                cur.execute(
                    """
                    DELETE FROM article_revisions
                    WHERE article_id = %s
                      AND id NOT IN (
                          SELECT id FROM article_revisions
                          WHERE article_id = %s
                          ORDER BY created_at DESC
                          LIMIT 30
                      )
                    """,
                    (article["id"], article["id"])
                )
            return article


def get_article(article_key: str) -> Optional[Dict]:
    ensure_article_columns()
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    id,
                    article_key,
                    session_id,
                    title,
                    keyword,
                    keywords_json,
                    results,
                    selected_urls,
                    content_score,
                    content_structure,
                    html,
                    text_content,
                    status,
                    assigned_to,
                    created_at,
                    updated_at
                FROM articles
                WHERE article_key = %s
                """,
                (article_key,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def list_articles() -> List[Dict]:
    ensure_article_columns()
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    a.id,
                    a.article_key,
                    a.session_id,
                    a.title,
                    a.keyword,
                    a.keywords_json,
                    a.content_score,
                    a.status,
                    a.assigned_to,
                    a.created_by,
                    a.updated_by                              AS user_id,
                    u_assign.name                             AS assigned_to_name,
                    u_assign.email                            AS assigned_to_email,
                    u_assign.role                             AS assigned_to_role,
                    u_create.name                             AS created_by_name,
                    a.created_at,
                    a.updated_at
                FROM articles a
                LEFT JOIN app_users u_assign ON u_assign.id = a.assigned_to
                LEFT JOIN app_users u_create ON u_create.id = a.created_by
                ORDER BY a.updated_at DESC
                """
            )
            return [dict(row) for row in cur.fetchall()]


def delete_article(article_key: str) -> bool:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM articles WHERE article_key = %s", (article_key,))
            return cur.rowcount > 0


def get_article_history(article_key: str) -> List[Dict]:
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id FROM articles WHERE article_key = %s", (article_key,))
            article = cur.fetchone()
            if not article:
                return []
            cur.execute(
                """
                SELECT
                    r.id,
                    r.diff_patch,
                    r.created_at,
                    u.name AS changed_by_name,
                    u.role AS changed_by_role
                FROM article_revisions r
                LEFT JOIN app_users u ON u.id = r.changed_by
                WHERE r.article_id = %s
                ORDER BY r.created_at DESC
                LIMIT 100
                """,
                (article["id"],),
            )
            return [dict(row) for row in cur.fetchall()]


def assign_article_permission(article_key: str, user_id: int, can_edit: bool, can_update: bool, assigned_by: Optional[int] = None) -> Dict:
    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id FROM articles WHERE article_key = %s", (article_key,))
            article = cur.fetchone()
            if not article:
                raise ValueError("Article not found")
            cur.execute(
                """
                INSERT INTO article_permissions (article_id, user_id, can_edit, can_update, assigned_by)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (article_id, user_id)
                DO UPDATE SET
                    can_edit = EXCLUDED.can_edit,
                    can_update = EXCLUDED.can_update,
                    assigned_by = EXCLUDED.assigned_by,
                    updated_at = NOW()
                RETURNING *
                """,
                (article["id"], user_id, can_edit, can_update, assigned_by),
            )
            return dict(cur.fetchone())


def upsert_keyword_json_output(
    source_keyword: str,
    file_name: str,
    payload: Dict,
    user_id: Optional[int] = None,
    results: Optional[List[Dict]] = None,
    selected_urls: Optional[List[str]] = None,
    keyword_output_id: Optional[int] = None
) -> Dict:
    source_keyword = (source_keyword or file_name or "search").strip()
    file_name = (file_name or f"{source_keyword}.json").strip()
    payload = payload or {}

    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            existing = None
            if keyword_output_id:
                cur.execute(
                    "SELECT id FROM nlp_keyword_outputs WHERE id = %s",
                    (keyword_output_id,)
                )
                existing = cur.fetchone()

            if not existing:
                cur.execute(
                    """
                    SELECT id
                    FROM nlp_keyword_outputs
                    WHERE LOWER(source_keyword) = LOWER(%s)
                      AND COALESCE(user_id, 0) = COALESCE(%s, 0)
                    LIMIT 1
                    """,
                    (source_keyword, user_id),
                )
                existing = cur.fetchone()

            if existing:
                cur.execute(
                    """
                    UPDATE nlp_keyword_outputs
                    SET
                        file_name = %s,
                        keywords_json = %s,
                        user_id = COALESCE(%s, user_id),
                        results = COALESCE(%s, results),
                        selected_urls = COALESCE(%s, selected_urls),
                        updated_at = NOW()
                    WHERE id = %s
                    RETURNING
                        id,
                        source_keyword,
                        file_name,
                        keywords_json,
                        user_id,
                        results,
                        selected_urls,
                        created_at,
                        updated_at
                    """,
                    (
                        file_name,
                        Json(payload),
                        user_id,
                        Json(results) if results is not None else None,
                        Json(selected_urls) if selected_urls is not None else None,
                        existing["id"],
                    ),
                )
                return dict(cur.fetchone())

            cur.execute(
                """
                INSERT INTO nlp_keyword_outputs
                    (source_keyword, file_name, keywords_json, user_id, results, selected_urls)
                VALUES
                    (%s, %s, %s, %s, %s, %s)
                RETURNING
                    id,
                    source_keyword,
                    file_name,
                    keywords_json,
                    user_id,
                    results,
                    selected_urls,
                    created_at,
                    updated_at
                """,
                (
                    source_keyword,
                    file_name,
                    Json(payload),
                    user_id,
                    Json(results) if results is not None else None,
                    Json(selected_urls) if selected_urls is not None else None
                ),
            )
            return dict(cur.fetchone())


def get_keyword_json_output(
    source_keyword: str,
    user_id: Optional[int] = None,
) -> Optional[Dict]:
    source_keyword = (source_keyword or "").strip()
    if not source_keyword:
        return None

    params = [source_keyword]
    where_clause = "WHERE LOWER(source_keyword) = LOWER(%s)"

    if user_id is not None:
        where_clause += " AND user_id = %s"
        params.append(user_id)

    query = f"""
        SELECT
            id,
            source_keyword,
            file_name,
            keywords_json,
            user_id,
            results,
            selected_urls,
            created_at,
            updated_at
        FROM nlp_keyword_outputs
        {where_clause}
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
    """

    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(query, tuple(params))
            row = cur.fetchone()
            return dict(row) if row else None


def import_json_outputs(json_outputs_dir: Path) -> int:
    total = 0
    for file_path in sorted(Path(json_outputs_dir).glob("*.json")):
        with open(file_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        source_keyword = file_path.stem.replace("_", " ")
        upsert_keyword_json_output(source_keyword, file_path.name, payload)
        total += 1
    return total


def list_keyword_json_outputs(
    source_keyword: Optional[str] = None,
    filter_type: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    user_id: Optional[int] = None,
    page: int = 1,
    limit: Optional[int] = None
) -> Dict:
    params = []
    conditions = []

    if source_keyword:
        conditions.append("source_keyword = %s")
        params.append(source_keyword)

    if user_id is not None:
        conditions.append("user_id = %s")
        params.append(user_id)

    if filter_type == 'today':
        conditions.append("updated_at >= CURRENT_DATE")
    elif filter_type == 'yesterday':
        conditions.append("updated_at >= CURRENT_DATE - INTERVAL '1 day' AND updated_at < CURRENT_DATE")
    elif filter_type == 'range':
        if start_date:
            conditions.append("updated_at >= %s")
            params.append(f"{start_date} 00:00:00")
        if end_date:
            conditions.append("updated_at <= %s")
            params.append(f"{end_date} 23:59:59")

    where_clause = ""
    if conditions:
        where_clause = "WHERE " + " AND ".join(conditions)

    count_query = f"SELECT COUNT(*) AS total_count FROM nlp_keyword_outputs {where_clause}"

    items_query = f"""
        SELECT
            id,
            source_keyword,
            file_name,
            keywords_json,
            user_id,
            results,
            selected_urls,
            created_at,
            updated_at
        FROM nlp_keyword_outputs
        {where_clause}
        ORDER BY updated_at DESC, source_keyword ASC
    """

    if limit is not None:
        limit_val = int(limit)
        page_val = int(page)
        offset = (page_val - 1) * limit_val
        items_query += f" LIMIT {limit_val} OFFSET {offset}"

    with _connect() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # 1. Get total count
            cur.execute(count_query, tuple(params))
            count_row = cur.fetchone()
            total = count_row['total_count'] if count_row else 0

            # 2. Get paginated items
            cur.execute(items_query, tuple(params))
            items = [dict(row) for row in cur.fetchall()]

            return {
                "total": total,
                "items": items,
                "page": page,
                "limit": limit if limit is not None else total,
                "has_more": (page * limit) < total if limit is not None else False
            }


def delete_keyword_json_output(output_id: int, user_id: Optional[int] = None) -> bool:
    with _connect() as conn:
        with conn.cursor() as cur:
            if user_id is None:
                cur.execute("DELETE FROM nlp_keyword_outputs WHERE id = %s", (output_id,))
            else:
                cur.execute("DELETE FROM nlp_keyword_outputs WHERE id = %s AND user_id = %s", (output_id, user_id))
            return cur.rowcount > 0
