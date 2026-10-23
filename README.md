# douyin-talent-screen

> 抖音来客「达人广场」批量取数技能：给一份达人昵称名单，一次拉齐 **粉丝指数 / 视频带货力等级 / 30 日总销售额 / 指定品类销售额**，落到 Excel。

Batch-read talent metrics (fans, video-sales level, 30-day GMV, per-category GMV) from the Douyin Laike talent square (`life.douyin.com`) and land them into Excel.

---

## 它解决什么

给定一份达人昵称名单（昵称即可，抖音号/uid 更好），输出一行一人的表：

| 列 | 含义 | 平台字段 |
|---|---|---|
| 账号 | 匹配到的实际昵称 | `talent_detail.nick_name` |
| 粉丝量 | 粉丝指数 | `detail → fans_count_display.statistice_value` |
| 带货等级 | **视频**带货力 | `detail → talent_item_level_display.statistice_value` |
| 带货金额 | 30 日总销售额 | `total/indicator → talent_total_gmv` |
| 品类列 | 该品类带货总销售额 | `detail/indicator?category=<平台品类名> → talent_item_gmv` |

数值统一按平台口径换算成 `X.XXw`；平台返回不足百元时写 `<0.01w`（**不是 0，也不是「无」**）。

## 目录结构

```
SKILL.md                       技能契约：输入、流程、输出契约、失败处理
scripts/cdp.mjs                零依赖 CDP 客户端（list/open/wake/eval/evalp/cookies）
scripts/talent-query.js        页面内取数脚本（whoami / search / cityPool / fields）
scripts/capture-xhr.mjs        抓页面真实 XHR，用于逆向新参数（schema 靠猜代价极高）
scripts/act.mjs                真实鼠标/键盘事件驱动，仅在需要操作 UI 时用
references/api-map.md          接口地图、字段映射、单位与品类名规则、回归校验桩
references/troubleshooting.md  症状 → 真实原因 → 做法（每条都是实测踩过的）
```

## 前置条件

- **Node.js 18+**，脚本零 npm 依赖（只用内置 `fetch` / `WebSocket`）
- **Edge 或 Chromium** 以 `--remote-debugging-port=9222` 启动
- 在该实例里**由使用者本人**登录抖音来客 —— 技能不接触账号、密码、验证码，也不保存 cookie

## 用法

技能面向 agent 执行，主流程：

```
wake → whoami → search(每人, pageSize≥20) → 四证据消歧
     → fields(category=<平台品类名>) → 写 Excel → 回归校验
```

关键命令：

```powershell
node scripts/cdp.mjs open "https://life.douyin.com/p/liteapp/alliance_merchant/merchant/talent/square"
node scripts/cdp.mjs list
node scripts/cdp.mjs wake <targetId>
node scripts/cdp.mjs evalp <targetId> scripts/talent-query.js <arg.json>
```

`evalp` 先注入 `window.__ARG` 再在页面上下文里 `awaitPromise` 求值，参数用 **`.json` 文件**传（Windows 下 PowerShell 会吃掉内联 JSON 的引号）。

消歧按顺序用四个证据：**昵称全等 > 以查询词开头 > 包含** → **常驻城市** → **订单地域第一位**（本地商家对应的达人，第一位必然是本市）→ **同机构后缀**（同一批名单常来自同一家 MCN，后缀逐字符相同）。

## 关键工程约定（都是踩过的坑）

1. **走 XHR，不走 fetch** —— 页面里的 `fetch` 可能被反爬 SDK 接管后永久 pending。
2. **品类名必须是平台品类名** —— 用户写「小吃快餐」，接口要的是「**快餐小吃**」；词序反了接口会返回 **HTTP 200 但静默不带 `talent_item_gmv`**（假成功，不是 4xx），唯一异常痕迹是 `categoryErr: 200`。
3. **「优势带货品类」卡只给 top5**，里面没有某品类 ≠ 该达人没有该品类。实测 `大发`、`酷7` 的 top5 都没有「快餐小吃」，但单独带 `category` 请求分别拿到 `0.36w` 和 `<0.01w`。该列的唯一权威来源是带 `category` 的单独请求。
4. **搜索是模糊匹配**，且不是子串匹配：`大发` 会命中 `暴暴大发现`、`大润发（三水店）`。不能拿「名字里包含这两个字」当匹配规则。
5. **昵称可能带 emoji / 空格 / 生僻字**（`酷7⃣️`、`三 岁 呀 ³`），关键词搜不到时走城市达人池兜底（`cityPool`）。
6. **不要采信简介里的自我介绍** —— 实测 `赵赵` 简介自称「带货等级 LV7」，平台字段是 `Lv6`。等级与销量一律以平台字段为准。
7. **平台没给的字段留空**，不要填 0，也不要写「无」——那会造出一个假结论。
8. **被遮挡的页面会被冻结**，`setTimeout` 不再触发，任何 `awaitPromise` 求值都会永久挂死且不报错。异步操作前先 `wake`。

## 披露

- **无凭据存储**：不收集、不保存、不打印任何账号密码、cookie、二维码或验证码。登录由使用者本人在浏览器内完成。
- **网络行为**：所有平台请求都在**你自己的已登录浏览器页面上下文**里发起（XHR），目标只有 `life.douyin.com` 的站内接口；不访问任何第三方服务器，不调用外部 API。
- **无遥测**：不发送任何使用分析、崩溃上报、埋点或心跳数据。
- **无第三方服务**：无 npm 依赖、无 MCP server、无数据库、无付费服务、无可执行安装脚本。仓库内不含任何账号数据或抓取结果。

## 已验证范围

2026-10-23 在本地商家账号下实测跑通完整链路：6 位达人消歧成功，四个字段全部取到并写入 Excel（数值格式 `X.XXw`）。

品类参数做过**正/负对照**：伪造品类名（如 `测试品类_不存在XYZ`）返回 `categoryErr: 200` 且无值，而真实平台品类（`火锅` / `快餐小吃`）对全部 6 人都有值 —— 证明该列是真值，不是「HTTP 200 静默缺字段」的假成功。

回归校验桩见 `references/api-map.md`：赵赵（uid `58783421119`）的粉丝量 `26.59w` 与视频带货力 `Lv6` 稳定复现。30 日总销售额会随平台滚动窗口前移而变化（示例中由 `49.68w` 变为 `43.70w`），这是数据本身的漂移，不是取数口径变化 —— 用「总额 × 平台品类占比 = 品类额」以及两个独立接口互证可区分二者。

## License

未指定，默认保留所有权利。需要某个开源协议的话自行加 LICENSE 文件即可。
