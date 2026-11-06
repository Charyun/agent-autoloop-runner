# 飞书管理者（可选）

这是中台之外的独立 owner 客户端。飞书卡片仍由现有通道直接发送、更新和接收回答；管理者只处理本人的私聊文字并发送独立文本回复。管理层默认关闭，省略开关时保留原来的运行方式。

目前支持自然语言进度问答、`详情 12` 和 `停止 12`。停止命令要求精确编号，只提交停止请求，不把请求成功说成进程已经结束。支持按用户与飞书会话保存最近 8 轮对话。模型通过 `get_state`、`get_run` 查询最新状态和某轮经过，最多连续请求 4 次模型回复。尚不支持自然语言派新任务或代答卡片。

## 配置

使用本仓库中的入口作为独立客户端运行。在仓库外的私有目录放 `manager.json`，权限设为 `0600`：

```json
{
  "url": "http://127.0.0.1:8787",
  "owner": "本人的密钥",
  "envFile": ".env",
  "llm": {
    "baseUrl": "https://model.example/v1",
    "model": "填写支持工具调用的模型名",
    "apiKeyEnv": "MANAGER_LLM_API_KEY"
  },
  "memory": "/Users/你的用户名/.agent-autoloop/memory.json"
}
```

管理层直接调用独立的模型 API，不启动 Claude Code、Codex 等 Agent CLI。`llm.baseUrl` 是包含版本路径的服务地址，程序追加 `/chat/completions`；模型需支持 OpenAI Chat Completions 格式及 function calling。接口格式依据：[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[工具调用](https://developers.openai.com/api/docs/guides/function-calling)。不同兼容服务的支持程度需自行核验。

在同一私有目录的 `.env` 中放模型密钥，权限设为 `0600`：

```dotenv
MANAGER_LLM_API_KEY=你的模型API密钥
```

也可以省略 `envFile`，由启动环境提供该变量。模型连接与 worker 的 Agent、模型和登录状态分别配置。模型 API 只接收对话和查询资料；owner 密钥只用于中台请求，模型 API 密钥只用于模型请求。地址要求 HTTPS，本地服务可使用回环 HTTP。请求超时为 20 秒，失败不自动重试。

管理层声明的模型工具只有 `get_state` 和 `get_run`。程序核验工具名、参数与轮次编号，执行查询，再按 `tool_call_id` 回传结果供模型继续回答；不向模型提供终端、文件读写、卡片回答或任意 HTTP 工具。精确的 `停止 编号` 命令由代码处理，不依赖模型选择写操作。

本机 `config.json` 中的飞书通道加可选 `manager` 命令（使用绝对路径）：

```json
{
  "manager": { "enabled": true },
  "channels": {
    "feishu": {
      "key": "飞书通道密钥",
      "user": "ou_本人的open_id",
      "manager": ["node", "/绝对路径/agent-autoloop-runner/examples/manager/manager.ts", "/私有目录/manager.json"]
    }
  }
}
```

本机 `config.json` 的顶层 `manager.enabled` 是统一启动开关，只有布尔值 `true` 才启用。设为 `false` 或省略时，飞书只走原有卡片流程，不启动文本消费者、不运行管理者命令；worker 不读取或注入 `memory.json`，新任务的资料文件保持原有字段。仅保留飞书通道中的管理者命令配置不会自动启用。

关闭时可以保留管理者配置、模型密钥、会话和记忆文件，之后开启可继续使用。它们不会被删除；已经运行过的 Agent 会话和任务记录也不回滚。修改开关后重启中台/接单程序，以及另行启动的记忆进程；不提供运行中热切换。独立管理程序也在启动时检查这个本机开关，关闭时在加载模型配置之前退出。若用自定义安装目录，启动独立管理者和记忆进程时需设置同一个 `AGENT_AUTOLOOP_HOME`。远程 worker 各自使用其所在机器的本机配置。

飞书应用除卡片回调外，需要订阅 `im.message.receive_v1` 并获得相应消息权限。重启自己的中台服务后生效。文本消费者和卡片消费者由同一通道启动，各自订阅一个事件类型，共享 lark-cli 本地总线；同一应用只在一处运行这套通道，不另开管理者消息监听。

官方字段与消费方式：[消息事件字段](https://github.com/larksuite/cli/blob/main/skills/lark-event/references/lark-event-im.md)、[事件消费与共享总线](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)。CLI 的文本 `content` 已经是纯文本，不再解析成 JSON。

管理者输入为单个 JSON：`{ "id", "sender", "chat", "text" }`；输出为 `{ "text": "回复" }`。通道在调用前核对本人身份、私聊和文本类型，并串行处理文字；卡片收发不等待管理者。管理者用原消息编号保存回复，飞书发送使用独立幂等键。`manager-dialogues.json` 放在配置旁边，按用户与会话保存最近 8 轮用户文字和最终回复，并保存原消息的回复缓存。会话与回复在同一次原子写入中保存，重启后可继续对话或复用重复消息的回复。中间工具结果不作为历史会话保存，下一次询问进度需要重新查询；回复缓存暂不自动清理。调用失败会记入通道日志，用户可重新发消息重试。

## 整理记忆

记忆整理复用管理层独立配置的模型 API，不继承用户聊天上下文、不开放工具。单独运行一个记忆进程：

```sh
node /绝对路径/agent-autoloop-runner/examples/manager/manager.ts /私有目录/manager.json --memory
```

它从 `/v1/stream` 读取事实，按顺序处理 `finish` 中的 `done` / `nothing` 轮次，以 `/why` 中实际领取时的规则目录作为 scope，模型只生成历史摘要。每条带 `evidence.run`，以 `run:<编号>` 去重，临时文件原子替换 `memory.json`。`memory-cursor.json` 在每条事实处理成功后更新；连接中断或模型失败时进程退出，由用户自己的进程管理器重启，从消费位置继续。初次运行从日志开头读取，会为历史完成任务调用模型。

只运行一个记忆写入进程。将 `memory` 指向接单程序安装目录的 `memory.json`；当前仅支持共享该本地文件的部署，远程 worker 的分发不在本批。记忆是 Agent 报告的摘要，不代表独立验收；没有新增事实时不写条目。目前不自动推翻旧条目或统计使用次数。

## 权限与验证

owner 密钥实际还允许回答卡片、结案和撤销密钥，本管理者只调用查询与明确编号的停止接口；这是可信客户端的使用约定。此批未使用 source 密钥，任务派发与专用 manager 来源的配置留到下一批。

本仓库使用假飞书 CLI、假管理命令、模拟模型 API 响应和中台本地事实验证收发、身份过滤、重复消息、停止和记忆归属。没有向真实飞书账号发消息，也没有验证真实模型的端到端结果；配置后需由使用者在自己的测试应用验收。
