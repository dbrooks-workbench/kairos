from datetime import datetime

from .base import ICalendarProvider
from ..models import CalendarItem, OAuthToken


class GoogleCalendarProvider(ICalendarProvider):
    def __init__(self, token: OAuthToken):
        self.token = token

    async def get_events(self, start: datetime, end: datetime) -> list[CalendarItem]:
        # TODO: implement Google Calendar API v3 fetch + normalize to CalendarItem
        return []

    async def create_event(self, item: CalendarItem) -> CalendarItem:
        raise NotImplementedError

    async def update_event(self, item: CalendarItem) -> CalendarItem:
        raise NotImplementedError

    async def delete_event(self, item_id: str) -> None:
        raise NotImplementedError
