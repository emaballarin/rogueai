#!/usr/bin/env python
# -*- coding: utf-8 -*-
import logging
import os
from typing import Any
from typing import Dict
from typing import List
from playsound import playsound
import torch

from utils import query_openai, speak_openai

TRUTHFUL: int = 0
DECEITFUL: int = 1

logger = logging.getLogger(__name__)


class Agent:
    """Represents an AI agent in the game."""

    name: str
    role: int
    memory: List[str]
    story: str

    def __init__(self, name: str, role: int, story:str) -> None:
        self.name = name
        self.role = role
        self.memory: List[str] = []
        self.story: str = story

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
    
    def speak(self, text: str, question_counts: Dict) -> str:
        """Reproduce a generated `opus` file given the IA's answer."""
        try:
            playsound(speak_openai(text, self.name, int(question_counts[self.name])))
        except Exception as e:
            logger.error(f"OpenAI TTS API call failed: {e}")
    
    def _build_prompt(self, history: List[str], question: str) -> str:
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

    def to_dict(self) -> dict:
        return {"name": self.name, "role": self.role, "memory": self.memory, "story": self.story}

    @staticmethod
    def from_dict(data: dict) -> "Agent":
        agent = Agent(data["name"], data["role"], data["story"])
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
    story: str

    def __init__(self, story: str, num_turns: int = 5) -> None:
        self.num_turns = num_turns
        self.story = story
        if torch.rand(1).item() > 0.5:
            self.agents = [Agent("AI-1", TRUTHFUL, self.story), Agent("AI-2", DECEITFUL, self.story)]
        else:
            self.agents = [Agent("AI-1", DECEITFUL, self.story), Agent("AI-2", TRUTHFUL, self.story)]
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
        agent.speak(answer, self.question_counts)
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

    def is_over(self) -> bool:
        return self.finished
