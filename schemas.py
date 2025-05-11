#!/usr/bin/env python
# -*- coding: utf-8 -*-
from typing import Any

from pydantic import BaseModel


class AskRequest(BaseModel):
    """Request model for asking a question to an AI agent."""

    agent_name: str
    question: str


class SelectAIRequest(BaseModel):
    """Request model for selecting which AI to address."""

    agent_name: str


class DecisionRequest(BaseModel):
    """Request model for making the final decision."""

    agent_name: str
