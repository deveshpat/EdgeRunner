"""Model Manager for EdgeRunner.

Manages downloading GGUF models from Hugging Face and hot-swapping the local
llama-server subprocess dynamically without restarting the FastAPI backend.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 EdgeRunner/0.1.0"
)


def _publish_event(msg: str) -> None:
    topic = os.getenv("EDGERUNNER_RENDEZVOUS_TOPIC")
    if topic:
        try:
            req = urllib.request.Request(
                f"https://ntfy.sh/{topic}",
                data=msg.encode("utf-8"),
                headers={"User-Agent": "EdgeRunner", "X-Cache": "yes"},
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass


@dataclass
class HardwareInfo:
    gpu: bool
    gpu_name: str | None
    vram_gb: float | None
    ram_gb: float | None


@dataclass
class ModelStatus:
    status: str  # "idle" | "downloading" | "loading" | "ready" | "error"
    model_id: str | None
    repo: str | None
    file: str | None
    progress: float  # 0 to 100
    downloaded_mb: float
    total_mb: float
    error: str | None
    hardware: HardwareInfo

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ModelManager:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._server_proc: subprocess.Popen | None = None
        self._models_dir = Path(settings.models_dir)
        self._models_dir.mkdir(parents=True, exist_ok=True)

        self.status = "idle"
        self.model_id: str | None = None
        self.repo: str | None = None
        self.file: str | None = None
        self.progress: float = 0.0
        self.downloaded_mb: float = 0.0
        self.total_mb: float = 0.0
        self.error: str | None = None

        self._hardware = self._detect_hardware()

    def _detect_hardware(self) -> HardwareInfo:
        gpu = False
        gpu_name = None
        vram_gb = None
        ram_gb = None

        # Detect RAM
        try:
            import psutil  # type: ignore

            ram_gb = round(psutil.virtual_memory().total / (1024**3), 1)
        except Exception:
            try:
                mem_bytes = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
                ram_gb = round(mem_bytes / (1024**3), 1)
            except Exception:
                ram_gb = 16.0

        # Detect GPU via nvidia-smi
        if shutil.which("nvidia-smi"):
            try:
                out = subprocess.check_output(
                    [
                        "nvidia-smi",
                        "--query-gpu=name,memory.total",
                        "--format=csv,noheader,nounits",
                    ],
                    timeout=3,
                    text=True,
                )
                line = out.strip().split("\n")[0]
                parts = [p.strip() for p in line.split(",")]
                if parts:
                    gpu = True
                    gpu_name = parts[0]
                    if len(parts) > 1:
                        vram_gb = round(float(parts[1]) / 1024.0, 1)
            except Exception:
                pass

        # Detect GPU via PyTorch if nvidia-smi failed
        if not gpu:
            try:
                import torch  # type: ignore

                if torch.cuda.is_available():
                    gpu = True
                    gpu_name = torch.cuda.get_device_name(0)
                    vram_gb = round(
                        torch.cuda.get_device_properties(0).total_memory / (1024**3), 1
                    )
            except Exception:
                pass

        return HardwareInfo(
            gpu=gpu, gpu_name=gpu_name, vram_gb=vram_gb, ram_gb=ram_gb
        )

    def get_hardware(self) -> HardwareInfo:
        return self._hardware

    def _sync_live_server(self) -> None:
        """If llama-server is answering but status is idle, sync active model info."""
        if self.status == "idle" and self._is_server_alive():
            try:
                req = urllib.request.Request("http://127.0.0.1:8080/v1/models")
                with urllib.request.urlopen(req, timeout=1.5) as r:
                    import json

                    data = json.loads(r.read().decode("utf-8")).get("data", [])
                    if data:
                        mid = data[0].get("id", "")
                        if mid:
                            self.model_id = mid
                            self.file = f"{mid}.gguf" if not mid.endswith(".gguf") else mid
                            self.status = "ready"
            except Exception:
                pass

    def get_status(self) -> ModelStatus:
        self._sync_live_server()
        return ModelStatus(
            status=self.status,
            model_id=self.model_id,
            repo=self.repo,
            file=self.file,
            progress=self.progress,
            downloaded_mb=round(self.downloaded_mb, 1),
            total_mb=round(self.total_mb, 1),
            error=self.error,
            hardware=self._hardware,
        )

    def _find_local_model(self, fname: str) -> Path | None:
        """Find an already downloaded GGUF file locally across search paths."""
        candidates = [
            self._models_dir / fname,
            self._models_dir / f"{fname}.gguf",
            Path(".") / fname,
            Path(".") / "models" / fname,
            Path("/kaggle/working/edgerunner") / fname,
            Path("/kaggle/working/edgerunner/models") / fname,
        ]
        for c in candidates:
            if c.exists() and c.is_file() and c.stat().st_size > 0:
                return c

        # Scan models directory for case-insensitive match or stem match
        clean_stem = fname.replace(".gguf", "").lower()
        if self._models_dir.exists():
            for f in self._models_dir.glob("*.gguf"):
                if f.stem.lower() == clean_stem or f.name.lower() == fname.lower():
                    if f.stat().st_size > 0:
                        return f
        return None

    def _get_dest_path(self, fname: str) -> Path:
        local = self._find_local_model(fname)
        if local:
            return local
        return self._models_dir / fname

    async def download_file(
        self, repo: str, fname: str, token: str | None = None
    ) -> Path:
        dest = self._get_dest_path(fname)
        token = token or settings.hf_token or os.getenv("HF_TOKEN", "")

        url = f"https://huggingface.co/{repo}/resolve/main/{fname}?download=true"
        self.status = "downloading"
        self.progress = 0.0
        self.downloaded_mb = 0.0
        self.total_mb = 0.0
        self.error = None

        logger.info(f"Downloading model {repo}/{fname} -> {dest}")

        def _do_download():
            # 1. Try huggingface_hub first if available (fast multi-threaded download)
            try:
                from huggingface_hub import hf_hub_download

                logger.info(
                    f"Using huggingface_hub for fast multi-part download: {repo}/{fname}"
                )
                _publish_event(
                    f"[edgerunner] downloading {fname} via HF Hub high-speed pipeline…"
                )
                downloaded_path = hf_hub_download(
                    repo_id=repo,
                    filename=fname,
                    local_dir=str(self._models_dir),
                    token=token or None,
                )
                p = Path(downloaded_path)
                if p.exists() and p.stat().st_size > 0:
                    self.progress = 100.0
                    self.downloaded_mb = round(p.stat().st_size / (1024 * 1024), 1)
                    self.total_mb = self.downloaded_mb
                    _publish_event(
                        f"[edgerunner] model downloaded ({int(self.downloaded_mb)} MB)"
                    )
                    return p
            except Exception as e:
                logger.info(
                    f"hf_hub_download not used ({e}), streaming with optimized HTTPX engine"
                )

            # 2. Resumed HTTPX Stream Engine with HTTP 206 Range support
            req_headers = {"User-Agent": _UA, "Accept": "*/*"}
            if token:
                req_headers["Authorization"] = f"Bearer {token}"

            with httpx.Client(
                follow_redirects=True,
                timeout=httpx.Timeout(
                    connect=15.0, read=60.0, write=30.0, pool=30.0
                ),
            ) as client:
                total_size = 0
                try:
                    head_resp = client.head(url, headers=req_headers)
                    if head_resp.status_code in (200, 302):
                        total_size = int(
                            head_resp.headers.get("Content-Length", 0) or 0
                        )
                        if total_size:
                            self.total_mb = round(total_size / (1024 * 1024), 1)
                except Exception as e:
                    logger.debug(f"HEAD request failed: {e}")

                max_attempts = 10
                for attempt in range(1, max_attempts + 1):
                    have = dest.stat().st_size if dest.exists() else 0
                    if total_size and have >= total_size:
                        self.progress = 100.0
                        self.downloaded_mb = round(have / (1024 * 1024), 1)
                        _publish_event(
                            f"[edgerunner] model downloaded ({int(self.downloaded_mb)} MB)"
                        )
                        return dest

                    curr_headers = dict(req_headers)
                    if have > 0:
                        curr_headers["Range"] = f"bytes={have}-"
                        logger.info(
                            f"Resuming download from byte {have} ({round(have / (1024*1024), 1)} MB)"
                        )

                    try:
                        with client.stream("GET", url, headers=curr_headers) as response:
                            if response.status_code not in (200, 206):
                                response.raise_for_status()

                            if response.status_code == 206:
                                mode = "ab"
                            else:
                                mode = "wb"
                                have = 0

                            content_len = int(
                                response.headers.get("Content-Length", 0) or 0
                            )
                            if not total_size and content_len:
                                total_size = have + content_len
                                self.total_mb = round(total_size / (1024 * 1024), 1)

                            last_publish = time.time()
                            with open(dest, mode, buffering=8 * 1024 * 1024) as f:
                                for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                                    if not chunk:
                                        continue
                                    f.write(chunk)
                                    have += len(chunk)
                                    now = time.time()
                                    if now - last_publish >= 0.5 or (
                                        total_size and have >= total_size
                                    ):
                                        self.downloaded_mb = round(
                                            have / (1024 * 1024), 1
                                        )
                                        if total_size:
                                            self.progress = round(
                                                have * 100.0 / total_size, 1
                                            )
                                            _publish_event(
                                                f"[edgerunner] downloading {fname}: {int(self.downloaded_mb)}/{int(self.total_mb)}MB ({self.progress}%)"
                                            )
                                        last_publish = now

                        if dest.exists() and (
                            not total_size or dest.stat().st_size >= total_size
                        ):
                            self.progress = 100.0
                            self.downloaded_mb = round(
                                dest.stat().st_size / (1024 * 1024), 1
                            )
                            _publish_event(
                                f"[edgerunner] model downloaded ({int(self.downloaded_mb)} MB)"
                            )
                            return dest

                    except Exception as e:
                        logger.warning(
                            f"Download attempt {attempt}/{max_attempts} error: {e}"
                        )
                        time.sleep(min(2 * attempt, 8))

            raise RuntimeError(
                f"Failed to download {repo}/{fname} from Hugging Face after {max_attempts} attempts."
            )

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _do_download)
        return dest

    def _stop_server_process(self) -> None:
        if self._server_proc is not None:
            logger.info("Stopping managed llama-server process...")
            try:
                self._server_proc.terminate()
                try:
                    self._server_proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._server_proc.kill()
            except Exception as e:
                logger.warning(f"Error stopping managed llama-server: {e}")
            finally:
                self._server_proc = None

        # Clean up any external / orphaned llama-server processes holding port 8080
        try:
            import psutil  # type: ignore

            for p in psutil.process_iter(["pid", "name", "cmdline"]):
                cmd = " ".join(p.info.get("cmdline") or [])
                if "llama_cpp.server" in cmd or "llama-server" in cmd:
                    try:
                        p.terminate()
                        p.wait(timeout=2)
                    except Exception:
                        try:
                            p.kill()
                        except Exception:
                            pass
        except Exception:
            if shutil.which("fuser"):
                subprocess.run(["fuser", "-k", "-9", "8080/tcp"], capture_output=True)
            elif shutil.which("pkill"):
                subprocess.run(["pkill", "-9", "-f", "llama_cpp.server"], capture_output=True)

        # Wait until port 8080 is verified free
        for _ in range(12):
            if not self._is_server_alive():
                break
            time.sleep(0.25)

    async def switch_model(
        self,
        repo: str,
        file: str,
        model_id: str | None = None,
        gpu: bool | None = None,
        n_ctx: int = 8192,
        hf_token: str | None = None,
    ) -> bool:
        """Download (if needed) and load model into llama-server."""
        clean_alias = file.rsplit(".", 1)[0]
        chosen_id = model_id or clean_alias

        async with self._lock:
            # Check if this exact model is already loaded and responsive
            if self.status == "ready" and self.file == file and self._is_server_alive():
                logger.info(f"Model {file} is already loaded and ready.")
                return True

            self.model_id = chosen_id
            self.repo = repo
            self.file = file
            self.error = None

            try:
                dest = self._get_dest_path(file)
                # If file does not exist or is 0 bytes, download it
                if not dest.exists() or dest.stat().st_size == 0:
                    await self.download_file(repo, file, token=hf_token)

                self.status = "loading"
                self._stop_server_process()

                dest_size_gb = dest.stat().st_size / (1024**3) if dest.exists() else 4.0
                use_gpu = gpu if gpu is not None else self._hardware.gpu
                vram = self._hardware.vram_gb or 16.0

                # Compute smart layer offloading & memory flags
                if not use_gpu:
                    gpu_layers = "0"
                    ctx_len = str(min(n_ctx, 4096) if dest_size_gb > 8.0 else n_ctx)
                elif dest_size_gb <= (vram - 2.5):
                    # Pure GPU offload (1B - 14B models)
                    gpu_layers = "-1"
                    ctx_len = str(n_ctx)
                elif dest_size_gb <= 23.0:
                    # Hybrid GPU+RAM offload (14B - 32B models, e.g. DeepSeek-R1 32B, Qwen 32B)
                    gpu_layers = "28"
                    ctx_len = str(min(n_ctx, 4096))
                else:
                    # Multi-tier offload for 70B+ / MoE models (Colibri / llama.cpp SSD+RAM+VRAM streaming)
                    gpu_layers = "16"
                    ctx_len = str(min(n_ctx, 4096))

                num_threads = str(min(os.cpu_count() or 4, 8))
                log_path = self._models_dir / "llama_server.log"
                cmd = [
                    sys.executable,
                    "-m",
                    "llama_cpp.server",
                    "--model",
                    str(dest),
                    "--model_alias",
                    clean_alias,
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "8080",
                    "--n_ctx",
                    ctx_len,
                    "--n_batch",
                    "512",
                    "--n_gpu_layers",
                    gpu_layers,
                    "--n_threads",
                    num_threads,
                    "--flash_attn",
                    "True",
                    "--use_mmap",
                    "True",
                ]

                logger.info(f"Starting llama-server (size: {round(dest_size_gb, 1)}GB, layers: {gpu_layers}, threads: {num_threads}): {' '.join(cmd)}")
                self._server_proc = subprocess.Popen(
                    cmd,
                    stdout=open(log_path, "w"),
                    stderr=subprocess.STDOUT,
                    env=dict(os.environ),
                )

                # Wait for server to become responsive
                ready = False
                for _ in range(120):  # up to 60s
                    await asyncio.sleep(0.5)
                    if self._server_proc.poll() is not None:
                        err_log = ""
                        try:
                            err_log = log_path.read_text()[-500:]
                        except Exception:
                            pass
                        raise RuntimeError(
                            f"llama-server process exited unexpectedly with code {self._server_proc.returncode}. Log: {err_log}"
                        )
                    if self._is_server_alive():
                        ready = True
                        break

                if not ready:
                    raise RuntimeError("Timed out waiting for llama-server to start.")

                self.status = "ready"
                _publish_event("[edgerunner] llama server up — chat is live")
                logger.info(f"Model {chosen_id} is live and ready on llama-server.")
                return True

            except Exception as e:
                self.status = "error"
                self.error = str(e)
                logger.error(f"Failed to switch to model {chosen_id}: {e}", exc_info=True)
                return False

    def _is_server_alive(self) -> bool:
        try:
            req = urllib.request.Request("http://127.0.0.1:8080/v1/models")
            with urllib.request.urlopen(req, timeout=1.5) as r:
                return r.status == 200
        except Exception:
            return False


model_manager = ModelManager()
