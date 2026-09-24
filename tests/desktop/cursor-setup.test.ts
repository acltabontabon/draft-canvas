import { describe, expect, it } from 'vitest';
import { cursorDeeplink, cursorServerConfig, genericConfigJson } from '../../src/desktop/ui/AgentSettings';

describe('Cursor MCP setup', () => {
  it('builds the deeplink and the pasted-config fallback from the same server definition', () => {
    const sidecarPath = '/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp';
    const deeplink = cursorDeeplink(sidecarPath);
    expect(deeplink.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=draft-canvas&config=')).toBe(true);

    const encoded = deeplink.split('config=')[1] ?? '';
    const decoded = JSON.parse(atob(decodeURIComponent(encoded)));
    expect(decoded).toEqual(cursorServerConfig(sidecarPath));
    expect(decoded).toEqual({ command: sidecarPath });

    // The manual-paste fallback wraps the exact same server definition, just for a different consumer.
    const pasted = JSON.parse(genericConfigJson(sidecarPath));
    expect(pasted.mcpServers['draft-canvas']).toEqual(cursorServerConfig(sidecarPath));
  });

  it('url-encodes a path with spaces so the query string stays valid', () => {
    const deeplink = cursorDeeplink('/Applications/Draft Canvas.app/mcp');
    expect(deeplink).not.toContain(' ');
    const encoded = deeplink.split('config=')[1] ?? '';
    expect(() => JSON.parse(atob(decodeURIComponent(encoded)))).not.toThrow();
  });
});
