# Running the EdgeRunner backend on Kaggle

The web app has no backend of its own — you run one on Kaggle (free CPU or a T4
GPU) and paste its URL into the app. There is **no Kaggle API key** and no
auto-launch: you start the notebook, you get a URL, you connect.

## Steps

1. Create a new [Kaggle Notebook](https://www.kaggle.com/code). In the sidebar,
   turn **Internet ON** (required for the tunnel). Optionally set the
   **Accelerator** to **GPU T4** for faster generation.
2. Copy the contents of [`run_on_kaggle.py`](./run_on_kaggle.py) into a single
   cell and run it. (On a GPU session, set `GPU = True` at the top.)
3. Wait for the banner:

   ```
   ============================================================
   EDGERUNNER_URL=https://something.trycloudflare.com
   ============================================================
   ```

4. In the EdgeRunner web app: **⚙ settings → paste the URL → connect**. The app
   shows `backend: online` and you can chat.

Leave the Kaggle cell running while you use the app. Stopping the cell (or the
session) takes the backend offline; just re-run it to get a fresh URL.

## Notes

- **Just testing the connection?** Set `MODEL_FILE = None` in the script. The
  backend comes up instantly and the **Echo (mock)** harness works; real chat
  (llama.cpp) needs a model.
- The tunnel URL changes every run (cloudflared quick tunnels are ephemeral).
- Pick a bigger model by editing `MODEL_REPO` / `MODEL_FILE` (any single-file
  GGUF on the HF Hub). The 7B reasoning models want the GPU.
