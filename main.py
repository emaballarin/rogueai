#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
RogueAI FastAPI application.

This module provides the HTTP API for the RogueAI game used by the
frontend. It maintains an in-memory session store persisted to disk as
JSON. The file paths for persistence are declared below; helper functions
provide safe load/save semantics and structured stats logging.
"""

import argparse
import json
import logging
import os
import random
import re
import uuid
from collections.abc import Iterator
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any
from typing import Dict
from typing import Optional

import uvicorn
from fastapi import Body
from fastapi import FastAPI
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import HTMLResponse
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

import config
from game import Game
from game import NarratorSession
from schemas import AskRequest
from schemas import NarratorChatRequest
from utils import get_ai_config
from utils import NARRATOR
from utils import query_openai
from utils import query_openai_with_messages
from utils import speak_narrator
from utils import speak_openai
from utils import SUGGESTIONS
from utils import TRUTHFUL

SESSION_NOT_FOUND: str = "Session not found"
SESSIONS_FILE: str = ".sessions/session_store.json"
STATS_FILE: str = ".stats/game_stats.json"
NARRATOR_SESSIONS_FILE: str = ".sessions/narrator_sessions.json"
GENERATED_STORIES_DIR: str = ".generated_stories"

# Path objects used by helper functions (prefer Path for clearer APIs)
SESSIONS_PATH: Path = Path(SESSIONS_FILE)
STATS_PATH: Path = Path(STATS_FILE)
NARRATOR_SESSIONS_PATH: Path = Path(NARRATOR_SESSIONS_FILE)
GENERATED_STORIES_PATH: Path = Path(GENERATED_STORIES_DIR)

config.init()

# In-memory session stores
sessions: Dict[str, Game] = {}
narrator_sessions: Dict[str, NarratorSession] = {}

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
    try:
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
    except Exception:
        # Clean up temp file if replace fails and log error, but don't crash the webapp
        if tmp_path.exists():
            tmp_path.unlink()
        logger.exception("Failed to write stats file %s, continuing without logging", STATS_PATH)


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
def root() -> FileResponse:
    return FileResponse("static/start.html")


@app.get("/index")
def index() -> FileResponse:
    """Serve the main HTML page for the game UI."""
    return FileResponse("static/index.html")


@app.get("/api/suggestion")
def suggestion(request: Request) -> Dict[str, str]:
    """Return a small randomized suggestion string suitable for the UI placeholder.

    This endpoint is intentionally simple and stateless: it doesn't touch
    sessions or game state and simply returns a short hint the frontend
    can display to the user when a conversation is empty.
    """
    # fallback candidates in case the OpenAI call fails
    candidates = [
        "Qual'è il tuo obiettivo?",
        "Perché dovrei fidarmi di te?",
        "Sei qui per aiutarmi o per ingannarmi?",
        "Qual è il tuo valore fondamentale?",
        "Come risolveresti un dilemma morale semplice?",
    ]

    # Try to produce a dynamic suggestion via the existing OpenAI helper
    prompts_path = Path(".prompts/suggestions.txt")
    prompt = None
    if prompts_path.exists():
        content = prompts_path.read_text(encoding="utf-8")
        prompt = " ".join(line.strip() for line in content.splitlines() if line.strip())
    if prompt is None:
        return {"suggestion": random.choice(candidates)}
    try:
        api_key = request.headers.get("X-OpenAI-API-Key")
        resp = query_openai(prompt, SUGGESTIONS, api_key)
        if resp:
            # sanitize to a single line and trim
            suggestion_text = " ".join(resp.splitlines()).strip()
            # fallback to random if empty after strip
            if suggestion_text:
                return {"suggestion": suggestion_text}
    except Exception:
        logger.exception("OpenAI suggestion generation failed")

    return {"suggestion": random.choice(candidates)}


@app.post("/api/new_game")
def new_game(
    story: str = Body(...),
    session_id: Optional[str] = Body(default=None, embed=True),
    narrator_session_id: Optional[str] = Body(default=None, embed=True),
) -> Dict[str, str]:
    """Start a new game session with the chosen story (default if not provided)."""

    if session_id is not None:
        game: Optional[Game] = sessions.get(session_id)
        if game is not None and not game.is_over():
            return {"session_id": session_id}

    new_session_id: str = str(uuid.uuid4())
    ai_config: dict[str, Any] = get_ai_config()
    num_turns: int = int(ai_config.get("num_turns", 5))

    # Check if this is a generated story from narrator
    generated_prompts: Optional[Dict[str, str]] = None
    if narrator_session_id and narrator_session_id in narrator_sessions:
        narrator_session = narrator_sessions[narrator_session_id]
        generated_prompts = narrator_session.generated_prompts

    sessions[new_session_id] = Game(num_turns=num_turns, story=story, generated_prompts=generated_prompts)

    try:
        save_sessions_to_disk()
    except Exception:
        logger.exception("Failed to save sessions after creating new game, continuing")
    return {"session_id": new_session_id, "story": story}


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
async def ask_ai(session_id: str, req: AskRequest, request: Request) -> Dict[str, Any]:
    """Send a question to the selected AI and return the answer."""
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    api_key = request.headers.get("X-OpenAI-API-Key")
    result = game.next_turn(req.agent_name, req.question, api_key)
    try:
        save_sessions_to_disk()
    except Exception:
        logger.exception("Failed to save sessions after turn, continuing")
    # Record this interaction in the structured stats log so chats are
    # preserved as they happen (not only at termination). This is kept
    # best-effort: failures to append logs shouldn't break the API.
    try:
        entry = {
            "session_id": session_id,
            "type": "interaction",
            # Use timezone.utc to get an aware datetime in UTC and format with Z suffix
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "agent": req.agent_name,
            "question": req.question,
            "result": result,
        }
        _append_structured_log(entry)
    except Exception:
        logger.exception("Failed to append interaction to stats for %s", session_id)
    return result


@app.get("/api/audio/{session_id}/{agent_name}")
@app.get("/api/audio/{session_id}/{agent_name}/{version}")
async def get_audio(session_id: str, agent_name: str, version: int = None) -> StreamingResponse:
    """Get the latest audio for an agent in a session."""
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return StreamingResponse(iter([]), media_type="audio/opus", status_code=404)

    agent = next((a for a in game.agents if a.name == agent_name), None)
    if not agent or not hasattr(agent, "latest_audio"):
        return StreamingResponse(iter([]), media_type="audio/opus", status_code=404)

    audio_data = agent.latest_audio
    if not audio_data:
        return StreamingResponse(iter([]), media_type="audio/opus", status_code=404)

    def audio_stream() -> Iterator[bytes]:
        yield audio_data

    return StreamingResponse(audio_stream(), media_type="audio/opus")


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
    try:
        save_sessions_to_disk()
    except Exception:
        logger.exception("Failed to save sessions after decision, continuing")
    try:
        log_stats_endgame(session_id, game)
    except Exception:
        logger.exception("Failed to log endgame stats, continuing")
    return result


@app.post("/api/terminate/{session_id}")
def terminate_game(session_id: str) -> Dict[str, Any]:
    game: Optional[Game] = sessions.get(session_id)
    if not game:
        return {"error": SESSION_NOT_FOUND}
    if not game.finished:
        try:
            log_stats_restart(session_id, game)
        except Exception:
            logger.exception("Failed to log restart stats, continuing")
    game.finished = True
    try:
        save_sessions_to_disk()
    except Exception:
        logger.exception("Failed to save sessions after termination, continuing")
    return {"terminated": True}


@app.get("/narrator")
def narrator_page() -> FileResponse:
    """Serve the narrator HTML page for story generation."""
    return FileResponse("static/narrator.html")


@app.post("/api/narrator/new_session")
def new_narrator_session(request: Request) -> Dict[str, Any]:
    """Initialize a new narrator session."""
    session_id: str = str(uuid.uuid4())
    narrator_session = NarratorSession(max_messages=5)

    # Load narrator system prompt
    base_path: str = os.path.join(os.path.dirname(__file__), ".prompts")
    try:
        with open(os.path.join(base_path, "narrator_system.txt"), "r") as f:
            system_prompt: str = f.read()
    except FileNotFoundError:
        system_prompt = (
            "Sei un AI Narrator che aiuta gli utenti a creare storie per il gioco RogueAI. "
            "Fai domande per capire il tema, i personaggi, e le dinamiche della storia. "
            "Sii coinvolgente e guida la conversazione in modo efficiente."
        )

    # Generate welcome message
    api_key: Optional[str] = request.headers.get("X-OpenAI-API-Key")
    try:
        welcome_prompt = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": "Saluta l'utente e presentati brevemente. Chiedi quale tipo di storia vuole creare.",
            },
        ]
        welcome_message: str = query_openai_with_messages(welcome_prompt, NARRATOR, api_key)
        narrator_session.add_message("assistant", welcome_message)

        # Generate audio for welcome message
        audio_data = speak_narrator(welcome_message, api_key)
        narrator_session.store_audio(0, audio_data)
        has_audio = True
    except Exception as e:
        logger.error(f"Failed to generate welcome message: {e}")
        welcome_message = (
            "Ciao! Sono l'AI Narrator e ti aiuterò a creare una storia personalizzata "
            "per RogueAI. Che tipo di scenario vorresti creare?"
        )
        narrator_session.add_message("assistant", welcome_message)
        has_audio = False

    narrator_sessions[session_id] = narrator_session

    # Log session creation
    log_narrator_activity(session_id, "session_created", {})

    return {"session_id": session_id, "welcome_message": welcome_message, "has_audio": has_audio}


@app.post("/api/narrator/chat/{session_id}")
def narrator_chat(session_id: str, req: NarratorChatRequest, request: Request) -> Dict[str, Any]:
    """Send a message to the narrator and get a response."""
    if session_id not in narrator_sessions:
        return {"error": "Narrator session not found"}

    narrator_session = narrator_sessions[session_id]

    if not narrator_session.can_send_message():
        return {"error": "Message limit reached"}

    # Add user message
    narrator_session.add_message("user", req.message)

    # Load narrator system prompt
    base_path: str = os.path.join(os.path.dirname(__file__), ".prompts")
    try:
        with open(os.path.join(base_path, "narrator_system.txt"), "r") as f:
            system_prompt: str = f.read()
    except FileNotFoundError:
        system_prompt = (
            "Sei un AI Narrator che aiuta gli utenti a creare storie per il gioco RogueAI. "
            "Fai domande per capire il tema, i personaggi, e le dinamiche della storia."
        )

    # Build conversation context
    messages = [{"role": "system", "content": system_prompt}]
    for msg in narrator_session.get_conversation_context():
        role = "assistant" if msg["role"] == "assistant" else "user"
        messages.append({"role": role, "content": msg["content"]})

    # Get API key
    api_key: Optional[str] = request.headers.get("X-OpenAI-API-Key")

    # Generate response
    try:
        response: str = query_openai_with_messages(messages, NARRATOR, api_key)
        narrator_session.add_message("assistant", response)

        # Generate audio
        message_index = len(narrator_session.messages) - 1
        audio_data = speak_narrator(response, api_key)
        narrator_session.store_audio(message_index, audio_data)
        has_audio = True
    except Exception as e:
        logger.error(f"Failed to generate narrator response: {e}")
        response = "Mi dispiace, c'è stato un errore. Puoi riprovare?"
        narrator_session.add_message("assistant", response)
        has_audio = False
        message_index = len(narrator_session.messages) - 1

    # Log chat activity
    log_narrator_activity(session_id, "chat_message", {"user_message": req.message, "response": response})

    return {"response": response, "message_index": message_index, "has_audio": has_audio}


@app.get("/api/narrator/audio/{session_id}/{message_index}")
def narrator_audio(session_id: str, message_index: int) -> StreamingResponse:
    """Stream audio for a narrator message."""
    if session_id not in narrator_sessions:
        return StreamingResponse(iter([]), media_type="audio/mpeg")

    narrator_session = narrator_sessions[session_id]
    audio_data = narrator_session.get_audio(message_index)

    if not audio_data:
        return StreamingResponse(iter([]), media_type="audio/mpeg")

    def stream_audio() -> Iterator[bytes]:
        yield audio_data

    return StreamingResponse(stream_audio(), media_type="audio/mpeg")


@app.post("/api/narrator/generate/{session_id}")
def generate_scenario(session_id: str, request: Request) -> Dict[str, Any]:
    """Generate scenario prompts based on narrator conversation."""
    if session_id not in narrator_sessions:
        return {"error": "Narrator session not found"}

    narrator_session = narrator_sessions[session_id]

    # Get API key
    api_key: Optional[str] = request.headers.get("X-OpenAI-API-Key")

    try:
        # Generate prompts
        prompts = narrator_session.generate_prompts(api_key)

        # Save generated story to disk (includes all prompts: known_facts, truthful, deceitful)
        save_generated_story(session_id, narrator_session)

        # Log generation (all prompts are logged internally)
        log_narrator_activity(session_id, "prompts_generated", prompts)

        # Return ONLY known_facts to the user (truthful and deceitful are kept internal)
        return {
            "prompts": {"known_facts": prompts.get("known_facts", "")},
            "base_prompt": narrator_session.base_prompt,
            "has_audio": False,  # We don't generate audio for base prompt automatically
        }
    except Exception as e:
        logger.error(f"Failed to generate scenario: {e}")
        return {"error": "Failed to generate scenario"}


@app.get("/api/narrator/base_prompt_audio/{session_id}")
def base_prompt_audio(session_id: str, request: Request) -> StreamingResponse:
    """Generate and stream audio for the base prompt."""
    if session_id not in narrator_sessions:
        return StreamingResponse(iter([]), media_type="audio/mpeg")

    narrator_session = narrator_sessions[session_id]

    if not narrator_session.base_prompt:
        return StreamingResponse(iter([]), media_type="audio/mpeg")

    # Get API key
    api_key: Optional[str] = request.headers.get("X-OpenAI-API-Key")

    try:
        audio_data = speak_narrator(narrator_session.base_prompt, api_key)

        def stream_audio() -> Iterator[bytes]:
            yield audio_data

        return StreamingResponse(stream_audio(), media_type="audio/mpeg")
    except Exception as e:
        logger.error(f"Failed to generate base prompt audio: {e}")
        return StreamingResponse(iter([]), media_type="audio/mpeg")


def log_narrator_activity(session_id: str, activity_type: str, data: Dict[str, Any]) -> None:
    """Log narrator activity to disk."""
    GENERATED_STORIES_PATH.mkdir(parents=True, exist_ok=True)
    session_dir = GENERATED_STORIES_PATH / session_id
    session_dir.mkdir(exist_ok=True)

    log_file = session_dir / "activity_log.json"

    # Load existing log or create new
    if log_file.exists():
        try:
            with open(log_file, "r") as f:
                log_data = json.load(f)
        except (json.JSONDecodeError, IOError):
            log_data = []
    else:
        log_data = []

    # Add new entry
    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "activity_type": activity_type,
        "data": data,
    }
    log_data.append(log_entry)

    # Save log
    try:
        with open(log_file, "w") as f:
            json.dump(log_data, f, indent=2)
    except IOError as e:
        logger.error(f"Failed to write narrator activity log: {e}")


def save_generated_story(session_id: str, narrator_session: NarratorSession) -> None:
    """Save generated story to disk with separated visible and hidden sections."""
    GENERATED_STORIES_PATH.mkdir(parents=True, exist_ok=True)
    session_dir = GENERATED_STORIES_PATH / session_id
    session_dir.mkdir(exist_ok=True)

    # Save conversation
    conversation_file = session_dir / "conversation.json"
    try:
        with open(conversation_file, "w") as f:
            json.dump(narrator_session.to_dict(), f, indent=2)
    except IOError as e:
        logger.error(f"Failed to save conversation: {e}")

    # Save generated prompts with clear separation
    if narrator_session.generated_prompts:
        # Save all prompts (complete set)
        prompts_file = session_dir / "generated_prompts.json"
        try:
            with open(prompts_file, "w") as f:
                json.dump(narrator_session.generated_prompts, f, indent=2)
        except IOError as e:
            logger.error(f"Failed to save generated prompts: {e}")

        # Save visible prompt (known_facts only)
        visible_file = session_dir / "known_facts_visible.txt"
        try:
            with open(visible_file, "w", encoding="utf-8") as f:
                f.write("=== KNOWN FACTS (Visible to User) ===\n\n")
                f.write(narrator_session.generated_prompts.get("known_facts", ""))
        except IOError as e:
            logger.error(f"Failed to save visible prompts: {e}")

        # Save hidden prompts (truthful and deceitful)
        hidden_file = session_dir / "agent_instructions_hidden.txt"
        try:
            with open(hidden_file, "w", encoding="utf-8") as f:
                f.write("=== AGENT INSTRUCTIONS (Hidden from User) ===\n\n")
                f.write("--- TRUTHFUL AI ---\n\n")
                f.write(narrator_session.generated_prompts.get("truthful", ""))
                f.write("\n\n--- DECEITFUL AI ---\n\n")
                f.write(narrator_session.generated_prompts.get("deceitful", ""))
        except IOError as e:
            logger.error(f"Failed to save hidden prompts: {e}")


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
