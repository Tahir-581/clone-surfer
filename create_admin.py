#!/usr/bin/env python3
"""
Create or update an admin user in the Surfox database.

Usage:
  python create_admin.py --email admin@example.com --password "StrongPass123"
"""

from __future__ import annotations

import argparse
import hashlib
import secrets
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from database import _connect, create_user, init_db  # noqa: E402


def _hash_password(password: str, salt: str | None = None) -> dict[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        (password or "").encode("utf-8"),
        salt.encode("utf-8"),
        120000,
    )
    return {"salt": salt, "hash": digest.hex()}


def create_or_update_admin(email: str, password: str, name: str) -> tuple[str, dict]:
    clean_email = email.strip().lower()
    if not clean_email:
        raise ValueError("Email is required.")
    if not password:
        raise ValueError("Password is required.")

    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM app_users WHERE email = %s", (clean_email,))
            row = cur.fetchone()

    if row:
        user_id = row[0]
        password_data = _hash_password(password)
        with _connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE app_users
                    SET role = 'admin',
                        password_hash = %s,
                        password_salt = %s,
                        email_verified = TRUE,
                        updated_at = NOW()
                    WHERE id = %s
                    RETURNING id, name, email, role, email_verified, created_at, updated_at
                    """,
                    (password_data["hash"], password_data["salt"], user_id),
                )
                updated = cur.fetchone()
        return "updated", {
            "id": updated[0],
            "name": updated[1],
            "email": updated[2],
            "role": updated[3],
            "email_verified": updated[4],
            "created_at": str(updated[5]),
            "updated_at": str(updated[6]),
        }

    created = create_user(name=name, email=clean_email, password=password, role="admin", verification_token=None)
    return "created", created


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or update an admin user.")
    parser.add_argument("--email", required=True, help="Admin user email")
    parser.add_argument("--password", required=True, help="Admin user password")
    parser.add_argument("--name", default="Admin", help="Name for new user (default: Admin)")
    args = parser.parse_args()

    try:
        init_db()
        action, user = create_or_update_admin(args.email, args.password, args.name)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Admin account {action}:")
    print(f"  id: {user.get('id')}")
    print(f"  name: {user.get('name')}")
    print(f"  email: {user.get('email')}")
    print(f"  role: {user.get('role')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
