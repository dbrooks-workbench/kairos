from abc import ABC, abstractmethod
from datetime import datetime, date

from ..models import CalendarItem


class ICalendarProvider(ABC):
    @abstractmethod
    async def get_events(self, start: datetime, end: datetime) -> list[CalendarItem]: ...

    @abstractmethod
    async def create_event(self, item: CalendarItem) -> CalendarItem: ...

    @abstractmethod
    async def update_event(self, item: CalendarItem) -> CalendarItem: ...

    @abstractmethod
    async def delete_event(self, item_id: str) -> None: ...


class ITaskProvider(ABC):
    @abstractmethod
    async def get_tasks(self, start: date, end: date) -> list[CalendarItem]: ...

    @abstractmethod
    async def complete_task(self, task_id: str) -> None: ...

    @abstractmethod
    async def update_task(self, item: CalendarItem) -> CalendarItem: ...
