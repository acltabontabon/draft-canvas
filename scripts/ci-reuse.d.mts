export function findReusableRun(options: {
  repository: string;
  revision: string;
  tree: string;
  full: boolean;
  desktop?: boolean;
  workflow: string;
  event: { repository: { default_branch: string } };
  api: (path: string) => unknown;
  evidence: (run: { id: number; run_attempt: number }, name: string) => unknown;
}): { id: number; url: string } | null;
