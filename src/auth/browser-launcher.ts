import { chromium, type Browser } from "playwright";

export const LOGIN_BROWSER_BACKENDS = ["playwright", "camoufox"] as const;
export type LoginBrowserBackend = (typeof LOGIN_BROWSER_BACKENDS)[number];
export type BrowserLauncher = (options: { headless: boolean }) => Promise<Browser>;

export function parseLoginBrowserBackend(value: string | undefined): LoginBrowserBackend {
  const normalized = value?.trim().toLowerCase() || "camoufox";
  if (normalized === "playwright" || normalized === "camoufox") return normalized;
  throw new Error(
    `Invalid LOGIN_BROWSER_BACKEND=${JSON.stringify(value)}; expected "playwright" or "camoufox"`,
  );
}

export async function launchLoginBrowser(
  backend: LoginBrowserBackend,
  options: { headless?: boolean; playwrightLauncher?: BrowserLauncher; camoufoxImporter?: () => Promise<typeof import("camoufox-js")> } = {},
): Promise<Browser> {
  const headless = options.headless ?? false;
  if (backend === "playwright") {
    return (options.playwrightLauncher ?? ((launchOptions) => chromium.launch(launchOptions)))({ headless });
  }

  try {
    const module = await (options.camoufoxImporter ?? (() => import("camoufox-js")))();
    return await module.Camoufox({ headless });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Camoufox launch failed: ${detail}. Run "bun run browser:camoufox:fetch" using Node >=22, ` +
      `or set LOGIN_BROWSER_BACKEND=playwright. Automatic fallback is disabled.`,
      { cause: error },
    );
  }
}
