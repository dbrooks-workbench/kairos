from datetime import datetime, date
from enum import Enum
from typing import Any

from pydantic import BaseModel
from sqlalchemy import String, DateTime, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class ItemType(str, Enum):
    EVENT = "EVENT"
    TASK = "TASK"
    MILESTONE = "MILESTONE"
    HABIT = "HABIT"


class ItemStatus(str, Enum):
    CONFIRMED = "CONFIRMED"
    TENTATIVE = "TENTATIVE"
    CANCELLED = "CANCELLED"
    COMPLETED = "COMPLETED"
    NEEDS_ACTION = "NEEDS_ACTION"


class SourceInfo(BaseModel):
    provider: str
    account_id: str
    external_id: str


class CalendarItem(BaseModel):
    id: str
    title: str
    item_type: ItemType
    source: SourceInfo
    start: datetime | date
    end: datetime | date | None = None
    due: datetime | date | None = None
    all_day: bool = False
    status: ItemStatus = ItemStatus.CONFIRMED
    recurrence: str | None = None
    metadata: dict[str, Any] = {}
    tags: list[str] = []
    color: str | None = None
    editable: bool = True


class OAuthToken(Base):
    __tablename__ = "oauth_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    provider: Mapped[str] = mapped_column(String(50))
    access_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    scopes: Mapped[str | None] = mapped_column(Text, nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
