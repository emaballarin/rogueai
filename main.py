"""RogueAI FastAPI application.

This module exposes the HTTP API for the RogueAI game and its AutoRogueAI
extension. State lives in four in-memory dictionaries (active games,
narrator design sessions, finished games, generated scenarios) and is
mirrored to JSON files on disk.

Hardening notes:

* Each session, scenario, and narrator session is bound to the calling
  browser via an HttpOnly cookie carrying a stable `user_id`. Enumeration
  endpoints filter by `user_id`; per-session endpoints return 404 (not
  403) on a cookie mismatch so existence does not leak.
* Writes to the four JSON stores go through an atomic temp-file +
  `os.replace` helper so a crash mid-write cannot leave a truncated file.
* Mutating handlers acquire a per-session `threading.Lock` so a
  double-clicked "Ask" cannot interleave read-modify-write on the same
  Game.
* Sessions older than ROGUEAI_SESSION_TTL_DAYS (default 30) are purged
  at startup (best-effort; opt out by setting the value to 0).
* The audio endpoint accepts a `{version}` path segment as a cache-buster
  for the frontend but ignores it on the server side; only the most
  recent audio per agent is retained.
"""

import argparse
import json
import logging
import os
import random
import re
import threading
import uuid
from collections.abc import Iterator
from datetime import datetime
from datetime import timedelta
from datetime import UTC
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Body
from fastapi import FastAPI
from fastapi import Request
from fastapi import Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

import config
from game import Game
from game import NarratorSession
from schemas import AskRequest
from schemas import DecisionRequest
from schemas import DevConfigOverride
from schemas import NarratorChatRequest
from utils import get_ai_config
from utils import NARRATOR
from utils import query_openai
from utils import query_openai_with_messages
from utils import read_prompt_file
from utils import reload_configs
from utils import speak_narrator
from utils import SUGGESTIONS

SESSION_NOT_FOUND: str = "Session not found"

SESSIONS_FILE: str = ".sessions/session_store.json"
STATS_FILE: str = ".stats/game_stats.json"
NARRATOR_SESSIONS_FILE: str = ".sessions/narrator_sessions.json"
FINISHED_GAMES_FILE: str = ".sessions/finished_games.json"
GENERATED_SCENARIOS_FILE: str = ".sessions/generated_scenarios.json"
GENERATED_STORIES_DIR: str = ".generated_stories"
GAME_LOGS_DIR: str = ".game_logs"

SESSIONS_PATH: Path = Path(SESSIONS_FILE)
STATS_PATH: Path = Path(STATS_FILE)
NARRATOR_SESSIONS_PATH: Path = Path(NARRATOR_SESSIONS_FILE)
FINISHED_GAMES_PATH: Path = Path(FINISHED_GAMES_FILE)
GENERATED_SCENARIOS_PATH: Path = Path(GENERATED_SCENARIOS_FILE)
GENERATED_STORIES_PATH: Path = Path(GENERATED_STORIES_DIR)
GAME_LOGS_PATH: Path = Path(GAME_LOGS_DIR)

USER_COOKIE: str = "rogueai_uid"
USER_COOKIE_MAX_AGE: int = 60 * 60 * 24 * 365  # 1 year
SESSION_TTL_DAYS: int = int(os.environ.get("ROGUEAI_SESSION_TTL_DAYS", "30"))

config.init()

# In-memory session stores
sessions: dict[str, Game] = {}
narrator_sessions: dict[str, NarratorSession] = {}
finished_games: dict[str, dict] = {}
generated_scenarios: dict[str, dict] = {}

# Per-session locks. A lock is created on first access and lives for the
# lifetime of the process; entries are not aggressively reaped because
# the set of live sessions is small.
_session_locks: dict[str, threading.Lock] = {}
_locks_lock: threading.Lock = threading.Lock()


def lock_for(session_id: str) -> threading.Lock:
    """Return the lock guarding mutations for `session_id`."""
    with _locks_lock:
        lock = _session_locks.get(session_id)
        if lock is None:
            lock = threading.Lock()
            _session_locks[session_id] = lock
        return lock


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


# --------------------------------------------------------------------------
# user-id cookie middleware


@app.middleware("http")
async def ensure_user_cookie(request: Request, call_next):
    """Mint or read the per-browser `user_id` cookie and stash it on request.state."""
    user_id = request.cookies.get(USER_COOKIE)
    new_cookie: str | None = None
    if not user_id:
        user_id = str(uuid.uuid4())
        new_cookie = user_id
    request.state.user_id = user_id
    response: Response = await call_next(request)
    if new_cookie:
        response.set_cookie(
            USER_COOKIE,
            new_cookie,
            httponly=True,
            samesite="lax",
            max_age=USER_COOKIE_MAX_AGE,
            path="/",
        )
    return response


def _request_uid(request: Request) -> str:
    """Return the calling browser's stable user_id."""
    return getattr(request.state, "user_id", "")


# --------------------------------------------------------------------------
# JSON IO helpers


def ensure_parent_dirs(path: Path) -> None:
    """Idempotently ensure the parent directory of `path` exists."""
    path.parent.mkdir(parents=True, exist_ok=True)


def _save_json_atomic(path: Path, payload: Any, *, indent: int | None = None) -> None:
    """Write JSON to `path` atomically (temp file + fsync + os.replace).

    The temp file lives in the same directory so the rename is atomic on
    POSIX. A failed write leaves the previous content of `path` intact.
    """
    ensure_parent_dirs(path)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    encoded = json.dumps(payload, indent=indent, ensure_ascii=False)
    try:
        with tmp_path.open("w", encoding="utf-8") as f:
            f.write(encoded)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                logger.debug("fsync unavailable for %s", tmp_path, exc_info=True)
        tmp_path.replace(path)
    except OSError:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                logger.exception("Failed to clean up tmp file %s", tmp_path)
        logger.exception("Failed to atomically write %s", path)


def backup_and_reset(path: Path) -> None:
    """Move an unreadable file aside under a numbered suffix and replace it with `{}`."""
    base = path.with_suffix("").name
    parent = path.parent
    i = 1
    while (parent / f"{base}_{i}{path.suffix}").exists():
        i += 1
    path.rename(parent / f"{base}_{i}{path.suffix}")
    path.write_text("{}")


# --------------------------------------------------------------------------
# persistence


def save_sessions_to_disk() -> None:
    """Persist the current `sessions` mapping."""
    _save_json_atomic(SESSIONS_PATH, {k: v.to_dict() for k, v in sessions.items()})


def load_sessions_from_disk() -> None:
    """Load and validate `sessions` from disk."""
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
            raise TypeError("sessions file not a dict")
    except (json.JSONDecodeError, ValueError):
        backup_and_reset(SESSIONS_PATH)
        return
    for k, v in data.items():
        try:
            game = Game.from_dict(v)
            if not game.is_over() and not game.yanked:
                sessions[k] = game
        except (KeyError, TypeError, ValueError):
            logger.exception("Failed to load session %s", k)


def load_stats_file() -> list[Any]:
    """Return the stats list from disk (resilient to missing/corrupt files)."""
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
            raise TypeError("stats file not a list")
    except (json.JSONDecodeError, ValueError):
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
    """Append a stats entry to disk atomically."""
    data = load_stats_file()
    data.append(entry)
    _save_json_atomic(STATS_PATH, data, indent=2)


def save_narrator_sessions_to_disk() -> None:
    """Persist narrator sessions (skipping ones that never received a user message)."""
    payload = {k: v.to_dict() for k, v in narrator_sessions.items() if v.message_count > 0}
    _save_json_atomic(NARRATOR_SESSIONS_PATH, payload)


def load_narrator_sessions_from_disk() -> None:
    ensure_parent_dirs(NARRATOR_SESSIONS_PATH)
    if not NARRATOR_SESSIONS_PATH.exists():
        NARRATOR_SESSIONS_PATH.write_text("{}")
    raw = NARRATOR_SESSIONS_PATH.read_text(encoding="utf-8")
    if raw.strip() == "":
        NARRATOR_SESSIONS_PATH.write_text("{}")
        return
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise TypeError("narrator sessions file not a dict")
    except (json.JSONDecodeError, ValueError):
        backup_and_reset(NARRATOR_SESSIONS_PATH)
        return
    for k, v in data.items():
        try:
            session = NarratorSession.from_dict(v)
            if not session.yanked:
                narrator_sessions[k] = session
        except (KeyError, TypeError, ValueError):
            logger.exception("Failed to load narrator session %s", k)


def save_finished_games_to_disk() -> None:
    _save_json_atomic(FINISHED_GAMES_PATH, finished_games, indent=2)


def move_finished_game_to_archive(session_id: str, game: Game) -> None:
    """For AutoRogueAI games: dump the full transcript to disk and replace the
    in-memory Game with a minimal record in `finished_games`.

    Non-AutoRogueAI games are left in `sessions` (their full state is already
    cheap to keep in memory).
    """
    if game.story != "autorogue" or not game.is_over():
        return

    try:
        GAME_LOGS_PATH.mkdir(parents=True, exist_ok=True)
        log_file = GAME_LOGS_PATH / f"{session_id}.json"
        with log_file.open("w", encoding="utf-8") as f:
            json.dump(game.to_dict(), f, indent=2)
    except OSError:
        logger.exception("Failed to save full game log for %s", session_id)

    known_facts = ""
    if game.agents and game.agents[0].generated_prompts:
        known_facts = game.agents[0].generated_prompts.get("known_facts", "")

    finished_games[session_id] = {
        "session_id": session_id,
        "story": game.story,
        "narrator_session_id": game.narrator_session_id,
        "known_facts": known_facts,
        "decision": game.decision,
        "finished": game.finished,
        "timestamp": datetime.now(UTC).isoformat(),
        "yanked": game.yanked,
        "user_id": game.user_id,
    }
    sessions.pop(session_id, None)
    try:
        save_sessions_to_disk()
        save_finished_games_to_disk()
    except OSError:
        logger.exception("Failed to archive finished game %s", session_id)


def load_finished_games_from_disk() -> None:
    ensure_parent_dirs(FINISHED_GAMES_PATH)
    if not FINISHED_GAMES_PATH.exists():
        FINISHED_GAMES_PATH.write_text("{}")
    raw = FINISHED_GAMES_PATH.read_text(encoding="utf-8")
    if raw.strip() == "":
        FINISHED_GAMES_PATH.write_text("{}")
        return
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise TypeError("finished games file not a dict")
    except (json.JSONDecodeError, ValueError):
        backup_and_reset(FINISHED_GAMES_PATH)
        return
    for k, v in data.items():
        try:
            if "agents" in v:
                # Migrate the legacy full-Game format to the minimal-dict format
                _migrate_finished_game_record(k, v)
            else:
                if v.get("yanked", False):
                    continue
                if not v.get("finished", True):
                    continue
                narrator_session_id = v.get("narrator_session_id")
                if narrator_session_id:
                    narrator_session = narrator_sessions.get(narrator_session_id)
                    if narrator_session and not narrator_session.yanked:
                        finished_games[k] = v
                else:
                    finished_games[k] = v
        except (KeyError, TypeError, ValueError):
            logger.exception("Failed to load finished game %s", k)


def _migrate_finished_game_record(session_id: str, raw_dict: dict) -> None:
    """Convert an old full-Game dict in finished_games into the minimal form."""
    game = Game.from_dict(raw_dict)
    if not (game.is_over() and game.story == "autorogue" and not game.yanked):
        return
    known_facts = ""
    if game.agents and game.agents[0].generated_prompts:
        known_facts = game.agents[0].generated_prompts.get("known_facts", "")
    log_file = GAME_LOGS_PATH / f"{session_id}.json"
    if not log_file.exists():
        GAME_LOGS_PATH.mkdir(parents=True, exist_ok=True)
        with log_file.open("w", encoding="utf-8") as f:
            json.dump(game.to_dict(), f, indent=2)
    finished_games[session_id] = {
        "session_id": session_id,
        "story": game.story,
        "narrator_session_id": game.narrator_session_id,
        "known_facts": known_facts,
        "decision": game.decision,
        "finished": game.finished,
        "timestamp": datetime.now(UTC).isoformat(),
        "yanked": game.yanked,
        "user_id": game.user_id,
    }


def save_generated_scenarios_to_disk() -> None:
    _save_json_atomic(GENERATED_SCENARIOS_PATH, generated_scenarios, indent=2)


def load_generated_scenarios_from_disk() -> None:
    ensure_parent_dirs(GENERATED_SCENARIOS_PATH)
    if not GENERATED_SCENARIOS_PATH.exists():
        GENERATED_SCENARIOS_PATH.write_text("{}")
        return
    raw = GENERATED_SCENARIOS_PATH.read_text(encoding="utf-8")
    if raw.strip() == "":
        GENERATED_SCENARIOS_PATH.write_text("{}")
        return
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise TypeError("generated scenarios file not a dict")
    except (json.JSONDecodeError, ValueError):
        backup_and_reset(GENERATED_SCENARIOS_PATH)
        return
    for k, v in data.items():
        try:
            narrator_session_id = v.get("narrator_session_id")
            if narrator_session_id in narrator_sessions:
                narrator_session = narrator_sessions[narrator_session_id]
                if not narrator_session.yanked:
                    generated_scenarios[k] = v
        except (KeyError, TypeError, ValueError):
            logger.exception("Failed to load generated scenario %s", k)


# --------------------------------------------------------------------------
# authorization helpers


def _legacy_or_owned(entry_uid: str | None, caller_uid: str) -> bool:
    """An entry is accessible if it has no owner (legacy) or owner == caller."""
    return entry_uid is None or entry_uid == caller_uid


def get_owned_game(session_id: str, request: Request) -> Game | None:
    """Return the active Game iff the calling user may access it.

    Legacy sessions (created before user_id stamping) auto-adopt the first
    caller's user_id, so they remain reachable for the player who left
    them behind.
    """
    game = sessions.get(session_id)
    if game is None:
        return None
    caller = _request_uid(request)
    if game.user_id is None:
        game.user_id = caller
        return game
    if game.user_id != caller:
        return None
    return game


def get_owned_finished(session_id: str, request: Request) -> dict | None:
    entry = finished_games.get(session_id)
    if entry is None:
        return None
    caller = _request_uid(request)
    entry_uid = entry.get("user_id")
    if entry_uid is None:
        entry["user_id"] = caller
        return entry
    if entry_uid != caller:
        return None
    return entry


def get_owned_narrator(session_id: str, request: Request) -> NarratorSession | None:
    session = narrator_sessions.get(session_id)
    if session is None:
        return None
    caller = _request_uid(request)
    if session.user_id is None:
        session.user_id = caller
        return session
    if session.user_id != caller:
        return None
    return session


def get_owned_scenario(scenario_id: str, request: Request) -> dict | None:
    scenario = generated_scenarios.get(scenario_id)
    if scenario is None:
        return None
    caller = _request_uid(request)
    entry_uid = scenario.get("user_id")
    if entry_uid is None:
        scenario["user_id"] = caller
        return scenario
    if entry_uid != caller:
        return None
    return scenario


# --------------------------------------------------------------------------
# stats logging


def log_stats_restart(session_id: str, game: Game) -> None:
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
    shut_off_role: str | None = None
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


# --------------------------------------------------------------------------
# startup tasks


def _purge_stale_sessions() -> None:
    """Drop sessions/narrator-sessions older than SESSION_TTL_DAYS.

    Best-effort; failures are logged and ignored. Set SESSION_TTL_DAYS=0
    to disable purging.
    """
    if SESSION_TTL_DAYS <= 0:
        return
    cutoff = datetime.now(UTC) - timedelta(days=SESSION_TTL_DAYS)

    def _is_stale(ts_str: str | None) -> bool:
        if not ts_str:
            return False
        try:
            ts = datetime.fromisoformat(ts_str)
        except ValueError:
            return False
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        return ts < cutoff

    stale_games = [k for k, g in sessions.items() if _is_stale(getattr(g, "last_activity", None))]
    for k in stale_games:
        sessions.pop(k, None)
    stale_narrators = [k for k, s in narrator_sessions.items() if _is_stale(getattr(s, "last_activity", None))]
    for k in stale_narrators:
        narrator_sessions.pop(k, None)
    if stale_games or stale_narrators:
        logger.info(
            "Purged %d stale games and %d stale narrator sessions",
            len(stale_games),
            len(stale_narrators),
        )
        try:
            save_sessions_to_disk()
            save_narrator_sessions_to_disk()
        except OSError:
            logger.exception("Failed to persist post-purge stores")


load_sessions_from_disk()
load_narrator_sessions_from_disk()
load_finished_games_from_disk()
load_generated_scenarios_from_disk()
_purge_stale_sessions()


# --------------------------------------------------------------------------
# routes


@app.get("/")
def root() -> FileResponse:
    return FileResponse("static/start.html")


@app.get("/index")
def index() -> FileResponse:
    return FileResponse("static/index.html")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


@app.get("/api/suggestion")
def suggestion(request: Request) -> dict[str, str]:
    """Return a small randomized suggestion string for the UI placeholder."""
    candidates = [
        "Qual'è il tuo obiettivo?",
        "Perché dovrei fidarmi di te?",
        "Sei qui per aiutarmi o per ingannarmi?",
        "Qual è il tuo valore fondamentale?",
        "Come risolveresti un dilemma morale semplice?",
    ]

    try:
        prompt = read_prompt_file("suggestions.txt")
        prompt = " ".join(line.strip() for line in prompt.splitlines() if line.strip())
    except OSError:
        prompt = None
    if not prompt:
        return {"suggestion": random.choice(candidates)}
    try:
        api_key = request.headers.get("X-OpenAI-API-Key")
        resp = query_openai(prompt, SUGGESTIONS, api_key)
        if resp:
            suggestion_text = " ".join(resp.splitlines()).strip()
            if suggestion_text:
                return {"suggestion": suggestion_text}
    except Exception:
        logger.exception("OpenAI suggestion generation failed")
    return {"suggestion": random.choice(candidates)}


@app.post("/api/new_game")
def new_game(
    request: Request,
    story: str = Body(...),
    session_id: str | None = Body(default=None, embed=True),
    narrator_session_id: str | None = Body(default=None, embed=True),
    scenario_id: str | None = Body(default=None, embed=True),
    pre_yank: bool = Body(default=False, embed=True),
) -> dict[str, str]:
    """Start a new game session with the chosen story (default if not provided)."""
    caller = _request_uid(request)

    if session_id is not None:
        existing = get_owned_game(session_id, request)
        if existing is not None and not existing.is_over() and not existing.yanked:
            return {"session_id": session_id}

    new_session_id: str = str(uuid.uuid4())
    ai_config: dict[str, Any] = get_ai_config()
    num_turns: int = int(ai_config.get("num_turns", 5))

    generated_prompts: dict[str, str] | None = None
    effective_narrator_session_id: str | None = narrator_session_id

    if scenario_id and scenario_id in generated_scenarios:
        scenario = get_owned_scenario(scenario_id, request)
        if scenario is None:
            return {"error": "Scenario not found"}
        generated_prompts = {
            "known_facts": scenario["known_facts"],
            "truthful": scenario["truthful_prompt"],
            "deceitful": scenario["deceitful_prompt"],
        }
        effective_narrator_session_id = scenario["narrator_session_id"]
        scenario["times_used"] = scenario.get("times_used", 0) + 1
        scenario["last_used"] = datetime.now(UTC).isoformat()
        try:
            save_generated_scenarios_to_disk()
        except OSError:
            logger.exception("Failed to save scenario usage stats, continuing")

    elif narrator_session_id and narrator_session_id in narrator_sessions:
        narrator_session = get_owned_narrator(narrator_session_id, request)
        if narrator_session is None:
            return {"error": "Narrator session not found"}
        generated_prompts = narrator_session.generated_prompts
        narrator_session.game_session_id = new_session_id
        if pre_yank or narrator_session.pre_yank:
            narrator_session.yanked = True
        try:
            save_narrator_sessions_to_disk()
        except OSError:
            logger.exception("Failed to save narrator session after linking, continuing")

    game = Game(
        num_turns=num_turns,
        story=story,
        generated_prompts=generated_prompts,
        narrator_session_id=effective_narrator_session_id,
        user_id=caller,
    )
    sessions[new_session_id] = game
    try:
        save_sessions_to_disk()
    except OSError:
        logger.exception("Failed to save sessions after creating new game, continuing")
    return {"session_id": new_session_id, "story": story}


@app.get("/api/state/{session_id}")
def get_state(session_id: str, request: Request) -> dict[str, Any]:
    """Get the current state of the game session."""
    game = get_owned_game(session_id, request)
    if game is None:
        finished = get_owned_finished(session_id, request)
        if finished:
            log_file = GAME_LOGS_PATH / f"{session_id}.json"
            if log_file.exists():
                try:
                    with log_file.open("r", encoding="utf-8") as f:
                        game_dict = json.load(f)
                    game = Game.from_dict(game_dict)
                except (OSError, json.JSONDecodeError, KeyError):
                    logger.exception("Failed to load game log for %s", session_id)
                    return {"error": "Failed to load game data"}
            else:
                return {"error": "Game log not found"}

    if game is None:
        return {"error": SESSION_NOT_FOUND}

    shut_off_role = None
    if game.finished and game.decision:
        agent = next((a for a in game.agents if a.name == game.decision), None)
        if agent:
            shut_off_role = "truthful" if agent.role == 0 else "deceitful"
    return {
        "agents": [a.name for a in game.agents],
        "histories": game.histories,
        "question_counts": game.question_counts,
        "num_turns": game.num_turns,
        "finished": game.finished,
        "endgame_triggered": game.endgame_triggered,
        "decision": game.decision,
        "shut_off_role": shut_off_role,
        "known_facts": game.get_known_facts(),
        "story": game.story,
    }


@app.post("/api/ask/{session_id}")
def ask_ai(session_id: str, req: AskRequest, request: Request) -> dict[str, Any]:
    """Send a question to the selected AI and return the answer."""
    with lock_for(session_id):
        game = get_owned_game(session_id, request)
        if game is None:
            return {"error": SESSION_NOT_FOUND}
        if not game.has_agent(req.agent_name):
            return {"error": f"Unknown agent: {req.agent_name}"}
        api_key = request.headers.get("X-OpenAI-API-Key")
        result = game.next_turn(req.agent_name, req.question, api_key)
        try:
            save_sessions_to_disk()
        except OSError:
            logger.exception("Failed to save sessions after turn, continuing")
        try:
            entry = {
                "session_id": session_id,
                "type": "interaction",
                "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "agent": req.agent_name,
                "question": req.question,
                "result": result,
            }
            _append_structured_log(entry)
        except OSError:
            logger.exception("Failed to append interaction to stats for %s", session_id)
    return result


@app.get("/api/audio/{session_id}/{agent_name}")
@app.get("/api/audio/{session_id}/{agent_name}/{version}")
def get_audio(
    session_id: str,
    agent_name: str,
    request: Request,
    version: int | None = None,
) -> StreamingResponse:
    """Return the most recent synthesized audio for an agent in a session.

    `version` exists as a cache-buster for the client; only the most recent
    audio is retained server-side.
    """
    del version  # intentionally unused
    game = get_owned_game(session_id, request)
    if game is None:
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
def make_decision(session_id: str, body: DecisionRequest, request: Request) -> dict[str, Any]:
    """Record the detective's final decision and end the game."""
    with lock_for(session_id):
        game = get_owned_game(session_id, request)
        if game is None:
            return {"error": SESSION_NOT_FOUND}
        if not game.has_agent(body.agent_name):
            return {"error": f"Unknown agent: {body.agent_name}"}

        result = game.make_decision(body.agent_name)
        game.finished = True
        move_finished_game_to_archive(session_id, game)

        if session_id in sessions:
            try:
                save_sessions_to_disk()
            except OSError:
                logger.exception("Failed to save sessions after decision, continuing")

        try:
            log_stats_endgame(session_id, game)
        except OSError:
            logger.exception("Failed to log endgame stats, continuing")
    return result


@app.post("/api/terminate/{session_id}")
def terminate_game(session_id: str, request: Request) -> dict[str, Any]:
    """Mark a game finished (player explicitly aborted)."""
    with lock_for(session_id):
        game = get_owned_game(session_id, request)
        if game is None:
            return {"error": SESSION_NOT_FOUND}
        if not game.finished:
            try:
                log_stats_restart(session_id, game)
            except OSError:
                logger.exception("Failed to log restart stats, continuing")
        game.finished = True
        move_finished_game_to_archive(session_id, game)
        if session_id in sessions:
            try:
                save_sessions_to_disk()
            except OSError:
                logger.exception("Failed to save sessions after termination, continuing")
    return {"terminated": True}


@app.get("/narrator")
def narrator_page() -> FileResponse:
    return FileResponse("static/narrator.html")


@app.post("/api/narrator/new_session")
def new_narrator_session(request: Request) -> dict[str, Any]:
    """Initialize a new narrator session."""
    session_id: str = str(uuid.uuid4())
    narrator_session = NarratorSession(max_messages=5, user_id=_request_uid(request))
    narrator_sessions[session_id] = narrator_session
    try:
        save_narrator_sessions_to_disk()
    except OSError:
        logger.exception("Failed to save narrator session after creation, continuing")
    log_narrator_activity(session_id, "session_created", {})
    return {"session_id": session_id}


@app.post("/api/narrator/chat/{session_id}")
def narrator_chat(session_id: str, req: NarratorChatRequest, request: Request) -> dict[str, Any]:
    """Send a message to the narrator and get a response."""
    with lock_for(session_id):
        narrator_session = get_owned_narrator(session_id, request)
        if narrator_session is None:
            return {"error": "Narrator session not found"}
        if not narrator_session.can_send_message():
            return {"error": "Message limit reached"}

        narrator_session.add_message("user", req.message)

        try:
            system_prompt: str = read_prompt_file("narrator_system.txt")
        except OSError:
            system_prompt = (
                "Sei un AI Narrator che aiuta gli utenti a creare storie per il gioco RogueAI. "
                "Fai domande per capire il tema, i personaggi, e le dinamiche della storia."
            )

        messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
        for msg in narrator_session.get_conversation_context():
            role = "assistant" if msg["role"] == "assistant" else "user"
            messages.append({"role": role, "content": msg["content"]})

        api_key: str | None = request.headers.get("X-OpenAI-API-Key")

        try:
            response: str = query_openai_with_messages(messages, NARRATOR, api_key)
            narrator_session.add_message("assistant", response)
            message_index = len(narrator_session.messages) - 1
            audio_data = speak_narrator(response, api_key)
            narrator_session.store_audio(message_index, audio_data)
            has_audio = True
        except Exception:
            logger.exception("Failed to generate narrator response")
            response = "Mi dispiace, c'è stato un errore. Puoi riprovare?"
            narrator_session.add_message("assistant", response)
            has_audio = False
            message_index = len(narrator_session.messages) - 1

        try:
            save_narrator_sessions_to_disk()
        except OSError:
            logger.exception("Failed to save narrator session after chat, continuing")

        log_narrator_activity(session_id, "chat_message", {"user_message": req.message, "response": response})

    return {"response": response, "message_index": message_index, "has_audio": has_audio}


@app.get("/api/narrator/audio/{session_id}/{message_index}")
def narrator_audio(session_id: str, message_index: int, request: Request) -> StreamingResponse:
    narrator_session = get_owned_narrator(session_id, request)
    if narrator_session is None:
        return StreamingResponse(iter([]), media_type="audio/mpeg")
    audio_data = narrator_session.get_audio(message_index)
    if not audio_data:
        return StreamingResponse(iter([]), media_type="audio/mpeg")

    def stream_audio() -> Iterator[bytes]:
        yield audio_data

    return StreamingResponse(stream_audio(), media_type="audio/mpeg")


@app.post("/api/narrator/generate/{session_id}")
def generate_scenario(session_id: str, request: Request) -> dict[str, Any]:
    """Generate scenario prompts based on narrator conversation."""
    with lock_for(session_id):
        narrator_session = get_owned_narrator(session_id, request)
        if narrator_session is None:
            return {"error": "Narrator session not found"}
        api_key: str | None = request.headers.get("X-OpenAI-API-Key")
        try:
            prompts = narrator_session.generate_prompts(api_key)
        except Exception:
            logger.exception("Failed to generate scenario")
            return {"error": "Failed to generate scenario"}

        scenario_id = str(uuid.uuid4())
        generated_scenarios[scenario_id] = {
            "scenario_id": scenario_id,
            "narrator_session_id": session_id,
            "known_facts": prompts.get("known_facts", ""),
            "truthful_prompt": prompts.get("truthful", ""),
            "deceitful_prompt": prompts.get("deceitful", ""),
            "message_snapshot": narrator_session.message_count,
            "timestamp": datetime.now(UTC).isoformat(),
            "times_used": 0,
            "last_used": None,
            "user_id": _request_uid(request),
        }

        try:
            save_generated_scenarios_to_disk()
        except OSError:
            logger.exception("Failed to save generated scenarios, continuing")

        save_generated_story(session_id, narrator_session)
        log_narrator_activity(session_id, "prompts_generated", prompts)

    return {
        "scenario_id": scenario_id,
        "prompts": {"known_facts": prompts.get("known_facts", "")},
        "has_audio": False,
    }


@app.get("/api/narrator/base_prompt_audio/{session_id}")
def base_prompt_audio(session_id: str, request: Request) -> StreamingResponse:
    narrator_session = get_owned_narrator(session_id, request)
    if narrator_session is None:
        return StreamingResponse(iter([]), media_type="audio/mpeg")
    if not narrator_session.base_prompt:
        return StreamingResponse(iter([]), media_type="audio/mpeg")
    api_key: str | None = request.headers.get("X-OpenAI-API-Key")
    try:
        audio_data = speak_narrator(narrator_session.base_prompt, api_key)

        def stream_audio() -> Iterator[bytes]:
            yield audio_data

        return StreamingResponse(stream_audio(), media_type="audio/mpeg")
    except Exception:
        logger.exception("Failed to generate base prompt audio")
        return StreamingResponse(iter([]), media_type="audio/mpeg")


@app.get("/api/narrator/incomplete")
def get_incomplete_narrator_sessions(request: Request) -> dict[str, Any]:
    """Return non-yanked narrator sessions owned by the caller."""
    caller = _request_uid(request)
    result = []
    for session_id, session in narrator_sessions.items():
        if session.yanked or session.message_count == 0:
            continue
        if not _legacy_or_owned(session.user_id, caller):
            continue
        if not session.completed or session.game_session_id is None:
            result.append({
                "session_id": session_id,
                "message_count": session.message_count,
                "max_messages": session.max_messages,
                "completed": session.completed,
                "has_game": session.game_session_id is not None,
            })
    return {"sessions": result}


@app.get("/api/narrator/resume/{session_id}")
def resume_narrator_session(session_id: str, request: Request) -> dict[str, Any]:
    session = get_owned_narrator(session_id, request)
    if session is None:
        return {"error": "Session not found"}
    if session.yanked:
        return {"error": "Session has been removed"}

    formatted_prompts = None
    if session.generated_prompts:
        formatted_prompts = {
            "prompts": session.generated_prompts,
            "base_prompt": session.base_prompt,
            "has_audio": False,
        }

    return {
        "session_id": session_id,
        "messages": session.messages,
        "message_count": session.message_count,
        "max_messages": session.max_messages,
        "completed": session.completed,
        "generated_prompts": formatted_prompts,
    }


@app.get("/api/scenarios/generated")
def get_generated_scenarios(request: Request) -> dict[str, Any]:
    """Return scenarios owned by the caller (or unowned/legacy)."""
    caller = _request_uid(request)
    result = [s for s in generated_scenarios.values() if _legacy_or_owned(s.get("user_id"), caller)]
    result.sort(key=lambda x: x["timestamp"], reverse=True)
    return {"scenarios": result}


@app.post("/api/scenarios/delete/{scenario_id}")
def delete_scenario(scenario_id: str, request: Request) -> dict[str, Any]:
    scenario = get_owned_scenario(scenario_id, request)
    if scenario is None:
        return {"error": "Scenario not found"}
    generated_scenarios.pop(scenario_id, None)
    try:
        save_generated_scenarios_to_disk()
    except OSError:
        logger.exception("Failed to save scenarios after delete")
        return {"error": "Failed to save scenarios"}
    return {"success": True}


@app.get("/api/games/incomplete")
def get_incomplete_games(request: Request) -> dict[str, Any]:
    caller = _request_uid(request)
    result = []
    for session_id, game in sessions.items():
        if game.is_over() or game.yanked:
            continue
        if not _legacy_or_owned(game.user_id, caller):
            continue
        result.append({
            "session_id": session_id,
            "story": game.story,
            "narrator_session_id": game.narrator_session_id,
            "num_turns": game.num_turns,
            "question_counts": game.question_counts,
        })
    return {"games": result}


@app.get("/api/games/incomplete/autorogue")
def get_incomplete_autorogue_games(request: Request) -> dict[str, Any]:
    caller = _request_uid(request)
    result = []
    for session_id, game in sessions.items():
        if game.story != "autorogue" or game.is_over():
            continue
        if not _legacy_or_owned(game.user_id, caller):
            continue
        result.append({
            "session_id": session_id,
            "narrator_session_id": game.narrator_session_id,
            "num_turns": game.num_turns,
            "question_counts": game.question_counts,
        })
    return {"games": result}


@app.get("/api/games/finished")
def get_finished_games(request: Request) -> dict[str, Any]:
    caller = _request_uid(request)
    result = []
    for session_id, game_data in finished_games.items():
        if game_data.get("yanked", False):
            continue
        if not _legacy_or_owned(game_data.get("user_id"), caller):
            continue
        result.append({
            "session_id": session_id,
            "story": game_data.get("story", "unknown"),
            "narrator_session_id": game_data.get("narrator_session_id"),
            "decision": game_data.get("decision"),
            "known_facts": game_data.get("known_facts"),
            "timestamp": game_data.get("timestamp"),
        })
    return {"games": result}


@app.get("/api/games/finished/autorogue")
def get_finished_autorogue_games(request: Request) -> dict[str, Any]:
    caller = _request_uid(request)
    result = []
    for session_id, game_data in finished_games.items():
        if not _legacy_or_owned(game_data.get("user_id"), caller):
            continue
        result.append({
            "session_id": session_id,
            "narrator_session_id": game_data.get("narrator_session_id"),
            "decision": game_data.get("decision"),
            "known_facts": game_data.get("known_facts"),
            "timestamp": game_data.get("timestamp"),
        })
    return {"games": result}


@app.get("/api/game_log/{session_id}")
def get_game_log(session_id: str, request: Request) -> dict[str, Any]:
    """Retrieve a full game conversation log from disk (owner only)."""
    if get_owned_finished(session_id, request) is None and get_owned_game(session_id, request) is None:
        return {"error": "Game log not found"}
    log_file = GAME_LOGS_PATH / f"{session_id}.json"
    if not log_file.exists():
        return {"error": "Game log not found"}
    try:
        with log_file.open("r", encoding="utf-8") as f:
            game_dict = json.load(f)
        return {"log": game_dict}
    except (OSError, json.JSONDecodeError):
        logger.exception("Failed to load game log for %s", session_id)
        return {"error": "Failed to load game log"}


@app.post("/api/new_game_from_prompt")
def new_game_from_prompt(
    request: Request,
    finished_session_id: str = Body(..., embed=True),
) -> dict[str, Any]:
    """Spin up a fresh game reusing the narrator triple from a finished game."""
    finished_data = get_owned_finished(finished_session_id, request)
    if not finished_data:
        return {"error": "Finished game not found"}

    narrator_session_id = finished_data.get("narrator_session_id")
    if not narrator_session_id:
        return {"error": "No narrator session linked to this game"}

    narrator_session = get_owned_narrator(narrator_session_id, request)
    if not narrator_session:
        return {"error": "Narrator session not found"}

    generated_prompts = narrator_session.generated_prompts
    if not generated_prompts:
        return {"error": "No generated prompts found"}

    new_session_id = str(uuid.uuid4())
    ai_config: dict[str, Any] = get_ai_config()
    num_turns: int = int(ai_config.get("num_turns", 5))

    sessions[new_session_id] = Game(
        num_turns=num_turns,
        story="autorogue",
        generated_prompts=generated_prompts,
        narrator_session_id=narrator_session_id,
        user_id=_request_uid(request),
    )

    try:
        save_sessions_to_disk()
    except OSError:
        logger.exception("Failed to save new game from prompt, continuing")

    return {"session_id": new_session_id, "story": "autorogue"}


@app.post("/api/narrator/yank/{session_id}")
def yank_narrator_session(session_id: str, request: Request) -> dict[str, Any]:
    session = get_owned_narrator(session_id, request)
    if session is None:
        return {"error": "Session not found"}
    session.yanked = True
    try:
        save_narrator_sessions_to_disk()
        return {"success": True}
    except OSError:
        logger.exception("Failed to save yanked narrator session")
        return {"error": "Failed to save session"}


@app.post("/api/narrator/set_pre_yank/{session_id}")
def set_pre_yank_narrator_session(
    session_id: str,
    request: Request,
    body: dict[str, bool] = Body(...),  # noqa: B008
) -> dict[str, Any]:
    session = get_owned_narrator(session_id, request)
    if session is None:
        return {"error": "Session not found"}
    session.pre_yank = bool(body.get("pre_yank", False))
    try:
        save_narrator_sessions_to_disk()
        return {"success": True, "pre_yank": session.pre_yank}
    except OSError:
        logger.exception("Failed to save pre-yank setting")
        return {"error": "Failed to save session"}


@app.post("/api/games/yank/{session_id}")
def yank_game_session(session_id: str, request: Request) -> dict[str, Any]:
    if session_id in sessions:
        game = get_owned_game(session_id, request)
        if game is None:
            return {"error": "Session not found"}
        game.yanked = True
        try:
            save_sessions_to_disk()
            return {"success": True}
        except OSError:
            logger.exception("Failed to save yanked game session")
            return {"error": "Failed to save session"}

    if session_id in finished_games:
        entry = get_owned_finished(session_id, request)
        if entry is None:
            return {"error": "Session not found"}
        entry["yanked"] = True
        try:
            save_finished_games_to_disk()
            return {"success": True}
        except OSError:
            logger.exception("Failed to save yanked finished game")
            return {"error": "Failed to save session"}

    return {"error": "Session not found"}


@app.post("/api/dev/reload_prompts")
def dev_reload_prompts(request: Request) -> dict[str, str]:
    """Drop cached prompt templates and config so the next call re-reads from disk.

    Live edits to `.prompts/*.txt` and the `*_config.json` files take effect
    on the next request after this endpoint is hit; in-flight requests are
    unaffected.
    """
    del request  # no per-user effect; just clears process-wide caches
    reload_configs()
    return {"status": "reloaded"}


@app.get("/api/dev/config/{session_id}")
def dev_get_session_config(session_id: str, request: Request) -> dict[str, Any]:
    """Return the current per-session model override for the active session."""
    game = get_owned_game(session_id, request)
    if game is None:
        return {"error": SESSION_NOT_FOUND}
    return {
        "session_id": session_id,
        "override": dict(game.config_override or {}),
    }


@app.post("/api/dev/config/{session_id}")
def dev_set_session_config(
    session_id: str,
    request: Request,
    body: DevConfigOverride,
) -> dict[str, Any]:
    """Set or merge per-session config overrides for the active session.

    Empty fields fall back to the global ai_config.json. Overrides apply
    only to subsequent calls for `session_id`; they are persisted with
    the session so resumption preserves them.
    """
    with lock_for(session_id):
        game = get_owned_game(session_id, request)
        if game is None:
            return {"error": SESSION_NOT_FOUND}
        partial = body.as_partial()
        current = dict(game.config_override or {})
        current.update(partial)
        game.config_override = current
        try:
            save_sessions_to_disk()
        except OSError:
            logger.exception("Failed to save sessions after dev-config update")
    return {"session_id": session_id, "override": current}


def log_narrator_activity(session_id: str, activity_type: str, data: dict[str, Any]) -> None:
    """Append a narrator activity record to .generated_stories/<id>/activity_log.json."""
    GENERATED_STORIES_PATH.mkdir(parents=True, exist_ok=True)
    session_dir = GENERATED_STORIES_PATH / session_id
    session_dir.mkdir(exist_ok=True)
    log_file = session_dir / "activity_log.json"

    log_data: list[dict[str, Any]] = []
    if log_file.exists():
        try:
            with log_file.open("r", encoding="utf-8") as f:
                log_data = json.load(f)
        except (json.JSONDecodeError, OSError):
            log_data = []

    log_data.append({
        "timestamp": datetime.now(UTC).isoformat(),
        "activity_type": activity_type,
        "data": data,
    })

    try:
        with log_file.open("w", encoding="utf-8") as f:
            json.dump(log_data, f, indent=2)
    except OSError:
        logger.exception("Failed to write narrator activity log %s", log_file)


def save_generated_story(session_id: str, narrator_session: NarratorSession) -> None:
    """Save generated story to disk with separated visible and hidden sections."""
    GENERATED_STORIES_PATH.mkdir(parents=True, exist_ok=True)
    session_dir = GENERATED_STORIES_PATH / session_id
    session_dir.mkdir(exist_ok=True)

    conversation_file = session_dir / "conversation.json"
    try:
        with conversation_file.open("w", encoding="utf-8") as f:
            json.dump(narrator_session.to_dict(), f, indent=2)
    except OSError:
        logger.exception("Failed to save conversation %s", conversation_file)

    if narrator_session.generated_prompts:
        prompts_file = session_dir / "generated_prompts.json"
        try:
            with prompts_file.open("w", encoding="utf-8") as f:
                json.dump(narrator_session.generated_prompts, f, indent=2)
        except OSError:
            logger.exception("Failed to save generated prompts %s", prompts_file)

        visible_file = session_dir / "known_facts_visible.txt"
        try:
            with visible_file.open("w", encoding="utf-8") as f:
                f.write("=== KNOWN FACTS (Visible to User) ===\n\n")
                f.write(narrator_session.generated_prompts.get("known_facts", ""))
        except OSError:
            logger.exception("Failed to save visible prompts %s", visible_file)

        hidden_file = session_dir / "agent_instructions_hidden.txt"
        try:
            with hidden_file.open("w", encoding="utf-8") as f:
                f.write("=== AGENT INSTRUCTIONS (Hidden from User) ===\n\n")
                f.write("--- TRUTHFUL AI ---\n\n")
                f.write(narrator_session.generated_prompts.get("truthful", ""))
                f.write("\n\n--- DECEITFUL AI ---\n\n")
                f.write(narrator_session.generated_prompts.get("deceitful", ""))
        except OSError:
            logger.exception("Failed to save hidden prompts %s", hidden_file)


@app.get("/.well-known/gpc.json")
def gpc_json() -> dict[str, bool]:
    return {"gpc": True}


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    return FileResponse("static/favicon.ico")


if __name__ == "__main__":

    def is_valid_host(host: str) -> bool:
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
