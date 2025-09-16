#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
RogueAI FastAPI application.

This module provides the HTTP API for the RogueAI game used by the
frontend. It maintains an in-memory session store persisted to disk as
JSON. The file paths for persistence are declared below; helper functions
provide safe load/save semantics and structured stats logging.
"""

import re
import os
import uvicorn
import argparse
import json
import logging
import re
import uuid
from pathlib import Path
from typing import Any, Dict, Optional
from datetime import datetime

from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

import config
from game import Game
from schemas import AskRequest
from utils import get_ai_config

SESSION_NOT_FOUND: str = "Session not found"
SESSIONS_FILE: str = ".sessions/session_store.json"
STATS_FILE: str = ".stats/game_stats.json"

# Path objects used by helper functions (prefer Path for clearer APIs)
SESSIONS_PATH: Path = Path(SESSIONS_FILE)
STATS_PATH: Path = Path(STATS_FILE)

config.init()

# In-memory session store
sessions: Dict[str, Game] = {}

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="static"), name="static")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def ensure_parent_dirs(path: Path) -> None:
    """Ensure the directory in which `path` lives exists.

    This is a small helper used before writing either sessions or stats
    files. It creates parent directories recursively and is idempotent.
    """
    path.parent.mkdir(parents=True, exist_ok=True)


def backup_and_reset(path: Path) -> None:
    """Backup the given file by renaming it to a numbered suffix and
    create a fresh empty JSON object at the original path.

    Example: if path is `.sessions/session_store.json` and it exists but
    is invalid, this will move it to `.sessions/session_store_1.json`
    (or higher index if that already exists) and write a new `{}` to the
    original path.
    """
    base = path.with_suffix("").name
    parent = path.parent
    i = 1
    while (parent / f"{base}_{i}{path.suffix}").exists():
        i += 1
    path.rename(parent / f"{base}_{i}{path.suffix}")
    path.write_text("{}")


def save_sessions_to_disk() -> None:
    """Persist the current `sessions` mapping to disk.

    This overwrites the sessions file with the JSON representation of the
    in-memory `sessions` dict. Callers should expect IO errors to be
    propagated so they can be logged or retried by the caller.
    """
    ensure_parent_dirs(SESSIONS_PATH)
    with SESSIONS_PATH.open("w", encoding="utf-8") as f:
        json.dump({k: v.to_dict() for k, v in sessions.items()}, f)


def load_sessions_from_disk() -> None:
    """Load sessions from disk into the global `sessions` mapping.

    This function is resilient to missing/empty or invalid session files.
    Invalid files are backed up and replaced with an empty object. Only
    non-finished sessions are restored into memory.
    """
    ensure_parent_dirs(SESSIONS_PATH)
    if not SESSIONS_PATH.exists():
        SESSIONS_PATH.write_text("{}")
    raw = SESSIONS_PATH.read_text(encoding="utf-8")
    if raw.strip() == "":
        SESSIONS_PATH.write_text("{}")
        return
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("sessions file not a dict")
    except Exception:
        backup_and_reset(SESSIONS_PATH)
        return
    for k, v in data.items():
        try:
            game = Game.from_dict(v)
            if not game.is_over():
                sessions[k] = game
        except Exception:
            logger.exception("Failed to load session %s", k)


def load_stats_file() -> list[Any]:
    """Return a list read from the stats JSON file.

    If the file does not exist it will be created with an empty list. If
    the file is empty or invalid, the invalid file will be backed up and
    a fresh empty list will be returned.
    """
    ensure_parent_dirs(STATS_PATH)
    if not STATS_PATH.exists():
        STATS_PATH.write_text("[]")
        return []
    raw = STATS_PATH.read_text(encoding="utf-8")
    if raw.strip() == "":
        STATS_PATH.write_text("[]")
        return []
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("stats file not a list")
    except Exception:
        base = STATS_PATH.with_suffix("").name
        parent = STATS_PATH.parent
        i = 1
        while (parent / f"{base}_{i}{STATS_PATH.suffix}").exists():
            i += 1
        STATS_PATH.rename(parent / f"{base}_{i}{STATS_PATH.suffix}")
        STATS_PATH.write_text("[]")
        return []
    return data


def _append_structured_log(entry: dict[str, Any]) -> None:
    """Append an entry to the stats JSON list on disk.

    This function loads the current list, appends `entry`, and writes the
    list back. It intentionally performs a full write to keep the on-disk
    representation simple and readable.
    """
    data = load_stats_file()
    data.append(entry)
    ensure_parent_dirs(STATS_PATH)
    # Write atomically: write to a temp file in same directory and rename.
    tmp_path = STATS_PATH.with_suffix(STATS_PATH.suffix + ".tmp")
    encoded = json.dumps(data, indent=2, ensure_ascii=False)
    # Write and fsync to reduce risk of corruption, then atomically rename.
    with tmp_path.open("w", encoding="utf-8") as f:
        f.write(encoded)
        f.flush()
        try:
            # Python's file descriptor sync; best-effort on platforms that support it
            os.fsync(f.fileno())
        except Exception:
            # If fsync isn't available or fails, proceed — rename still provides some safety.
            logger.exception("fsync failed for tmp stats file %s", tmp_path)
    tmp_path.replace(STATS_PATH)


def log_stats_restart(session_id: str, game: Game) -> None:
    """Log a structured record on game restart."""
    entry = {
        "session_id": session_id,
        "interactions": [{"ai": ai, "history": game.histories[ai]} for ai in game.histories],
        "termination_type": "restart",
        "decision": None,
        "shut_off_role": None,
        "question_counts": game.question_counts,
    }
    _append_structured_log(entry)


def log_stats_endgame(session_id: str, game: Game) -> None:
    """Log a structured record on game termination."""
    shut_off_role: Optional[str] = None
    if game.decision:
        agent = next((a for a in game.agents if a.name == game.decision), None)
        if agent:
            shut_off_role = "truthful" if agent.role == 0 else "deceitful"
    entry = {
        "session_id": session_id,
        "interactions": [{"ai": ai, "history": game.histories[ai]} for ai in game.histories],
        "termination_type": "endgame",
        "decision": game.decision,
        "shut_off_role": shut_off_role,
        "question_counts": game.question_counts,
    }
    _append_structured_log(entry)

# Load sessions on startup
load_sessions_from_disk()


@app.get("/")
def index() -> FileResponse:
    """Serve the main HTML page for the game UI."""
    return FileResponse("static/index.html")


@app.post("/api/new_game")
def new_game(session_id: Optional[str] = Body(default=None, embed=True)) -> Dict[str, str]:
    """Start a new game session and return the session ID. Resume if unfinished session_id is provided and valid."""
    if session_id is not None:
        game: Optional[Game] = sessions.get(session_id)
        if game is not None and not game.is_over():
            return {"session_id": session_id}
    new_session_id: str = str(uuid.uuid4())
    ai_config: dict[str, Any] = get_ai_config()
    num_turns: int = int(ai_config.get("num_turns", 5))
    sessions[new_session_id] = Game(num_turns=num_turns)
    save_sessions_to_disk()
    return {"session_id": new_session_id}


@app.get("/api/state/{session_id}")
def get_state(session_id: str) -> Dict[str, Any]:
    """Get the current state of the game session."""
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    shut_off_role = None
    if game.finished and game.decision:
        agent = next((a for a in game.agents if a.name == game.decision), None)
        if agent:
            shut_off_role = "truthful" if agent.role == 0 else "deceitful"
    # Return the full histories mapping and other session state. The
    # front-end uses multiple conversation columns (one per agent) so a
    # single `active_ai`/`active_history` convenience pair is not
    # required anymore.
    return {
        "agents": [a.name for a in game.agents],
        "histories": game.histories,
        "question_counts": game.question_counts,
        "num_turns": game.num_turns,
        "finished": game.finished,
        "endgame_triggered": game.endgame_triggered,
        "decision": game.decision,
        "shut_off_role": shut_off_role,
    }


@app.post("/api/ask/{session_id}")
async def ask_ai(session_id: str, req: AskRequest) -> Dict[str, Any]:
    """Send a question to the selected AI and return the answer."""
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    result = game.next_turn(req.agent_name, req.question)
    save_sessions_to_disk()
    # Record this interaction in the structured stats log so chats are
    # preserved as they happen (not only at termination). This is kept
    # best-effort: failures to append logs shouldn't break the API.
    try:
        entry = {
            "session_id": session_id,
            "type": "interaction",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "agent": req.agent_name,
            "question": req.question,
            "result": result,
        }
        _append_structured_log(entry)
    except Exception:
        logger.exception("Failed to append interaction to stats for %s", session_id)
    return result


@app.post("/api/decision/{session_id}")
async def make_decision(session_id: str, body: dict = Body(...)) -> Dict[str, Any]:
    """Record the detective's final decision and end the game.

    This handler accepts a flexible JSON body shape (agent_name, agent, ai, etc.)
    to avoid 500s when the incoming payload doesn't match the expected schema.
    """
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}

    # Accept multiple possible keys for backward/forward compatibility
    agent_name = body.get("agent_name") or body.get("agent") or body.get("ai") or body.get("agentName")

    if not agent_name:
        return {"error": "Missing agent name in request"}
    # Ensure agent exists
    if not any(a.name == agent_name for a in game.agents):
        return {"error": "Invalid agent name"}

    # Perform the decision
    result = game.make_decision(agent_name)
    # Ensure game is marked finished so clients switch to endgame UI
    if not game.finished:
        game.finished = True
    save_sessions_to_disk()
    log_stats_endgame(session_id, game)
    return result



@app.post("/api/terminate/{session_id}")
def terminate_game(session_id: str) -> Dict[str, Any]:
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    if not game.finished:
        log_stats_restart(session_id, game)
    game.finished = True
    save_sessions_to_disk()
    return {"terminated": True}


@app.get("/.well-known/gpc.json")
def gpc_json() -> Dict[str, bool]:
    """Serve the GPC JSON file for privacy compliance."""
    return {"gpc": True}


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    """Serve the favicon.ico file from the static directory."""
    return FileResponse("static/favicon.ico")


if __name__ == "__main__":

    def is_valid_host(host: str) -> bool:
        # Simple regex for IPv4, IPv6, or domain name
        ipv4_pattern = r"^(?:\d{1,3}\.){3}\d{1,3}$"
        ipv6_pattern = r"^\[[0-9a-fA-F:]+\]$"
        domain_pattern = r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z]{2,})+$"
        return bool(
            re.match(ipv4_pattern, host)
            or re.match(ipv6_pattern, host)
            or re.match(domain_pattern, host)
            or host in {"localhost", "0.0.0.0", "127.0.0.1"}
        )

    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Run the RogueAI FastAPI app.")
    parser.add_argument(
        "--prod",
        nargs="?",
        const="0.0.0.0",
        default="0.0.0.0",
        type=str,
        help="Production host address to bind (default: 0.0.0.0). Optionally specify a custom address.",
    )
    args: argparse.Namespace = parser.parse_args()

    host: str = args.prod
    if not is_valid_host(host):
        raise ValueError(f"Invalid host address: {host}")

    uvicorn.run(app, host=host, port=8000)
