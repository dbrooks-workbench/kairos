from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from icalendar import Calendar, Event as ICalEvent
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import CalendarItem, OAuthToken
from ..providers.google_calendar import GoogleCalendarProvider
from ..providers.google_tasks import GoogleTasksProvider

router = APIRouter()


def _default_start() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _default_end() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=23, minute=59, second=59, microsecond=0)


@router.get("/feed", response_model=list[CalendarItem])
async def get_feed(
    start: datetime = Query(default_factory=_default_start),
    end: datetime = Query(default_factory=_default_end),
    db: AsyncSession = Depends(get_db),
) -> list[CalendarItem]:
    result = await db.execute(select(OAuthToken))
    tokens = result.scalars().all()

    items: list[CalendarItem] = []
    for token in tokens:
        if token.provider == "google":
            items.extend(await GoogleCalendarProvider(token).get_events(start, end))
            items.extend(await GoogleTasksProvider(token).get_tasks(start.date(), end.date()))

    return items


@router.get("/feed.ics")
async def get_ics_feed(
    start: datetime = Query(default_factory=_default_start),
    end: datetime = Query(default_factory=_default_end),
    db: AsyncSession = Depends(get_db),
):
    items = await get_feed(start=start, end=end, db=db)

    cal = Calendar()
    cal.add("prodid", "-//Kairos//kairos//EN")
    cal.add("version", "2.0")

    for item in items:
        event = ICalEvent()
        event.add("uid", item.id)
        event.add("summary", item.title)
        event.add("dtstart", item.start)
        if item.end:
            event.add("dtend", item.end)
        if item.due:
            event.add("due", item.due)
        cal.add_component(event)

    return Response(
        content=cal.to_ical(),
        media_type="text/calendar",
        headers={"Content-Disposition": 'attachment; filename="kairos.ics"'},
    )
