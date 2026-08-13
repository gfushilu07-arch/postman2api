# 模块设计文档（DESIGN）

## 1. 目标

自动化完成 Postman 账号从「获取临时邮箱」到「启用 Postman AI」的完整注册链路，
并把七个阶段拆成可独立维护、可独立重跑的模块。

## 2. 分层架构与解耦

```
┌──────────────────────────────────────────────┐
│ index.ts       —— 编排层：阶段顺序 + 错误边界   │
├──────────────────────────────────────────────┤
│ steps/*        —— 业务步骤层：每个阶段一个文件  │
├──────────────────────────────────────────────┤
│ selectors/*    —— 站点适配层：所有 DOM 知识     │
├──────────────────────────────────────────────┤
│ core/*         —— 基础设施层：浏览器/等待/日志  │
└──────────────────────────────────────────────┘
```

依赖方向：上层依赖下层，下层不依赖上层。三层之间唯一的「数据通道」是 `PlanTrack`。

### 为什么这样拆

| 关注点 | 落在哪一层 | 变化原因 |
| --- | --- | --- |
| 流程顺序、错误处理 | index.ts | 需求变更（加/减阶段） |
| 某个阶段怎么做 | steps/xxx.ts | 业务逻辑调整 |
| 元素怎么找 | selectors/xxx.ts | 站点改版 |
| 浏览器启动、多标签页 | core/browser.ts | 基础设施升级 |
| 跨阶段数据 | types.ts 的 PlanTrack | 数据结构调整 |

站点改版是这类自动化最频繁的变更，把它隔离到 `selectors/`，改动面最小。
每个选择器都是「多候选定位器 + 文本兜底」，站点改版时通常只需增删候选。

## 3. plan_track 数据流

`PlanTrack`（见 `src/types.ts`）模拟流程描述中的 plan_track，贯穿所有阶段：

| 字段 | 写入阶段 | 用途 |
| --- | --- | --- |
| email / emailPrefix | ① 临时邮箱 | ② 注册、④ 姓名 |
| password | 启动时 | ② 注册 |
| verifyUrl（含 authFlowId） | ② 注册 | ③ 标签页丢失时恢复 |
| verifyCode | ③ 验证 | ③ 提交验证码 |
| emailTab / postmanTab | ①② | 多标签页切换 |

各阶段只通过 `PlanTrack` 交换数据，不直接 import 其他阶段，因此可以单独调试、
调整顺序或插入新阶段。

## 4. 阶段 → 文件 → 关键行为映射

| 阶段 | 文件 | 关键行为 |
| --- | --- | --- |
| ① 全新临时邮箱 | steps/tempEmail.ts | 打开 → 等待邮箱显示 → 检测 Postman 邮件 → 必要时删除重生 → 复制地址 |
| ② 注册 | steps/signup.ts | 填表 → 等 Cloudflare 绿色 Success! → Create Free Account → 记录 verifyUrl |
| ③ 邮箱验证 | steps/verify.ts | A 刷新收件箱 → 打开邮件 → 提取 6 位码 → B 提交 |
| ④ 完善资料 | steps/profile.ts | 姓名=邮箱 → 三个下拉 → 先填 AI 文本区再点 Get started with AI |
| ⑤ Enterprise 试用 | steps/upgrade.ts | Upgrade → 选 Enterprise $49 → Start Enterprise Trial → 校验文案 |
| ⑥ 团队设置 | steps/team.ts | 直接导航 /settings/team/members，失败走齿轮菜单 |
| ⑦ 启用 AI | steps/enableAi.ts | 导航 /settings/team/ai → Enable → 变 Disable |

## 5. 健壮性设计

- 每个元素查找都有多候选定位器 + 文本兜底（`firstVisible`）。
- **实时监测器 `core/monitor.ts`**：细粒度轮询（300ms）+ 多信号并行，邮箱显示与
  Cloudflare 通过都走它，专门捕捉「绿色 Success!」这类转瞬即逝的状态。
- Cloudflare 通过采用多信号：组件 `data-status`、隐藏 token 输入框、iframe 内
  Success 文案/勾选标记；超时自动输出现场信息（status 值、iframe URL、token）用于排查。
- **专属标签页**：临时邮箱（标签页 A）与 Postman（标签页 B）通过
  `openDedicatedTab` 各自开独立标签页并打日志，注册步骤内置互不共用校验。
- 关键等待都有重试：邮件到达、Cloudflare 通过、AI 按钮解禁。
- 标签页句柄失效时，可凭记录的 `verifyUrl` 重新打开页面恢复。
- 日志按阶段着色输出，失败时能直接定位到第几步。
- 每次运行都从头开始，不做断点续跑；失败时浏览器保持打开供人工排查，`Ctrl+C` 退出。

## 6. 如何扩展

新增阶段：在 `steps/` 加一个文件 → 在 `types.ts` 的 `STAGES` 与 `PlanTrack` 加字段 →
在 `index.ts` 的 `STAGE_ORDER` / `RUNNERS` 注册。无需改动其他阶段。
