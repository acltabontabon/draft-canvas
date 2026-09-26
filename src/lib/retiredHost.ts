/**
 * Whether this visit is a copy of the retired VS Code extension (0.1.0–0.1.7) framing the editor at
 * `?host=vscode` — the one URL parameter the app ever understood. `main.tsx` answers it with
 * `ui/RetiredHostNotice.tsx` instead of the editor.
 */
export function isRetiredHostVisit(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('host') === 'vscode';
  } catch {
    return false;
  }
}
