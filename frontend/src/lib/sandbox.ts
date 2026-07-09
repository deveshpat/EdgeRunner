import { loadPyodide } from "pyodide";

let pyodideInstance: any = null;

export async function executePythonInBrowser(code: string): Promise<string> {
  if (!pyodideInstance) {
    // Load the WASM Python environment
    pyodideInstance = await loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/",
    });
  }

  try {
    // Redirect stdout so we can capture print() statements
    await pyodideInstance.runPythonAsync(`
      import sys
      import io
      sys.stdout = io.StringIO()
    `);
    
    // Run the agent's code
    await pyodideInstance.runPythonAsync(code);
    
    // Fetch the printed output
    const stdout = await pyodideInstance.runPythonAsync("sys.stdout.getvalue()");
    return `✅ EXECUTION SUCCESS:\n${stdout}`;
  } catch (error: any) {
    // Capture Tracebacks if the agent writes bad code
    return `❌ EXECUTION FAILED:\n${error.message}`;
  }
}