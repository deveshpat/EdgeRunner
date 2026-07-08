declare function importScripts(...urls: string[]): void;

declare let PdfTeXEngine: {
  new (): {
    loadEngine: () => Promise<void>;
    writeMemFSFile: (name: string, content: string) => void;
    setEngineMainFile: (name: string) => void;
    compileLaTeX: () => Promise<{ pdf?: Uint8Array; status?: number; log?: string }>;
  };
};

let engine:
  | {
      loadEngine: () => Promise<void>;
      writeMemFSFile: (name: string, content: string) => void;
      setEngineMainFile: (name: string) => void;
      compileLaTeX: () => Promise<{ pdf?: Uint8Array; status?: number; log?: string }>;
    }
  | null = null;

const workerScope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data as {
    type: string;
    id: string;
    payload: { source?: string };
  };

  try {
    if (type === "init") {
      importScripts("/swiftlatex/PdfTeXEngine.js");
      engine = new PdfTeXEngine();
      await engine.loadEngine();
      workerScope.postMessage({ type: "ready", id });
      return;
    }

    if (type === "compile") {
      if (!engine) {
        workerScope.postMessage({ type: "error", id, payload: "Latex engine not initialized" });
        return;
      }

      const source = payload.source || "";
      engine.writeMemFSFile("main.tex", source);
      engine.setEngineMainFile("main.tex");
      const result = await engine.compileLaTeX();

      if (!result.pdf) {
        workerScope.postMessage({ type: "error", id, payload: result.log || "LaTeX compile failed" });
        return;
      }

      const pdfBuffer = result.pdf.buffer.slice(
        result.pdf.byteOffset,
        result.pdf.byteOffset + result.pdf.byteLength,
      );
      workerScope.postMessage({ type: "pdf", id, payload: pdfBuffer }, [pdfBuffer]);
    }
  } catch (err) {
    workerScope.postMessage({ type: "error", id, payload: String(err) });
  }
};
