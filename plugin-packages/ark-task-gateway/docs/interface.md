# ark-task-gateway-video 接口契约

面向「把厂商原生路径统一挂到 `/v1` 下」的中转网关的豆包 Seedance 任务式视频协议。

## 提供方

| 字段 | 值 |
| --- | --- |
| Provider ID | `ark-task-gateway-video` |
| Label | Ark Task Gateway（中转网关 · 豆包任务式） |
| Capabilities | `video` |
| Scopes | `admin.system-channel`、`user.custom-channel`、`canvas`、`creation`、`agent` |
| 默认 baseUrl | `https://your-gateway.example.com`（**占位符，请改为你自己的网关**） |
| 鉴权 | `auth.type = bearer`，`auth.field = apiKey` |

## 请求

| 操作 | 方法 | 路径 |
| --- | --- | --- |
| create | POST | `/v1/contents/generations/tasks` |
| poll | GET | `/v1/contents/generations/tasks/{{taskId}}` |
| cancel | DELETE | `/v1/contents/generations/tasks/{{taskId}}` |

`create` 请求体（`contentType: application/json`）：

```json
{
  "model": "doubao-seedance-2.0",
  "content": [
    { "type": "text", "text": "<提示词>" },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "first_frame" },
    { "type": "video_url", "video_url": { "url": "https://..." }, "role": "reference_video" },
    { "type": "audio_url", "audio_url": { "url": "https://..." }, "role": "reference_audio" }
  ],
  "ratio": "16:9",
  "resolution": "720p",
  "duration": 5,
  "generate_audio": true,
  "watermark": false
}
```

## 响应映射

| 宿主字段 | 取值来源（依次 coalesce） |
| --- | --- |
| `taskId` | `response.platform_task_id` → `response.id` → `response.task_id` → `response.data.id` → 上下文 `taskId` |
| `status` | `response.status` → `response.data.status` → `pending` |
| `message` | `response.error.message` → `response.message` → `response.fail_reason` |
| `videos` | `response.content.video_url` → `response.video_url` → `response.output.video_url` → `response.data.video_url` |
| `usage` | `response.usage` |

错误路径：`error.code`。`resultEphemeral = true`（结果 URL 需由宿主及时下载留存）。

---

## 中转网关的两类「反直觉」行为（实测踩坑）

### 1. 轮询响应里的 `id` 可能不是你的任务号

典型响应：

```json
// 创建：返回你的任务号
{ "id": "01M3NJQ1X7MZXZD0E33CGYZ9HY" }

// 进行中：id 变成网关自己的内部号，原任务号在 platform_task_id
{ "id": "cgt-20260929111814-2rj75", "platform_task_id": "01M3NJQ...",
  "model": "doubao-seedance-2-0-fast-260128", "status": "running" }

// 成功：platform_task_id 可能消失，视频在 content.video_url
{ "id": "cgt-2026...", "status": "succeeded",
  "content": { "video_url": "https://.../xxx.mp4?X-Tos-..." } }
```

**如果照抄官方 Ark 的映射（`response.id` 优先），第一次轮询后任务号就会被换成网关内部号，
后续轮询全部失败。** 所以本插件的 `taskId` 把 `platform_task_id` 放在第一位。

### 2. 状态与错误语义

- 网关常用 `queued` / `running` / `succeeded` / `failed`；项目内置的 `normalizeStatus`
  （`backend/internal/protocol/builtin.go`）认识这些词，无需额外映射。
- **查询偶发 503「所有供应商暂时不可用」不一定是终态失败**——同一任务号持续轮询常常会自愈。
- 响应里的 `model` 常被网关映射成厂商命名（如 `doubao-seedance-2-0-fast-260128`），
  **只是展示**；入参必须保持点号写法（`doubao-seedance-2.0-fast`），
  不要拿响应去回写渠道配置。
- **创建返回 200 + 任务号，不等于这一单会被执行**：上游在接单阶段拒单（例如参考图触发内容审核）时，
  仍然会返回任务号，只有查询阶段才暴露失败。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Seedance 2.5（provider `ark-task-gateway-video-25`）

2.5 与 2.0 系列**同一网关、两套契约**，因此拆成两个 provider：

| 操作 | `ark-task-gateway-video`（2.0 系列） | `ark-task-gateway-video-25`（2.5） |
| --- | --- | --- |
| create | `POST /v1/contents/generations/tasks`，body `{model, content[], ratio, resolution, duration, watermark}` | 同一路径，body **顶层 `prompt`**：`{model, prompt, ratio, resolution, duration, watermark, input_reference?, image_urls?}` |
| poll | `GET /v1/contents/generations/tasks/{{taskId}}` | **`GET /v1/videos/{{taskId}}`** |
| cancel | `DELETE /v1/contents/generations/tasks/{{taskId}}` | `DELETE /v1/videos/{{taskId}}` |

2.5 的查询响应（实测）：

```json
// 进行中
{ "id": "task_...", "object": "video", "model": "doubao-seedance-2.5", "status": "running", "created_at": 1790751061 }

// 成功
{ "id": "task_...", "status": "succeeded", "video_url": "https://.../xxx.mp4",
  "metadata": { "url": "https://.../xxx.mp4" }, "usage": { ... } }
```

响应映射：`status ← response.status`；`videos ← response.video_url → response.metadata.url`；
`taskId ← response.id`。

**必须记住的坑**：2.5 的任务如果去查 `GET /v1/contents/generations/tasks/{id}`，
网关会返回一段**聊天消息形状的响应**（`{"type":"message","role":"assistant","content":[{"type":"text","text":""}]}`），
既没有 `status` 也没有 `video_url` → 任务会永远停在「上游生成中」。2.5 必须查 `/v1/videos/{id}`。

参考图：单张用 `input_reference`，多张用 `image_urls`，**两者不可同时提供**；
2.5 目前不接受参考视频/参考音频（据网关文档）。

---

## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "ark-task-gateway",
  "name": "Ark Task Gateway (Seedance)",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "经「中转网关」调用豆包 Seedance 任务式视频接口的协议插件：网关把厂商原生路径统一挂在 /v1 下，即 POST /v1/contents/generations/tasks 与 GET /v1/contents/generations/tasks/{task_id}。默认 baseUrl 为占位符，请在渠道里填写你自己的网关地址。",
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
        "id": "ark-task-gateway-video",
        "label": "Ark Task Gateway（中转网关 · 豆包任务式）",
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
            "description": "Ark endpoint/model ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "content[type=text].text",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "content[type=image_url]",
            "description": "first_frame、last_frame、reference_image 等 role 原样映射。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "content[type=video_url]",
            "description": "reference_video。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "content[type=audio_url]",
            "description": "reference_audio/reference_voice。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "ratio",
            "description": "输出画幅。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution",
            "description": "输出分辨率档位。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "duration",
            "description": "输出时长秒数。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "required": false,
            "mapping": "generate_audio",
            "description": "是否生成音频。"
          },
          {
            "name": "watermark",
            "type": "boolean",
            "required": false,
            "mapping": "watermark",
            "description": "是否带水印。"
          },
          {
            "name": "seed",
            "type": "integer",
            "required": false,
            "mapping": "seed",
            "description": "providerOptions seed。"
          },
          {
            "name": "camera_fixed",
            "type": "boolean",
            "required": false,
            "mapping": "camera_fixed",
            "description": "providerOptions camera_fixed。"
          }
        ],
        "validations": [],
        "create": {
          "method": "POST",
          "path": "/v1/contents/generations/tasks",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "content": {
              "$concatArrays": [
                [
                  {
                    "type": "text",
                    "text": {
                      "$ref": "request.prompt"
                    }
                  }
                ],
                {
                  "$map": {
                    "from": {
                      "$sortByOrder": {
                        "$ref": "request.images"
                      }
                    },
                    "as": "media",
                    "in": {
                      "type": "image_url",
                      "image_url": {
                        "url": {
                          "$ref": "media.value"
                        }
                      },
                      "role": {
                        "$coalesce": [
                          {
                            "$ref": "media.role"
                          },
                          "reference_image"
                        ]
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
                      "type": "video_url",
                      "video_url": {
                        "url": {
                          "$ref": "media.value"
                        }
                      },
                      "role": {
                        "$coalesce": [
                          {
                            "$ref": "media.role"
                          },
                          "reference_video"
                        ]
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
                      "type": "audio_url",
                      "audio_url": {
                        "url": {
                          "$ref": "media.value"
                        }
                      },
                      "role": {
                        "$coalesce": [
                          {
                            "$ref": "media.role"
                          },
                          "reference_audio"
                        ]
                      }
                    }
                  }
                }
              ]
            },
            "ratio": {
              "$coalesce": [
                {
                  "$ref": "request.aspectRatio"
                },
                "16:9"
              ]
            },
            "resolution": {
              "$coalesce": [
                {
                  "$ref": "request.resolution"
                },
                "720p"
              ]
            },
            "duration": {
              "$if": {
                "condition": {
                  "$or": [
                    {
                      "$gt": [
                        {
                          "$ref": "request.duration"
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$ref": "request.duration"
                        },
                        -1
                      ]
                    }
                  ]
                },
                "then": {
                  "$ref": "request.duration"
                },
                "else": 5
              }
            },
            "generate_audio": {
              "$ref": "request.generateAudio"
            },
            "watermark": {
              "$ref": "request.watermark"
            },
            "seed": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.ark-task-gateway-video.seed"
              }
            },
            "camera_fixed": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.ark-task-gateway-video.camera_fixed"
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/contents/generations/tasks/{{taskId}}"
        },
        "cancel": {
          "method": "DELETE",
          "path": "/v1/contents/generations/tasks/{{taskId}}"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.platform_task_id"
              },
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
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
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.fail_reason"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.content.video_url"
              },
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.output.video_url"
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
            "error.code"
          ],
          "resultEphemeral": true
        }
      },
      {
        "id": "ark-task-gateway-video-25",
        "label": "Ark Task Gateway · Seedance 2.5（顶层 prompt + /v1/videos 查询）",
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
            "description": "Ark endpoint/model ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "content[type=text].text",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "content[type=image_url]",
            "description": "first_frame、last_frame、reference_image 等 role 原样映射。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "content[type=video_url]",
            "description": "reference_video。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "content[type=audio_url]",
            "description": "reference_audio/reference_voice。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "ratio",
            "description": "输出画幅。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution",
            "description": "输出分辨率档位。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "duration",
            "description": "输出时长秒数。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "required": false,
            "mapping": "generate_audio",
            "description": "是否生成音频。"
          },
          {
            "name": "watermark",
            "type": "boolean",
            "required": false,
            "mapping": "watermark",
            "description": "是否带水印。"
          },
          {
            "name": "seed",
            "type": "integer",
            "required": false,
            "mapping": "seed",
            "description": "providerOptions seed。"
          },
          {
            "name": "camera_fixed",
            "type": "boolean",
            "required": false,
            "mapping": "camera_fixed",
            "description": "providerOptions camera_fixed。"
          }
        ],
        "validations": [],
        "create": {
          "method": "POST",
          "path": "/v1/contents/generations/tasks",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "ratio": {
              "$coalesce": [
                {
                  "$ref": "request.aspectRatio"
                },
                "16:9"
              ]
            },
            "resolution": {
              "$coalesce": [
                {
                  "$ref": "request.resolution"
                },
                "720p"
              ]
            },
            "duration": {
              "$if": {
                "condition": {
                  "$or": [
                    {
                      "$gt": [
                        {
                          "$ref": "request.duration"
                        },
                        0
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$ref": "request.duration"
                        },
                        -1
                      ]
                    }
                  ]
                },
                "then": {
                  "$ref": "request.duration"
                },
                "else": 5
              }
            },
            "watermark": {
              "$ref": "request.watermark"
            },
            "input_reference": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$len": {
                          "$ref": "request.images"
                        }
                      },
                      1
                    ]
                  },
                  "then": {
                    "$first": {
                      "$map": {
                        "from": {
                          "$sortByOrder": {
                            "$ref": "request.images"
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                }
              }
            },
            "image_urls": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$gt": [
                      {
                        "$len": {
                          "$ref": "request.images"
                        }
                      },
                      1
                    ]
                  },
                  "then": {
                    "$map": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/videos/{{taskId}}"
        },
        "cancel": {
          "method": "DELETE",
          "path": "/v1/videos/{{taskId}}"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$ref": "response.status"
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.metadata.url"
              },
              {
                "$ref": "response.content.video_url"
              }
            ]
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "resultEphemeral": true
        },
        "description": "豆包 Seedance 2.5 在中转网关上的专用协议：创建请求用顶层 prompt（不是 content[]），任务查询走 GET /v1/videos/{task_id}。"
      }
    ]
  }
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
