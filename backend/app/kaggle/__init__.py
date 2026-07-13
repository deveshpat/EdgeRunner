"""Kaggle orchestration: pack, push, and monitor the worker kernel.

Only used when the backend runs locally as the control plane. The `kaggle`
package is imported lazily so the core backend works without it installed.
"""
