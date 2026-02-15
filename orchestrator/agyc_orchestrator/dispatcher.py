from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Mapping

from .config import DispatcherConfig
from .session_manager import SessionHandle


@dataclass
class AccountMetrics:
    tasks_total: int = 0
    errors_total: int = 0
    latency_ms_total: float = 0.0
    last_success_ts: float | None = None
    last_error_ts: float | None = None

    @property
    def avg_latency_ms(self) -> float:
        if self.tasks_total <= 0:
            return 0.0
        return self.latency_ms_total / self.tasks_total


@dataclass
class AccountState:
    handle: SessionHandle
    queue: asyncio.Queue["TaskItem"]
    semaphore: asyncio.Semaphore
    last_used_ts: float = 0.0
    health_score: float = 100.0
    inflight: int = 0
    metrics: AccountMetrics = field(default_factory=AccountMetrics)


@dataclass
class TaskItem:
    request: dict[str, Any]
    future: asyncio.Future[dict[str, Any]]
    created_ts: float
    task_id: str


class Dispatcher:
    def __init__(self, cfg: DispatcherConfig, sessions: Mapping[str, SessionHandle]):
        self._cfg = cfg
        self._global_queue: asyncio.Queue[TaskItem] = asyncio.Queue(maxsize=cfg.global_queue_size)
        self._accounts: dict[str, AccountState] = {}
        self._router_task: asyncio.Task[None] | None = None
        self._workers: list[asyncio.Task[None]] = []
        self._stop_event = asyncio.Event()
        self._rr_cursor = 0
        self._capacity_event = asyncio.Event()

        for account_id, handle in sessions.items():
            q: asyncio.Queue[TaskItem] = asyncio.Queue(maxsize=cfg.per_account_queue_size)
            self._accounts[account_id] = AccountState(
                handle=handle,
                queue=q,
                semaphore=asyncio.Semaphore(handle.max_concurrency),
            )

    async def start(self) -> None:
        self._stop_event.clear()
        self._router_task = asyncio.create_task(self._router_loop())
        for st in self._accounts.values():
            self._workers.append(asyncio.create_task(self._account_worker(st)))

    async def stop(self) -> None:
        self._stop_event.set()
        if self._router_task:
            self._router_task.cancel()
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*(t for t in [self._router_task, *self._workers] if t), return_exceptions=True)
        self._router_task = None
        self._workers.clear()

    async def submit(self, request: Mapping[str, Any]) -> dict[str, Any]:
        if self._global_queue.full():
            raise RuntimeError("Global queue is full")

        task_id = f"task_{uuid.uuid4().hex[:12]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        item = TaskItem(request=dict(request), future=fut, created_ts=time.time(), task_id=task_id)
        await self._global_queue.put(item)
        return await fut

    def _usable_accounts(self) -> list[AccountState]:
        # "Healthy" here is the current score; process health is checked by SessionManager.
        return [a for a in self._accounts.values() if a.health_score > 0]

    def _pick_account(self, hint: str | None = None) -> AccountState | None:
        strategy = (hint or self._cfg.routing or "round-robin").lower()
        usable = self._usable_accounts()
        if not usable:
            return None

        if strategy in {"lru", "least-recently-used", "least_recently_used"}:
            return min(usable, key=lambda a: a.last_used_ts)

        if strategy in {"health", "health-score", "health_score"}:
            return max(usable, key=lambda a: a.health_score)

        # default: round-robin
        ordered = sorted(usable, key=lambda a: a.handle.account_id)
        self._rr_cursor = self._rr_cursor % len(ordered)
        chosen = ordered[self._rr_cursor]
        self._rr_cursor = (self._rr_cursor + 1) % len(ordered)
        return chosen

    async def _router_loop(self) -> None:
        while not self._stop_event.is_set():
            item = await self._global_queue.get()
            hint = (
                (item.request.get("metadata") or {})
                .get("routing", {})
                .get("strategyHint")
            )

            while not self._stop_event.is_set():
                acc = self._pick_account(hint)
                if not acc:
                    await asyncio.sleep(0.1)
                    continue

                # Prefer accounts with available capacity; if chosen is saturated, wait for capacity.
                if acc.inflight >= acc.handle.max_concurrency:
                    self._capacity_event.clear()
                    await asyncio.wait_for(self._capacity_event.wait(), timeout=1.0)
                    continue

                try:
                    acc.queue.put_nowait(item)
                    break
                except asyncio.QueueFull:
                    # Try again on a different account.
                    acc.health_score = max(0.0, acc.health_score - 1.0)
                    await asyncio.sleep(0)
                    continue

            self._global_queue.task_done()

    async def _account_worker(self, acc: AccountState) -> None:
        while not self._stop_event.is_set():
            item = await acc.queue.get()
            start = time.time()
            try:
                await acc.semaphore.acquire()
                acc.inflight += 1
                try:
                    req = dict(item.request)
                    req["account_id"] = acc.handle.account_id
                    result = await asyncio.wait_for(
                        acc.handle.session.run_task(req),
                        timeout=self._cfg.task_timeout_seconds,
                    )
                finally:
                    acc.inflight -= 1
                    acc.semaphore.release()
                acc.last_used_ts = time.time()
                acc.health_score = min(100.0, acc.health_score + 0.5)
                acc.metrics.tasks_total += 1
                acc.metrics.latency_ms_total += (time.time() - start) * 1000
                acc.metrics.last_success_ts = time.time()
                result.setdefault("metadata", {})
                result["metadata"] = {**(result.get("metadata") or {}), "account_id": acc.handle.account_id}
                if not item.future.done():
                    item.future.set_result(result)
            except Exception as e:
                acc.health_score = max(0.0, acc.health_score - 5.0)
                acc.metrics.errors_total += 1
                acc.metrics.last_error_ts = time.time()
                if not item.future.done():
                    item.future.set_exception(e)
            finally:
                acc.queue.task_done()
                self._capacity_event.set()

    def metrics_text(self) -> str:
        now = time.time()
        lines = []
        lines.append("# TYPE agyc_queue_depth gauge")
        lines.append(f"agyc_queue_depth {self._global_queue.qsize()}")
        lines.append("# TYPE agyc_accounts gauge")
        lines.append(f"agyc_accounts {len(self._accounts)}")

        for account_id, acc in sorted(self._accounts.items()):
            m = acc.metrics
            lines.append("# TYPE agyc_account_tasks_total counter")
            lines.append(f'agyc_account_tasks_total{{account="{account_id}"}} {m.tasks_total}')
            lines.append("# TYPE agyc_account_errors_total counter")
            lines.append(f'agyc_account_errors_total{{account="{account_id}"}} {m.errors_total}')
            lines.append("# TYPE agyc_account_avg_latency_ms gauge")
            lines.append(f'agyc_account_avg_latency_ms{{account="{account_id}"}} {m.avg_latency_ms:.3f}')
            lines.append("# TYPE agyc_account_health_score gauge")
            lines.append(f'agyc_account_health_score{{account="{account_id}"}} {acc.health_score:.3f}')
            if m.last_success_ts:
                lines.append("# TYPE agyc_account_last_success_seconds gauge")
                lines.append(
                    f'agyc_account_last_success_seconds{{account="{account_id}"}} {now - m.last_success_ts:.3f}'
                )
        return "\n".join(lines) + "\n"
