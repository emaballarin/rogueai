#!/usr/bin/env python
# -*- coding: utf-8 -*-
from pydantic import BaseModel


class AskRequest(BaseModel):
    """Request model for asking a question to an AI agent."""

    agent_name: str
    question: str


class SelectAIRequest(BaseModel):
    """Request model for selecting which AI to address."""

    agent_name: str
