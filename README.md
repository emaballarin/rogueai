# AI Detective RPG

A web-based game where you, the detective, interrogate two AI agents—one always truthful, one potentially deceitful. Your goal: decide which AI to shut off based on their answers.

## Features

- FastAPI backend with modular, type-annotated Python code
- PyTorch for randomization
- OpenAI GPT-4o for agent responses
- Modern, minimal frontend (vanilla JS/CSS)

## Setup

### 1. Clone the repository

```bash
git clone <repo-url>
cd rogueai
```

### 2. Install dependencies

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Set your OpenAI API key

Export your API key as an environment variable:

```bash
export OPENAI_API_KEY_TSNEXT2025=sk-...
```

### 4. Run the server

```bash
python main.py
```

The app will be available at [http://localhost:8000](http://localhost:8000).

## Development

- Backend code is modularized:
  - `main.py`: FastAPI app and endpoints
  - `game.py`: Game and Agent logic
  - `utils.py`: OpenAI API utilities
  - `config.py`: Configuration and API key management
  - `schemas.py`: Pydantic models for request validation
- Frontend assets are in `static/`

## Notes

- For production, use a persistent session store (e.g., Redis) instead of in-memory sessions.
- All endpoints are async for efficiency.
- All code uses type annotations and docstrings.

## Persistence and Logging

- The game now persists the current session to disk in `.sessions/session_store.json`. If the server restarts or the page is refreshed, the last non-terminated session is restored automatically unless the game is over.
- A new 'Terminate Game' button allows you to end the game at any time, even without triggering the endgame. This is available on-screen during play.
- Game statistics are logged to `stats/game_stats.txt`:
  - Each manual termination (via the button) is logged.
  - Each endgame is logged with which AI was terminated and after how many questions.

## License

MIT
