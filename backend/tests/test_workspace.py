"""Tests for the workspace sandbox and path protection."""

from __future__ import annotations

import pytest

from app import workspace


def test_ensure_workspace_exists():
    path = workspace.ensure_workspace()
    assert path.exists()
    assert path.is_dir()


def test_resolve_safe_path():
    p = workspace.resolve_safe_path("foo/bar.txt")
    assert str(p).endswith("foo/bar.txt")


def test_resolve_safe_path_rejects_traversal():
    with pytest.raises(ValueError, match="Access denied: path"):
        workspace.resolve_safe_path("../../etc/passwd")


def test_workspace_file_crud():
    # Write
    rel = "tests/test_file.txt"
    res = workspace.write_file_content(rel, "hello edgerunner workspace")
    assert res["name"] == "test_file.txt"
    assert res["size"] == 26

    # Read
    read_data = workspace.read_file_content(rel)
    assert read_data["content"] == "hello edgerunner workspace"
    assert read_data["truncated"] is False

    # Tree
    tree = workspace.get_file_tree()
    assert any(item["name"] == "tests" for item in tree)

    # Delete
    deleted = workspace.delete_file_or_dir(rel)
    assert deleted is True

    # Read after delete should raise FileNotFoundError
    with pytest.raises(FileNotFoundError):
        workspace.read_file_content(rel)
