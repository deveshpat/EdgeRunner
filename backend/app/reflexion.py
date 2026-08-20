"""Reflexion: Episodic Verbal Reinforcement Learning Memory for EdgeRunner.

Based on Shinn et al. (NeurIPS 2023) 'Reflexion: Language Agents with Verbal
Reinforcement Learning'. Maintains an episodic buffer of past trajectory failures
and counterfactual corrections to eliminate failure loops.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from app.workspace import ensure_workspace


@dataclass
class ReflexionItem:
    signature: str
    root_cause: str
    counterfactual_fix: str
    fitness_score: float
    timestamp: str


class ReflexionMemoryStore:
    """Stores and retrieves episodic verbal reflections based on error signature similarity."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or (ensure_workspace() / ".edgerunner_reflexion.db")
        self._init_db()

    def _init_db(self):
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS reflexion_memory (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        signature TEXT NOT NULL,
                        root_cause TEXT NOT NULL,
                        counterfactual_fix TEXT NOT NULL,
                        fitness_score REAL DEFAULT 1.0,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                conn.commit()
        except Exception:
            pass

    def record_reflection(self, signature: str, root_cause: str, counterfactual_fix: str) -> str:
        """Store an episodic self-reflection tuple after an execution failure."""
        clean_sig = signature.strip()[:200]
        if not clean_sig or not counterfactual_fix.strip():
            return "error: missing signature or counterfactual fix"

        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute(
                    """
                    INSERT INTO reflexion_memory (signature, root_cause, counterfactual_fix, fitness_score)
                    VALUES (?, ?, ?, 1.2)
                    """,
                    (clean_sig, root_cause.strip(), counterfactual_fix.strip()),
                )
                conn.commit()
            return f"✓ Recorded Reflexion episodic memory for '{clean_sig[:60]}...'."
        except Exception as ex:
            return f"error saving reflexion: {ex}"

    def retrieve_reflections(self, query_context: str, max_items: int = 3) -> list[str]:
        """Retrieve matching episodic reflections using keyword/signature intersection."""
        if not query_context.strip():
            return []

        q_lower = query_context.lower()
        tokens = set(re.findall(r"[a-zA-Z0-9_\-\.]{3,}", q_lower))
        if not tokens:
            return []

        candidates: list[tuple[float, str]] = []
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute(
                    "SELECT signature, root_cause, counterfactual_fix, fitness_score FROM reflexion_memory ORDER BY id DESC LIMIT 50"
                )
                rows = cur.fetchall()

            for sig, cause, fix, score in rows:
                sig_tokens = set(re.findall(r"[a-zA-Z0-9_\-\.]{3,}", sig.lower()))
                overlap = len(tokens.intersection(sig_tokens))
                if overlap > 0:
                    relevance = overlap * score
                    entry = f"- [Reflexion Memory]: When encountering '{sig[:80]}': Root cause was '{cause}'. Solution: {fix}"
                    candidates.append((relevance, entry))

            candidates.sort(key=lambda x: x[0], reverse=True)
            return [c[1] for c in candidates[:max_items]]
        except Exception:
            return []

    def get_memory_report(self) -> str:
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT id, signature, root_cause, counterfactual_fix, created_at FROM reflexion_memory ORDER BY id DESC LIMIT 10")
                rows = cur.fetchall()

            if not rows:
                return "No Reflexion episodic memories recorded yet."

            lines = ["### 🪞 EdgeRunner Reflexion Episodic Memory Buffer\n"]
            for mid, sig, cause, fix, ts in rows:
                lines.append(f"**Memory #{mid}** (`{ts}`)\n- **Signature:** {sig}\n- **Root Cause:** {cause}\n- **Counterfactual Strategy:** {fix}\n")
            return "\n".join(lines)
        except Exception as ex:
            return f"error getting memory report: {ex}"


_REFLEXION = ReflexionMemoryStore()


def record_episodic_reflection(signature: str, root_cause: str, counterfactual_fix: str) -> str:
    return _REFLEXION.record_reflection(signature, root_cause, counterfactual_fix)


def retrieve_episodic_reflections(query_context: str) -> list[str]:
    return _REFLEXION.retrieve_reflections(query_context)


def get_reflexion_report() -> str:
    return _REFLEXION.get_memory_report()
