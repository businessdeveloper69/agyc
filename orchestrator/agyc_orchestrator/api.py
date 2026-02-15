from __future__ import annotations

import argparse
import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from .config import OrchestratorConfig, load_config
from .dispatcher import Dispatcher
from .session_manager import SessionManager


def _anthropic_message_response(model: str, text: str, account_id: str | None) -> dict[str, Any]:
    return {
        "id": f"msg_{uuid.uuid4().hex[:16]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": text}],
        "metadata": {"account_id": account_id} if account_id else {},
    }


def create_app(cfg: OrchestratorConfig) -> FastAPI:
    session_manager = SessionManager(cfg)
    dispatcher: Dispatcher | None = None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        nonlocal dispatcher
        await session_manager.start_all()
        dispatcher = Dispatcher(cfg.dispatcher, session_manager.sessions)
        await dispatcher.start()
        try:
            yield
        finally:
            if dispatcher:
                await dispatcher.stop()
            await session_manager.stop_all()

    app = FastAPI(title="AGYC Orchestrator", version="0.1.0", lifespan=lifespan)

    @app.get("/healthz")
    async def healthz():
        return {"ok": True, "ts": time.time()}

    @app.get("/metrics")
    async def metrics():
        if not dispatcher:
            return PlainTextResponse("dispatcher_not_ready 1\n", status_code=503)
        return PlainTextResponse(dispatcher.metrics_text(), media_type="text/plain; version=0.0.4")

    @app.post("/v1/messages")
    async def v1_messages(req: Request):
        if not dispatcher:
            raise HTTPException(status_code=503, detail="Dispatcher not ready")
        body = await req.json()
        model = body.get("model")
        messages = body.get("messages")
        if not isinstance(model, str) or not model:
            raise HTTPException(status_code=400, detail="model is required")
        if not isinstance(messages, list) or not messages:
            raise HTTPException(status_code=400, detail="messages[] is required")

        try:
            result = await dispatcher.submit(body)
        except RuntimeError as e:
            raise HTTPException(status_code=429, detail=str(e)) from e
        except asyncio.TimeoutError as e:
            raise HTTPException(status_code=504, detail="Task timed out") from e

        # If the session already returned a full Anthropic-shaped payload, pass it through.
        if isinstance(result, dict) and result.get("type") == "message":
            return JSONResponse(result)

        text = ""
        if isinstance(result, dict):
            if "content" in result and isinstance(result["content"], str):
                text = result["content"]
            elif "raw" in result:
                text = str(result["raw"])
            else:
                text = str(result)
        else:
            text = str(result)

        account_id = None
        if isinstance(result, dict):
            account_id = (result.get("metadata") or {}).get("account_id") or result.get("account_id")
        return JSONResponse(_anthropic_message_response(model, text, account_id))

    return app


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="AGYC Orchestrator")
    parser.add_argument("--config", required=True, help="Path to JSON/YAML config file")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)

    import uvicorn

    app = create_app(cfg)
    uvicorn.run(app, host=cfg.server.host, port=cfg.server.port, reload=False, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    main()
