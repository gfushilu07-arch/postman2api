import type { Locator, Page } from "playwright";
import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { firstVisible, retry } from "../core/waiters";
import * as ps from "../selectors/postman";

async function fillField(page: Page, candidates: Locator[], value: string, label: string): Promise<void> {
  const loc = await firstVisible(candidates, CONFIG.timeouts.short);
  if (!loc) throw new Error(`未找到输入框: ${label}`);
  await loc.fill(value);
  log.info(`已填写 ${label}: ${value}`);
}

/**
 * 第二阶段：注册账号（标签页 B）。仅在正常提交注册表单后，且页面出现 OTP
 * 验证证据时，才允许后续阶段访问邮箱。
 */
export async function runSignup(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("signup", "打开 Postman 注册页");
  if (!plan.email) throw new Error("缺少临时邮箱，请先执行第一阶段");

  const tab = await tabs.openDedicatedTab("Postman 注册 B", CONFIG.urls.postmanSignup);
  if (tab === plan.emailTab) throw new Error("内部错误：Postman 注册页与临时邮箱共用了同一标签页");
  plan.postmanTab = tab;

  await fillField(tab, ps.emailInputs(tab), plan.email, "工作邮箱");
  await fillField(tab, ps.usernameInputs(tab), plan.emailPrefix!, "用户名");
  await fillField(tab, ps.passwordInputs(tab), plan.password, "密码");

  // CAPTCHA 不存在时仍必须验证当前注册页可正常提交；绝不把“组件不存在”当作验证成功。
  await ps.waitForCloudflareSuccess(tab, CONFIG.timeouts.cfWait, () => ps.registrationFormReady(tab));

  const submit = await firstVisible(ps.registrationSubmitButtons(tab), CONFIG.timeouts.short);
  if (!submit) throw new Error("未找到正常的 Register / Create Free Account 提交按钮");
  if (await submit.isDisabled().catch(() => true)) throw new Error("注册提交按钮不可用，未提交注册表单");
  await submit.click();
  plan.signupSubmitted = true;
  log.info("已正常提交注册表单，等待 OTP 验证界面……");

  // 此等待会检测 CAPTCHA 失败 UI；authFlowId/handover URL 本身不是完成证据。
  await ps.waitForVerificationUi(tab);
  plan.verificationReady = true;
  log.ok("已在提交后确认 OTP 验证界面");

  // 仅在确认 OTP 界面后保存恢复 URL，不能用 URL 参数推断注册成功。
  await retry(
    async () => {
      const url = tab.url();
      if (!url) throw new Error("验证页 URL 为空");
      plan.verifyUrl = url;
    },
    { attempts: 5, delayMs: 1000 },
  ).catch(() => log.warn("未捕获验证页 URL，第三阶段将尝试从当前页面继续"));

  log.info(`当前 URL: ${tab.url()}`);
}
