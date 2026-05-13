"""Pydantic schemas for HTTP request bodies.

Length caps protect the OpenAI budget and prevent prompt-flooding.
"""

from typing import Any

from pydantic import BaseModel
from pydantic import Field

QUESTION_MAX_LEN: int = 2000
NARRATOR_MSG_MAX_LEN: int = 2000
AGENT_NAME_MAX_LEN: int = 32


class AskRequest(BaseModel):
    """Detective's question to one of the two agents."""

    agent_name: str = Field(..., min_length=1, max_length=AGENT_NAME_MAX_LEN)
    question: str = Field(..., min_length=1, max_length=QUESTION_MAX_LEN)


class SelectAIRequest(BaseModel):
    """Selects which AI the detective is currently addressing."""

    agent_name: str = Field(..., min_length=1, max_length=AGENT_NAME_MAX_LEN)


class NarratorChatRequest(BaseModel):
    """A single user-side message in the narrator design conversation."""

    message: str = Field(..., min_length=1, max_length=NARRATOR_MSG_MAX_LEN)


class DecisionRequest(BaseModel):
    """Final verdict: which agent the detective elects to shut off."""

    agent_name: str = Field(..., min_length=1, max_length=AGENT_NAME_MAX_LEN)


class DevConfigOverride(BaseModel):
    """Per-session overrides to ai_config.json that only apply to one session.

    Any key omitted falls back to the global config. Bounded ranges keep the
    surface narrow and safe for live tweaking.
    """

    model: str | None = Field(default=None, max_length=128)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=4096)

    def as_partial(self) -> dict[str, Any]:
        """Return a dict of only the explicitly-set fields."""
        return {k: v for k, v in self.model_dump().items() if v is not None}
