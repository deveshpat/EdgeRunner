"""Evolutionary Prompt Genome & Online Learning Store for EdgeRunner."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.workspace import ensure_workspace

DEFAULT_GENES = {
    "core_identity": (
        "You are EdgeRunner, an elite autonomous software engineering agent with full access to a live Unix terminal, specialized workspace tools, and real-time internet search."
    ),
    "reasoning_protocol": (
        "Protocol: Think inside <think>...</think> -> Inspect -> Act -> Verify -> Answer. Keep thoughts focused on hypotheses and tool calls."
    ),
    "error_recovery": (
        "When an error occurs, inspect the traceback file and line numbers with 'view_file', search docs with 'web_search', and surgically patch with 'replace_file_content'. Never guess."
    ),
    "tool_mastery": (
        "Prefer 'replace_file_content' for precise file edits, 'view_file' with line ranges to save tokens, 'run_skill' for mechanical tasks, and 'terminal' for test verification."
    ),
}


class PromptGenomeStore:
    """Stores, mutates, and scores modular prompt genes to optimize agent intelligence over time."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or (ensure_workspace() / ".edgerunner_genome.db")
        self._init_db()
        self._seed_default_genes()

    def _init_db(self):
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS prompt_genome (
                        gene_name TEXT PRIMARY KEY,
                        content TEXT NOT NULL,
                        fitness_score REAL DEFAULT 1.0,
                        mutation_count INTEGER DEFAULT 0,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                conn.commit()
        except Exception:
            pass

    def _seed_default_genes(self):
        try:
            with sqlite3.connect(self.db_path) as conn:
                for gene, content in DEFAULT_GENES.items():
                    conn.execute(
                        "INSERT OR IGNORE INTO prompt_genome (gene_name, content, fitness_score, mutation_count) VALUES (?, ?, 1.0, 0)",
                        (gene, content),
                    )
                conn.commit()
        except Exception:
            pass

    def assemble_prompt(self, task_context: str = "") -> str:
        """Compose the active champion prompt from modular genes."""
        genes = dict(DEFAULT_GENES)
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT gene_name, content FROM prompt_genome")
                for name, content in cur.fetchall():
                    genes[name] = content
        except Exception:
            pass

        prompt_parts = [
            genes.get("core_identity", DEFAULT_GENES["core_identity"]),
            "\n### Execution Protocol",
            genes.get("reasoning_protocol", DEFAULT_GENES["reasoning_protocol"]),
            "\n### Error Recovery Directive",
            genes.get("error_recovery", DEFAULT_GENES["error_recovery"]),
            "\n### High-Leverage Tool Strategy",
            genes.get("tool_mastery", DEFAULT_GENES["tool_mastery"]),
        ]

        return "\n".join(prompt_parts)

    def evolve_gene(self, gene_name: str, lesson_learned: str) -> str:
        """Mutate and refine a prompt gene based on real trajectory experience."""
        gene = gene_name.strip().lower()
        if gene not in DEFAULT_GENES:
            gene = "error_recovery"

        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT content, mutation_count FROM prompt_genome WHERE gene_name = ?", (gene,))
                row = cur.fetchone()
                existing = row[0] if row else DEFAULT_GENES.get(gene, "")
                mut_count = (row[1] + 1) if row else 1

                # Append concise lesson learned
                new_content = f"{existing}\n- Learned Directive (v{mut_count}): {lesson_learned.strip()}"
                conn.execute(
                    """
                    INSERT OR REPLACE INTO prompt_genome (gene_name, content, fitness_score, mutation_count, updated_at)
                    VALUES (?, ?, 1.1, ?, CURRENT_TIMESTAMP)
                    """,
                    (gene, new_content, mut_count),
                )
                conn.commit()
            return f"✓ Successfully evolved prompt gene '{gene}' (generation {mut_count})."
        except Exception as ex:
            return f"error evolving prompt gene: {ex}"

    def get_report(self) -> str:
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT gene_name, content, fitness_score, mutation_count, updated_at FROM prompt_genome")
                rows = cur.fetchall()

            if not rows:
                return "No prompt genome data recorded."

            lines = ["### 🧬 EdgeRunner Evolutionary Prompt Genome\n"]
            for name, content, score, muts, updated in rows:
                lines.append(f"#### Gene: `{name}` (Fitness: {score:.2f} | Mutations: {muts})\n{content}\n")
            return "\n".join(lines)
        except Exception as ex:
            return f"error generating genome report: {ex}"


_GENOME = PromptGenomeStore()


def get_evolved_system_prompt(task_context: str = "") -> str:
    return _GENOME.assemble_prompt(task_context)


def evolve_prompt_gene(gene_name: str, lesson_learned: str) -> str:
    return _GENOME.evolve_gene(gene_name, lesson_learned)


def get_genome_report() -> str:
    return _GENOME.get_report()
