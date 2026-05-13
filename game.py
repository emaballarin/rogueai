"""Domain model: Agent, Game, NarratorSession.

The Game/Agent split mirrors the conceptual split in the paper draft:
a Game runs a single bounded interrogation; an Agent is one of the two
opaque interlocutors. NarratorSession is the off-game design loop used
by AutoRogueAI to produce a scenario triple before a Game is created.
"""

import json
import logging
import os
import random
import re
from datetime import datetime
from datetime import UTC
from typing import Any
from typing import Self

import openai

from utils import NARRATOR
from utils import query_openai_with_messages
from utils import read_prompt_file
from utils import speak_openai

TRUTHFUL: int = 0
DECEITFUL: int = 1

logger = logging.getLogger(__name__)

# Keep video/audio plugin chatter quiet
os.environ.setdefault("GST_DEBUG", "video*:0,audio*:1,*:1")


def _utcnow_iso() -> str:
    """ISO-8601 UTC timestamp for last-activity bookkeeping."""
    return datetime.now(UTC).isoformat()


class Agent:
    """One opaque interlocutor in a Game."""

    def __init__(
        self,
        name: str,
        role: int,
        story: str,
        generated_prompts: dict[str, str] | None = None,
    ) -> None:
        self.name: str = name
        self.role: int = role
        self.story: str = story
        self.memory: list[str] = []
        self.latest_audio: bytes | None = None
        self.audio_version: int = 0
        self.generated_prompts: dict[str, str] | None = generated_prompts

    def respond(
        self,
        history: list[str],
        question: str,
        api_key: str | None = None,
        override: dict[str, Any] | None = None,
    ) -> str:
        """Generate the agent's answer for the current question.

        `history` must contain only *prior* turns; the current question is
        passed separately and appended as the final user message inside
        `_build_messages`. This avoids the historical double-counting where
        the question appeared both in the rendered history and as a
        trailing prompt.
        """
        messages = self._build_messages(history, question)
        try:
            response = query_openai_with_messages(
                messages,
                role=self.role,
                api_key=api_key,
                override=override,
            )
        except openai.OpenAIError as e:
            logger.error("OpenAI chat call failed for %s: %s", self.name, e)
            response = "[Error: Unable to generate response.]"
        self.memory.append(f"Q: {question}\nA: {response}")
        return response

    def speak(self, text: str, api_key: str | None = None) -> None:
        """Synthesise speech for the agent's most recent answer."""
        try:
            self.latest_audio = speak_openai(text, self.name, api_key)
            self.audio_version += 1
        except openai.OpenAIError as e:
            logger.error("OpenAI TTS call failed for %s: %s", self.name, e)
            self.latest_audio = None

    def _build_messages(self, history: list[str], question: str) -> list[dict[str, str]]:
        """Compose chat-completion messages from history + the live question.

        The role-conditioning prompt is sent as a `system` message; historical
        turns alternate `user` (detective) / `assistant` (agent); the live
        question is the final `user` message. This keeps untrusted text out
        of the system position, which is the practical defence against
        prompt-injection attempts in the player's question.
        """
        base_template = read_prompt_file("base.txt")
        if self.generated_prompts:
            known_facts = self.generated_prompts.get("known_facts", "")
            if self.role == TRUTHFUL:
                role_instructions = self.generated_prompts.get("truthful", "")
            else:
                role_instructions = self.generated_prompts.get("deceitful", "")
        else:
            known_facts = read_prompt_file(f"known_facts_{self.story}.txt")
            if self.role == TRUTHFUL:
                role_instructions = read_prompt_file(f"truthful_{self.story}.txt")
            else:
                role_instructions = read_prompt_file(f"deceitful_{self.story}.txt")

        system_content = (
            base_template.replace("{name}", self.name)
            .replace("[KNOWN_FACTS]", known_facts.strip())
            .replace("[ROLE_INSTRUCTIONS]", role_instructions.strip())
        )

        messages: list[dict[str, str]] = [{"role": "system", "content": system_content}]
        detective_prefix = "Detective: "
        agent_prefix = f"{self.name}: "
        for entry in history:
            if entry.startswith(detective_prefix):
                messages.append({"role": "user", "content": entry[len(detective_prefix) :]})
            elif entry.startswith(agent_prefix):
                messages.append({"role": "assistant", "content": entry[len(agent_prefix) :]})
            else:
                messages.append({"role": "user", "content": entry})
        messages.append({"role": "user", "content": question})
        return messages

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "role": self.role,
            "memory": self.memory,
            "story": self.story,
            "audio_version": self.audio_version,
            "generated_prompts": self.generated_prompts,
        }

    @staticmethod
    def from_dict(data: dict) -> "Agent":
        agent = Agent(
            data["name"],
            data["role"],
            data["story"],
            generated_prompts=data.get("generated_prompts"),
        )
        agent.memory = data.get("memory", [])
        agent.audio_version = data.get("audio_version", 0)
        agent.latest_audio = None
        return agent


class Game:
    """A single bounded detective-vs-AIs interrogation session."""

    def __init__(
        self: Self,
        story: str,
        num_turns: int = 5,
        generated_prompts: dict[str, str] | None = None,
        narrator_session_id: str | None = None,
        user_id: str | None = None,
        _skip_init: bool = False,
    ) -> None:
        """Create a fresh Game.

        When `_skip_init=True` no agents, histories, or counters are set —
        this branch exists exclusively for `from_dict` to avoid re-rolling
        the role assignment after deserialization. External callers should
        always use the default.
        """
        self.story: str = story
        self.num_turns: int = num_turns
        self.narrator_session_id: str | None = narrator_session_id
        self.yanked: bool = False
        self.user_id: str | None = user_id
        self.last_activity: str = _utcnow_iso()
        if _skip_init:
            self.agents: list[Agent] = []
            self.histories: dict[str, list[str]] = {}
            self.question_counts: dict[str, int] = {}
            self.finished: bool = False
            self.endgame_triggered: bool = False
            self.decision: str = ""
            self.selected_ai: str = ""
            self.config_override: dict[str, Any] = {}
            return

        if random.random() > 0.5:
            self.agents = [
                Agent("IA-1", TRUTHFUL, self.story, generated_prompts),
                Agent("IA-2", DECEITFUL, self.story, generated_prompts),
            ]
        else:
            self.agents = [
                Agent("IA-1", DECEITFUL, self.story, generated_prompts),
                Agent("IA-2", TRUTHFUL, self.story, generated_prompts),
            ]
        self.histories = {agent.name: [] for agent in self.agents}
        self.question_counts = {agent.name: 0 for agent in self.agents}
        self.finished = False
        self.endgame_triggered = False
        self.decision = ""
        self.selected_ai = self.agents[0].name
        self.config_override = {}

    def touch(self) -> None:
        """Update the last-activity timestamp."""
        self.last_activity = _utcnow_iso()

    def get_known_facts(self) -> str | None:
        if self.agents and self.agents[0].generated_prompts:
            return self.agents[0].generated_prompts.get("known_facts")
        return None

    def has_agent(self, agent_name: str) -> bool:
        return any(a.name == agent_name for a in self.agents)

    def next_turn(self, agent_name: str, question: str, api_key: str | None = None) -> dict[str, Any]:
        if self.finished:
            return {"error": "The game is over. Please start a new game."}
        if self.endgame_triggered and not self.finished:
            return {"error": "Endgame: Please make your final decision."}
        if not self.has_agent(agent_name):
            return {"error": f"Unknown agent: {agent_name}"}
        agent = next(a for a in self.agents if a.name == agent_name)
        # history at this point does NOT include the new question. respond()
        # appends it internally as the final user message.
        answer = agent.respond(self.histories[agent_name], question, api_key, override=self.config_override or None)
        # only after the model has answered do we extend the persisted history
        self.histories[agent_name].append(f"Detective: {question}")
        self.histories[agent_name].append(f"{agent.name}: {answer}")
        self.question_counts[agent_name] += 1
        agent.speak(answer, api_key)
        self.touch()
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

    def make_decision(self, agent_name: str) -> dict[str, Any]:
        self.decision = agent_name
        self.finished = True
        agent = next(a for a in self.agents if a.name == agent_name)
        role_str = "truthful" if agent.role == TRUTHFUL else "deceitful"
        roles = {a.name: ("TRUTHFUL" if a.role == TRUTHFUL else "DECEITFUL") for a in self.agents}
        self.touch()
        return {
            "result": f"You have chosen to shut off {agent_name} ({role_str} AI). The game is over.",
            "shut_off_role": role_str,
            "roles": roles,
        }

    def manual_endgame(self) -> None:
        if not self.endgame_triggered:
            self.endgame_triggered = True
            self.touch()

    def untrigger_endgame(self) -> None:
        if self.endgame_triggered and not self.finished:
            self.endgame_triggered = False
            self.touch()

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
            "narrator_session_id": self.narrator_session_id,
            "yanked": self.yanked,
            "user_id": self.user_id,
            "last_activity": self.last_activity,
            "config_override": self.config_override,
        }

    @staticmethod
    def from_dict(data: dict) -> "Game":
        """Restore a Game without re-rolling its role assignment.

        Agent role assignment is recovered from the serialised agents; we
        never invoke the constructor's coin-flip branch on resume.
        """
        game = Game(
            story=data["story"],
            num_turns=data["num_turns"],
            narrator_session_id=data.get("narrator_session_id"),
            user_id=data.get("user_id"),
            _skip_init=True,
        )
        game.agents = [Agent.from_dict(a) for a in data["agents"]]
        game.histories = data["histories"]
        game.question_counts = data["question_counts"]
        game.finished = data["finished"]
        game.endgame_triggered = data["endgame_triggered"]
        game.decision = data["decision"]
        game.selected_ai = data.get("selected_ai") or (game.agents[0].name if game.agents else "")
        game.yanked = data.get("yanked", False)
        game.last_activity = data.get("last_activity") or _utcnow_iso()
        game.config_override = data.get("config_override") or {}
        return game

    def is_over(self) -> bool:
        return self.finished


# Strict regex for the JSON envelope the narrator emits. Used as a last-resort
# extraction when the model wraps its JSON in surrounding chatter.
_JSON_OBJECT_RE = re.compile(r"\{[\s\S]*\}")


class NarratorSession:
    """Off-game story-design dialogue used by AutoRogueAI."""

    def __init__(self, max_messages: int = 5, user_id: str | None = None) -> None:
        self.messages: list[dict[str, str]] = []
        self.message_count: int = 0
        self.max_messages: int = max_messages
        self.generated_prompts: dict[str, str] | None = None
        self.base_prompt: str | None = None
        self.audio_cache: dict[int, bytes] = {}
        self.yanked: bool = False
        self.pre_yank: bool = False
        self.game_session_id: str | None = None
        self.completed: bool = False
        self.user_id: str | None = user_id
        self.last_activity: str = _utcnow_iso()

    def touch(self) -> None:
        self.last_activity = _utcnow_iso()

    def add_message(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content})
        if role == "user":
            self.message_count += 1
        self.touch()

    def can_send_message(self) -> bool:
        return self.message_count < self.max_messages

    def get_conversation_context(self) -> list[dict[str, str]]:
        return self.messages

    def generate_prompts(self, api_key: str | None = None) -> dict[str, str]:
        """Generate a (known_facts, truthful, deceitful) triple from the design conversation.

        The narrator is asked to respond in strict JSON; failure to do so
        triggers a single retry with an explicit reminder, after which we
        raise. This replaces the previous regex-marker parser which silently
        produced empty triples on malformed output.
        """
        generation_instructions = read_prompt_file("narrator_generation.txt")

        if self.message_count == 0:
            user_prompt = (
                "Generate a creative and engaging scenario autonomously. "
                "Create the three required prompts for an original story."
            )
        else:
            conversation_summary = "\n\n".join(f"{msg['role'].upper()}: {msg['content']}" for msg in self.messages)
            user_prompt = f"Based on this conversation, generate the three required prompts:\n\n{conversation_summary}"

        prompts = self._invoke_and_parse(
            system_prompt=generation_instructions,
            user_prompt=user_prompt,
            api_key=api_key,
        )
        if not all(prompts.get(k) for k in ("known_facts", "truthful", "deceitful")):
            # one retry with an explicit JSON-only nudge
            retry_user = user_prompt + (
                "\n\nIMPORTANT: respond with a single JSON object only — "
                '{"known_facts": "...", "truthful": "...", "deceitful": "..."}. '
                "No prose, no markers, no surrounding text."
            )
            prompts = self._invoke_and_parse(
                system_prompt=generation_instructions,
                user_prompt=retry_user,
                api_key=api_key,
            )
            if not all(prompts.get(k) for k in ("known_facts", "truthful", "deceitful")):
                raise RuntimeError("narrator failed to produce a complete prompt triple")

        self.generated_prompts = prompts
        self.base_prompt = read_prompt_file("base.txt")
        self.touch()
        return prompts

    def _invoke_and_parse(
        self,
        system_prompt: str,
        user_prompt: str,
        api_key: str | None,
    ) -> dict[str, str]:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        response = query_openai_with_messages(messages, role=NARRATOR, api_key=api_key)
        return self._parse_generated_prompts(response)

    @staticmethod
    def _parse_generated_prompts(response: str) -> dict[str, str]:
        """Parse a (known_facts, truthful, deceitful) triple from a narrator response.

        Prefers strict JSON. If the model wraps JSON in surrounding text or
        a markdown fence, we extract the first {...} block. Falls back to
        the legacy marker-based parser for backward compatibility with old
        responses; empty fields are returned if all paths fail.
        """
        prompts = {"known_facts": "", "truthful": "", "deceitful": ""}
        if not response:
            return prompts

        candidate = response.strip()
        if candidate.startswith("```"):
            # strip the first and last fenced-code blocks
            candidate = re.sub(r"^```[a-zA-Z]*\s*", "", candidate)
            candidate = re.sub(r"\s*```$", "", candidate)

        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            match = _JSON_OBJECT_RE.search(candidate)
            parsed = None
            if match:
                try:
                    parsed = json.loads(match.group(0))
                except json.JSONDecodeError:
                    parsed = None

        if isinstance(parsed, dict):
            for key in prompts:
                value = parsed.get(key)
                if isinstance(value, str):
                    prompts[key] = value.strip()
            return prompts

        # legacy marker-based fallback (kept for old prompts that emit markers)
        current_section: str | None = None
        for line in candidate.splitlines():
            line_upper = line.upper().strip()
            if "KNOWN FACTS" in line_upper or "KNOWN_FACTS" in line_upper:
                current_section = "known_facts"
                continue
            if "TRUTHFUL" in line_upper and "DECEITFUL" not in line_upper:
                current_section = "truthful"
                continue
            if "DECEITFUL" in line_upper:
                current_section = "deceitful"
                continue
            if current_section and line.strip() and not line.strip().startswith("==="):
                prompts[current_section] += line + "\n"
        for key, value in prompts.items():
            prompts[key] = value.strip()
        return prompts

    def store_audio(self, message_index: int, audio_data: bytes) -> None:
        self.audio_cache[message_index] = audio_data

    def get_audio(self, message_index: int) -> bytes | None:
        return self.audio_cache.get(message_index)

    def to_dict(self) -> dict:
        return {
            "messages": self.messages,
            "message_count": self.message_count,
            "max_messages": self.max_messages,
            "generated_prompts": self.generated_prompts,
            "base_prompt": self.base_prompt,
            "yanked": self.yanked,
            "pre_yank": self.pre_yank,
            "game_session_id": self.game_session_id,
            "completed": self.completed,
            "user_id": self.user_id,
            "last_activity": self.last_activity,
        }

    @staticmethod
    def from_dict(data: dict) -> "NarratorSession":
        session = NarratorSession(
            max_messages=data.get("max_messages", 5),
            user_id=data.get("user_id"),
        )
        session.messages = data.get("messages", [])
        session.message_count = data.get("message_count", 0)
        session.generated_prompts = data.get("generated_prompts")
        session.base_prompt = data.get("base_prompt")
        session.audio_cache = {}
        session.yanked = data.get("yanked", False)
        session.pre_yank = data.get("pre_yank", False)
        session.game_session_id = data.get("game_session_id")
        session.completed = data.get("completed", False)
        session.last_activity = data.get("last_activity") or _utcnow_iso()
        return session
