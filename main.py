#!/usr/bin/env python
# -*- coding: utf-8 -*-
import json
import logging
import os
import uuid
from typing import Any
from typing import Dict
from typing import Optional

from fastapi import Body
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

import config  # Ensures OpenAI API key is set
from game import Game
from schemas import AskRequest
from schemas import DecisionRequest
from schemas import SelectAIRequest
from utils import get_ai_config

SESSION_NOT_FOUND: str = "Session not found"
SESSIONS_FILE: str = ".sessions/session_store.json"
STATS_FILE: str = ".stats/game_stats.json"

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


def save_sessions_to_disk() -> None:
    with open(SESSIONS_FILE, "w") as f:
        json.dump({k: v.to_dict() for k, v in sessions.items()}, f)


def load_sessions_from_disk() -> None:  # NOSONAR
    if not os.path.exists(SESSIONS_FILE):
        with open(SESSIONS_FILE, "w") as f:
            f.write("{}")
    if os.path.exists(SESSIONS_FILE):
        # Fallback mechanism for empty or invalid session_store.json
        with open(SESSIONS_FILE, "r") as f:
            raw_content: str = f.read()
        if raw_content.strip() == "":
            # File is empty or only whitespace/newlines
            with open(SESSIONS_FILE, "w") as f:
                f.write("{}")
            data = {}
        else:
            try:
                data = json.loads(raw_content)
            except Exception:
                # File is not empty but invalid JSON
                # Find next available session_store_X.json
                base, ext = os.path.splitext(SESSIONS_FILE)
                i = 1
                while os.path.exists(f"{base}_{i}{ext}"):
                    i += 1
                os.rename(SESSIONS_FILE, f"{base}_{i}{ext}")
                with open(SESSIONS_FILE, "w") as f:
                    f.write("{}")
                data = {}
        for k, v in data.items():
            game = Game.from_dict(v)
            if not game.is_over():
                sessions[k] = game


def log_stats_manual_termination(session_id: str, game: Game) -> None:
    """Log a structured record for manual termination."""
    log_entry: dict[str, Any] = {
        "session_id": session_id,
        "interactions": [
            {"ai": ai, "history": game.histories[ai]} for ai in game.histories
        ],
        "termination_type": "manual",
        "decision": None,
        "shut_off_role": None,
        "question_counts": game.question_counts,
    }
    _append_structured_log(log_entry)


def log_stats_endgame(session_id: str, game: Game) -> None:
    """Log a structured record for endgame termination."""
    shut_off_role: Optional[str] = None
    if game.decision:
        agent = next((a for a in game.agents if a.name == game.decision), None)
        if agent:
            shut_off_role = "truthful" if agent.role == 0 else "deceitful"
    log_entry: dict[str, Any] = {
        "session_id": session_id,
        "interactions": [
            {"ai": ai, "history": game.histories[ai]} for ai in game.histories
        ],
        "termination_type": "endgame",
        "decision": game.decision,
        "shut_off_role": shut_off_role,
        "question_counts": game.question_counts,
    }
    _append_structured_log(log_entry)


def load_stats_file() -> list[Any]:
    """Ensure the stats file exists and is a valid JSON list. If empty, fill with []. If invalid, back up and start fresh."""
    if not os.path.exists(STATS_FILE):
        with open(STATS_FILE, "w") as f:
            json.dump([], f)
        return []
    with open(STATS_FILE, "r+") as f:
        raw_content: str = f.read()
        if raw_content.strip() == "":
            f.seek(0)
            json.dump([], f)
            f.truncate()
            return []
        try:
            data = json.loads(raw_content)
            if not isinstance(data, list):
                data = []
        except Exception:
            # Backup invalid file
            base, ext = os.path.splitext(STATS_FILE)
            i = 1
            while os.path.exists(f"{base}_{i}{ext}"):
                i += 1
            os.rename(STATS_FILE, f"{base}_{i}{ext}")
            with open(STATS_FILE, "w") as f2:
                json.dump([], f2)
            return []
        return data


def _append_structured_log(entry: dict[str, Any]) -> None:
    """Append a structured log entry to the stats file as a JSON list."""
    data = load_stats_file()
    data.append(entry)
    with open(STATS_FILE, "w") as f:
        json.dump(data, f, indent=2)


# Load sessions on startup
load_sessions_from_disk()


@app.get("/", response_class=HTMLResponse)
def index() -> FileResponse:
    """Serve the main HTML page for the game UI."""
    return FileResponse("static/index.html")


@app.post("/api/new_game")
def new_game(
    session_id: Optional[str] = Body(default=None, embed=True),
) -> Dict[str, str]:
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
    return {
        "agents": [a.name for a in game.agents],
        "selected_ai": game.selected_ai,
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
    return result


@app.post("/api/select_ai/{session_id}")
async def select_ai(session_id: str, req: SelectAIRequest) -> Dict[str, Any]:
    """Change which AI the detective is addressing."""
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    agent_name: str = req.agent_name
    if agent_name in [a.name for a in game.agents]:
        game.selected_ai = agent_name
        save_sessions_to_disk()
        return {"selected_ai": agent_name}
    return {"error": "Invalid agent name"}


@app.post("/api/manual_endgame/{session_id}")
async def manual_endgame(session_id: str) -> Dict[str, Any]:
    """Manually trigger the endgame phase for the session."""
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    game.manual_endgame()
    save_sessions_to_disk()
    return {"endgame_triggered": True}


@app.post("/api/decision/{session_id}")
async def make_decision(session_id: str, req: DecisionRequest) -> Dict[str, Any]:
    """Record the detective's final decision and end the game."""
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    result = game.make_decision(req.agent_name)
    save_sessions_to_disk()
    log_stats_endgame(session_id, game)
    return result


@app.post("/api/untrigger_endgame/{session_id}")
async def untrigger_endgame(session_id: str) -> Dict[str, Any]:
    """Allow the detective to go back from the endgame phase to continue questioning."""
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    game.untrigger_endgame()
    save_sessions_to_disk()
    return {"endgame_triggered": game.endgame_triggered}


@app.post("/api/terminate/{session_id}")
def terminate_game(session_id: str) -> Dict[str, Any]:
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    if not game.finished:
        log_stats_manual_termination(session_id, game)
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
    import argparse
    import re

    import uvicorn

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

    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        description="Run the RogueAI FastAPI app."
    )
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
