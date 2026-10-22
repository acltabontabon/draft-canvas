/**
 * Copying and pasting invite links and reply codes. The async clipboard API is missing on pages
 * that aren't a secure context (a LAN guest's `http://` page) and refused without a recent gesture,
 * so every call says whether it worked and the caller falls back to "select it and copy".
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function pasteText(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** Whether the platform has a native share sheet for links (phones, Safari, Edge on Windows). */
export function canShareLink(url: string): boolean {
  return typeof navigator.share === 'function' && (navigator.canShare?.({ url }) ?? true);
}

/** Opens the native share sheet. `false` when it was dismissed or isn't available. */
export async function shareLink(url: string, title: string): Promise<boolean> {
  try {
    await navigator.share({ url, title });
    return true;
  } catch {
    return false;
  }
}

/** Whether pasted text looks like a reply code (`1.` and base64url), so pasting it can connect at once. */
export function looksLikeCode(text: string): boolean {
  return /^1\.[A-Za-z0-9_-]{40,}$/.test(text.replace(/\s+/g, ''));
}
