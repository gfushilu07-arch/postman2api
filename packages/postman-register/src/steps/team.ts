import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { clickByText, firstVisible, tryNavigate, waitForAnyVisibleText } from "../core/waiters";
import * as ps from "../selectors/postman";

/**
 * 第六阶段：进入团队设置
 * 优先直接导航到 /settings/team/members；失败则走 齿轮图标 → Team settings 菜单。
 */
export async function runTeam(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("team", "进入团队设置");
  const tab = plan.postmanTab;
  if (!tab) throw new Error("Postman 标签页不存在");
  await tabs.bringToFront(tab);

  const navigated = await tryNavigate(tab, `${CONFIG.urls.workspace}/settings/team/members`);
  if (!navigated) {
    log.info("直接导航失败，改走齿轮图标菜单");
    const gear = await firstVisible(ps.settingsGear(tab), CONFIG.timeouts.short);
    if (!gear) throw new Error("未找到设置（齿轮）图标");
    await gear.click();
    await clickByText(tab, /Team settings/i, { timeout: CONFIG.timeouts.medium });
  }

  await waitForAnyVisibleText(tab, ["Team settings", "Members"], CONFIG.timeouts.long);
  log.ok("团队设置页面已打开");
}
