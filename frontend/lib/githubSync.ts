"use client";

import { vfs } from "./wasmShell";
import { gitManager } from "./gitManager";

export interface GitHubSyncOptions {
  token: string;
  repo: string; // "owner/repo"
  branch?: string;
  message?: string;
}

export interface SyncProgressCallback {
  (status: string): void;
}

/**
 * 2-Way GitHub Push & Pull Sync Engine.
 */
export const githubSync = {
  /**
   * Push all VFS files to a remote GitHub repository.
   */
  async push(
    opts: GitHubSyncOptions,
    onProgress?: SyncProgressCallback,
  ): Promise<{ commitUrl: string; sha: string }> {
    const { token, repo, branch = "main", message = "Update from EdgeRunner IDE" } = opts;
    if (!token) throw new Error("GitHub Personal Access Token is required.");
    if (!repo || !repo.includes("/")) throw new Error("Target repository must be in format 'owner/repo'.");

    const cleanToken = token.trim();
    const cleanRepo = repo.trim();
    const headers = {
      Authorization: `Bearer ${cleanToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };

    onProgress?.(`1/5 Connecting to GitHub repo '${cleanRepo}'…`);

    // 1. Get reference to current branch head
    let parentCommitSha: string | null = null;
    const refRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/refs/heads/${branch}`, {
      headers,
    });

    if (refRes.ok) {
      const refData = await refRes.json();
      parentCommitSha = refData.object?.sha || null;
    }

    // 2. Upload blobs for all VFS files
    const entries = vfs.getAllEntries();
    if (entries.length === 0) {
      throw new Error("Workspace is empty. Nothing to push.");
    }

    onProgress?.(`2/5 Uploading ${entries.length} workspace files…`);
    const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];

    for (const entry of entries) {
      const blobRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/blobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: entry.content,
          encoding: "utf-8",
        }),
      });

      if (!blobRes.ok) {
        const err = await blobRes.text();
        throw new Error(`Failed to upload blob '${entry.path}': ${err}`);
      }

      const blobData = await blobRes.json();
      treeItems.push({
        path: entry.path.replace(/^\//, ""),
        mode: "100644",
        type: "blob",
        sha: blobData.sha,
      });
    }

    // 3. Create new Tree
    onProgress?.("3/5 Creating Git DAG Tree on GitHub…");
    const treePayload: any = { tree: treeItems };
    if (parentCommitSha) treePayload.base_tree = parentCommitSha;

    const treeRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify(treePayload),
    });

    if (!treeRes.ok) {
      const err = await treeRes.text();
      throw new Error(`Failed to create Git tree: ${err}`);
    }
    const treeData = await treeRes.json();

    // 4. Create Commit
    onProgress?.("4/5 Creating commit object…");
    const commitPayload: any = {
      message,
      tree: treeData.sha,
    };
    if (parentCommitSha) commitPayload.parents = [parentCommitSha];

    const commitRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify(commitPayload),
    });

    if (!commitRes.ok) {
      const err = await commitRes.text();
      throw new Error(`Failed to create commit: ${err}`);
    }
    const commitData = await commitRes.json();

    // 5. Update branch reference
    onProgress?.(`5/5 Updating branch '${branch}'…`);
    const updateRefRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        sha: commitData.sha,
        force: true,
      }),
    });

    if (!updateRefRes.ok && updateRefRes.status === 404) {
      // Create branch if not exists
      await fetch(`https://api.github.com/repos/${cleanRepo}/git/refs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: commitData.sha,
        }),
      });
    }

    // Record in local in-house Git
    gitManager.commit(`[GitHub Push] ${message}`);

    onProgress?.("✓ Successfully pushed to GitHub!");
    return {
      commitUrl: `https://github.com/${cleanRepo}/commit/${commitData.sha}`,
      sha: commitData.sha,
    };
  },

  /**
   * Pull all files from a remote GitHub repository into local VFS.
   */
  async pull(
    opts: GitHubSyncOptions,
    onProgress?: SyncProgressCallback,
  ): Promise<{ filesCount: number; branch: string }> {
    const { token, repo, branch = "main" } = opts;
    if (!repo || !repo.includes("/")) throw new Error("Target repository must be in format 'owner/repo'.");

    const cleanToken = token ? token.trim() : "";
    const cleanRepo = repo.trim();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
    };
    if (cleanToken) headers.Authorization = `Bearer ${cleanToken}`;

    onProgress?.(`Fetching tree for '${cleanRepo}@${branch}'…`);

    const treeRes = await fetch(
      `https://api.github.com/repos/${cleanRepo}/git/trees/${branch}?recursive=1`,
      { headers },
    );

    if (!treeRes.ok) {
      const err = await treeRes.text();
      throw new Error(`Failed to fetch GitHub repository tree: ${err}`);
    }

    const treeData = await treeRes.json();
    const blobs = (treeData.tree || []).filter((item: any) => item.type === "blob");

    onProgress?.(`Downloading ${blobs.length} files from GitHub…`);
    let downloaded = 0;

    for (const item of blobs) {
      const rawRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/blobs/${item.sha}`, {
        headers,
      });
      if (rawRes.ok) {
        const blobData = await rawRes.json();
        let content = "";
        if (blobData.encoding === "base64") {
          content = decodeURIComponent(escape(atob(blobData.content.replace(/\s/g, ""))));
        } else {
          content = blobData.content || "";
        }
        vfs.writeFile(item.path, content);
        downloaded++;
        onProgress?.(`Downloaded (${downloaded}/${blobs.length}): ${item.path}`);
      }
    }

    // Commit to local in-house Git
    gitManager.init();
    gitManager.add(".");
    gitManager.commit(`[GitHub Pull] Synced from ${cleanRepo}@${branch}`);

    onProgress?.(`✓ Successfully pulled ${downloaded} files from GitHub!`);
    return { filesCount: downloaded, branch };
  },

  /**
   * Clone a GitHub repository into VFS.
   */
  async clone(
    urlOrRepo: string,
    targetDir?: string,
    token?: string,
    onProgress?: SyncProgressCallback,
  ): Promise<{ repo: string; filesCount: number; branch: string; targetDir: string }> {
    let clean = urlOrRepo.trim();
    // Parse out owner/repo from URL
    clean = clean.replace(/\.git$/i, "");
    clean = clean.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
    clean = clean.replace(/^git@github\.com:/i, "");
    clean = clean.replace(/^\/+/, "");

    const parts = clean.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`Invalid GitHub repository or URL: '${urlOrRepo}'. Format: 'owner/repo' or 'https://github.com/owner/repo.git'`);
    }

    const repo = `${parts[0]}/${parts[1]}`;
    const repoName = parts[1];
    const destination = targetDir || "";

    const cleanToken = token ? token.trim() : (typeof window !== "undefined" ? localStorage.getItem("edgerunner.git.token") || "" : "");
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
    };
    if (cleanToken) headers.Authorization = `Bearer ${cleanToken}`;

    onProgress?.(`Cloning into '${destination || repoName}'…`);

    // 1. Determine default branch
    let branch = "main";
    try {
      const repoMetaRes = await fetch(`https://api.github.com/repos/${repo}`, { headers });
      if (repoMetaRes.ok) {
        const meta = await repoMetaRes.json();
        if (meta.default_branch) branch = meta.default_branch;
      }
    } catch {
      // ignore
    }

    // 2. Fetch git tree recursively
    onProgress?.(`remote: Enumerating objects from ${branch} branch…`);
    let treeRes = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
      { headers },
    );

    if (!treeRes.ok && branch === "main") {
      // try master
      branch = "master";
      treeRes = await fetch(
        `https://api.github.com/repos/${repo}/git/trees/master?recursive=1`,
        { headers },
      );
    }

    if (!treeRes.ok) {
      const err = await treeRes.text();
      throw new Error(`Failed to clone '${repo}': ${err}`);
    }

    const treeData = await treeRes.json();
    const blobs = (treeData.tree || []).filter((item: any) => item.type === "blob");

    onProgress?.(`remote: Counting objects: ${blobs.length}, done.`);
    let downloaded = 0;

    for (const item of blobs) {
      const rawRes = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${item.sha}`, {
        headers,
      });

      if (rawRes.ok) {
        const blobData = await rawRes.json();
        let content = "";
        if (blobData.encoding === "base64") {
          content = decodeURIComponent(escape(atob(blobData.content.replace(/\s/g, ""))));
        } else {
          content = blobData.content || "";
        }

        const filePath = destination
          ? `${destination.replace(/\/$/, "")}/${item.path.replace(/^\//, "")}`
          : item.path;

        vfs.writeFile(filePath, content);
        downloaded++;
        if (downloaded % 5 === 0 || downloaded === blobs.length) {
          onProgress?.(`Receiving objects: ${Math.round((downloaded / blobs.length) * 100)}% (${downloaded}/${blobs.length}), done.`);
        }
      }
    }

    // Save active repo in localStorage
    if (typeof window !== "undefined") {
      localStorage.setItem("edgerunner.git.repo", repo);
      localStorage.setItem("edgerunner.git.branch", branch);
    }

    // Initialize local in-house Git
    gitManager.init();
    gitManager.add(".");
    gitManager.commit(`Initial clone of ${repo}@${branch}`);

    return {
      repo,
      filesCount: downloaded,
      branch,
      targetDir: destination || repoName,
    };
  },
};
