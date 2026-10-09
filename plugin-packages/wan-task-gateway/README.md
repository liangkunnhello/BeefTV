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

细节契约见 [docs/interface.md](docs/interface.md)。
