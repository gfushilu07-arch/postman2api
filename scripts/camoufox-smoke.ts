import { launchLoginBrowser } from "../src/auth/browser-launcher.ts";

const publicLoginPage = process.argv.includes("--postman-login");
const browser = await launchLoginBrowser("camoufox", { headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("about:blank");
  console.log("Camoufox smoke: module import, launch, about:blank, and close succeeded");
  if (publicLoginPage) {
    await page.goto("https://identity.getpostman.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    console.log(`Camoufox smoke: public Postman login page loaded (${page.url()})`);
  }
} finally {
  await browser.close();
}
