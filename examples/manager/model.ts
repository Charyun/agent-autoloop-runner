// Chat Completions transport for the manager's own model, independent of worker agent adapters.
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type Tool = { type: "function"; function: { name: string; description: string; parameters: object } };
export type Model = (messages: Message[], tools?: Tool[]) => Promise<Message>;
export type ModelConfig = { baseUrl: string; model: string; apiKeyEnv: string };
type Request = (url: string | URL, init?: RequestInit) => Promise<Response>;

export function createModel(
  config: ModelConfig,
  request: Request = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Model {
  if (
    !config ||
    typeof config.baseUrl !== "string" ||
    typeof config.model !== "string" ||
    !config.model.trim() ||
    typeof config.apiKeyEnv !== "string" ||
    !config.apiKeyEnv.trim()
  )
    throw new Error("llm 要配置 baseUrl、model 和 apiKeyEnv");
  const base = new URL(config.baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !(
      base.protocol === "https:" ||
      (base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    )
  ) {
    throw new Error("模型地址要使用 HTTPS，本地测试地址可使用 HTTP，地址中不能带凭据或查询参数");
  }
  const key = env[config.apiKeyEnv];
  if (!key) throw new Error(`缺少模型 API 密钥环境变量：${config.apiKeyEnv}`);
  const url = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  return async (messages, tools = []) => {
    const response = await request(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages,
        ...(tools.length ? { tools, parallel_tool_calls: false } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`管理模型 API 返回 ${response.status}，请检查配置、额度和服务状态`);
    }
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new Error("管理模型返回的不是 JSON");
    }
    const choice = body?.choices?.[0];
    const message = choice?.message;
    if (!["stop", "tool_calls"].includes(choice?.finish_reason) || message?.role !== "assistant") {
      throw new Error("管理模型没有返回完整回复");
    }
    const calls = message.tool_calls ?? undefined;
    if (
      calls !== undefined &&
      (!Array.isArray(calls) ||
        calls.some(
          (call: any) =>
            !call ||
            typeof call.id !== "string" ||
            !call.id ||
            call.type !== "function" ||
            typeof call.function?.name !== "string" ||
            typeof call.function?.arguments !== "string",
        ))
    ) {
      throw new Error("管理模型的工具调用格式不正确");
    }
    if (calls?.length) {
      if (new Set(calls.map((call: ToolCall) => call.id)).size !== calls.length) throw new Error("工具调用编号重复");
      return {
        role: "assistant",
        content: typeof message.content === "string" ? message.content : null,
        tool_calls: calls,
      };
    }
    if (choice.finish_reason !== "stop" || typeof message.content !== "string")
      throw new Error("管理模型没有返回完整回复");
    return { role: "assistant", content: message.content };
  };
}
