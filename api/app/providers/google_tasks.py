from datetime import date

from .base import ITaskProvider
from ..models import CalendarItem, OAuthToken


class GoogleTasksProvider(ITaskProvider):
    def __init__(self, token: OAuthToken):
        self.token = token

    async def get_tasks(self, start: date, end: date) -> list[CalendarItem]:
        # TODO: implement Google Tasks API fetch + normalize to CalendarItem
        return []

    async def complete_task(self, task_id: str) -> None:
        raise NotImplementedError

    async def update_task(self, item: CalendarItem) -> CalendarItem:
        raise NotImplementedError
