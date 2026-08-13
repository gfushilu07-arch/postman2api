# Camoufox 浏览器自动化示例

这是一个独立的 Bun 示例包，使用 `camoufox-js` 启动浏览器，并通过 Playwright API 完成以下操作：

- 打开本地演示页面
- 向输入框填写中文内容
- 点击按钮并读取动态结果
- 点击按钮打开两个新标签页
- 在三个标签页之间切换
- 返回主标签页并校验页面状态

示例中的关键步骤都带有中文注释。演示网页由脚本在本机临时启动，不依赖外部网站。

## 安装

在当前示例目录中执行：

```bash
cd examples/camoufox-automation
bun install
bunx camoufox-js fetch
```

如果已经在仓库根目录安装过依赖并执行过 `bun run browser:camoufox:fetch`，可以跳过上面的安装步骤。

## 运行

默认使用有界面模式，便于观察自动化过程：

```bash
bun run start
```

在服务器或 CI 中可以使用无界面模式：

```bash
bun run start:headless
```

运行成功后，终端最后会显示：

```text
[完成] 输入、点击、打开标签页、切换标签页和状态校验全部成功
```

## 核心 API

| 操作 | API |
| --- | --- |
| 输入内容 | `locator.fill()` |
| 点击按钮 | `locator.click()` |
| 等待新标签页 | `context.waitForEvent("page")` |
| 获取全部标签页 | `context.pages()` |
| 切换标签页 | `page.bringToFront()` |
| 读取输入值 | `locator.inputValue()` |
