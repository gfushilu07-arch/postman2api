/**
 * 生成随机密码：12 位大小写字母 + 数字，保证至少 1 个字母和 1 个数字（满足 Postman 密码要求），
 * 并打乱顺序。每个账号独立生成一个，避免所有账号共用固定密码。
 */
function randomPassword(length = 12): string {
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const all = letters + digits;
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const chars = [pick(letters), pick(digits)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** 固定密码（设置了 POSTMAN_PASSWORD 生效，否则每轮独立随机） */
const FIXED_PASSWORD = process.env.POSTMAN_PASSWORD;

/** 默认创建随机密码；设置 POSTMAN_PASSWORD 后则一律使用固定密码 */
export function createRunPassword(): string {
  return FIXED_PASSWORD ?? randomPassword();
}

/** 批量注册轮数：优先 `--count N` 命令行参数，其次 POSTMAN_COUNT 环境变量，默认 1 */
function resolveRegisterCount(): number {
  const idx = process.argv.indexOf("--count");
  const argvValue = idx >= 0 ? Number(process.argv[idx + 1]) : NaN;
  const value = Number.isFinite(argvValue) ? argvValue : Number(process.env.POSTMAN_COUNT);
  if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  return 1;
}

/**
 * 全局配置：URL、轮数、超时与浏览器选项。
 * 站点改版时优先改 selectors/ 目录，这里只放不变的业务配置。
 */
export const CONFIG = {
  urls: {
    /** 临时邮箱（标签页 A） */
    tempMail: "https://temp-mail.org/zh/",
    /** Postman 注册页（标签页 B） */
    postmanSignup: "https://identity.getpostman.com/signup",
    /** 工作区地址前缀，后续阶段直接导航用 */
    workspace: "https://go.postman.co",
  },
  /** 批量注册轮数：`--count N` 或 POSTMAN_COUNT，默认 1（保持单次注册行为） */
  count: resolveRegisterCount(),
  /** 账号 Token 保存目录（固定文件夹，可用 POSTMAN_TOKENS_DIR 覆盖）；每轮注册生成一个独立文件 */
  tokensDir: process.env.POSTMAN_TOKENS_DIR ?? "tokens",
  headless: process.argv.includes("--headless"),
  timeouts: {
    /** 单次临时邮箱地址获取等待；失败后会执行有限次数的刷新重试 */
    emailAcquireAttempt: 12000,
    /** 临时邮箱地址获取的总尝试次数（包含首次） */
    emailAcquireAttempts: 3,
    /** 临时邮箱地址获取重试前的基础退避时间 */
    emailAcquireBackoff: 1500,
    /** 邮箱页面初始生成等待 */
    emailGenerate: 3000,
    /** 删除邮箱后重新生成等待 */
    deleteRegenerate: 4000,
    /** 短等待（元素轮询基准） */
    short: 5000,
    /** 中等等待 */
    medium: 15000,
    /** 长等待（跨阶段跳转） */
    long: 30000,
    /** Cloudflare 验证循环等待总超时（默认 3 分钟，可用 POSTMAN_CF_TIMEOUT 覆盖） */
    cfWait: Number(process.env.POSTMAN_CF_TIMEOUT) || 180000,
    /** 页面加载 */
    pageLoad: 45000,
  },
  browser: {
    os: "macos" as const,
    locale: "zh-CN",
    fonts: ["Source Han Sans SC", "Hiragino Sans GB", "Heiti SC", "Arial Unicode MS"],
  },
};
