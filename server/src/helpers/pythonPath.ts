import path from 'path';
import fs from 'fs';

/**
 * Get the Python executable path.
 * Prefers venv at server/python/.venv/bin/python, falls back to system python3.
 */
export function getPythonPath(): string {
  const venvPython = path.resolve(__dirname, '../../python/.venv/bin/python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
}
