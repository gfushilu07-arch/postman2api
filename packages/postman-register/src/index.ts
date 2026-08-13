import type { Browser } from "playwright";
import { CONFIG, createRunPassword } from "./config";
import { createPlanTrack, STAGES, type Stage, type StepContext } from "./types";
import { launchBrowser, TabManager } from "./core/browser";
import { log } from "./core/logger";
import { runTempEmail } from "./steps/tempEmail";
import { runSignup } from "./steps/signup";
import { runVerify } from "./steps/verify";
import { runProfile } from "./steps/profile";
import { runUpgrade } from "./steps/upgrade";
import { runTeam } from "./steps/team";
import { runEnableAi } from "./steps/enableAi";

/** 阶段执行顺序：与需求中的七个阶段一一对应 */
const STAGE_ORDER: Stage[] = [...STAGES];

const RUNNERS: Record<Stage, (ctx: StepContext) => Promise<void>> = {
  tempEmail: runTempEmail,
  signup: runSignup,
  verify: runVerify,
  profile: runProfile,
  upgrade: runUpgrade,
  team: runTeam,
  enableAi: runEnableAi,
};

/** 当前正在运行的浏览器实例：供 Ctrl+C 无论在哪一轮都能关闭并退出 */
let currentBrowser: Browser | null = null;

async function closeCurrentBrowser(): Promise<void> {
  await currentBrowser?.close().catch(() => {});
  currentBrowser = null;
}

/**
 * 报错后保持进程存活、浏览器不关闭，方便人工分析失败现场。
 * 定时器句柄 + 永不 resolve 的 Promise 共同保证进程不会因事件循环空转而退出。
 */
async function keepBrowserOpen(_browser: Browser): Promise<void> {
  const keepAlive = setInterval(() => {}, 60_000);
  log.warn("浏览器保持打开以便排查，请检查各标签页状态；排查完成后按 Ctrl+C 退出。");
  await new Promise<void>(() => {});
  clearInterval(keepAlive);
  await _browser.close();
}

/**
 * 单独执行一轮完整注册：独占一个全新的 Camoufox 浏览器实例，
 * 全部阶段成功则保存 Token 并关闭浏览器。
 * 单轮模式（count=1）失败时保留原行为：浏览器保持打开供人工排查。
 */
async function runOnce(iteration: number): Promise<boolean> {
  const label = CONFIG.count > 1 ? `第 ${iteration}/${CONFIG.count} 轮` : "";
  if (label) log.info(`========== 开始 ${label} 账号注册 ==========`);

  const password = createRunPassword();
  const browser = await launchBrowser();
  currentBrowser = browser;

  try {
    const context = await browser.newContext();
    const tabs = new TabManager(context);
    const plan = createPlanTrack(password);

    for (const stage of STAGE_ORDER) {
      plan.stage = stage;
      try {
        await RUNNERS[stage]({ plan, tabs });
      } catch (err) {
        log.error(`流程中断于阶段「${stage}」: ${err instanceof Error ? err.message : String(err)}`);
        for (const [idx, p] of tabs.pages.entries()) {
          log.info(`  标签页 ${idx + 1}: ${p.url()}`);
        }
        // 单轮失败：不关闭浏览器，保持打开供人工排查
        if (CONFIG.count === 1) {
          await keepBrowserOpen(browser);
          return false;
        }
        log.warn("本轮注册失败，正在关闭浏览器并继续下一轮……");
        await closeCurrentBrowser();
        return false;
      }
    }

    log.ok(`${label ? label + " 注册成功！" : "全流程完成！"}邮箱: ${plan.email}，用户名: ${plan.emailPrefix}`);
    await closeCurrentBrowser();
    return true;
  } catch (err) {
    log.error(`流程中断: ${err instanceof Error ? err.message : String(err)}`);
    if (CONFIG.count === 1) {
      await keepBrowserOpen(browser);
      return false;
    }
    await closeCurrentBrowser();
    return false;
  }
}

async function main(): Promise<void> {
  log.info(`浏览器模式：${CONFIG.headless ? "无界面" : "有界面"}，注册轮数：${CONFIG.count}`);

  // Ctrl+C：先关闭当前浏览器再退出，避免残留浏览器进程
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log.info("收到中断信号，正在关闭浏览器并退出……");
    void closeCurrentBrowser().finally(() => process.exit(130));
  });

  let ok = 0;
  let failed = 0;
  for (let i = 1; i <= CONFIG.count; i++) {
    const success = await runOnce(i);
    if (success) ok++;
    else failed++;
    if (i < CONFIG.count) {
      log.info(`本轮结束（成功 ${ok} / 失败 ${failed}），准备开始下一轮注册……`);
    }
  }

  if (CONFIG.count > 1) {
    log.info(`批量注册结束：共 ${CONFIG.count} 轮，成功 ${ok}，失败 ${failed}`);
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  log.error(`流程启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});