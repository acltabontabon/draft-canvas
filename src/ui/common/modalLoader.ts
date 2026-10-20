let modalModule: Promise<typeof import('./Modal')> | undefined;

export function loadModal() {
  return modalModule ??= import('./Modal').catch((error) => {
    modalModule = undefined;
    throw error;
  });
}

/** Warm the existing dialog chunk on intent, keeping its code off the initial Home load. */
export function warmModal() {
  void loadModal().catch(() => {});
}
