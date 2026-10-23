---
name: douyin-talent-screen
description: |
  按一份达人昵称名单，从抖音来客「达人广场」批量取达人数据（粉丝指数 / 视频带货力等级 / 30日总销售额 / 指定品类销售额），
  用于筛选达人并落到 Excel。
  Use this skill when the user hands over a list of 达人昵称 or 抖音号 and wants those fields filled in —
  triggers on「抖音达人筛选」「按名单搜达人」「达人广场查达人」「帮我把这几个达人的粉丝量和带货金额查一下」
  「达人带货数据」「齐大达人」「把这些达人填到表里」「再建一个 sheet 另一套名单」。
  Do NOT use it to export the whole 达人广场 list（那是页面自带的「导出达人」按钮），
  to pull merchant revenue / order reports（用 daily-platforms-export），
  or when the user gives no talent list to look up.
---

# 抖音达人筛选

数据全部来自 `life.douyin.com` 的站内接口，在用户已登录的浏览器里通过 CDP 调用。
不走 HTTP 直连（SPA 空壳 + secsdk/bdms 反爬），不走 headless（没有登录态），不靠点页面上表。

## Inputs to collect

- 名单：昵称，有抖音号/uid 更好
- 目标 Excel 路径，以及是新建 sheet 还是追加
- 需要的字段与口径。默认口径见 `references/api-map.md` 的字段映射表
- 是否需要某个「品类列」（如「小吃快餐」）——要的话需要品类名

名单里给的昵称往往和抖音实际昵称不完全一致（少 emoji、简写、后缀省略），
所以「找不到」是常态而不是异常，按 Failure handling 逐个兜底，不要静默跳过或猜一个。

## 前置环境

1. **先探测 9222，能通就复用**：

```powershell
Invoke-RestMethod "http://127.0.0.1:9222/json/version"
```

通了就直接跳到第 3 步、**复用它**。不要另起 profile —— 端口会冲突，而且新 profile 是干净的、
没有登录态，会逼用户重新扫码；已在跑的调试实例通常带着真实登录态，复用才对。
复用时守规矩：只开自己的标签页，不要导航或关闭用户已经开着的页面。

2. 9222 不通时，才用独立 profile 起 Edge：

```powershell
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$prof = Join-Path $env:TEMP "edge-cdp-talent"
[System.IO.Directory]::CreateDirectory($prof) | Out-Null
Start-Process -FilePath $edge -ArgumentList @(
  "--user-data-dir=$prof","--remote-debugging-port=9222",
  "--no-first-run","--no-default-browser-check","--disable-sync"
)
Start-Sleep -Seconds 12
Invoke-RestMethod "http://127.0.0.1:9222/json/version"
```

3. 在该实例里打开并登录抖音来客达人广场，确认不跳登录页：

```
https://life.douyin.com/p/liteapp/alliance_merchant/merchant/talent/square
```

4. `node scripts/cdp.mjs open <广场URL>` 开**自己的**标签页，
   再用 `node scripts/cdp.mjs list` 认出它的 targetId，后面所有命令都挂这个 targetId。
   不要复用用户已经开着的页面（容易被对方的操作打断）。

登录本身由用户完成，不要索要、不要记录账号密码或验证码。

## Procedure

1. **唤醒页面**：`node scripts/cdp.mjs wake <targetId>`
   原因：被遮挡的 Chromium 渲染进程会被冻结，`setTimeout` 不再触发，于是任何 `awaitPromise`
   的求值都会永久挂死、且不报错。表现是命令一直不返回 —— 看到这个症状先怀疑冻结，别去改脚本。

2. **取商家身份**。参数写成 `.json` 文件再传路径，别内联（PowerShell 会吃掉 JSON 里的引号）：

   ```powershell
   $arg = Join-Path $env:TEMP "whoami.json"
   '{"op":"whoami"}' | Out-File -Encoding utf8 $arg
   node scripts/cdp.mjs evalp <targetId> scripts/talent-query.js $arg
   ```

   `evalp` 先往页面注入 `window.__ARG`，再在页面上下文里 `awaitPromise` 求值，
   所以拿到的响应自带登录 cookie。返回 `root_life_account_id`，后面的接口都要它；取不到就直接问用户。

3. **逐人搜索**：
   ```json
   { "root": "<root>", "op": "search", "keyword": "大发", "pageSize": 30 }
   ```
   `pageSize` 别低于 20 —— 相关度排序下，本地同名的那个达人经常排在第 2~5 位，页太小会把它挤出去。

4. **消歧**（这一步不能省）。搜索是模糊匹配，`大发` 会命中 `暴暴大发现`、`大润发（三水店）`。
   按顺序用三个证据：
   - 昵称：全等 > 以查询词开头 > 包含。`赵赵.（MCN松柏文化）` 以「赵赵」开头，`暴暴大发现` 不是
   - 常驻城市：与商家同城（`provinceCity` 编码见 `references/api-map.md`）
   - **订单地域**：跑一次 `fields`，看 `orderArea` 第一位。本地商家对应的达人第一位必然是本市
     （实测 20 人全部满足，且异地同名者第一位都不是本市）。这一条最硬，昵称近似时用它定音
   - **同机构后缀**：同一批名单常来自同一家 MCN，昵称后缀会**逐字符相同**
     （`赵赵.（𝙈𝙘𝙣松柏文化）` / `大发.（𝙈𝙘𝙣松柏文化）`）。命中第一个人之后，
     后缀是给后面的人定音的好线索；`keyword` 直接搜 MCN 名（如「松柏文化」）还能反向捞出整本花名册

   **不要采信达人简介里的自我介绍**：实测 `赵赵` 简介自称「带货等级LV7」，平台字段是 `Lv6`。
   简介是自我宣传，等级/销量一律以平台字段为准，简介只当同城同机构的辅助线索用。

5. **取字段**：
   ```json
   { "root": "<root>", "op": "fields", "category": "快餐小吃",
     "uids": [["赵赵","58783421119"], ["大发","61714788494"]] }
   ```
   返回 `fansW / levelItem / gmv30W / categoryW / orderArea`。

   `category` 要填**平台的品类名**，不是用户表头的列名。用户写「小吃快餐」，接口要的是「快餐小吃」，
   词序反了就不认。填错时接口**返回 200 但静默不带 `talent_item_gmv`**（假成功，不是 4xx），
   表现只是 `categoryErr: 200`，批量跑会让整列悄悄变空。
   拿不准就先不带 `category` 请求一次，从 `talent_great_category_data.category_name[]`
   读出平台真实品类名再填，不要猜。

   **不要用「优势带货品类里没列出这个品类」判定该达人没有该品类。** 那张卡只有 top5，
   实测 `大发`、`酷7` 的 top5 里都没有「快餐小吃」，但带 `category` 请求分别拿到 `0.36w` 和 `<0.01w`。
   `categoryW` 为空或 `<0.01w` 时按实填写，不要写成「无」。

6. **写入 Excel**。写文件交给 `xlsx` skill，不要自己拼 xlsx 二进制；
   数值格式统一按平台口径换算成 `X.XXw`（见 `references/api-map.md`）。

7. **回归校验**。跑一次 `赵赵`（uid `58783421119`），四个值必须是
   `26.59w / Lv6 / 49.68w / 4.41w`。对不上说明字段口径漂了，停下查 `references/api-map.md`，
   不要带着错口径批量跑。

## Output contract

- Excel：一人一行，一列一个字段，数值统一 `X.XXw`；平台返回 `<100`（不足百元）写 `<0.01w`
- 汇报里要给出：账号 | 匹配到的实际昵称 | 抖音号 | 各字段值
- 汇报里要显式说明：哪些行是昵称不精确匹配的、匹配依据是什么、哪些值平台没给（缺值不要填 0）
- 名单里任何一个人没查到，都要单独列出来并说明「需要抖音号才能继续」，不要悄悄少一行

## Failure handling

出问题先读 `references/troubleshooting.md` —— 那里面每一条都是实测踩过的，
症状描述比下面这份摘要具体（挂死、浮层挡点击、emoji 昵称、schema 试错等）。

- **搜索返回 0 或全是异地**：换 `cityPool` 兜底 —— 拉该城市达人池分页，按正则匹配昵称：
  ```json
  { "root": "<root>", "op": "cityPool", "city": "230200", "pages": 10,
    "pageSize": 50, "nameRegex": "酷7|丹妮" }
  ```
  实测 `酷7⃣️`（带 keycap emoji）用关键词完全搜不到，靠这个池子捞出来的。
- **昵称里有 emoji / 生僻字 / 平台做了同形替换**：同上走 cityPool；另一条线索是看同城同机构
  达人的简介（`fields` 返回 `intro`），常有 `@终身合作伙伴：@酷7⃣️` 这类提及。
- **城市池也没有**：回头问用户要抖音号。不要用「名字里都带这个字」的近似达人顶替。
- **接口报 4xx / 返回结构变了**：用 `scripts/capture-xhr.mjs` 抓真实请求 ——
  先起抓包，再在页面上点一次对应按钮，请求体就出来了。抖音的筛选项 schema 靠猜代价极高
  （`filter_item_params` 试了 8 种写法才确认是「key → 数组」的 map）。
- **命令一直不返回**：页面冻结，`wake` 后重试（详见 `references/troubleshooting.md` 第 1 条）。
- **同一个人名搜到多个高度相似候选**：不要自己挑，把候选列给用户选。

## Windows (win32) platform notes

- 全部命令走 PowerShell。`python3` 不存在，用 `python` 或 `py`。
- 传 JSON 参数给 `evalp` 时优先写 `.json` 文件再传路径，避免 PowerShell 吃掉引号。
- 用 `Start-Process` 拉带空格参数的 Edge 时用 `-ArgumentList @(...)` 数组形式，不要拼字符串。
- 源文件若含中文，用 pwsh 7+ 执行（5.1 按 GBK 读脚本会乱码）。

## Examples

Input：「按这个名单（赵赵、大桐桐、大发……20 人）抓 粉丝量/带货等级/带货金额/小吃快餐，填到齐大达人.xlsx」

Path：`wake` → `whoami` → 对 20 人 `search`（pageSize 30）→ 用「昵称前缀 + 常驻城市 + 订单地域」消歧 →
`fields` 带 `category:"快餐小吃"` → 写 Excel → 用赵赵回归校验。

Output：20 行 × 4 字段，另附「匹配到的实际昵称」对照表。实测本名单里 4 个需要说明：
`董姑娘→董姑娘探店`、`大宇吃喝玩乐→鹤城大宇`、`红梅姐姐→红梅姐姐（达人团长）免费策划`、
`三岁呀→三 岁 呀 ³`（昵称带空格）。
