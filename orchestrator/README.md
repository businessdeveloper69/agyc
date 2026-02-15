# AGYC Orchestrator (Python)

This directory contains a minimal, production-grade **local orchestrator** that can drive **up to ~30 concurrent IDE/CLI sessions** (e.g., Antigravity CLI) from a single controller process.

It is intentionally **pluggable**: each “account” maps to an isolated session state directory plus a configurable way to execute tasks (HTTP, stdio, or per-request subprocess).

## 1) Data model & interfaces

### Config

See `orchestrator/config.example.json`.

At a high level:

- **accounts[]**: logical account IDs + state dir + commands + maxConcurrency
- **dispatcher**: routing policy + queue sizes + timeouts
- **server**: bind host/port

### Session interface

Each account is represented by an `IDESession` implementation:

- `start()` / `stop()`: lifecycle
- `is_healthy()`: process + lightweight auth/health signal
- `run_task(request: dict) -> dict`: execute one Anthropic-style `/v1/messages` request and return a response dict

See: `agyc_orchestrator/sessions/base.py`

### Dispatcher

The dispatcher provides:

- Global incoming queue (backpressure)
- Routing strategies:
  - round-robin
  - least-recently-used (LRU)
  - health-score-based
- Per-account queues + per-account concurrency limits
- Metrics & structured logs

See: `agyc_orchestrator/dispatcher.py`

## 2) Control flow (single request)

1. Client sends `POST /v1/messages` (Anthropic-style JSON)
2. API validates basics and enqueues a task into the **global queue**
3. Router loop selects a target account (based on routing policy + health + capacity)
4. Task is placed into that account’s queue
5. Account worker executes `session.run_task()` (with per-account semaphore)
6. Result is returned to the waiting HTTP request; metrics are updated

## 3) Running

### Install (optional)

This orchestrator is shipped as source code; install deps only if you want to run it:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r orchestrator/requirements.txt
```

### Start

```bash
PYTHONPATH=orchestrator python -m agyc_orchestrator.api --config orchestrator/config.example.json
```

## 4) Example request/response

Request:

```bash
curl -s http://127.0.0.1:8088/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-4-5-thinking",
    "messages": [{"role": "user", "content": "Say hello"}],
    "metadata": {"routing": {"strategyHint": "lru"}}
  }'
```

Response (example):

```json
{
  "id": "msg_01H...",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5-thinking",
  "content": [{"type": "text", "text": "hello"}],
  "metadata": {"account_id": "acc01"}
}
```
