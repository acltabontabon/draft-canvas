import { spawnSync } from 'node:child_process';

const result = spawnSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', 'desktop_wire_types_match_rust'], {
  stdio: 'inherit',
  env: { ...process.env, DRAFT_CANVAS_WRITE_BINDINGS: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
