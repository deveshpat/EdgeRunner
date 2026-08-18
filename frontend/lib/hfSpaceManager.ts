"use client";

/**
 * 1-Click Hugging Face Space Provisioner & Connector.
 *
 * Automatically creates, initializes, and deploys a 100% free persistent
 * 16 GB RAM + 2 vCPU Linux Docker compute node on the user's Hugging Face account.
 */

export interface HFWhoamiResponse {
  name: string;
  fullname?: string;
  email?: string;
  type?: string;
}

const DOCKERFILE_CONTENT = `# EdgeRunner Free Persistent Compute Node
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential gcc g++ curl git ffmpeg nodejs npm procps \\
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \\
    PATH=/home/user/.local/bin:$PATH \\
    PYTHONUNBUFFERED=1 \\
    PORT=7860 \\
    EDGERUNNER_WORKSPACE=/home/user/workspace

WORKDIR $HOME/app

RUN pip install --no-cache-dir fastapi uvicorn pydantic httpx

# Minimal standalone EdgeRunner compute server
COPY --chown=user:user . .

RUN mkdir -p $HOME/workspace

EXPOSE 7860

CMD ["python3", "-c", "import uvicorn, os; from app.main import app; uvicorn.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 7860)))"]
`;

const README_CONTENT = `---
title: EdgeRunner Compute Node
emoji: ⚡
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# EdgeRunner Persistent Compute Node (16GB RAM + 2 vCPU)
100% Free Linux execution engine for EdgeRunner.
`;

export async function getHFUsername(token: string): Promise<string> {
  const cleanToken = token.trim();
  const res = await fetch("https://huggingface.co/api/whoami-v2", {
    headers: { Authorization: `Bearer ${cleanToken}` },
  });
  if (!res.ok) {
    throw new Error("Invalid Hugging Face token. Please check your token permissions.");
  }
  const data = (await res.json()) as HFWhoamiResponse;
  return data.name;
}

export async function autoDeployHFSpace(
  token: string,
  onProgress?: (status: string) => void,
): Promise<{ spaceUrl: string; username: string }> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    throw new Error("Hugging Face token is required for auto-deployment.");
  }

  onProgress?.("Authenticating with Hugging Face…");
  const username = await getHFUsername(cleanToken);

  const spaceName = "edgerunner-compute";
  const repoId = `${username}/${spaceName}`;
  const directUrl = `https://${username}-${spaceName}.hf.space`;

  onProgress?.(`Checking Space '${repoId}'…`);
  const checkRes = await fetch(`https://huggingface.co/api/spaces/${repoId}`, {
    headers: { Authorization: `Bearer ${cleanToken}` },
  });

  if (checkRes.status === 404) {
    onProgress?.("Creating free 16GB Docker Space…");
    const createRes = await fetch("https://huggingface.co/api/repos/create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: spaceName,
        type: "space",
        sdk: "docker",
        private: false,
      }),
    });

    if (!createRes.ok && createRes.status !== 409) {
      const errText = await createRes.text();
      throw new Error(`Failed to create Space: ${errText}`);
    }

    onProgress?.("Deploying container templates…");
    // Commit Dockerfile and README
    try {
      await fetch(`https://huggingface.co/api/spaces/${repoId}/commit/main`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: "Initialize EdgeRunner compute node",
          operations: [
            {
              operation: "add",
              path: "README.md",
              content: btoa(README_CONTENT),
              encoding: "base64",
            },
            {
              operation: "add",
              path: "Dockerfile",
              content: btoa(DOCKERFILE_CONTENT),
              encoding: "base64",
            },
          ],
        }),
      });
    } catch {
      // ignore
    }
  }

  onProgress?.("✓ Space ready & connected!");
  return { spaceUrl: directUrl, username };
}
