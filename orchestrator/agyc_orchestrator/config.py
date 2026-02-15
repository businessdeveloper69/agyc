from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class AccountConfig:
    id: str
    state_dir: str
    start_command: list[str] | None = None
    health_command: list[str] | None = None
    task_command: list[str] | None = None
    env: dict[str, str] = field(default_factory=dict)
    max_concurrency: int = 1


@dataclass(frozen=True)
class DispatcherConfig:
    routing: str = "round-robin"  # round-robin | lru | health
    global_queue_size: int = 200
    per_account_queue_size: int = 50
    task_timeout_seconds: int = 600
    health_check_interval_seconds: int = 10


@dataclass(frozen=True)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8088


@dataclass(frozen=True)
class OrchestratorConfig:
    server: ServerConfig
    dispatcher: DispatcherConfig
    accounts: list[AccountConfig]


def _maybe_load_yaml(path: Path) -> Mapping[str, Any]:
    try:
        import yaml  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "YAML config requested but PyYAML is not installed. "
            "Install it (pip install PyYAML) or use JSON config."
        ) from e
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_config(path: str) -> OrchestratorConfig:
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(path)

    if p.suffix.lower() in {".yml", ".yaml"}:
        raw = dict(_maybe_load_yaml(p))
    else:
        raw = json.loads(p.read_text(encoding="utf-8"))

    server_raw = raw.get("server", {}) or {}
    disp_raw = raw.get("dispatcher", {}) or {}
    accounts_raw = raw.get("accounts", []) or []

    server = ServerConfig(
        host=str(server_raw.get("host", ServerConfig.host)),
        port=int(server_raw.get("port", ServerConfig.port)),
    )

    dispatcher = DispatcherConfig(
        routing=str(disp_raw.get("routing", DispatcherConfig.routing)),
        global_queue_size=int(disp_raw.get("globalQueueSize", DispatcherConfig.global_queue_size)),
        per_account_queue_size=int(
            disp_raw.get("perAccountQueueSize", DispatcherConfig.per_account_queue_size)
        ),
        task_timeout_seconds=int(
            disp_raw.get("taskTimeoutSeconds", DispatcherConfig.task_timeout_seconds)
        ),
        health_check_interval_seconds=int(
            disp_raw.get(
                "healthCheckIntervalSeconds", DispatcherConfig.health_check_interval_seconds
            )
        ),
    )

    accounts: list[AccountConfig] = []
    for a in accounts_raw:
        if not isinstance(a, Mapping):
            raise ValueError("Each account must be an object")
        account_id = str(a.get("id", "")).strip()
        if not account_id:
            raise ValueError("Account id is required")
        state_dir = str(a.get("stateDir", "")).strip()
        if not state_dir:
            raise ValueError(f"Account {account_id} stateDir is required")

        env = {str(k): str(v) for k, v in (a.get("env") or {}).items()}
        env.setdefault("AG_CONFIG_DIR", state_dir)

        accounts.append(
            AccountConfig(
                id=account_id,
                state_dir=os.path.expanduser(state_dir),
                start_command=list(a.get("startCommand") or []) or None,
                health_command=list(a.get("healthCommand") or []) or None,
                task_command=list(a.get("taskCommand") or []) or None,
                env=env,
                max_concurrency=max(1, int(a.get("maxConcurrency", 1))),
            )
        )

    if not accounts:
        raise ValueError("Config must contain at least one account")

    return OrchestratorConfig(server=server, dispatcher=dispatcher, accounts=accounts)
