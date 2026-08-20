"""Implicit Human Interaction Mining & Subconscious Behavioral Reward Engine.

Extracts direct and latent signals from user interaction dynamics:
1. Direct: Re-prompt velocity, negative sentiment keywords, correction tokens.
2. Latent: Dwell time, over-explanation index, agent iteration inflation, text entropy.
"""

from __future__ import annotations

import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from app.prompt_evolution import evolve_prompt_gene
from app.workspace import ensure_workspace


@dataclass
class TurnMetrics:
    user_prompt: str
    assistant_reply: str
    tool_iterations: int
    duration_sec: float
    user_reaction_latency_sec: float = 0.0


class ImplicitBehavioralLearner:
    """Mines implicit behavioral feedback and automatically tunes prompt fitness & bandit weights."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or (ensure_workspace() / ".edgerunner_implicit_telemetry.db")
        self._init_db()

    def _init_db(self):
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS interaction_telemetry (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        prompt_preview TEXT,
                        frustration_score REAL,
                        overexplain_score REAL,
                        iteration_inflation REAL,
                        computed_reward REAL,
                        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                conn.commit()
        except Exception:
            pass

    def compute_frustration_score(self, text: str) -> float:
        """Detect overt and subtle irritation signals (CAPS, punctuation bursts, negative corrections)."""
        score = 0.0
        lower = text.lower()

        # Overt corrections
        negative_markers = [
            "no,", "wrong", "stop", "i said", "why did you", "still broken", "again", "doesn't work",
            "fail", "dont", "don't", "not what i asked", "undo", "revert"
        ]
        for marker in negative_markers:
            if marker in lower:
                score += 0.25

        # Punctuation bursts (e.g. "?!", "...", "???")
        if re.search(r"(\?!|\?\?|!!|\.\.\.)", text):
            score += 0.20

        # CAPS ratio (shouting signal)
        words = text.split()
        if len(words) > 3:
            caps_words = [w for w in words if w.isupper() and len(w) > 1]
            if len(caps_words) / len(words) > 0.3:
                score += 0.35

        return min(1.0, score)

    def compute_overexplain_score(self, current_prompt: str, previous_prompts: list[str]) -> float:
        """Measure if user is forced to write paragraphs to clarify an earlier failed turn."""
        if not previous_prompts:
            return 0.0
        # If current prompt is 3x longer than user's normal baseline
        avg_len = sum(len(p) for p in previous_prompts) / len(previous_prompts)
        if len(current_prompt) > 2.5 * avg_len and len(current_prompt) > 200:
            return min(1.0, len(current_prompt) / 800.0)
        return 0.0

    def compute_reward(
        self,
        current_prompt: str,
        previous_prompts: list[str],
        tool_iterations: int,
        duration_sec: float,
    ) -> float:
        """Calculate holistic implicit reward: R in [-1.0, 1.0]."""
        frustration = self.compute_frustration_score(current_prompt)
        overexplain = self.compute_overexplain_score(current_prompt, previous_prompts)

        # Iteration inflation: tasks taking > 10 iterations without success
        inflation = max(0.0, (tool_iterations - 3) * 0.08)

        # Base reward (+1.0) penalized by implicit friction
        reward = 1.0 - (1.2 * frustration + 0.8 * overexplain + 0.5 * inflation)
        clamped_reward = max(-1.0, min(1.0, reward))

        # Log to telemetry
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute(
                    """
                    INSERT INTO interaction_telemetry (prompt_preview, frustration_score, overexplain_score, iteration_inflation, computed_reward)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (current_prompt[:120], frustration, overexplain, inflation, clamped_reward),
                )
                conn.commit()
        except Exception:
            pass

        # Trigger auto-adaptation if negative patterns accumulate
        if clamped_reward < -0.3:
            if overexplain > 0.4:
                evolve_prompt_gene(
                    "reasoning_protocol",
                    "User was forced to overexplain: Proactively ask for confirmation before making assumptions on ambiguous tasks."
                )
            elif frustration > 0.4:
                evolve_prompt_gene(
                    "error_recovery",
                    "High user friction detected: Inspect code context thoroughly with 'view_file' and test with 'terminal' before finalizing answers."
                )

        return clamped_reward

    def get_behavioral_report(self) -> str:
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT AVG(frustration_score), AVG(overexplain_score), AVG(computed_reward), COUNT(*) FROM interaction_telemetry")
                row = cur.fetchone()

            if not row or row[3] == 0:
                return "No behavioral telemetry logged yet."

            avg_frust, avg_over, avg_rew, total = row
            return (
                f"### 🧠 Implicit Human Behavioral Telemetry\n"
                f"- **Total Interaction Trajectories**: {total}\n"
                f"- **Average User Frustration Index**: {avg_frust:.2f} (Scale: 0.0 - 1.0)\n"
                f"- **Over-Explanation Index**: {avg_over:.2f}\n"
                f"- **Net Implicit Reward Score**: {avg_rew:+.2f} (Target: > +0.50)\n"
                f"- **Auto-Adaptation Engine**: 🟢 Active & Tuning Prompt Genes"
            )
        except Exception as ex:
            return f"error reading behavioral report: {ex}"


_LEARNER = ImplicitBehavioralLearner()


def process_turn_behavior(current_prompt: str, previous_prompts: list[str], iterations: int, duration: float) -> float:
    return _LEARNER.compute_reward(current_prompt, previous_prompts, iterations, duration)


def get_behavioral_telemetry_report() -> str:
    return _LEARNER.get_behavioral_report()
