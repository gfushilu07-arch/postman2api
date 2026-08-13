---
name: postman_register
title: Postman账号注册与配置自动化
description: "自动化完成Postman账号全流程注册：获取临时邮箱、注册账号、验证邮箱、完善资料、升级Enterprise试用版、启用Postman AI功能，并保存账号密码到文件。"
when_to_use: "当用户需要自动注册新的Postman账号时使用，包括邮箱验证、新手引导完成、Enterprise试用激活和Postman AI功能开启。触发关键词：'注册postman'、'register postman'、'创建Postman账号'等类似请求。"
---

# Postman账号注册与配置自动化

## 使用场景

- 用户需要自动注册全新的Postman账号
- 需要完整设置包括Enterprise试用版和AI功能
- 希望注册完成后将凭证保存到文件中
- 任何包含"Postman注册"、"register postman"、"创建Postman账号"的请求

## 运行环境要求

- 需要浏览器登录：**否**（创建全新账号）
- 需要沙箱环境：**是**（用于保存凭证文件）
- 需要MCP：**否**
- 需要页面脚本：**否**
- 需要用户本地文件夹：**可选**（未挂载时默认使用 /mnt/work）

## 能力路由说明

**浏览器操作（主要方式）：**
- 打开并管理两个标签页：标签页A（temp-mail.org）和标签页B（Postman注册/设置页面）
- 填写表单、点击按钮、处理下拉菜单
- 在标签页之间切换以获取验证码
- 完成新手引导流程

**沙箱操作（辅助方式）：**
- 保存包含邮箱/密码/账号详情的凭证文件
- 无需复杂脚本，只需简单的文件写入

**无需网络搜索** - 所有数据均来自浏览器交互

## 工作流程

### 第一阶段：获取全新的临时邮箱（标签页A）

1. **打开临时邮箱页面**
   - `new_page` → `https://temp-mail.org/zh`
   - 等待3秒让邮箱生成完成

2. **检查邮箱是否已被使用**
   - 使用 `take_snapshot` 查找邮箱地址字段
   - 检查收件箱是否已有Postman邮件（验证码、AI已启用、试用已激活等）
   - 如果收件箱包含Postman相关邮件 → 说明该邮箱已被使用过

3. **必要时删除并重新生成**
   - 点击"删除"按钮
   - 等待3-5秒让新邮箱生成
   - 确认新邮箱出现且收件箱为空

4. **记录邮箱地址**
   - 从快照中提取邮箱（格式：xxxxxxxx@primetor.com）
   - 存储到 plan_track 中供后续使用

### 第二阶段：注册账号（标签页B）

1. **打开Postman注册页面**
   - `new_page` → `https://identity.getpostman.com/signup`

2. **填写注册表单**
   - 工作邮箱：[第一阶段的临时邮箱]
   - 用户名：[邮箱前缀，例如 tegor65317]
   - 密码：`11111111`（按任务要求固定为此密码）

3. **提交注册信息**
   - 点击"Create Free Account"按钮
   - 等待Cloudflare验证通过（显示绿色"Success!"）
   - 页面将跳转到验证码输入界面

### 第三阶段：邮箱验证（标签页A ↔ 标签页B）

1. **切换到标签页A**（临时邮箱）
   - `select_page` → 第一阶段的tabId
   - 如需要则刷新页面（`navigate_page` reload）
   - `take_snapshot` 查找收件箱内容

2. **提取验证码**
   - 找到来自"The Postman Team"的邮件
   - 在邮件正文中定位6位数字验证码
   - 示例格式：`Verification code: 131460`

3. **切换到标签页B**（Postman验证页面）
   - `select_page` → 第二阶段的tabId
   - 如果页面丢失，直接导航到带 handover/authFlowId 参数的 verify-account URL

4. **输入验证码**
   - 在验证输入框中输入6位数字代码
   - 点击提交按钮
   - 页面将跳转到新手引导页面

### 第四阶段：完善个人资料

1. **填写姓名字段**
   - 输入临时邮箱地址（按任务要求："填写邮箱"）

2. **选择偏好设置**
   - "I'd like to"：选择"build APIs"（或第一个选项）
   - 角色：选择任意角色（例如"backend developer"）
   - 团队规模：选择"1 member"（第一个选项）

3. **⚠️ 关键步骤：激活AI引导流程**
   - **重要提示**："Get started with AI"按钮**默认处于禁用状态**
   - 您必须先与文本区域交互：
     - 点击文本区域下方的示例按钮之一（例如"Send Requests"、"Write tests"）
     - 或者直接在文本区域中输入/粘贴文字
   - 只有在文本区域有内容后，"Get started with AI"才会变为可用状态
   - 然后点击"Get started with AI"按钮

4. **进入工作区**
   - 如果输入文本后"Get started with AI"仍然禁用，改用"Go forward"按钮
   - 成功进入Postman工作区

### 第五阶段：升级至Enterprise试用版

1. **找到Upgrade按钮**
   - 位于工作区工具栏右上角
   - 橙色/珊瑚色的按钮，标注"Upgrade"

2. **点击Upgrade**
   - 弹出模态对话框，显示三个定价层级：
     - Solo $9
     - Team $19
     - **Enterprise $49** ← 选择此项

3. **选择Enterprise方案**
   - 点击"Enterprise $49"单选按钮/选项
   - 按钮应显示选中状态（蓝色/高亮）

4. **开始试用**
   - 点击"Start Enterprise Trial"按钮（白色按钮，不是橙色那个）
   - 等待处理（加载旋转图标）
   - 验证成功：右上角显示"Enterprise Trial ending in 30 days"

5. **关闭弹窗**
   - 试用成功启动后弹窗可能自动关闭
   - 如果仍然打开，点击关闭/X按钮

### 第六阶段：进入团队设置

1. **点击设置图标**
   - 工具栏右侧的齿轮图标
   - 打开下拉菜单

2. **选择团队设置**
   - 菜单项标注"Team settings"
   - 导航到 `/settings/team/members` 页面

### 第七阶段：启用Postman AI功能

1. **导航到AI设置**
   - 左侧边栏 → "API Network & Applications"部分
   - 点击"AI"子菜单项
   - URL：`/settings/team/ai`

2. **启用Postman AI**
   - 主内容区显示"Postman AI"标题
   - 描述："Let users in your organization use Postman's AI features..."
   - 点击橙色**"Enable"**按钮
   - 验证成功：按钮变为**"Disable"**
   - 显示访问管理选项（All users / Selected users）

### 第八阶段：保存凭证文件

1. **准备凭证数据**
   ```
   Email: [临时邮箱]
   Password: 11111111
   Enterprise Trial: 已激活（30天）
   Postman AI: 已启用
   Registration Date: [当前日期]
   ```

2. **保存到文件**
   - 使用 `e2b_write` 创建凭证文件
   - 默认路径：`/mnt/work/postman_credentials.txt`
   - 如果本地挂载可用：`/mnt/local/postman_credentials.txt`
   - 包含所有步骤完成的确认信息

## 本技能包含的文件

无需额外文件 - 本技能主要使用浏览器操作，仅在最后写入一个简单的文本文件。

## 输出约定

**必需输出：**
1. **凭证文件**：文本文件包含：
   - 邮箱地址
   - 密码（11111111）
   - Enterprise试用状态
   - Postman AI状态
   - 注册日期
   - 所有8个步骤完成的确认

2. **验证证据**（在终止摘要中）：
   - 使用的临时邮箱
   - 输入的验证码
   - Enterprise试用激活确认
   - Postman AI启用确认
   - 凭证文件路径

**成功标准：**
- 所有8个阶段顺利完成且无错误
- 凭证文件保存成功
- Enterprise试用显示为活跃状态（30天）
- Postman AI按钮显示"Disable"（已启用状态）

## 故障处理

### 常见故障及恢复方法：

1. **临时邮箱加载卡住（显示"正在加载"）**
   - 再等待3-5秒
   - 使用 `navigate_page(action="reload")` 刷新页面
   - 如果仍然卡住，删除当前邮箱并等待重新生成

2. **Cloudflare验证失败**
   - 等待自动重试（通常10秒内通过）
   - 如果卡住，刷新注册页面并重新填写表单

3. **收件箱中找不到验证码**
   - 刷新临时邮箱页面
   - 等待10-15秒（邮件投递延迟）
   - 如适用，检查垃圾邮件/废件箱
   - 如果验证码过期，申请新的验证码

4. **"Get started with AI"按钮禁用**
   - ⚠️ 这是预期行为 - 按钮初始状态就是禁用的
   - 必须先点击示例按钮或在文本区域输入内容
   - 文本输入后，按钮会在1-2秒内变为可用状态
   - 备选方案：如果AI按钮仍然禁用，使用"Go forward"按钮

5. **升级弹窗未出现**
   - 确保点击了正确的"Upgrade"按钮（右上角，橙色）
   - 检查是否已在Enterprise方案上（按钮可能显示"Manage"而不是"Upgrade"）
   - 如需要，刷新工作区页面

6. **标签页切换丢失页面状态**
   - 当标签页状态丢失时，使用直接URL导航代替 select_page
   - 对于 verify-account 页面：构建带 handover 和 authFlowId 参数的URL
   - 对于设置页面：使用已知URL模式（/settings/team/*）

7. **AI设置页面看不到Enable按钮**
   - 确认您在正确的页面上：`/settings/team/ai`
   - 检查AI是否已经启用（显示"Disable"按钮而不是"Enable"）
   - 如果元素未完全加载，刷新页面

### 何时停止：
- 临时邮箱服务完全不可用（重试3次后）
- Postman注册被阻止（IP封禁、地区限制）
- 该账号无法获得Enterprise试用
- 同一步骤连续失败3次且尝试了不同方法

## 优化要点（从实际执行中总结的经验）

1. **AI按钮前的文本输入**：新手引导中的"Get started with AI"按钮故意设计为禁用状态，直到用户与文本区域交互。始终先触发示例按钮或输入文本。

2. **邮箱复用检测**：在使用邮箱前始终检查临时邮箱收件箱是否有现有Postman邮件。重复使用的邮箱会导致验证冲突。

3. **标签页状态管理**：浏览器标签页可能在切换过程中丢失状态。保留关键URL以便恢复导航。

4. **视觉+快照双重验证**：某些按钮在视觉上显示为启用但在DOM中标记为禁用（或反之）。当DOM不明确时信任视觉证据，但DOM状态清晰时优先采用。

5. **等待时间调优**：
   - 临时邮箱生成：3-5秒
   - Postman页面跳转：2-3秒
   - Cloudflare验证：10秒内自动通过
   - 邮件接收：10-15秒缓冲时间
