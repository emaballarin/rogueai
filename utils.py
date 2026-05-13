"""OpenAI client wrappers, config loaders, and prompt-template cache.

All OpenAI calls share a single timeout configured via the
ROGUEAI_OPENAI_TIMEOUT environment variable (default 30s). Prompt
templates are cached in-process; `reload_configs()` drops every cache so
authors can edit `.prompts/*` files and pick up the changes via the
`/api/dev/reload_prompts` endpoint without a server restart.
"""

import json
import os
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from typing import Any
from typing import cast

import openai
from openai.types.chat import ChatCompletionMessageParam

TRUTHFUL: int = 0
DECEITFUL: int = 1
SUGGESTIONS: int = 2
NARRATOR: int = 3

OPENAI_TIMEOUT: float = float(os.environ.get("ROGUEAI_OPENAI_TIMEOUT", "30"))

_PROMPTS_DIR: Path = Path(__file__).parent / ".prompts"


def load_ai_config() -> dict[str, dict[str, Any]]:
    """Load AI configuration from the .prompts/ai_config.json file."""
    with (_PROMPTS_DIR / "ai_config.json").open("r", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def get_ai_config() -> dict[str, dict[str, Any]]:
    """Cached view of the AI config (call `reload_configs()` to reload)."""
    return load_ai_config()


def _role_to_config_key(role: int) -> str:
    """Map an Agent role / role-flag to the matching ai_config.json section."""
    if role == DECEITFUL:
        return "deceitful"
    if role == SUGGESTIONS:
        return "suggestions"
    if role == NARRATOR:
        return "narrator"
    return "truthful"


def _resolve_ai_params(role: int, override: dict[str, Any] | None = None) -> dict[str, Any]:
    """Resolve the active model params for a role, applying any per-session override."""
    config = get_ai_config()
    key = _role_to_config_key(role)
    # narrator falls back to truthful if no narrator section is configured
    base = config.get(key) if key != "narrator" else config.get("narrator", config["truthful"])
    if base is None:
        base = config["truthful"]
    if override:
        merged = dict(base)
        merged.update(override)
        return merged
    return base


def _client(api_key: str | None) -> openai.OpenAI:
    """Build an OpenAI client with the shared timeout applied."""
    if api_key:
        return openai.OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT)
    return openai.OpenAI(timeout=OPENAI_TIMEOUT)


def query_openai(
    prompt: str,
    role: int,
    api_key: str | None = None,
    override: dict[str, Any] | None = None,
) -> str:
    """Query the OpenAI API with a single system prompt and return the response."""
    ai_params = _resolve_ai_params(role, override)
    messages: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": prompt},
    ]
    response = _client(api_key).chat.completions.create(
        model=ai_params["model"],
        messages=messages,
        max_tokens=ai_params["max_tokens"],
        temperature=ai_params["temperature"],
    )
    content: str | None = response.choices[0].message.content
    return content.strip() if content is not None else ""


def load_audio_config() -> dict[str, dict[str, Any]]:
    """Load audio configuration from the .prompts/audio_config.json file."""
    with (_PROMPTS_DIR / "audio_config.json").open("r", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def get_audio_config() -> dict[str, dict[str, Any]]:
    """Cached view of the audio config (call `reload_configs()` to reload)."""
    return load_audio_config()


def speak_openai(prompt: str, selected_ai: str, api_key: str | None = None) -> bytes:
    """Convert input text to speech using OpenAI's TTS API and return audio data."""
    config = get_audio_config()
    ai_params = config[selected_ai]
    with _client(api_key).audio.speech.with_streaming_response.create(
        model=ai_params["model"],
        voice=ai_params["speaker"],
        input=prompt,
        instructions=ai_params["sys_prompt"],
    ) as response:
        return response.read()


def query_openai_with_messages(
    messages: Iterable[dict[str, str]],
    role: int = NARRATOR,
    api_key: str | None = None,
    override: dict[str, Any] | None = None,
) -> str:
    """Query the OpenAI API with a structured message list and return the response."""
    ai_params = _resolve_ai_params(role, override)
    typed_messages = cast("Iterable[ChatCompletionMessageParam]", messages)
    response = _client(api_key).chat.completions.create(
        model=ai_params["model"],
        messages=typed_messages,
        max_tokens=ai_params["max_tokens"],
        temperature=ai_params["temperature"],
    )
    content: str | None = response.choices[0].message.content
    return content.strip() if content is not None else ""


def speak_narrator(text: str, api_key: str | None = None) -> bytes:
    """Convert narrator text to speech using OpenAI's TTS API."""
    config = get_audio_config()
    narrator_config = config.get("narrator") or config.get("IA-1")
    if narrator_config is None:
        raise RuntimeError("audio_config.json has neither 'narrator' nor 'IA-1' sections")
    with _client(api_key).audio.speech.with_streaming_response.create(
        model=narrator_config["model"],
        voice=narrator_config["speaker"],
        input=text,
        instructions=narrator_config.get("sys_prompt", "Leggi il testo in modo chiaro e coinvolgente."),
    ) as response:
        return response.read()


@lru_cache(maxsize=64)
def read_prompt_file(name: str) -> str:
    """Read and cache a prompt template by file name.

    Cached for the lifetime of the process; call `reload_configs()` to
    pick up edits to `.prompts/*` files without a server restart.
    """
    return (_PROMPTS_DIR / name).read_text(encoding="utf-8")


def reload_configs() -> None:
    """Drop all cached configs and prompt templates."""
    get_ai_config.cache_clear()
    get_audio_config.cache_clear()
    read_prompt_file.cache_clear()
