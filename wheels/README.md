# Prebuilt wheels (fast Kaggle boot)

Compiling `llama-cpp-python` on every session is the main cold-start cost.
EdgeRunner installs **prebuilt Linux wheels** from the GitHub release tag
[`wheels-v1`](https://github.com/deveshpat/EdgeRunner/releases/tag/wheels-v1)
so pip should finish in seconds, not minutes.

## Automatic (CI)

Workflow [`.github/workflows/build-wheels.yml`](../.github/workflows/build-wheels.yml)
builds **CPU** manylinux-compatible wheels for CPython 3.10–3.12 and uploads
them to the `wheels-v1` release on push to `main` when `backend/requirements.txt`
or this folder changes (manual `workflow_dispatch` also works).

## GPU wheels (one-time on Kaggle)

CUDA builds need a GPU image. Run once:

```bash
# From a machine with Kaggle CLI authenticated:
kaggle kernels push -p scripts/kaggle_wheel_builder/
# Or paste scripts/kaggle_build_wheels.py into a Kaggle GPU notebook and run.
```

Download the output `.whl` files, then:

```bash
./scripts/publish_wheels.sh path/to/wheel_dir
```

## Layout

| File | Purpose |
|------|---------|
| `index.json` | Manifest the worker fetches to pick the right wheel URL |
| release assets | Actual `.whl` files on tag `wheels-v1` |

Bootstrap (`kaggle_worker/bootstrap.py`) order:

1. Fetch `index.json` (repo raw → release)
2. Download matching `llama-cpp-python` wheel for this Python + cpu/gpu
3. `pip install` that wheel + the rest of `requirements.txt` (`--prefer-binary`)
4. Only if the wheel is missing: fall back to source build
