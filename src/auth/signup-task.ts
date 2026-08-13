export interface ActiveSignupTask {
  confirmationId: string;
  email: string;
  startedAt: number;
}

let activeSignupTask: ActiveSignupTask | null = null;

export function acquireSignupTask(confirmationId: string, email: string): boolean {
  if (activeSignupTask) return false;
  activeSignupTask = {
    confirmationId: confirmationId.trim(),
    email: email.trim().toLowerCase(),
    startedAt: Date.now(),
  };
  return true;
}

export function releaseSignupTask(confirmationId: string): void {
  if (activeSignupTask?.confirmationId === confirmationId.trim()) activeSignupTask = null;
}

export function getActiveSignupTask(): ActiveSignupTask | null {
  return activeSignupTask ? { ...activeSignupTask } : null;
}
