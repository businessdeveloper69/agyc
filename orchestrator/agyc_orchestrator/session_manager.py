from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Callable

from .config import DispatcherConfig, OrchestratorConfig
from .sessions.base import IDESession
from .sessions.subprocess_session import SubprocessSession


@dataclass
class SessionHandle:
    account_id: str
    session: IDESession
    max_concurrency: int


class SessionManager:
    def __init__(self, cfg: OrchestratorConfig):
        self._cfg = cfg
        self._sessions: dict[str, SessionHandle] = {}
        self._monitor_task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    @property
    def sessions(self) -> dict[str, SessionHandle]:
        return self._sessions

    async def start_all(self) -> None:
        for a in self._cfg.accounts:
            sess = SubprocessSession(a)
            await sess.start()
            self._sessions[a.id] = SessionHandle(
                account_id=a.id, session=sess, max_concurrency=a.max_concurrency
            )

        self._stop_event.clear()
        self._monitor_task = asyncio.create_task(self._monitor_loop(self._cfg.dispatcher))

    async def stop_all(self) -> None:
        self._stop_event.set()
        if self._monitor_task:
            self._monitor_task.cancel()
            try:
                await self._monitor_task
            except Exception:
                pass
            self._monitor_task = None

        for h in list(self._sessions.values()):
            try:
                await h.session.stop()
            except Exception:
                pass
        self._sessions.clear()

    async def _monitor_loop(self, disp: DispatcherConfig) -> None:
        while not self._stop_event.is_set():
            for h in list(self._sessions.values()):
                try:
                    healthy = await h.session.is_healthy()
                    if not healthy:
                        await h.session.stop()
                        await h.session.start()
                except Exception:
                    try:
                        await h.session.stop()
                        await h.session.start()
                    except Exception:
                        pass
            await asyncio.sleep(max(1, disp.health_check_interval_seconds))

