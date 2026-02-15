from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Mapping

from ..config import AccountConfig
from .base import IDESession


class SubprocessSession(IDESession):
    """
    Minimal session wrapper:
    - Optionally starts a long-lived process (start_command)
    - Health checks via process liveness and/or health_command
    - Executes tasks by spawning task_command per request (isolated by env/stateDir)
    """

    def __init__(self, cfg: AccountConfig):
        self._cfg = cfg
        self._proc: asyncio.subprocess.Process | None = None

    def _env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.update(self._cfg.env)
        env.setdefault("AG_CONFIG_DIR", self._cfg.state_dir)
        return env

    async def start(self) -> None:
        Path(self._cfg.state_dir).mkdir(parents=True, exist_ok=True)
        if not self._cfg.start_command:
            return
        if self._proc and self._proc.returncode is None:
            return
        self._proc = await asyncio.create_subprocess_exec(
            *self._cfg.start_command,
            env=self._env(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )

    async def stop(self) -> None:
        if not self._proc or self._proc.returncode is not None:
            self._proc = None
            return
        self._proc.terminate()
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=5)
        except TimeoutError:
            self._proc.kill()
            await self._proc.wait()
        finally:
            self._proc = None

    async def _run_command_ok(self, cmd: list[str]) -> bool:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            env=self._env(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        rc = await proc.wait()
        return rc == 0

    async def is_healthy(self) -> bool:
        if self._cfg.start_command:
            if not self._proc or self._proc.returncode is not None:
                return False
        if self._cfg.health_command:
            return await self._run_command_ok(self._cfg.health_command)
        return True

    async def run_task(self, request: Mapping[str, Any]) -> dict[str, Any]:
        if not self._cfg.task_command:
            raise RuntimeError(f"Account {self._cfg.id} has no taskCommand configured")

        stdin = json.dumps(dict(request)).encode("utf-8")
        proc = await asyncio.create_subprocess_exec(
            *self._cfg.task_command,
            env=self._env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(stdin)
        if proc.returncode != 0:
            raise RuntimeError(
                f"taskCommand failed for {self._cfg.id} rc={proc.returncode}: "
                f"{err.decode('utf-8', errors='replace')}"
            )
        try:
            return json.loads(out.decode("utf-8"))
        except Exception:
            return {"raw": out.decode("utf-8", errors="replace")}

