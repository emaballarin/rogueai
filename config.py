#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os
from typing import Optional

import openai

# TODO: Remove following line before publishing source!
DEFAULT_KEY_LB: str = "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"

API_KEY_ENV_VAR: str = "OPENAI_API_KEY_TSNEXT2025"
api_key: Optional[str] = os.environ.get(API_KEY_ENV_VAR) or DEFAULT_KEY_LB
if not api_key:
    raise RuntimeError(f"Please set the {API_KEY_ENV_VAR} environment variable.")
openai.api_key = api_key


def init() -> None:
    """
    This function is a placeholder to ensure that the OpenAI API key is always set.
    """
    pass
