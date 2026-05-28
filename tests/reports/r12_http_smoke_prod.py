"""R12 HTTP smoke for prod container - verifies R12-BUG-02 fix is live on prod.

Run inside prod backend container:
  PYTHONPATH=/app python /tmp/r12_http_smoke_prod.py
"""
import asyncio
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone

import httpx

from app.api.routes.auth import _hash_code
from app.config import get_settings
from app.db import AsyncSessionLocal
from app.db.models import OTPCode, User
from sqlalchemy import delete, select


async def main():
    base_url = "http://localhost:8000"
    # Use an allowed email but a unique sub-tag so cleanup doesnt nuke a real user.
    # We will create a UNIQUE user using a temp email and clean up at the end.
    email = f"r12-verify-{uuid.uuid4().hex[:8]}@ramax.ru"
    code = "654321"

    settings = get_settings()

    async with AsyncSessionLocal() as db:
        db.add(
            OTPCode(
                email=email.lower().strip(),
                code_hash=_hash_code(code),
                expires_at=datetime.now(timezone.utc)
                + timedelta(minutes=settings.otp_expiry_minutes),
            )
        )
        await db.commit()

    steps = []
    sid = None
    try:
        async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
            r = await client.post(
                "/api/auth/verify-otp", json={"email": email, "code": code}
            )
            steps.append({"step": "verify-otp", "status": r.status_code})
            if r.status_code != 200:
                print(json.dumps({"steps": steps, "auth_body": r.text[:500]}, indent=2))
                return
            token = r.json()["access_token"]
            client.headers["Authorization"] = f"Bearer {token}"

            r = await client.post(
                "/api/sessions/",
                json={
                    "name": f"r12-verify-{uuid.uuid4().hex[:8]}",
                    "specification": "smoke for R12-BUG-02 prod",
                },
            )
            steps.append({"step": "POST /api/sessions/", "status": r.status_code})
            if r.status_code != 201:
                print(json.dumps({"steps": steps, "body": r.text[:500]}, indent=2))
                return
            sid = r.json()["id"]

            r = await client.patch(
                f"/api/sessions/{sid}", json={"settings": {"streaming": False}}
            )
            steps.append({"step": "PATCH streaming=false", "status": r.status_code})

            r = await client.get(f"/api/sessions/{sid}")
            s = r.json().get("settings", {}) if r.status_code == 200 else {}
            steps.append(
                {
                    "step": "GET after PATCH false",
                    "status": r.status_code,
                    "settings": s,
                    "streaming": s.get("streaming") if isinstance(s, dict) else None,
                }
            )

            r = await client.patch(
                f"/api/sessions/{sid}", json={"settings": {"streaming": True}}
            )
            steps.append({"step": "PATCH streaming=true", "status": r.status_code})

            r = await client.get(f"/api/sessions/{sid}")
            s = r.json().get("settings", {}) if r.status_code == 200 else {}
            steps.append(
                {
                    "step": "GET after PATCH true",
                    "status": r.status_code,
                    "settings": s,
                    "streaming": s.get("streaming") if isinstance(s, dict) else None,
                }
            )

            r = await client.delete(f"/api/sessions/{sid}")
            steps.append({"step": "DELETE", "status": r.status_code})
    finally:
        try:
            async with AsyncSessionLocal() as db:
                u = (
                    await db.execute(
                        select(User).where(User.email == email.lower().strip())
                    )
                ).scalar_one_or_none()
                if u is not None:
                    await db.delete(u)
                await db.execute(
                    delete(OTPCode).where(OTPCode.email == email.lower().strip())
                )
                await db.commit()
        except Exception:
            pass

    print(json.dumps({"env": "prod", "session_id": sid, "steps": steps}, indent=2, default=str))


asyncio.run(main())
