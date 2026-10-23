# 抖音来客达人接口地图

Base：`/life/alliance/v1/merchant/talent_square/talent/`
所有请求都要带 `root_life_account_id=<id>`，并复用浏览器里的登录 cookie（靠 CDP 在页面内发起即可）。
用 XHR 发起，不要用 `fetch` —— 页面里的 `fetch` 可能被反爬 SDK 接管后永久 pending。

## 1. 搜索达人

```
POST {base}search/?root_life_account_id=<root>
Content-Type: application/json
```

```json
{
  "enable_filter_item_params": true,
  "request_source": 2,
  "page": 1,
  "page_size": 30,
  "from_type": 5,
  "keyword": "赵赵"
}
```

- `page_size` 建议 30~50。相关度排序下本地同名达人常在 2~5 位，页太小会丢掉。
- `from_type: 5` 是关键：带上它之后排序会按商家相关性倾斜，本地达人被顶到前面；
  不带 `from_type` 只给全站模糊结果（`酷7` 那种情况下两边都搜不到，纯靠城市池兜底）。
- `total_count` 恒为 1000（服务端上限），不是真实总量，别拿它判断有没有搜全。
- 响应：`talent_list[]`，元素含 `nick_name / uid / unique_id(抖音号) / fans_count / item_level /
  live_level / content_level / city_name / resident_city_name / local_fans_count / sale_detail`。

### 过滤项 `filter_item_params`

结构是 **`{ key: [value...] }` 的 map，值必须是数组**：

```json
{ "filter_item_params": { "CooperationStatus": ["Cooperated"], "provinceCity": ["230200"] } }
```

踩坑记录：写成 `{"CooperationStatus":"Cooperated"}`（值不是数组）、写成数组 `[{key,value}]`、
写成裸 `[]` 全部报 `JSON-TO-THRIFT dismatched types`。只有 map→array 这一种是对的。

可用的 key（完整清单见 `search/config/?from_type=5` 响应里的 `filter_items[].key`）：

| key | 含义 | 取值示例 |
|---|---|---|
| `provinceCity` | 常驻城市 | 城市码，齐齐哈尔 `230200`，黑龙江省 `23` |
| `CooperationStatus` | 是否合作过 | `Cooperated` / `ContactedAndUnCooperate` / `UnContact` |
| `cateTag` | 优势品类 | `快餐小吃`、`地方菜` … |
| `itemLevel` / `liveLevel` | 视频/直播带货力 | `"0"`~`"8"` |
| `talentFansNum` | 粉丝指数分档 | `"[0,1,2]"` |
| `KeyuserIds` | 指定达人 | 抖音号数组，如 `["9469011886"]` |
| `mediaType` | 达人类型 | `Video` / `Live` / `VideoAndLive` |

注意 `provinceCity` 过滤下 `total_count` 仍是 1000，分页照常翻，命中要靠本地正则过滤。

### 顶层参数 `citycode`

`search` 的 body 里还有一组**顶层**参数，不用塞进 `filter_item_params`：
`keyword`（昵称/抖音号）、`citycode`（城市码）、`talent_uid_list`（指定 uid 数组）、
`page` / `page_size` / `from_type`。

这些名字是从前端 bundle 里反查出来的（`genBaseURL` 那一支的函数签名），不是猜的。
`citycode=230200` 实测能把结果直接限定在齐齐哈尔，效果与 `provinceCity` 过滤项等价，两者都可用。

## 2. 达人详情

```
GET {base}detail/?from_type=5&uid=<uid>&root_life_account_id=<root>
```

响应 `talent_detail`：
- `nick_name` / `unique_id`(抖音号) / `self_intro` / `city_name` / `resident_city_name`
- `talent_display_info.fans_count_display.statistice_value` → `{value, notation}`，粉丝指数
- `talent_display_info.talent_item_level_display` → **视频带货力**（`Lv0`~`Lv8`）
- `talent_display_info.talent_live_level_display` → 直播带货力

## 3. 总计指标（30日总销售额）

```
GET {base}total/indicator/?from_type=5&uid=<uid>&root_life_account_id=<root>
```

响应 `talent_total_statistice`：
- `talent_total_gmv` → **30日总销售额**，`{value, notation, prefix:"¥", digit_value}`
- `verify_rate_30d.statistice_value.value` → 30日核销率
- `order_user_area_rate[]` → 下单用户地域分布，**消歧的决定性证据**
- `fans_area_rate[]` / `fans_age_rate[]` / `order_user_age_rate[]`

## 4. 品类指标（品类精确销售额）

```
GET {base}detail/indicator/?uid=<uid>&media_type=1&date_n=30&category=<品类URL编码>&from_type=5&root_life_account_id=<root>
```

响应 `talent_item_statistice`，带 `category` 时：
- `talent_item_gmv` → **该品类的带货总销售额（精确值）**

不带 `category` 时同一个字段是整个视频口径的总销售额，另外会多返回
`talent_great_category_data`：`category_name[]` + `category_rate[]`，这是
页面「优势带货品类」那张卡的数据源。

### `category` 必须是平台品类名（填错是假成功）

平台品类名和用户表头的列名不一定同序：用户写「**小吃快餐**」，接口要的是「**快餐小吃**」。

填平台不认识的品类名时，接口返回 **HTTP 200 但不带 `talent_item_gmv`** ——
不是 4xx、不报错、不抛异常，只是静默缺字段。批量跑会让整列悄悄变空，
唯一的异常痕迹是 `categoryErr: 200`。**看到 `categoryW` 全空而 `categoryErr` 是 200，先怀疑品类名。**

**怎么拿到真名**（两条都不用猜）：

1. 先不带 `category` 请求同一接口，读 `talent_great_category_data.category_name[]`
2. `GET {base}search/config/?from_type=5` → `filter_items[]` 里 `key = cateTag` 的候选值
   （如 `快餐小吃`、`地方菜`）

不要用用户表头的列名直接当参数，也不要试 `小吃` / `快餐` / `美食` 这类自造简称。

**只有 top5**，所以这里有两类错法：

1. 用「总销售额 × 品类占比」估 —— 那只是估算，不是平台值。
2. **看到 top5 里没有目标品类，就判定「该达人没有这个品类」—— 这是错的。**

实测反例（同一批数据）：

| 达人 | top5 里有没有「快餐小吃」 | 带 `category=快餐小吃` 的实际返回 |
|---|---|---|
| 赵赵 | **有** | `4.41w` |
| 大发 | **没有**（汽车服务/休闲食品/地方菜/景点票券/传统娱乐） | **`0.36w`** |
| 酷7 | **没有**（景点票券/汽车服务/洗浴按摩/火锅） | **`<0.01w`** |

三个人**都有**该品类成交，其中两个人根本不在 top5 里。
**top5 没列出 ≠ 没有成交。** 要某个品类的准确金额，只有一条路：带 `category` 单独请求一次。
`<100` 表示确有成交但不足百元，它不是 0，也不能写成「无」。

`media_type`：`1` = 视频，`2` = 直播。品类卡和 `category` 过滤走的是 `media_type=1`。

## 字段映射（与用户口径对齐）

| 业务列 | 来源 | 路径 |
|---|---|---|
| 账号 | 用户名单 | —— |
| 粉丝量 | 粉丝指数 | `detail` → `fans_count_display.statistice_value` |
| 带货等级 | **视频带货力** | `detail` → `talent_item_level_display.statistice_value.value` |
| 带货金额 | **30日总销售额** | `total/indicator` → `talent_total_gmv` |
| 品类列（如小吃快餐） | 该品类带货总销售额 | `detail/indicator?category=<品类>` → `talent_item_gmv` |

**不要**用 `level` / `talent_level_display`（「带货力」综合值）当带货等级 —— 用户要的是视频带货力。

## 单位与格式

- `digit_value` 是**分**：`digit_value / 100` 才是元。
  例：赵赵 `digit_value=49683031` → 496,830.31 元 → 49.68万元。
- `notation` 为 `"万"` 时 `value` 已经是万；没有 `notation` 时 `value` 是元。
- 平台对不足百元的金额返回字符串 `"<100"`，不要当成 0，也不要做数值运算。
- 输出统一换算成 `X.XXw`；`"<100"` → `"<0.01w"`。

## 回归校验桩

赵赵 uid `58783421119`，四值必须为：

```
粉丝量 26.59w | 带货等级 Lv6 | 带货金额 49.68w | 小吃快餐 4.41w
（原始：26.59万 / Lv6 / 49.68万 / <100 之外的 4.41万，digit 4410612）
```

酷7 uid `59132698085`（昵称 `酷7⃣️`，抖音号 `ku758009`）：
`0.54w / Lv1 / 0.23w / <0.01w` —— 用来验证缺值与 emoji 昵称两条路径。

口径跑通前不要批量落表。
