import { loadPyodide, type PyodideInterface } from "pyodide";

let pyodideInstance: PyodideInterface | null = null;

export async function executePythonInBrowser(code: string): Promise<string> {
  try {
    if (!pyodideInstance) {
      console.log("Loading Pyodide WASM environment...");
      pyodideInstance = await loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/",
      });
    }

    // Redirect Python's stdout to a JavaScript variable
    await pyodideInstance.runPythonAsync(`
        import sys
        import io
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
    `);

    // Execute the AI's code
    await pyodideInstance.runPythonAsync(code);

    // Fetch the captured terminal output
    const stdout = await pyodideInstance.runPythonAsync("sys.stdout.getvalue()");
    const stderr = await pyodideInstance.runPythonAsync("sys.stderr.getvalue()");

    if (stderr) {
      return `❌ EXECUTION FAILED:\n${stderr}`;
    }
    return `✅ SUCCESS. Output:\n${stdout}`;

  } catch (error: any) {
    // Catch syntax errors and tracebacks
    return `❌ FAILED. Traceback:\n${error.message}`;
  }
}