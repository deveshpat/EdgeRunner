"""Tests for the /api/terminal/exec, /api/files/* endpoints, and TerminalHarness."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.harnesses.terminal import TerminalHarness
from app.main import app
from app.schemas import ChatRequest

client = TestClient(app)


def test_terminal_exec_success():
    resp = client.post("/api/terminal/exec", json={"command": "echo 'api test ok'"})
    assert resp.status_code == 200
    data = resp.json()
    assert "api test ok" in data["output"]
    assert data["exit_code"] == 0
    assert "duration_ms" in data


def test_terminal_exec_empty_command():
    resp = client.post("/api/terminal/exec", json={"command": "   "})
    assert resp.status_code == 400


def test_files_api_flow():
    # 1. Write file
    resp = client.post("/api/files/write", json={"path": "api_test/file.py", "content": "print('hello from api')"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"

    # 2. Read file
    resp = client.get("/api/files/read?path=api_test/file.py")
    assert resp.status_code == 200
    assert resp.json()["content"] == "print('hello from api')"

    # 3. File Tree
    resp = client.get("/api/files/tree")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert any(it["name"] == "api_test" for it in items)

    # 4. Run the file via terminal
    exec_resp = client.post("/api/terminal/exec", json={"command": "python3 api_test/file.py"})
    assert exec_resp.status_code == 200
    assert "hello from api" in exec_resp.json()["output"]

    # 5. Delete file
    del_resp = client.delete("/api/files/delete?path=api_test/file.py")
    assert del_resp.status_code == 200

    # 6. Delete directory
    del_dir_resp = client.delete("/api/files/delete?path=api_test")
    assert del_dir_resp.status_code == 200


def test_files_api_traversal_protection():
    resp = client.get("/api/files/read?path=../../etc/passwd")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_terminal_harness_stream():
    harness = TerminalHarness()
    req = ChatRequest(
        model="local",
        harness="terminal",
        messages=[{"role": "user", "content": "echo 'from harness'"}],
    )
    events = [ev async for ev in harness.run(req)]
    assert any(e.type == "token" and "from harness" in e.data for e in events)
    assert events[-1].type == "done"
