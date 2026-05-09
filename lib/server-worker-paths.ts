import path from "node:path"

export function getLocalWorkerPythonPath(projectRoot: string) {
  return (
    process.env.YAMNET_PYTHON_PATH ??
    [projectRoot, ".venv-yamnet", "bin", "python"].join(path.sep)
  )
}

export function getWorkerScriptPath(projectRoot: string, scriptName: string) {
  return path.join(projectRoot, "scripts", scriptName)
}

