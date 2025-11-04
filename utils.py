#!/usr/bin/env python
# -*- coding: utf-8 -*-
import json
from functools import lru_cache
from typing import Any
from typing import Dict
from typing import Optional

import openai

TRUTHFUL: int = 0
DECEITFUL: int = 1
SUGGESTIONS: int = 2
NARRATOR: int = 3


def load_ai_config() -> Dict[str, Dict[str, Any]]:
    """Load AI configuration from the .prompts/ai_config.json file."""
    with open(".prompts/ai_config.json", "r") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def get_ai_config() -> Dict[str, Dict[str, Any]]:
    return load_ai_config()


def query_openai(prompt: str, role: int, api_key: Optional[str] = None) -> str:
    """Query the OpenAI API and return the response as a string."""
    config: Dict[str, Dict[str, Any]] = get_ai_config()
    if role == DECEITFUL:
        ai_params = config["deceitful"]
    elif role == SUGGESTIONS:
        ai_params = config["suggestions"]
    else:
        ai_params = config["truthful"]

    client = openai.OpenAI(api_key=api_key) if api_key else openai
    response = client.chat.completions.create(
        model=ai_params["model"],
        messages=[{"role": "system", "content": prompt}],
        max_tokens=ai_params["max_tokens"],
        temperature=ai_params["temperature"],
    )
    content: Optional[str] = response.choices[0].message.content
    return content.strip() if content is not None else ""


def load_audio_config() -> Dict[str, Dict[str, Any]]:
    """Load AI configuration from the .prompts/audio_config.json file."""
    with open(".prompts/audio_config.json", "r") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def get_audio_config() -> Dict[str, Dict[str, Any]]:
    return load_audio_config()


def speak_openai(prompt: str, selected_ai: str, api_key: Optional[str] = None) -> bytes:
    """Convert input text to speech using OpenAI's TTS API and return audio data."""
    config: Dict[str, Dict[str, Any]] = get_audio_config()

    ai_params = config[selected_ai]

    client = openai.OpenAI(api_key=api_key) if api_key else openai
    with client.audio.speech.with_streaming_response.create(
        model=ai_params["model"],
        voice=ai_params["speaker"],
        input=prompt,
        instructions=ai_params["sys_prompt"],
    ) as response:
        return response.read()


def query_openai_with_messages(
    messages: list[Dict[str, str]], role: int = NARRATOR, api_key: Optional[str] = None
) -> str:
    """Query the OpenAI API with custom messages and return the response."""
    config: Dict[str, Dict[str, Any]] = get_ai_config()

    if role == NARRATOR:
        ai_params = config.get("narrator", config["truthful"])
    elif role == DECEITFUL:
        ai_params = config["deceitful"]
    elif role == SUGGESTIONS:
        ai_params = config["suggestions"]
    else:
        ai_params = config["truthful"]

    client = openai.OpenAI(api_key=api_key) if api_key else openai
    response = client.chat.completions.create(
        model=ai_params["model"],
        messages=messages,
        max_tokens=ai_params["max_tokens"],
        temperature=ai_params["temperature"],
    )
    content: Optional[str] = response.choices[0].message.content
    return content.strip() if content is not None else ""


def speak_narrator(text: str, api_key: Optional[str] = None) -> bytes:
    """Convert narrator text to speech using OpenAI's TTS API."""
    config: Dict[str, Dict[str, Any]] = get_audio_config()

    # Use narrator config or fallback to IA-1
    narrator_config = config.get("narrator", config.get("IA-1"))

    client = openai.OpenAI(api_key=api_key) if api_key else openai
    with client.audio.speech.with_streaming_response.create(
        model=narrator_config["model"],
        voice=narrator_config["speaker"],
        input=text,
        instructions=narrator_config.get("sys_prompt", "Leggi il testo in modo chiaro e coinvolgente."),
    ) as response:
        return response.read()
