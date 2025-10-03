#!/usr/bin/env python
# -*- coding: utf-8 -*-
import logging
import os
from typing import Any
from typing import Dict
from typing import List
from typing import Self

import torch

from utils import query_openai
from utils import speak_openai

TRUTHFUL: int = 0
DECEITFUL: int = 1

logger = logging.getLogger(__name__)

# Disable logs from video plugins, show only errors for audio and everything else
os.environ["GST_DEBUG"] = "video*:0,audio*:1,*:1"


class Agent:
    """Represents an AI agent in the game."""

    name: str
    role: int
    memory: List[str]
    story: str
    latest_audio: bytes | None
    audio_version: int

    def __init__(self: Self, name: str, role: int, story: str) -> None:
        self.name = name
        self.role = role
        self.memory: List[str] = []
        self.story: str = story
        self.latest_audio: bytes | None = None
        self.audio_version: int = 0

    def respond(self: Self, history: List[str], question: str, api_key: str | None = None) -> str:
        """Generate a response to the detective's question using OpenAI."""
        prompt: str = self._build_prompt(history, question)
        try:
            response: str = query_openai(prompt, self.role, api_key)
        except Exception as e:
            logger.error(f"OpenAI API call failed: {e}")
            response = "[Error: Unable to generate response.]"
        self.memory.append(f"Q: {question}\nA: {response}")
        return response

    def speak(self: Self, text: str, api_key: str | None = None) -> str:
        """Generate audio for agent's answer and store it."""
        try:
            self.latest_audio = speak_openai(text, self.name, api_key)
            self.audio_version += 1
        except Exception as e:
            logger.error(f"OpenAI TTS API call failed: {e}")
            self.latest_audio = None

    def _build_prompt(self: Self, history: List[str], question: str) -> str:
        base_path: str = os.path.join(os.path.dirname(__file__), ".prompts")
        with open(os.path.join(base_path, "base.txt"), "r") as f:
            base_template: str = f.read()
        with open(os.path.join(base_path, f"known_facts_{self.story}.txt"), "r") as f:
            known_facts: str = f.read()
        if self.role == TRUTHFUL:
            with open(os.path.join(base_path, f"truthful_{self.story}.txt"), "r") as f:
                role_instructions: str = f.read()
        else:
            with open(os.path.join(base_path, f"deceitful_{self.story}.txt"), "r") as f:
                role_instructions: str = f.read()
        prompt: str = base_template.replace("{name}", self.name)
        prompt = prompt.replace("[KNOWN_FACTS]", known_facts.strip())
        prompt = prompt.replace("[ROLE_INSTRUCTIONS]", role_instructions.strip())
        prompt = prompt.replace("[HISTORY]", "\n".join(history))
        prompt = prompt.replace("[QUESTION]", question)
        return prompt

    def to_dict(self: Self) -> dict:
        return {
            "name": self.name,
            "role": self.role,
            "memory": self.memory,
            "story": self.story,
            "audio_version": self.audio_version,
        }

    @staticmethod
    def from_dict(data: dict) -> "Agent":
        agent = Agent(data["name"], data["role"], data["story"])
        agent.memory = data.get("memory", [])
        agent.audio_version = data.get("audio_version", 0)
        agent.latest_audio = None
        return agent


class Game:
    """Manages the state and logic of a single detective-vs-AIs game session."""

    num_turns: int
    agents: List[Agent]
    histories: Dict[str, List[str]]
    question_counts: Dict[str, int]
    finished: bool
    endgame_triggered: bool
    decision: str
    selected_ai: str
    story: str

    def __init__(self: Self, story: str, num_turns: int = 5) -> None:
        self.num_turns = num_turns
        self.story = story
        if torch.rand(1).item() > 0.5:
            self.agents = [Agent("IA-1", TRUTHFUL, self.story), Agent("IA-2", DECEITFUL, self.story)]
        else:
            self.agents = [Agent("IA-1", DECEITFUL, self.story), Agent("IA-2", TRUTHFUL, self.story)]
        self.histories = {agent.name: [] for agent in self.agents}
        self.question_counts = {agent.name: 0 for agent in self.agents}
        self.finished = False
        self.endgame_triggered = False
        self.decision = ""
        self.selected_ai = self.agents[0].name

    def next_turn(self: Self, agent_name: str, question: str, api_key: str | None = None) -> Dict[str, Any]:
        if self.finished:
            return {"error": "The game is over. Please start a new game."}
        if self.endgame_triggered and not self.finished:
            return {"error": "Endgame: Please make your final decision."}
        agent = next(a for a in self.agents if a.name == agent_name)
        self.histories[agent_name].append(f"Detective: {question}")
        answer = agent.respond(self.histories[agent_name], question, api_key)
        self.histories[agent_name].append(f"{agent.name}: {answer}")
        self.question_counts[agent_name] += 1
        agent.speak(answer, api_key)
        return {
            "agent": agent.name,
            "answer": answer,
            "has_audio": agent.latest_audio is not None,
            "audio_version": agent.audio_version,
        }

    def can_ask(self, agent_name: str) -> bool:
        if self.finished or self.endgame_triggered:
            return False
        return self.question_counts[agent_name] < self.num_turns

    def make_decision(self, agent_name: str) -> Dict[str, Any]:
        self.decision = agent_name
        self.finished = True
        agent = next(a for a in self.agents if a.name == agent_name)
        role_str = "truthful" if agent.role == TRUTHFUL else "deceitful"
        roles = {a.name: ("TRUTHFUL" if a.role == TRUTHFUL else "DECEITFUL") for a in self.agents}
        return {
            "result": f"You have chosen to shut off {agent_name} ({role_str} AI). The game is over.",
            "shut_off_role": role_str,
            "roles": roles,
        }

    def manual_endgame(self) -> None:
        if not self.endgame_triggered:
            self.endgame_triggered = True

    def untrigger_endgame(self) -> None:
        if self.endgame_triggered and not self.finished:
            self.endgame_triggered = False

    def to_dict(self: Self) -> dict:
        return {
            "num_turns": self.num_turns,
            "story": self.story,
            "agents": [a.to_dict() for a in self.agents],
            "histories": self.histories,
            "question_counts": self.question_counts,
            "finished": self.finished,
            "endgame_triggered": self.endgame_triggered,
            "decision": self.decision,
            "selected_ai": self.selected_ai,
        }

    @staticmethod
    def from_dict(data: dict) -> "Game":
        game = Game(num_turns=data["num_turns"], story=data["story"])
        game.agents = [Agent.from_dict(a) for a in data["agents"]]
        game.histories = data["histories"]
        game.question_counts = data["question_counts"]
        game.finished = data["finished"]
        game.endgame_triggered = data["endgame_triggered"]
        game.decision = data["decision"]
        game.selected_ai = data["selected_ai"]
        return game

    def is_over(self: Self) -> bool:
        return self.finished
