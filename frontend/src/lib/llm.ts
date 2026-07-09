import { pipeline, env } from "@huggingface/transformers";

// Configure Transformers.js for Web
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

let generatorInstance: any = null;
let currentModelId: string | null = null;

// 1. Dynamic Model Fetcher
export async function fetchTrendingWebModels(deviceRamGb: number) {
  console.log("🌐 Fetching dynamic WebGPU models from Hugging Face...");
  
  try {
    // Query HF API for trending text-generation models pre-compiled for transformers.js
    const res = await fetch("https://huggingface.co/api/models?filter=transformers.js,text-generation&sort=trendingScore&limit=20");
    const repos = await res.json();
    
    const candidateModels = [];

    for (let i = 0; i < repos.length; i++) {
      const repoId = repos[i].id;
      const name = repoId.split("/").pop();
      
      // Dynamic RAM Estimation: Look for "B" (Billions) in the name (e.g., "1.5B", "8B")
      let paramsBillion = 2.0; // Default fallback estimate
      const match = name.match(/(\d+(?:\.\d+)?)[bB]/);
      if (match) {
        paramsBillion = parseFloat(match[1]);
      }
      
      // For 4-bit ONNX models, RAM requirement is roughly (Params * 0.6) + 1.5GB (KV Cache / Context)
      const ramRequired = (paramsBillion * 0.6) + 1.5;
      const capabilityScore = 100 - (i * 3); // Proxy score based on HF Trending rank

      candidateModels.push({
        id: repoId,
        name: name,
        ramRequired: parseFloat(ramRequired.toFixed(1)),
        capabilityScore: capabilityScore
      });
    }

    return candidateModels;
  } catch (error) {
    console.error("Failed to fetch models dynamically:", error);
    return []; // Return empty array if offline
  }
}

// 2. Hardware Scanner & Scorer
export async function scanBrowserHardware() {
  let webGpuAvailable = false;
  let deviceRamGb = 4; // Safe fallback for browsers that hide RAM

  // Check WebGPU Support
  if ("gpu" in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) webGpuAvailable = true;
    } catch (e) {
      console.warn("WebGPU not available.");
    }
  }

  // Check Device Memory
  if ("deviceMemory" in (navigator as any)) {
    deviceRamGb = (navigator as any).deviceMemory;
  }

  // Fetch dynamic models
  const dynamicModels = await fetchTrendingWebModels(deviceRamGb);

  // Score them against local hardware
  const scoredModels = dynamicModels.map((model) => {
    let fitStatus = "✅ PERFECT FIT";
    let isCompatible = true;

    if (!webGpuAvailable) {
      fitStatus = "❌ NO WEBGPU (Slow CPU Fallback)";
    } else if (model.ramRequired > deviceRamGb) {
      fitStatus = "❌ INCOMPATIBLE";
      isCompatible = false;
    } else if (deviceRamGb - model.ramRequired <= 1) {
      fitStatus = "⚠️ TIGHT FIT";
    }

    return { ...model, fitStatus, isCompatible };
  });

  // Sort by highest capability that actually fits
  scoredModels.sort((a, b) => {
    if (a.isCompatible && !b.isCompatible) return -1;
    if (!a.isCompatible && b.isCompatible) return 1;
    return b.capabilityScore - a.capabilityScore;
  });

  return { webGpuAvailable, deviceRamGb, scoredModels };
}

// 3. Dynamic Engine Initializer
export async function getTransformersEngine(modelId: string, onProgress?: (info: any) => void) {
  if (generatorInstance && currentModelId !== modelId) {
    console.log("Switching models. Nullifying old session to free VRAM...");
    generatorInstance = null; 
  }

  if (!generatorInstance) {
    currentModelId = modelId;
    generatorInstance = await pipeline(
      "text-generation",
      modelId,
      {
        device: "webgpu", // Forces GPU acceleration
        dtype: "q4",      // Requests 4-bit quantization automatically
        progress_callback: (progressInfo: any) => {
          if (onProgress) onProgress(progressInfo);
        }
      }
    );
  }

  return generatorInstance;
}

// 4. Text Generation Helper
export async function generateText(generator: any, messages: {role: string, content: string}[]) {
  const prompt = generator.tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true,
  });

  const output = await generator(prompt, {
    max_new_tokens: 1024,
    temperature: 0.2,
    do_sample: true,
    return_full_text: false,
  });

  return output[0].generated_text;
}