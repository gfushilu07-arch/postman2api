import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { firstVisible, waitForAnyVisibleText, waitUntilEnabled } from "../core/waiters";
import * as ps from "../selectors/postman";

/**
 * 第五阶段：升级至 Enterprise 试用版
 * Upgrade → 弹窗选 Enterprise $49 → Start Enterprise Trial → 校验成功文案 → 关闭弹窗。
 */
export async function runUpgrade(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("upgrade", "找到 Upgrade 按钮并打开升级弹窗");
  const tab = plan.postmanTab;
  if (!tab) throw new Error("Postman 标签页不存在");
  await tabs.bringToFront(tab);

  await ps.upgradeButton(tab).click();
  log.info("已点击 Upgrade");
  await waitForAnyVisibleText(tab, ["Enterprise", "Solo", "Team"], CONFIG.timeouts.medium);
  log.info("升级弹窗已出现，等待方案内容加载……");

  const enterprise = await firstVisible(ps.enterpriseOption(tab), CONFIG.timeouts.medium);
  if (!enterprise) throw new Error("升级弹窗内容加载超时，未找到 Enterprise 方案");
  log.info("升级方案内容已加载，检测到 Enterprise 方案");
  await enterprise.click();
  log.info("已点击 Enterprise 方案（label），确认选中状态……");
  await ps.waitForEnterpriseSelected(tab);
  log.info("已选择 Enterprise $49 方案");

  const startTrial = await firstVisible([ps.startEnterpriseTrialButton(tab)], CONFIG.timeouts.medium);
  if (!startTrial) throw new Error("Enterprise 方案已选中，但 Start Enterprise Trial 按钮加载超时");
  await waitUntilEnabled(startTrial, CONFIG.timeouts.medium);
  await startTrial.click();
  log.info("已点击 Start Enterprise Trial，等待处理……");

  await waitForAnyVisibleText(tab, [ps.enterpriseTrialBadge, /Trial ending in/i], CONFIG.timeouts.long);
  log.ok("Enterprise 试用已激活");

  await ps.closeModal(tab).catch(() => log.warn("未找到弹窗关闭按钮，按 Esc 兜底"));
  await tab.keyboard.press("Escape").catch(() => {});
}
