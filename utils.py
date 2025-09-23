#!/usr/bin/env python
# -*- coding: utf-8 -*-
import json
from functools import lru_cache
from typing import Any
from typing import Dict
from typing import Optional
import os
import openai
from playsound import playsound

TRUTHFUL: int = 0
DECEITFUL: int = 1
SUGGESTIONS: int = 2


def load_ai_config() -> Dict[str, Dict[str, Any]]:
    """Load AI configuration from the .prompts/ai_config.json file."""
    with open(".prompts/ai_config.json", "r") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def get_ai_config() -> Dict[str, Dict[str, Any]]:
    return load_ai_config()


def query_openai(prompt: str, role: int) -> str:
    """Query the OpenAI API and return the response as a string."""
    config: Dict[str, Dict[str, Any]] = get_ai_config()
    if role == DECEITFUL:
        ai_params = config["deceitful"]
    elif role == SUGGESTIONS:
        ai_params = config["suggestions"]
    else:
        ai_params = config["truthful"]
    response = openai.chat.completions.create(
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


def speak_openai(prompt: str, selected_ai: str) -> str:
    """Convert input text to speech using OpenAI's TTS API and play the audio."""
    config: Dict[str, Dict[str, Any]] = get_audio_config()

    ai_params = config[selected_ai]

    speech_file_name = f"{selected_ai}.opus"
    # Ensure the .audio directory exists
    os.makedirs(".audio", exist_ok=True)
    speech_file_path = os.path.join(".audio", speech_file_name)

    with openai.audio.speech.with_streaming_response.create(
        model=ai_params["model"],
        voice=ai_params["speaker"],
        input=prompt,
        instructions=ai_params["sys_prompt"],
    ) as response:
        response.stream_to_file(speech_file_path)

    try:
        playsound(speech_file_path)
    except Exception as e:
        print(f"Error playing sound: {e}")
