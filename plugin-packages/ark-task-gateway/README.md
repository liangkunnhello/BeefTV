# Ark Task Gateway

面向**自建 / 中转网关**的豆包 Seedance 任务式视频协议插件。

- Provider ID：`ark-task-gateway-video`
- 能力：`video`（任务型异步）
- 鉴权：`Authorization: Bearer <apiKey>`

| 操作 | 方法 | 路径 |
| --- | --- | --- |
| 创建任务 | POST | `/v1/contents/generations/tasks` |
| 查询任务 | GET | `/v1/contents/generations/tasks/{task_id}` |
| 取消任务 | DELETE | `/v1/contents/generations/tasks/{task_id}` |

## 怎么接到你自己的网关

1. 在渠道设置里选择本协议；
2. **把渠道的 `baseUrl` 填成你自己的网关地址**（例如 `https://your-gateway.example.com`）。
   **不要**带 `/v1` —— 路径里已经有了；
3. API Key 填网关下发的 Key。

插件清单里写的是占位地址 `https://your-gateway.example.com`，**只是默认值**；
渠道里填的地址在运行时优先。也就是说：这个插件对任何
「把厂商原生路径统一挂到 `/v1` 下」的网关都适用。

## 入参（豆包官方格式）

```json
{
  "model": "doubao-seedance-2.0",
  "content": [{ "type": "text", "text": "写实风格，一片白色雏菊花田，镜头逐渐拉近" }],
  "ratio": "16:9",
  "duration": 5,
  "watermark": false
}
```

参考图 / 参考视频 / 参考音频走 `content[]` 的 `image_url` / `video_url` / `audio_url`（带 `role`）。

## 和官方火山方舟协议（`volcengine-ark-video`）的关系

请求体映射完全一致，**只有路径前缀不同**：

| | 创建路径 |
| --- | --- |
| `volcengine-ark-video`（官方 Ark，直连火山） | `/api/v3/contents/generations/tasks` |
| `ark-task-gateway-video`（本插件，走网关） | `/v1/contents/generations/tasks` |

很多中转网关的规律是「**厂商原生路径去掉 host 后统一挂到 `/v1`**」，本插件就是为这种网关准备的。

## Seedance 2.5 用的是另一个 provider

`doubao-seedance-2.5` 的入参与查询路径都和 2.0 系列不同，所以本插件提供了第二个协议：

| | 2.0 / 2.0-fast | 2.5 |
| --- | --- | --- |
| Provider ID | `ark-task-gateway-video` | `ark-task-gateway-video-25` |
| 创建 | `POST /v1/contents/generations/tasks`，body 用 `content[]` | 同一路径，body 用**顶层 `prompt`** |
| 查询 | `GET /v1/contents/generations/tasks/{task_id}` | **`GET /v1/videos/{task_id}`** |
| 结果字段 | `content.video_url` | `video_url`（同时有 `metadata.url`）|
| 参考图 | `content[]` 里的 `image_url` + `role` | 单图 `input_reference`；多图 `image_urls`（两者不可同时给）|
| 参考视频/音频 | 支持 | 据网关文档**不支持**，插件会直接报错提示 |

> 踩坑记录：2.5 的任务**在 Ark 查询路径上会返回一段"聊天消息"形状的响应**
> （`{"type":"message","role":"assistant",...}`），永远没有 `status`/`video_url` ——
> 如果沿用它查询，任务会永远停在「上游生成中」。必须改用 `/v1/videos/{task_id}`。

## 已知限制

- 参考素材需要上游可访问（公网 URL 或上游接受的内联形式）。

细节与实测响应结构见 [docs/interface.md](docs/interface.md)。
