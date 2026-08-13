const sessionTails = new Map<string, Promise<void>>();

export async function acquireSessionLock(sessionId?: string): Promise<() => void> {
  if (!sessionId) return () => {};

  const previous = sessionTails.get(sessionId) || Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  sessionTails.set(sessionId, current);
  await previous.catch(() => {});

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (sessionTails.get(sessionId) === current) sessionTails.delete(sessionId);
  };
}

export function clearSessionLocks(): void {
  sessionTails.clear();
}
