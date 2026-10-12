# Wan Task Gateway（阿里系视频）

面向**自建 / 中转网关**的阿里系视频协议插件：一次接入万相 `wan` 与 `happyhorse` 系列模型。

- Provider ID：`wan-task-gateway-video`
- 能力：`video`（任务型异步：创建 → 轮询）
- 鉴权：`Authorization: Bearer <apiKey>`

| 操作 | 方法 | 路径 |
| --- | --- | --- |
| 创建任务 | POST | `/v1/wan/video-generation/video-synthesis` |
| 查询任务 | GET | `/v1/wan/task/{task_id}` |

创建请求需要带 `X-DashScope-Async: enable`（插件已内置该请求头）。

## 支持的模型

`wan-3.0`、`wan3.0-video-prime`、`happyhorse-1.1-i2v`、`happyhorse-1.1-t2v`、`happyhorse-1.1-r2v`、`happyhorse-1.0-video-edit`

这 6 个模型共享同一套收费口径（按分辨率 + 秒数）与同一套请求接口，因此**共用这一个协议**：
在渠道里给每个模型都把「请求协议」选成本协议即可。

## 怎么接到你自己的网关

1. 在渠道的模型编辑里，把模型的「请求协议」选为 **Wan Task Gateway（中转网关 · 阿里系视频）**；
2. **把渠道的 `baseUrl` 填成你自己的网关地址**（例如 `https://your-gateway.example.com`）。
   **不要**带 `/v1` —— 路径里已经有了；
3. API Key 填网关下发的 Key。

插件清单里写的是占位地址 `https://your-gateway.example.com`，**只是默认值**；渠道里填的地址在运行时优先。

## 请求体（网关文档形态）

```json
{
  "model": "wan-3.0",
  "input": {
    "prompt": "一支高端智能眼镜产品广告……",
    "media": [
      { "type": "first_frame", "url": "https://…/first.png" },
      { "type": "reference_video", "url": "https://…/ref.mp4" },
      { "type": "driving_audio", "url": "https://…/voice.mp3" }
    ]
  },
  "parameters": {
    "resolution": "480P",
    "ratio": "adaptive",
    "duration": 10,
    "prompt_extend": true,
    "watermark": false
  }
}
```

### 素材类型（`input.media[].type`）

| 模型族 | 可用 type | 说明 |
| --- | --- | --- |
| 图生视频 `*-i2v` | `first_frame` / `last_frame` / `driving_audio` | 首帧、尾帧、驱动音频 |
| 参考生视频 `*-r2v` | `reference_image` / `reference_video` / `first_frame` | 参考图与参考视频合计 ≤ 5 |
| 视频编辑 `*-video-edit` | `video` / `reference_image` | `video` 为被编辑的源视频 |

插件按「角色 + 当前操作」自动选择 type：显式的 `first_frame`/`last_frame` 角色原样保留；
`reference_to_video` 操作下的普通参考图映射为 `reference_image`；视频编辑类操作下的视频映射为 `video`。

> ⚠️ 上游要求素材是**公网可访问的 HTTPS 直链**；需要登录、带 Cookie、内网地址或临时链接会导致任务失败。

### 参数注意

- `resolution` 必须是**大写 P**（`480P` / `720P` / `1080P`）—— 插件会自动把渠道里的 `480p` 转成 `480P`；
- `duration` 必须是**整数**（不要传字符串）；≤ 0 时不发送该字段，由上游默认；
- `ratio` 缺省 `adaptive`，也可显式给 `16:9` / `9:16` / `1:1` 等；
- `prompt_extend` 默认 `true`（上游提示词扩写）。

## 查询与结果

```json
// 进行中
{ "request_id": "…", "output": { "task_id": "…", "task_status": "RUNNING" } }

// 成功
{ "request_id": "…", "usage": { "video_count": 1, "video_duration": 10 },
  "output": { "task_id": "…", "task_status": "SUCCEEDED",
              "video_url": "https://…/xxx.mp4?Expires=…" } }
```

`task_status` 取值：`PENDING` / `RUNNING` / `SUCCEEDED` / `FAILED` / `CANCELED` / `UNKNOWN`（项目内置的状态归一全部认识）。
**结果 URL 有效期通常 24 小时**，宿主会及时下载留存（`resultEphemeral = true`）。

## ✅ 实测状态（2026-10-09 已跑通）

已端到端验证（模型权限开通后）：

| 环节 | 实测结果 |
| --- | --- |
| 创建 | `POST /v1/wan/video-generation/video-synthesis` → **200** `{"output":{"task_id":"…","task_status":"PENDING"},"request_id":"…"}` |
| 查询 | `GET /v1/wan/task/{task_id}` → `PENDING → RUNNING → SUCCEEDED`，成功时 `output.video_url` 就绪 |
| 出片 | `happyhorse-1.1-t2v`，480P / 16:9 / 5 秒，**约 60 秒**出片（直连）；走 BeefTV 全链路 **52 秒** 成功 |
| 全链路 | 宿主发出的请求体与网关文档一致；`resolution` 自动转大写 P、`duration` 为整数 |

### ⚠️ 坑 1：`ratio: "adaptive"` 会被拒（已修）

`happyhorse-1.1-t2v` 拒绝 `adaptive`：

```json
{"output":{"task_status":"FAILED","code":"InvalidParameter",
 "message":"Input should be '16:9', '9:16', '4:3', '3:4', '1:1', '5:4', '4:5', '9:21' or '21:9': parameters.ratio"}}
```

合法取值就是上面这 9 个。因此插件把缺省 `ratio` 从 `adaptive` 改为 **`16:9`**（渠道里给了画幅就按渠道的走）。
**注意 `FAILED` 只在查询阶段才暴露**，创建仍然返回 200 + 任务号。

### ⚠️ 坑 2：模型 ID 以网关模型列表为准

`GET /v1/models` 里实际存在的是：

```
wan3.0-video   wan3.0-video-prime
happyhorse-1.1-t2v   happyhorse-1.1-i2v   happyhorse-1.1-r2v
happyhorse-1.0-video-edit
```

**没有 `wan-3.0` 这个 ID**（写 `wan-3.0` 会得到 `503 no_available_providers`，
这句报错同时表示「模型名不对」和「上游暂时没容量」，容易被误导 —— 先用 `/v1/models` 核对名字）。

### 上游抖动

`wan3.0-video` 首次实测返回 `503 service_unavailable_error`（所有供应商暂时不可用），
属上游容量抖动，重试即可；与模型名错误（也是 503）无法从文案区分，**先核对模型列表**。

**2026-10-12 补充实测**：该渠道下 `wan3.0-video` 与 `wan3.0-video-prime` **持续 503**
（15:08 / 15:46 / 15:50 三次 BeefTV 任务 + 直连探测，均 `service_unavailable_error`），
即使用**最小合法请求**（只给 `input.prompt`、不带任何素材）：

```sh
curl -sS "$GATEWAY/v1/wan/video-generation/video-synthesis" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'X-DashScope-Async: enable' \
  -d '{"model":"wan3.0-video","input":{"prompt":"一只橘猫在窗台上打盹"},
       "parameters":{"resolution":"720P","ratio":"16:9","duration":5}}'
# → HTTP 503 {"error":{"code":"service_unavailable_error","message":"所有供应商暂时不可用，请稍后重试"}}
```

同一时刻同协议的 `happyhorse-1.1-i2v` **可以正常出片**（200 / 124 秒）。
⇒ 这两个模型是**上游未开通 / 无容量**，与请求参数无关（该渠道的 503 同时覆盖「无可用上游」
「上游拒单」「任务号查不到」三种语义，所以**先用最小请求把参数因素排除掉**）。

### 三个 wan 名字的实测对照（2026-10-12 15:5x，本渠道 Key）

网关文档列出的阿里系可用模型写的是 **`wan-3.0`**（带横线），而 `GET /v1/models` 里是
`wan3.0-video` / `wan3.0-video-prime`（没有 `wan-3.0`）。用最小请求（只给 prompt）逐个打一遍：

| 模型 ID | HTTP | 错误码 | 说明 |
| --- | --- | --- | --- |
| `wan3.0-video` | 503 | `service_unavailable_error` | 在 `/v1/models` 里，但无可用上游 |
| `wan3.0-video-prime` | 503 | `service_unavailable_error` | 同上 |
| `wan-3.0` | 503 | `no_available_providers` | **ID 被网关识别**（不是 403 未知模型），同样无可用上游 |
| `happyhorse-1.1-i2v` | 200 | — | 正常出片 |

- 三种 503 的错误码不同，但语义都是「没有可用上游」，**改参数无用**；
  ⚠️ 对未知模型名网关返回的是 403 `model_not_allowed`（不是 503），可据此区分「名字写错」与「没开通」。
- ⚠️ 文档里给的示例 Key（`sk-6bf3acf4…`）实测 **401 `invalid_api_key`** —— 那是文档示例凭证，不能直接用；
  请以你自己的渠道 Key 为准。
- `wan-3.0` 已按「万相 3.0」纳入能力画像（时长 2–30 秒、画幅含 `adaptive`），上游开通后无需再改代码。

细节契约见 [docs/interface.md](docs/interface.md)。

## 官方契约对齐（2026-10-12 核对 Model Studio《万相3.0-视频产生API参考》）

逐字段核对后，**确实发错的两处**已改：

| 项 | 改前 | 改后 | 依据 |
| --- | --- | --- | --- |
| 音频素材 `type` | `driving_audio` | **`reference_audio`** | 官方枚举只有 first_frame / last_frame / reference_image / reference_video / reference_audio / file / link |
| 待编辑视频 `type` | `video` | **`reference_video`** | 同上：官方枚举里**没有** `video` |

**刻意保持不变**（有实测或成本依据，不跟随官方默认）：

- 缺省 `ratio` 仍为 `16:9`：`happyhorse` 实测**拒绝 `adaptive`**（见「坑 1」），而本协议同时服务两个家族；
- 缺省 `resolution` 仍为 `720P`（官方默认 `1080P`）—— 显式传参，固定成本；
- **不发送**官方 `parameters.audio`（官方默认 `true`，即输出含音轨，开关声音同价）：
  未对 happyhorse 实测前不新增字段，因此 BeefTV 里也不显示「生成音频」开关。[待验证]
- `prompt_extend` 已默认 `true`，与官方默认一致。

**按家族区分的参数**（在 BeefTV 的能力画像里实现，插件本身不做区分）：

| 家族 | 时长 | 画幅枚举 |
| --- | --- | --- |
| `wan3.0-video` / `wan3.0-video-prime` | 2–30 秒（官方：无视频输入 [2,30] 整数） | `adaptive` + `21:9` `16:9` `4:3` `1:1` `3:4` `9:16` |
| `happyhorse-*` | 2–15 秒（无公开文档，保守） | 9 个具名值：`16:9` `9:16` `4:3` `3:4` `1:1` `5:4` `4:5` `9:21` `21:9`（无 `adaptive`） |

仍未覆盖（上游会报错，本地拦不住）：官方要求 `reference_*`/`file`/`link` 与 `first_frame`/`last_frame`
**互斥，不能同请求混用**；现有能力模型无法表达这条约束。
