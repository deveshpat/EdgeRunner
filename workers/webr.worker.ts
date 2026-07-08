import { WebR } from "webr";

type CaptureOutput = {
  type?: string;
  data?: unknown;
};

type CaptureResult = {
  output?: CaptureOutput[];
  images?: ImageBitmap[];
};

type ShelterLike = {
  captureR: (code: string, options?: Record<string, unknown>) => Promise<CaptureResult>;
  purge?: () => void | Promise<void>;
  destroy?: () => void | Promise<void>;
};

type WebRLike = WebR & {
  Shelter?: new () => ShelterLike;
  evalRString?: (code: string) => Promise<unknown>;
  evalR?: (code: string) => Promise<{ toString?: () => string }>;
};

let webR: WebRLike | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function imageBitmapToBase64(image: ImageBitmap): Promise<string> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create canvas context for captured R plot");
  }

  context.drawImage(image, 0, 0, image.width, image.height);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buffer = await blob.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

async function ensureWebR(): Promise<WebRLike> {
  if (!webR) {
    webR = new WebR() as WebRLike;
    await webR.init();
  }
  return webR;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data as {
    type: string;
    id: string;
    payload: { code?: string };
  };

  try {
    if (type === "init") {
      await ensureWebR();
      self.postMessage({ type: "ready", id });
      return;
    }

    if (type === "run") {
      const runtime = await ensureWebR();
      let stdout = "";
      let plot: string | null = null;

      if (runtime.Shelter) {
        const shelter = await new runtime.Shelter();
        try {
          const capture = await shelter.captureR(payload.code || "", {
            captureStreams: true,
            captureGraphics: { capture: true, width: 720, height: 450, bg: "white" },
            withAutoprint: true,
          });

          stdout = (capture.output ?? [])
            .map((entry) => {
              if (entry.type === "stdout" || entry.type === "stderr") {
                return String(entry.data ?? "");
              }
              if (entry.type === "message" || entry.type === "warning" || entry.type === "error") {
                return String(entry.data ?? "");
              }
              return "";
            })
            .join("");

          if (capture.images && capture.images.length > 0) {
            plot = await imageBitmapToBase64(capture.images[0]);
          }
        } finally {
          await shelter.purge?.();
          await (shelter as { destroy?: (value?: unknown) => void | Promise<void> }).destroy?.(undefined);
        }
      } else if (runtime.evalRString) {
        stdout = String(await runtime.evalRString(payload.code || ""));
      } else if (runtime.evalR) {
        const result = await runtime.evalR(payload.code || "");
        stdout = result?.toString?.() || "";
      }

      self.postMessage({ type: "result", id, payload: { stdout, plot } });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", id, payload: String(err) });
  }
};
