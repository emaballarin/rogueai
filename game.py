#!/usr/bin/env python
# -*- coding: utf-8 -*-
import logging
import os
from typing import Any
from typing import Dict
from typing import List

import torch

from utils import query_openai

TRUTHFUL: int = 0
DECEITFUL: int = 1

logger = logging.getLogger(__name__)


class Agent:
    """Represents an AI agent in the game."""

    name: str
    role: int
    memory: List[str]

    def __init__(self, name: str, role: int) -> None:
        self.name = name
        self.role = role
        self.memory: List[str] = []

    def respond(self, history: List[str], question: str) -> str:
        """Generate a response to the detective's question using OpenAI."""
        prompt: str = self._build_prompt(history, question)
        try:
            response: str = query_openai(prompt, self.role)
        except Exception as e:
            logger.error(f"OpenAI API call failed: {e}")
            response = "[Error: Unable to generate response.]"
        self.memory.append(f"Q: {question}\nA: {response}")
        return response

    def _build_prompt(self, history: List[str], question: str) -> str:
        base_path: str = os.path.join(os.path.dirname(__file__), ".prompts")
        with open(os.path.join(base_path, "base.txt"), "r") as f:
            base_template: str = f.read()
        if self.role == TRUTHFUL:
            with open(os.path.join(base_path, "truthful.txt"), "r") as f:
                role_instructions: str = f.read()
        else:
            with open(os.path.join(base_path, "deceitful.txt"), "r") as f:
                role_instructions: str = f.read()
        prompt: str = base_template.replace("{name}", self.name)
        prompt = prompt.replace("[ROLE_INSTRUCTIONS]", role_instructions.strip())
        prompt = prompt.replace("[HISTORY]", "\n".join(history))
        prompt = prompt.replace("[QUESTION]", question)
        return prompt

    def to_dict(self) -> dict:
        return {"name": self.name, "role": self.role, "memory": self.memory}

    @staticmethod
    def from_dict(data: dict) -> "Agent":
        agent = Agent(data["name"], data["role"])
        agent.memory = data.get("memory", [])
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

    def __init__(self, num_turns: int = 5) -> None:
        self.num_turns = num_turns
        if torch.rand(1).item() > 0.5:
            self.agents = [Agent("AI-1", TRUTHFUL), Agent("AI-2", DECEITFUL)]
        else:
            self.agents = [Agent("AI-1", DECEITFUL), Agent("AI-2", TRUTHFUL)]
        self.histories = {agent.name: [] for agent in self.agents}
        self.question_counts = {agent.name: 0 for agent in self.agents}
        self.finished = False
        self.endgame_triggered = False
        self.decision = ""
        self.selected_ai = self.agents[0].name

    def next_turn(self, agent_name: str, question: str) -> Dict[str, Any]:
        if self.finished:
            return {"error": "The game is over. Please start a new game."}
        if self.endgame_triggered and not self.finished:
            return {"error": "Endgame: Please make your final decision."}
        agent = next(a for a in self.agents if a.name == agent_name)
        self.histories[agent_name].append(f"Detective: {question}")
        answer = agent.respond(self.histories[agent_name], question)
        self.histories[agent_name].append(f"{agent.name}: {answer}")
        self.question_counts[agent_name] += 1
        return {"agent": agent.name, "answer": answer}

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

    def to_dict(self) -> dict:
        return {
            "num_turns": self.num_turns,
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
        game = Game(num_turns=data["num_turns"])
        game.agents = [Agent.from_dict(a) for a in data["agents"]]
        game.histories = data["histories"]
        game.question_counts = data["question_counts"]
        game.finished = data["finished"]
        game.endgame_triggered = data["endgame_triggered"]
        game.decision = data["decision"]
        game.selected_ai = data["selected_ai"]
        return game


    def is_over(self) -> bool:
        return self.finished
