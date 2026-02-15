from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Mapping


class IDESession(ABC):
    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    async def is_healthy(self) -> bool: ...

    @abstractmethod
    async def run_task(self, request: Mapping[str, Any]) -> dict[str, Any]: ...

