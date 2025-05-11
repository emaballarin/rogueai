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
