"""Tool Telemetry, Dead-Weight Analytics & Adaptive Bandit Engine for EdgeRunner."""

from __future__ import annotations

import math
import sqlite3
import time
from pathlib import Path
from typing import Any

from app.workspace import ensure_workspace


class TelemetryStore:
    """Records real-time tool performance and computes UCB1 adaptive bandit rewards."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or (ensure_workspace() / ".edgerunner_telemetry.db")
        self._init_db()

    def _init_db(self):
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS tool_telemetry (
                        tool_name TEXT PRIMARY KEY,
                        total_calls INTEGER DEFAULT 0,
                        success_calls INTEGER DEFAULT 0,
                        failed_calls INTEGER DEFAULT 0,
                        total_duration_ms REAL DEFAULT 0.0,
                        last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        last_error TEXT DEFAULT ''
                    )
                """)
                conn.commit()
        except Exception:
            pass

    def record_call(self, tool_name: str, duration_ms: float, is_success: bool, error: str = ""):
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute(
                    """
                    INSERT INTO tool_telemetry (tool_name, total_calls, success_calls, failed_calls, total_duration_ms, last_used_at, last_error)
                    VALUES (?, 1, ?, ?, ?, CURRENT_TIMESTAMP, ?)
                    ON CONFLICT(tool_name) DO UPDATE SET
                        total_calls = total_calls + 1,
                        success_calls = success_calls + ?,
                        failed_calls = failed_calls + ?,
                        total_duration_ms = total_duration_ms + ?,
                        last_used_at = CURRENT_TIMESTAMP,
                        last_error = ?
                    """,
                    (
                        tool_name,
                        1 if is_success else 0,
                        0 if is_success else 1,
                        duration_ms,
                        error,
                        1 if is_success else 0,
                        0 if is_success else 1,
                        duration_ms,
                        error,
                    ),
                )
                conn.commit()
        except Exception:
            pass

    def get_report(self) -> str:
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute(
                    "SELECT tool_name, total_calls, success_calls, failed_calls, total_duration_ms, last_used_at, last_error FROM tool_telemetry ORDER BY total_calls DESC"
                )
                rows = cur.fetchall()

            if not rows:
                return "No tool telemetry recorded yet."

            lines = ["### 📊 EdgeRunner Tool Telemetry & Health Report\n"]
            lines.append("| Tool Name | Calls | Success Rate | Avg Latency | Health Status |")
            lines.append("|---|---|---|---|---|")

            for name, total, succ, fail, dur, last_t, err in rows:
                rate = (succ / total * 100) if total > 0 else 100.0
                avg_ms = (dur / total) if total > 0 else 0.0
                status = "🟢 Healthy" if rate >= 80 else ("🟡 Degrading" if rate >= 50 else "🔴 High Error Rate")
                lines.append(f"| `{name}` | {total} | {rate:.1f}% | {avg_ms:.1f}ms | {status} |")

            return "\n".join(lines)
        except Exception as ex:
            return f"error generating telemetry report: {ex}"


_TELEMETRY = TelemetryStore()


def _invert_6x6(matrix: list[list[float]]) -> list[list[float]]:
    """Invert a 6x6 matrix using Gauss-Jordan elimination."""
    n = 6
    # Create augmented matrix [A | I]
    aug = [matrix[i][:] + [1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    for i in range(n):
        # Pivot
        pivot = aug[i][i]
        if abs(pivot) < 1e-9:
            pivot = 1e-9
        for j in range(2 * n):
            aug[i][j] /= pivot
        for k in range(n):
            if k != i:
                factor = aug[k][i]
                for j in range(2 * n):
                    aug[k][j] -= factor * aug[i][j]
    return [row[n:] for row in aug]


def extract_context_features(messages: list[dict] | None = None) -> list[float]:
    """Extract a 6-dimensional task context feature vector x in R^6."""
    if not messages:
        return [1.0, 0.0, 0.0, 0.0, 0.0, 0.0]

    last_content = str(messages[-1].get("content") or "").lower()
    return [
        1.0,  # Bias
        1.0 if any(k in last_content for k in ("error", "traceback", "syntax", "line ", "failed", "exit code")) else 0.0,  # Error signal
        1.0 if any(k in last_content for k in ("search", "how to", "docs", "api", "what is", "where is")) else 0.0,  # Search signal
        1.0 if any(k in last_content for k in ("edit", "replace", "fix", "patch", "modify", "update")) else 0.0,  # Edit signal
        1.0 if any(k in last_content for k in ("csv", "sqlite", "skill", "macro", "scrape", "table")) else 0.0,  # Skill/Data signal
        1.0 if any(k in last_content for k in ("delegate", "subagent", "researcher", "tester", "swarm")) else 0.0,  # Swarm signal
    ]


class LinUCBBanditRouter:
    """Contextual Multi-Armed Bandit using LinUCB (Li et al. 2010) with sublinear regret bounds."""

    def __init__(self, d: int = 6, alpha: float = 1.0):
        self.d = d
        self.alpha = alpha
        # For each tool: A_a in R^{dxd}, b_a in R^d
        self.A: dict[str, list[list[float]]] = {}
        self.b: dict[str, list[float]] = {}

    def _ensure_arm(self, tool_name: str):
        if tool_name not in self.A:
            # Initialize with Identity matrix I_d for ridge regularization
            self.A[tool_name] = [[1.0 if i == j else 0.0 for j in range(self.d)] for i in range(self.d)]
            self.b[tool_name] = [0.0 for _ in range(self.d)]

    def score_arm(self, tool_name: str, x: list[float]) -> float:
        self._ensure_arm(tool_name)
        A_inv = _invert_6x6(self.A[tool_name])
        b_vec = self.b[tool_name]

        # theta_hat = A_inv * b
        theta_hat = [sum(A_inv[i][j] * b_vec[j] for j in range(self.d)) for i in range(self.d)]

        # Mean payoff = theta_hat^T * x
        mean_payoff = sum(theta_hat[i] * x[i] for i in range(self.d))

        # Confidence bound = sqrt(x^T * A_inv * x)
        A_inv_x = [sum(A_inv[i][j] * x[j] for j in range(self.d)) for i in range(self.d)]
        variance = max(0.0, sum(x[i] * A_inv_x[i] for i in range(self.d)))
        confidence_bound = self.alpha * math.sqrt(variance)

        return mean_payoff + confidence_bound

    def update_arm(self, tool_name: str, x: list[float], reward: float):
        self._ensure_arm(tool_name)
        # A_a += x * x^T
        for i in range(self.d):
            for j in range(self.d):
                self.A[tool_name][i][j] += x[i] * x[j]
        # b_a += reward * x
        for i in range(self.d):
            self.b[tool_name][i] += reward * x[i]


_LINUCB = LinUCBBanditRouter()


def record_tool_call(tool_name: str, duration_ms: float, is_success: bool, error: str = "", context_messages: list[dict] | None = None):
    _TELEMETRY.record_call(tool_name, duration_ms, is_success, error)
    reward = 1.0 if is_success else 0.0
    features = extract_context_features(context_messages)
    _LINUCB.update_arm(tool_name, features, reward)


def score_tool_linucb(tool_name: str, messages: list[dict] | None = None) -> float:
    features = extract_context_features(messages)
    return _LINUCB.score_arm(tool_name, features)


def get_telemetry_report() -> str:
    return _TELEMETRY.get_report()

