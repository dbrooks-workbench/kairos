import json

import anyio
import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse
from google_auth_oauthlib.flow import Flow
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models import OAuthToken

router = APIRouter(prefix="/auth")

SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/tasks.readonly",
]

_REDIRECT_URI = f"{settings.base_url}/api/auth/google/callback"


def _make_flow(state: str | None = None) -> Flow:
    client_config = {
        "web": {
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [_REDIRECT_URI],
        }
    }
    flow = Flow.from_client_config(client_config, scopes=SCOPES, state=state)
    flow.redirect_uri = _REDIRECT_URI
    return flow


@router.get("/google/login")
async def google_login():
    flow = _make_flow()
    auth_url, _ = flow.authorization_url(access_type="offline", prompt="consent")
    return RedirectResponse(auth_url)


@router.get("/google/callback")
async def google_callback(
    code: str,
    state: str,
    db: AsyncSession = Depends(get_db),
):
    flow = _make_flow(state=state)
    await anyio.to_thread.run_sync(lambda: flow.fetch_token(code=code))
    credentials = flow.credentials

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {credentials.token}"},
        )
        resp.raise_for_status()
        user_info = resp.json()

    account_id = f"google:{user_info['id']}"

    result = await db.execute(select(OAuthToken).where(OAuthToken.account_id == account_id))
    token_row = result.scalar_one_or_none()

    if token_row is None:
        token_row = OAuthToken(account_id=account_id, provider="google")
        db.add(token_row)

    token_row.access_token = credentials.token
    token_row.refresh_token = credentials.refresh_token
    token_row.expires_at = credentials.expiry
    token_row.scopes = json.dumps(list(credentials.scopes or []))
    token_row.email = user_info.get("email")

    await db.commit()

    return RedirectResponse(f"{settings.base_url}/?connected=true")


@router.get("/accounts")
async def list_accounts(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(OAuthToken.account_id, OAuthToken.email, OAuthToken.provider)
    )
    return [
        {"account_id": r.account_id, "email": r.email, "provider": r.provider}
        for r in result.all()
    ]
