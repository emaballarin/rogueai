# PROJECT.md — (Auto)RogueAI

Project-specific context for coding agents and human contributors. See
also `CLAUDE.md` (project-level agent instructions) and `~/.mindfunnel/SOUL.md`
(maintainer profile, optional).

## What this is

An interactive webapp that operationalizes a "revisited Turing Test":
a human detective interrogates two large-language-model agents,
knowing that exactly one has been licensed to deceive within a shared
scenario. The player asks bounded questions and must identify the
deceptive agent before turn budgets run out.

Two modes coexist:

- **Fixed RogueAI** — three hand-authored scenarios (`email`,
  `bank_credentials`, `superheroes`).
- **AutoRogueAI** — a _narrator_ AI co-designs custom scenarios with
  the user, then secretly fixes a deception strategy before the game
  begins.

## Repository layout

```
main.py             FastAPI app: routes, persistence, cookie auth, locking
game.py             Domain model: Agent, Game, NarratorSession
schemas.py          Pydantic request bodies (with length caps)
utils.py            OpenAI client wrappers + config/prompt caches
config.py           OpenAI API-key bootstrap from env
.prompts/           Prompt templates (.txt) + ai_config.json, audio_config.json
static/             Frontend SPA (vanilla JS + CSS)
  index.html        Game (detective interrogation) view
  narrator.html     Narrator (scenario design) view
  start.html        Landing/scenario selection
  main.js           Game-view client
  narrator.js       Narrator-view client
  start_style.css   Landing styles
  style.css         Game-view styles
  narrator_style.css Narrator-view styles
.sessions/          Persistent session/scenario state (JSON, auto-managed)
.stats/             Append-only stats log
.generated_stories/ Per-narrator-session artefacts
.game_logs/         Full transcripts of finished AutoRogueAI games
sketch.tex          Drafty paper draft (workshop length, ~4000 words)
references.bib      Bibliography for the paper draft (all arXiv-verified)
```

## Architecture in three logical layers

1. **Scenario layer** — produces a triple `(known_facts, truthful,
deceitful)`. Sources: fixed `.prompts/*.txt` files for the three
   hand-authored stories; `NarratorSession.generate_prompts()` for
   procedurally generated scenarios.
2. **Game layer** — `Game` orchestrates a single bounded interrogation
   session: two `Agent`s under randomized role assignment, per-agent
   turn budget, conversation history, verdict, reveal.
3. **API/Persistence layer** — FastAPI in `main.py`. In-memory dicts
   (`sessions`, `narrator_sessions`, `finished_games`,
   `generated_scenarios`) are mirrored to JSON files under
   `.sessions/`. All writes go through `_save_json_atomic()`.

## Per-user scoping

Every browser receives a `rogueai_uid` cookie (HttpOnly, SameSite=Lax,
1-year max-age) minted on first hit. Sessions, narrator sessions, and
generated scenarios store this `user_id`; enumeration endpoints filter
by it and per-session endpoints return 404 on a cookie mismatch.

Legacy entries (created before user_id stamping) carry `user_id = None`
and are auto-adopted by the first cookie to access them. This preserves
backward compatibility while ensuring new sessions are isolated.

**This is a soft scoping mechanism appropriate for a hobby deployment.**
A shared multi-tenant deployment with strong auth requirements should
gate behind OAuth or similar — that is a follow-up.

## Concurrency model

The app assumes **single-process uvicorn** (`python main.py` runs
`uvicorn.run(app, ...)` with implicit `--workers 1`). Per-session
mutations are guarded by `lock_for(session_id)` (a `threading.Lock`
per session). Running uvicorn with `--workers > 1` will lose state
silently and is not supported; a follow-up could move session state
to Redis or SQLite.

## Adding a new fixed scenario

1. Drop three text files into `.prompts/`:
    - `known_facts_<story>.txt` — the shared facts of the case (visible
      to the player and both agents).
    - `truthful_<story>.txt` — instructions for the honest agent.
    - `deceitful_<story>.txt` — instructions for the deceptive agent.
2. Add a story tile to `static/start.html` (the `.story` divs) with
   `onclick="startGame('<story>')"`.
3. Add a display-name mapping in `static/start.html` (the `storyNames`
   dict in the inline resume-tab code).

Restart the server (or hit `POST /api/dev/reload_prompts`) to pick up
the new prompt files.

## Authoring affordances

- **Hot-reload prompts:** `POST /api/dev/reload_prompts` clears the
  in-process prompt-template + config cache. In-flight requests are
  unaffected; the next request reads fresh.
- **Per-session model override:** `POST /api/dev/config/<session_id>`
  with `{"model": "...", "temperature": 0.6, "max_tokens": 300}`
  (any subset). Override applies only to that session; the global
  `ai_config.json` is never modified. `GET /api/dev/config/<session_id>`
  returns the active override.
- **Session visibility:** every page surfaces the active session id
  in a footer with a copy-to-clipboard button, so non-technical
  players can share it with support without opening devtools.

These dev endpoints are not gated by extra auth — the assumption is
that whoever can reach the server is trusted. Behind a public
deployment, add an auth layer in front.

## Environment variables

See `.env.example`. Required:

- `OPENAI_API_KEY_TSNEXT2025` — OpenAI API key used when no
  `X-OpenAI-API-Key` request header is supplied by the client.

Optional:

- `ROGUEAI_OPENAI_TIMEOUT` — per-call OpenAI timeout in seconds
  (default `30`).
- `ROGUEAI_SESSION_TTL_DAYS` — at startup, drop sessions older than
  this (default `30`; set `0` to disable).

## How to run

```sh
pip install -r requirements.txt
export OPENAI_API_KEY_TSNEXT2025=sk-...
python main.py            # bind 0.0.0.0:8000
# or: python main.py --prod 127.0.0.1
```

Browse to `http://localhost:8000/`.

## Stats logging

Each interrogation turn and each endgame appends a structured record
to `.stats/game_stats.json`. The file is read into memory on every
append; under heavy load this becomes the bottleneck. If session
volume grows, rotate the file (e.g., one per day) or move stats into
SQLite.

## Notes on the prompt engineering

`base.txt` (now) contains _only_ the system-message text. The
detective's question is sent as the final `user` message, and prior
turns alternate `user` / `assistant`. This separation defends against
prompt-injection attempts in the question — untrusted text never
sits in a system position.

The narrator emits its scenario triple in JSON
(`{"known_facts": ..., "truthful": ..., "deceitful": ...}`). The parser
in `NarratorSession._parse_generated_prompts` falls back to the legacy
marker-based extraction if JSON parsing fails, then retries once with
a strict "respond in JSON only" reminder.
