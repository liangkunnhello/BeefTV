# Wan Task Gateway 接口契约

面向「把厂商原生路径统一挂到 `/v1` 下」的中转网关的阿里系视频协议。

## 提供方

| 字段 | 值 |
| --- | --- |
| Provider ID | `wan-task-gateway-video` |
| Label | Wan Task Gateway（中转网关 · 阿里系视频） |
| Capabilities | `video` |
| Scopes | `admin.system-channel`、`user.custom-channel`、`canvas`、`creation`、`agent` |
| 默认 baseUrl | `https://your-gateway.example.com`（**占位符，请改为你自己的网关**） |
| 鉴权 | `auth.type = bearer`，`auth.field = apiKey` |

## 请求

| 操作 | 方法 | 路径 |
| --- | --- | --- |
| create | POST | `/v1/wan/video-generation/video-synthesis` |
| poll | GET | `/v1/wan/task/{{taskId}}` |

`create` 附加请求头：`X-DashScope-Async: enable`（缺了它上游会报
`current user api does not support synchronous calls`）。

`create` 请求体（`contentType: application/json`）：

```json
{
  "model": "<模型 ID>",
  "input": {
    "prompt": "<提示词>",
    "media": [
      { "type": "first_frame", "url": "https://…" },
      { "type": "reference_image", "url": "https://…" },
      { "type": "reference_video", "url": "https://…" },
      { "type": "driving_audio", "url": "https://…" }
    ]
  },
  "parameters": {
    "resolution": "480P",
    "ratio": "adaptive",
    "duration": 5,
    "prompt_extend": true,
    "watermark": false,
    "seed": 12345
  }
}
```

映射细节：

| 宿主持有 | 落到请求 |
| --- | --- |
| `request.model` | `model` |
| `request.prompt` | `input.prompt` |
| `request.images[].role` | `input.media[].type`：`first_frame` / `last_frame` 原样；`reference_to_video` 下普通参考图 → `reference_image`；其余 → `first_frame` |
| `request.videos` | `input.media[].type`：视频编辑类操作（`video_edit` / `video_to_video`）→ `video`；否则 → `reference_video` |
| `request.audios` | `input.media[].type = driving_audio` |
| `request.aspectRatio` | `parameters.ratio`（缺省 `adaptive`）|
| `request.resolution` | `parameters.resolution`，**自动转大写 P** |
| `request.duration` | `parameters.duration`（整数；≤ 0 时该字段整体省略）|
| `request.watermark` | `parameters.watermark` |
| `request.providerOptions.wan-task-gateway-video.prompt_extend` | `parameters.prompt_extend`（缺省 `true`）|
| `request.providerOptions.wan-task-gateway-video.seed` | `parameters.seed`（为空时省略）|

`media` 为空数组时整个字段省略（文生视频不传 `media`）。

## 响应映射

| 宿主字段 | 取值来源（依次 coalesce） |
| --- | --- |
| `taskId` | `response.output.task_id` → `response.task_id` → `response.data.task_id` → 上下文 `taskId` |
| `status` | `response.output.task_status` → `response.status` → `response.data.status` → `pending` |
| `message` | `response.output.message` → `response.message` → `response.error.message` → `response.output.code` |
| `videos` | `response.output.video_url` → `response.output.results.0.url` → `response.video_url` → `response.data.video_url` |
| `usage` | `response.usage` |

错误路径：`output.code`、`code`（两者均为空/`null`/`ok`/`success` 时不视为失败，
见 `backend/internal/protocol/manifest.go` 的 `manifestError`）。`resultEphemeral = true`。

## 状态取值

上游 `task_status`：`PENDING` / `RUNNING` / `SUCCEEDED` / `FAILED` / `CANCELED` / `UNKNOWN`。

宿主的状态归一（`backend/internal/protocol/builtin.go` 的 `normalizeStatus`）认识
`pending` / `running` / `succeeded` / `cancelled` / `canceled` / `failed` / `expired`，
大小写不敏感，因此无需额外映射。

⚠️ `UNKNOWN` 表示「任务不存在或状态未知」，归一后为空 → 宿主会继续轮询到超时，
这是刻意选择（网关偶发查不到任务时的自愈空间），不是缺陷。

## 与官方 DashScope 协议（`dashscope-wan-video`）的关系

| | 创建路径 | 查询路径 | 素材表达 |
| --- | --- | --- | --- |
| `dashscope-wan-video`（官方 DashScope 直连） | `/api/v1/services/aigc/video-generation/video-synthesis` | `/api/v1/tasks/{id}` | `input.img_url` / `reference_images` / `video_url` / `audio_url` |
| `wan-task-gateway-video`（本插件，走网关） | `/v1/wan/video-generation/video-synthesis` | `/v1/wan/task/{id}` | `input.media[]`（带 `type`） |

两者**不是同一份契约**：网关把阿里云原生路径改写成 `/v1/wan/...`，并把素材统一成 `media[]`
（wan2.7 风格）。因此本插件单独实现，不复用官方那套字段。

## 待办：端到端实测

见 [README 的实测状态](README.md)。当前只完成静态实现：
这 6 个模型在 2026-10-09 实测均 `503 no_available_providers`，
示例 Key 已失效（`401 invalid_api_key`）。开通后需按 README 的自检命令跑一遍，
确认 `output.task_id` / `output.task_status` / `output.video_url` 三个字段与假设一致。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "wan-task-gateway",
  "name": "Wan Task Gateway (阿里系视频)",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "经「中转网关」调用阿里系视频模型（万相 wan / happyhorse）的协议插件：创建 POST /v1/wan/video-generation/video-synthesis（带 X-DashScope-Async: enable），查询 GET /v1/wan/task/{task_id}。默认 baseUrl 为占位符，请在渠道里填写你自己的网关地址。",
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "API Key",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "wan-task-gateway-video",
        "label": "Wan Task Gateway（中转网关 · 阿里系视频）",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://your-gateway.example.com",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "阿里系模型 ID，例如 wan-3.0、happyhorse-1.1-t2v。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "input.prompt",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "input.media[type=first_frame|last_frame|reference_image]",
            "description": "首帧/尾帧/参考图；reference_to_video 下普通参考图映射为 reference_image。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "input.media[type=reference_video|video]",
            "description": "参考视频；视频编辑类操作映射为 video。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "input.media[type=driving_audio]",
            "description": "驱动音频。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "parameters.ratio",
            "description": "输出画幅，例如 16:9；缺省 adaptive。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "parameters.resolution（自动转大写 P）",
            "description": "480p / 720p / 1080p。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "parameters.duration",
            "description": "时长秒数（整数）；<=0 时不传。"
          },
          {
            "name": "watermark",
            "type": "boolean",
            "required": false,
            "mapping": "parameters.watermark",
            "description": "是否带 AI 水印。"
          },
          {
            "name": "promptExtend",
            "type": "boolean",
            "required": false,
            "mapping": "parameters.prompt_extend（默认 true）",
            "description": "是否启用上游提示词扩写。"
          },
          {
            "name": "seed",
            "type": "integer",
            "required": false,
            "mapping": "parameters.seed",
            "description": "providerOptions seed。"
          }
        ],
        "validations": [],
        "create": {
          "method": "POST",
          "path": "/v1/wan/video-generation/video-synthesis",
          "contentType": "application/json",
          "headers": {
            "X-DashScope-Async": "enable"
          },
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "input": {
              "prompt": {
                "$ref": "request.prompt"
              },
              "media": {
                "$omitEmpty": {
                  "$concatArrays": [
                    {
                      "$map": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "in": {
                          "type": {
                            "$if": {
                              "condition": {
                                "$eq": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "last_frame"
                                ]
                              },
                              "then": "last_frame",
                              "else": {
                                "$if": {
                                  "condition": {
                                    "$eq": [
                                      {
                                        "$ref": "media.role"
                                      },
                                      "first_frame"
                                    ]
                                  },
                                  "then": "first_frame",
                                  "else": {
                                    "$if": {
                                      "condition": {
                                        "$eq": [
                                          {
                                            "$ref": "request.operation"
                                          },
                                          "reference_to_video"
                                        ]
                                      },
                                      "then": "reference_image",
                                      "else": "first_frame"
                                    }
                                  }
                                }
                              }
                            }
                          },
                          "url": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    },
                    {
                      "$map": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.videos"
                          }
                        },
                        "as": "media",
                        "in": {
                          "type": {
                            "$if": {
                              "condition": {
                                "$in": [
                                  {
                                    "$ref": "request.operation"
                                  },
                                  [
                                    "video_edit",
                                    "video_to_video"
                                  ]
                                ]
                              },
                              "then": "video",
                              "else": "reference_video"
                            }
                          },
                          "url": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    },
                    {
                      "$map": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.audios"
                          }
                        },
                        "as": "media",
                        "in": {
                          "type": "driving_audio",
                          "url": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    }
                  ]
                }
              }
            },
            "parameters": {
              "resolution": {
                "$upper": {
                  "$coalesce": [
                    {
                      "$ref": "request.resolution"
                    },
                    "720p"
                  ]
                }
              },
              "ratio": {
                "$coalesce": [
                  {
                    "$ref": "request.aspectRatio"
                  },
                  "adaptive"
                ]
              },
              "duration": {
                "$omitEmpty": {
                  "$if": {
                    "condition": {
                      "$gt": [
                        {
                          "$ref": "request.duration"
                        },
                        0
                      ]
                    },
                    "then": {
                      "$ref": "request.duration"
                    },
                    "else": null
                  }
                }
              },
              "prompt_extend": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.wan-task-gateway-video.prompt_extend"
                  },
                  true
                ]
              },
              "watermark": {
                "$ref": "request.watermark"
              },
              "seed": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.wan-task-gateway-video.seed"
                }
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/wan/task/{{taskId}}"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.output.task_id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.output.task_status"
              },
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.data.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.output.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.output.code"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.output.video_url"
              },
              {
                "$ref": "response.output.results.0.url"
              },
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.data.video_url"
              }
            ]
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "output.code",
            "code"
          ],
          "resultEphemeral": true
        }
      }
    ]
  }
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
