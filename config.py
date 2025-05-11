#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os
from typing import Optional

import openai

API_KEY_ENV_VAR: str = "OPENAI_API_KEY_TSNEXT2025"
api_key: Optional[str] = os.environ.get(API_KEY_ENV_VAR)
if not api_key:
    raise RuntimeError(f"Please set the {API_KEY_ENV_VAR} environment variable.")
openai.api_key = api_key


def init():
    """
    This function is a placeholder to ensure that the OpenAI API key is always set.
    """
    pass
