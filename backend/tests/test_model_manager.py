from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.model_manager import ModelManager, model_manager


@pytest.fixture
def client():
    return TestClient(app)


def test_hardware_detection():
    mgr = ModelManager()
    hw = mgr.get_hardware()
    assert hw.ram_gb is not None
    assert hw.ram_gb > 0
    assert isinstance(hw.gpu, bool)


def test_status_structure():
    st = model_manager.get_status()
    data = st.to_dict()
    assert "status" in data
    assert "hardware" in data
    assert "progress" in data
    assert "downloaded_mb" in data
    assert "total_mb" in data


def test_find_local_model(tmp_path: Path):
    mgr = ModelManager()
    mgr._models_dir = tmp_path

    # Create dummy GGUF
    dummy_file = tmp_path / "test_model.gguf"
    dummy_file.write_bytes(b"dummy gguf tensor bytes")

    # Match by exact filename
    found = mgr._find_local_model("test_model.gguf")
    assert found is not None and found.samefile(dummy_file)

    # Match by stem without .gguf
    found2 = mgr._find_local_model("test_model")
    assert found2 is not None and found2.samefile(dummy_file)

    # Match case-insensitively
    found3 = mgr._find_local_model("TEST_MODEL")
    assert found3 is not None and found3.samefile(dummy_file)

    # Non-existent file returns None
    assert mgr._find_local_model("non_existent_model.gguf") is None


def test_models_status_api(client: TestClient):
    resp = client.get("/api/models/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "status" in data
    assert "hardware" in data
    assert isinstance(data["hardware"]["gpu"], bool)


@patch("httpx.AsyncClient.get")
def test_models_explore_api(mock_get, client: TestClient):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = [
        {
            "id": "unsloth/Qwen3.5-4B-GGUF",
            "tags": ["gguf", "4b", "chat"],
            "downloads": 150000,
            "likes": 850,
        },
        {
            "id": "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B-GGUF",
            "tags": ["gguf", "32b", "reasoning"],
            "downloads": 500000,
            "likes": 3200,
        },
    ]
    mock_resp.raise_for_status = MagicMock()
    mock_get.return_value = mock_resp

    resp = client.get("/api/models/explore?sort=trending&limit=10")
    assert resp.status_code == 200
    data = resp.json()
    assert "models" in data
    assert len(data["models"]) >= 2
    first = data["models"][0]
    assert "id" in first
    assert "fits_hardware" in first
    assert "tier_label" in first


@patch("httpx.AsyncClient.get")
def test_models_tree_api(mock_get, client: TestClient):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = [
        {"path": "model-Q4_K_M.gguf", "size": 2500000000},
        {"path": "model-Q8_0.gguf", "size": 4200000000},
        {"path": "README.md", "size": 1200},
    ]
    mock_resp.raise_for_status = MagicMock()
    mock_get.return_value = mock_resp

    resp = client.get("/api/models/tree?repo=unsloth/Qwen3.5-4B-GGUF")
    assert resp.status_code == 200
    data = resp.json()
    assert "files" in data
    assert len(data["files"]) == 2  # README.md excluded
    assert data["files"][0]["path"] == "model-Q4_K_M.gguf"
    assert data["files"][0]["recommended"] is True


def test_models_load_api_already_ready(client: TestClient):
    with patch.object(model_manager, "status", "ready"), \
         patch.object(model_manager, "file", "test.gguf"), \
         patch.object(model_manager, "_is_server_alive", return_value=True):
        resp = client.post(
            "/api/models/load",
            json={"repo": "test/repo", "file": "test.gguf"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ready"


def test_models_load_api_dispatch(client: TestClient):
    with patch.object(model_manager, "status", "idle"), \
         patch.object(model_manager, "_is_server_alive", return_value=False), \
         patch.object(model_manager, "switch_model", new_callable=AsyncMock):
        resp = client.post(
            "/api/models/load",
            json={"repo": "unsloth/Qwen3.5-4B-GGUF", "file": "Qwen3.5-4B-Q4_K_M.gguf"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "starting"
