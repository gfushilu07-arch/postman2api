import type { Page } from "playwright";

/**
 * take_snapshot 的等价物：收集页面当前可见的交互元素与标题，
 * 便于在日志中定位"邮箱字段在哪、按钮是否禁用"等状态。
 * 只读操作，不影响页面。
 */
export interface SnapshotItem {
  role: string;
  name: string;
  disabled: boolean;
}

export async function snapshot(page: Page, limit = 150): Promise<SnapshotItem[]> {
  return page.evaluate((max) => {
    const items: SnapshotItem[] = [];
    const selector = [
      "button", "a", "input", "select", "textarea",
      '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="combobox"]',
      '[role="checkbox"]', '[role="radio"]', '[role="heading"]',
      "h1", "h2", "h3",
    ].join(",");

    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0) continue;
      if (style.display === "none" || style.visibility === "hidden" || el.hidden) continue;
      if (items.length >= max) break;

      let role = el.getAttribute("role");
      if (!role) {
        const tag = el.tagName.toLowerCase();
        role = tag === "a" ? "link"
          : tag === "input" ? ((el as HTMLInputElement).type === "checkbox" ? "checkbox"
            : (el as HTMLInputElement).type === "radio" ? "radio" : "textbox")
          : tag;
      }

      const inputName =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.placeholder || (el instanceof HTMLInputElement ? el.value : "")
          : "";
      const name = [el.getAttribute("aria-label"), el.getAttribute("title"), inputName, el.textContent]
        .find((v) => v && v.trim()) ?? "";

      items.push({ role, name: name.slice(0, 120), disabled: el.getAttribute("disabled") !== null });
    }
    return items;
  }, limit);
}
