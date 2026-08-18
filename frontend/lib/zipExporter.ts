"use client";

import { vfs } from "./wasmShell";

/**
 * Lightweight Zero-Dependency Pure JS ZIP Generator (PKZip Standard).
 */
function createZipBuffer(files: Array<{ path: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const fileEntries: Array<{
    nameBytes: Uint8Array;
    contentBytes: Uint8Array;
    offset: number;
    crc32: number;
  }> = [];

  let currentOffset = 0;
  const localHeaders: Uint8Array[] = [];

  // CRC32 table & calculation
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
  }

  function calcCrc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  for (const f of files) {
    const cleanName = f.path.replace(/^\//, "");
    const nameBytes = encoder.encode(cleanName);
    const contentBytes = encoder.encode(f.content);
    const crc = calcCrc32(contentBytes);

    const header = new Uint8Array(30 + nameBytes.length + contentBytes.length);
    const view = new DataView(header.buffer);

    // Local file header signature = 0x04034b50
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true);  // flags
    view.setUint16(8, 0, true);  // compression = 0 (stored)
    view.setUint16(10, 0, true); // mod time
    view.setUint16(12, 0, true); // mod date
    view.setUint32(14, crc, true); // crc32
    view.setUint32(18, contentBytes.length, true); // compressed size
    view.setUint32(22, contentBytes.length, true); // uncompressed size
    view.setUint16(26, nameBytes.length, true); // file name length
    view.setUint16(28, 0, true); // extra field length

    header.set(nameBytes, 30);
    header.set(contentBytes, 30 + nameBytes.length);

    fileEntries.push({
      nameBytes,
      contentBytes,
      offset: currentOffset,
      crc32: crc,
    });

    localHeaders.push(header);
    currentOffset += header.length;
  }

  // Central Directory
  const centralDirStart = currentOffset;
  const centralHeaders: Uint8Array[] = [];

  for (const entry of fileEntries) {
    const ch = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(ch.buffer);

    // Central directory header signature = 0x02014b50
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);  // version made by
    view.setUint16(6, 20, true);  // version needed
    view.setUint16(8, 0, true);   // flags
    view.setUint16(10, 0, true);  // compression (stored)
    view.setUint16(12, 0, true);  // mod time
    view.setUint16(14, 0, true);  // mod date
    view.setUint32(16, entry.crc32, true);
    view.setUint32(20, entry.contentBytes.length, true);
    view.setUint32(24, entry.contentBytes.length, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, 0, true);  // extra len
    view.setUint16(32, 0, true);  // comment len
    view.setUint16(34, 0, true);  // disk start
    view.setUint16(36, 0, true);  // internal attr
    view.setUint32(38, 0, true);  // external attr
    view.setUint32(42, entry.offset, true); // local header offset

    ch.set(entry.nameBytes, 46);
    centralHeaders.push(ch);
    currentOffset += ch.length;
  }

  const centralDirSize = currentOffset - centralDirStart;

  // End of Central Directory Record (EOCD)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
  eocdView.setUint16(4, 0, true); // disk num
  eocdView.setUint16(6, 0, true); // start disk
  eocdView.setUint16(8, fileEntries.length, true); // total entries on disk
  eocdView.setUint16(10, fileEntries.length, true); // total entries
  eocdView.setUint32(12, centralDirSize, true); // size of central dir
  eocdView.setUint32(16, centralDirStart, true); // offset of central dir
  eocdView.setUint16(20, 0, true); // comment len

  // Combine into single Uint8Array
  const totalLength = currentOffset + eocd.length;
  const finalZip = new Uint8Array(totalLength);

  let pos = 0;
  for (const h of localHeaders) {
    finalZip.set(h, pos);
    pos += h.length;
  }
  for (const ch of centralHeaders) {
    finalZip.set(ch, pos);
    pos += ch.length;
  }
  finalZip.set(eocd, pos);

  return finalZip;
}

export const zipExporter = {
  /**
   * Export entire VFS workspace as a downloadable .zip archive.
   */
  downloadWorkspaceZip(filename: string = `edgerunner-project-${new Date().toISOString().slice(0, 10)}.zip`) {
    const entries = vfs.getAllEntries();
    if (entries.length === 0) {
      alert("Workspace is empty. Create or add files first.");
      return;
    }

    const zipBuffer = createZipBuffer(entries);
    const blob = new Blob([zipBuffer], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  downloadZip(filename?: string) {
    this.downloadWorkspaceZip(filename);
  },

  /**
   * Publish workspace files directly to a GitHub Gist.
   */
  async publishGist(
    token: string,
    description: string = "Created with EdgeRunner AI Workstation",
    isPublic: boolean = false,
  ): Promise<{ gistUrl: string; htmlUrl: string }> {
    if (!token) throw new Error("GitHub token required to publish Gist.");
    const entries = vfs.getAllEntries();
    if (entries.length === 0) throw new Error("Workspace is empty.");

    const gistFiles: Record<string, { content: string }> = {};
    for (const e of entries) {
      const cleanName = e.path.replace(/^\//, "").replace(/\//g, "_");
      gistFiles[cleanName] = { content: e.content };
    }

    const res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description,
        public: isPublic,
        files: gistFiles,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to publish Gist: ${err}`);
    }

    const data = await res.json();
    return {
      gistUrl: data.url,
      htmlUrl: data.html_url,
    };
  },
};
