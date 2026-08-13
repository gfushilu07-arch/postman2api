# Postman 账号 Token 获取与 JSON 导入

本文档说明如何获取 postman2api 所需的四个字段，并通过管理台导入一个或多个账号。这些值可用于访问已登录的 Postman 账号，因此只能获取和使用你本人拥有或已获授权操作的账号凭据。

## 必需字段

| JSON 字段 | 来源 | 示例形式 |
| --- | --- | --- |
| `postman_sid` | `.postman.co` 域下名为 `postman.sid` 的 Cookie | 不透明的会话值 |
| `user_id` | Postman handshake JWT 载荷中的 `userId` | 数字或字符串 ID |
| `workspace_id` | Postman handshake JWT 载荷中的 `teamId` | 数字或字符串 ID |
| `workspace_subdomain` | `<前缀>.postman.co` 中的域名前缀 | `kajimab999-9757616` |

JSON 中的字段名是 `postman_sid`，浏览器中的 Cookie 名称则是 `postman.sid`。

## 1. 登录并打开团队工作区

1. 在普通浏览器窗口中登录 Postman。
2. 打开目标团队域名下的页面，例如额度页面：

   `https://<workspace_subdomain>.postman.co/billing/add-ons/overview`

3. 获取域名前缀。例如：

   `https://kajimab999-9757616.postman.co/billing/add-ons/overview`

   对应的 `workspace_subdomain` 是 `kajimab999-9757616`。

请选择实际拥有目标 AI credits 的团队。不要把 `go.postman.co`、`identity.getpostman.com` 等保留域名当作 `workspace_subdomain`。

## 2. 获取 `postman_sid`

1. 在 Postman 页面打开浏览器开发者工具。
2. 打开 **Application（应用）** 面板；Firefox 中对应 **Storage（存储）** 面板。
3. 在 **Cookies** 下选择一个 `postman.co` 来源。
4. 找到名为 `postman.sid` 的 Cookie。
5. 复制其完整值，填入 JSON 的 `postman_sid` 字段。

该 Cookie 可能带有 `HttpOnly` 标记，因此通过 `document.cookie` 不一定能够读取。请使用浏览器开发者工具中的 Cookie 存储面板。如果找不到该值，请重新登录并刷新团队工作区页面。

## 3. 获取 `user_id` 和 `workspace_id`

保持 Postman 登录状态，在 Postman 页面打开开发者工具的 **Console（控制台）**，运行以下代码：

```js
const handshake = await fetch(
  "https://ra.gw.postman.co/v1/handshake/token?agent=cloud",
  { credentials: "include" },
).then(async (response) => {
  if (!response.ok) throw new Error(`Handshake HTTP ${response.status}`);
  return response.json();
});

const payloadPart = handshake.token.split(".")[1]
  .replace(/-/g, "+")
  .replace(/_/g, "/");
const payload = JSON.parse(
  decodeURIComponent(
    atob(payloadPart.padEnd(Math.ceil(payloadPart.length / 4) * 4, "="))
      .split("")
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join(""),
  ),
);

console.table({ user_id: payload.userId, workspace_id: payload.teamId });
```

将输出的 `userId` 填入 `user_id`，将 `teamId` 填入 `workspace_id`。不要把 handshake token 本身写入导入 JSON；postman2api 只需要并存储从中提取的两个 ID。

如果浏览器阻止向控制台粘贴代码，请按照浏览器提示手动输入确认文本；也可以在 **Network（网络）** 面板中找到上述接口响应，并在本地解码其中的 JWT `token` 载荷。不要安装不明扩展，也不要把 Token 粘贴到在线 JWT 解码网站。

## 4. 构建导入 JSON

推荐使用带版本号的批量导入结构：

```json
{
  "version": 1,
  "accounts": [
    {
      "email": "first@example.com",
      "enabled": true,
      "tokens": {
        "postman_sid": "POSTMAN_SID_VALUE",
        "user_id": "POSTMAN_USER_ID",
        "workspace_id": "POSTMAN_TEAM_ID",
        "workspace_subdomain": "team-prefix"
      }
    },
    {
      "email": "second@example.com",
      "enabled": true,
      "tokens": {
        "postman_sid": "ANOTHER_POSTMAN_SID_VALUE",
        "user_id": "ANOTHER_USER_ID",
        "workspace_id": "ANOTHER_TEAM_ID",
        "workspace_subdomain": "another-team-prefix"
      }
    }
  ]
}
```

规则如下：

- 批量导入文档的 `version` 必须为 `1`。
- 每次导入的 `accounts` 数组支持 1 至 500 个账号。
- `email` 和四个 Token 字段均为必填项，并且必须是非空字符串。
- `enabled` 为可选字段；新账号未填写时默认为 `true`。
- 如果邮箱已经存在，则原地更新该账号，并保留其数据库账号 ID 和请求历史。
- 同一次导入中出现重复邮箱时，只处理第一次出现的记录，后续重复项会被拒绝。
- 某条记录校验失败不会阻止其他合法记录继续导入。

也支持直接导入单个账号对象，此时可以省略 `version` 和 `accounts` 外层结构：

```json
{
  "email": "user@example.com",
  "tokens": {
    "postman_sid": "POSTMAN_SID_VALUE",
    "user_id": "POSTMAN_USER_ID",
    "workspace_id": "POSTMAN_TEAM_ID",
    "workspace_subdomain": "team-prefix"
  }
}
```

## 5. 导入并验证

1. 打开 postman2api 管理台。
2. 点击 **添加账号**，切换到 **JSON 导入**。
3. 粘贴 JSON，点击 **导入账号**。
4. 检查每一条记录的结果：已创建、已更新或导入失败。
5. 点击账号列表中的 **测试**。该操作会发送一次最小化的真实 Agent 请求，并消耗少量 AI credits。

## 安全说明

- 请像保护密码一样保护 `postman_sid`。不要将其提交到 Git，不要放入截图，也不要粘贴到聊天、工单或 Issue 中。
- 导入文件应存放在项目仓库之外；完成导入后请删除明文副本。
- 应用会加密账号密码占位值，但当前 SQLite 数据库的 `tokens` 列会将导入的 Token JSON 作为应用数据保存。请妥善保护数据库文件及其所在主机。
- 退出 Postman、修改账号安全设置或会话过期都可能导致 `postman_sid` 失效。当账号测试出现身份验证错误时，请重新获取并导入新的值。
