"use client";

import { useCallback, useEffect, useState } from "react";
import { getBackendBase } from "@/lib/api";
import { vfs } from "@/lib/wasmShell";

export interface FileItem {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  mtime?: number;
  children?: FileItem[];
}

export interface UseWorkspaceFiles {
  items: FileItem[];
  root: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  readFile: (path: string) => Promise<{ content: string; size: number; name: string }>;
  writeFile: (path: string, content: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<boolean>;
  deleteItem: (path: string) => Promise<boolean>;
}

function buildVfsTree(): FileItem[] {
  const entries = vfs.getAllEntries();
  const rootItems: FileItem[] = [];
  const dirMap = new Map<string, FileItem>();

  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let currentPath = "";
    let parentChildren = rootItems;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (isFile) {
        parentChildren.push({
          name: part,
          path: entry.path,
          type: "file",
          size: entry.content.length,
          mtime: entry.mtime,
        });
      } else {
        let dirItem = dirMap.get(currentPath);
        if (!dirItem) {
          dirItem = {
            name: part,
            path: currentPath,
            type: "directory",
            children: [],
          };
          dirMap.set(currentPath, dirItem);
          parentChildren.push(dirItem);
        }
        parentChildren = dirItem.children!;
      }
    }
  }

  return rootItems;
}

export function useWorkspaceFiles(): UseWorkspaceFiles {
  const [items, setItems] = useState<FileItem[]>([]);
  const [root, setRoot] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = getBackendBase();
      const url = `${base}/api/files/tree`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { root: string; items: FileItem[] };
        setRoot(data.root);
        setItems(data.items || []);
        return;
      }
    } catch {
      // Backend offline -> Fallback to client-side Virtual Filesystem (VFS)
    } finally {
      setLoading(false);
    }

    // Load from local VFS
    setRoot("/workspace");
    setItems(buildVfsTree());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const readFile = useCallback(
    async (path: string): Promise<{ content: string; size: number; name: string }> => {
      try {
        const base = getBackendBase();
        const url = `${base}/api/files/read?path=${encodeURIComponent(path)}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          return { content: data.content, size: data.size, name: data.name };
        }
      } catch {
        // Backend offline -> Read from VFS
      }

      const content = vfs.readFile(path);
      if (content !== null) {
        return { content, size: content.length, name: path.split("/").pop() || path };
      }
      throw new Error(`File not found: ${path}`);
    },
    [],
  );

  const writeFile = useCallback(
    async (path: string, content: string): Promise<boolean> => {
      try {
        const base = getBackendBase();
        const url = `${base}/api/files/write`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, content }),
        });
        if (res.ok) {
          await refresh();
          return true;
        }
      } catch {
        // Backend offline -> Write to VFS
      }

      vfs.writeFile(path, content);
      await refresh();
      return true;
    },
    [refresh],
  );

  const deleteItem = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const base = getBackendBase();
        const url = `${base}/api/files/delete?path=${encodeURIComponent(path)}`;
        const res = await fetch(url, { method: "DELETE" });
        if (res.ok) {
          await refresh();
          return true;
        }
      } catch {
        // Backend offline -> Delete from VFS
      }

      vfs.deleteFile(path);
      await refresh();
      return true;
    },
    [refresh],
  );

  const mkdir = useCallback(
    async (path: string): Promise<boolean> => {
      const cleanPath = path.trim().replace(/^\/+|\/+$/g, "");
      if (!cleanPath) return false;
      const keepFile = `${cleanPath}/.keep`;

      try {
        const base = getBackendBase();
        const url = `${base}/api/files/write`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: keepFile, content: "" }),
        });
        if (res.ok) {
          await refresh();
          return true;
        }
      } catch {
        // Backend offline -> Write to VFS
      }

      vfs.writeFile(keepFile, "");
      await refresh();
      return true;
    },
    [refresh],
  );

  return {
    items,
    root,
    loading,
    error,
    refresh,
    readFile,
    writeFile,
    mkdir,
    deleteItem,
  };
}
