import { sleep } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { clickByText } from "../core/waiters";
import * as tm from "../selectors/tempMail";
import * as ps from "../selectors/postman";

/**
 * 从收件箱列表文本中提取 6 位数字验证码。
 * 验证码直接出现在列表的邮件摘要里，无需进入邮件详情。
 * temp-mail 有反爬措施，会注入零宽字符（\u200b 等）拆开数字，提取前统一清除不可见字符。
 * 安全策略：优先带 label；无 label 时仅当恰好存在一个 6 位数字时才使用，避免抓错。
 */
export function extractCodeFromListText(text: string): string | null {
  const invisible = /[\s\u200b\u200c\u200d\u2060\ufeff\u00ad]/g;
  const normalized = text.replace(invisible, " ");

  // 1) 带 label：Verification code: 853602 / code is 853602 / 您的验证码是 853602
  const labeled = normalized.match(/(?:code|código|验证码|确认码)[^0-9]{0,15}([0-9][0-9\s-]{0,10}[0-9])/i);
  if (labeled) {
    const digits = labeled[1].replace(/[^\d]/g, "");
    if (digits.length === 6) return digits;
  }

  // 2) 恰好一个 6 位连续数字时才采用（多个则无法确定，宁可失败）
  const runs = normalized.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
  if (runs.length === 1) return runs[0];

  return null;
}

/** 提取失败时打印文本中「code」附近的片段，便于人工判断读取是否正确 */
function messagePreview(text: string): string {
  const idx = text.search(/code|código|验证码|确认码/i);
  if (idx >= 0) return text.slice(Math.max(0, idx - 80), idx + 200);
  return text.slice(0, 400);
}

/** 提取失败时把读取到的全文保存到 runtime/ 目录，便于离线分析 */
async function saveMessageDump(body: string): Promise<void> {
  try {
    await mkdir("runtime", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `runtime/verify-message-${stamp}.txt`;
    await writeFile(file, body, "utf8");
    log.warn(`已将读取到的文本保存到 ${file}（共 ${body.length} 字符）`);
  } catch {
    log.warn("保存文本失败（跳过）");
  }
}

/**
 * 第三阶段：邮箱验证（标签页 A ↔ 标签页 B）
 * A 刷新收件箱 → 直接从列表摘要提取验证码（无需点进邮件详情）→ B 输入验证码提交。
 */
export async function runVerify(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("verify", "从临时邮箱收件箱提取验证码");
  // 邮箱访问是有副作用的轮询操作：必须先由 signup 阶段提供提交后 OTP 证据。
  if (!plan.signupSubmitted || !plan.verificationReady) {
    throw new Error("注册尚未正常提交并确认 OTP 验证界面；拒绝轮询临时邮箱");
  }
  const emailTab = plan.emailTab;
  if (!emailTab) throw new Error("临时邮箱标签页不存在");

  // 切到标签页 A 并刷新收件箱
  await tabs.bringToFront(emailTab);
  await tabs.navigate(emailTab, CONFIG.urls.tempMail);
  await sleep(1000);

  // 直接从收件箱列表提取验证码；轮询等待邮件到达
  let code: string | null = null;
  let lastList = "";
  for (let attempt = 1; attempt <= 6 && !code; attempt++) {
    await tm.waitForInboxLoaded(emailTab);
    lastList = await tm.readInboxListText(emailTab);

    // 多封不同验证码的邮件摘要（残留旧数据）时拒绝猜测
    const labeledRaw = lastList.match(/(?:code|código|验证码|确认码)[^0-9]{0,15}\d{6}/gi) ?? [];
    const distinctCodes = [...new Set(labeledRaw.map((m) => m.replace(/[^\d]/g, "").slice(-6)))];
    if (distinctCodes.length > 1) {
      log.warn(`第 ${attempt} 次：收件箱列表含多个不同验证码（${distinctCodes.join(" / ")}），可能残留旧数据，不猜测`);
      if (attempt < 6) await sleep(4000);
      continue;
    }

    code = extractCodeFromListText(lastList);
    if (!code) {
      log.warn(`第 ${attempt} 次未提取到验证码（列表 ${lastList.trim().length} 字符，邮件可能尚未到达）`);
      if (attempt < 6) await sleep(4000);
    }
  }
  if (!code) {
    await saveMessageDump(lastList);
    log.warn(`收件箱列表片段: ${messagePreview(lastList) || "（空）"}`);
    throw new Error("未在收件箱列表中找到 6 位验证码（详见上方文本与 runtime/verify-message-*.txt）");
  }
  plan.verifyCode = code;
  log.ok(`验证码: ${code}`);

  // 切换到标签页 B；若已丢失，用记录的验证页 URL 重新打开
  let tab = plan.postmanTab;
  if (!tab || tab.isClosed()) {
    if (!plan.verifyUrl) throw new Error("Postman 标签页已丢失且没有可恢复的验证页 URL");
    log.info("Postman 标签页已丢失，用记录的 URL 重新打开");
    tab = await tabs.openDedicatedTab("Postman 验证页（恢复）", plan.verifyUrl);
    plan.postmanTab = tab;
  } else {
    await tabs.bringToFront(tab);
  }

  // 验证页同样可能有 Cloudflare（Turnstile）校验，先等它通过（绿色 Success!）再填码提交
  await ps.waitForCloudflareSuccess(tab, CONFIG.timeouts.cfWait, () => ps.verificationPageReady(tab));
  log.ok("验证页 CAPTCHA 状态已确认");

  log.info(`在标签页填充验证码，当前 URL: ${tab.url()}`);
  await ps.fillOtp(tab, code, CONFIG.timeouts.long);
  await clickByText(tab, /^Verify Account$|^Verify$/i, { timeout: CONFIG.timeouts.short }).catch(() =>
    log.info("验证按钮已不可见（可能已自动提交）"),
  );
  log.info("已提交验证码，等待跳转到新手引导……");

  // 提交后可能还会触发一次 Cloudflare 挑战（组件由提交触发，提交前页面上没有）：
  // 同样走循环等待 + 跨 frame 点击；页面上没有组件时函数会自动跳过
  await ps.waitForCloudflareSuccess(tab, CONFIG.timeouts.cfWait, () => ps.verificationPageReady(tab));
  log.ok("验证提交后的 CAPTCHA 状态已确认");

  await ps.waitForOnboarding(tab);
  log.ok("邮箱验证通过，已进入新手引导页面");
}
