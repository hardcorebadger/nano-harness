export type Tool = {
  description: string;
  parameters: Record<string, unknown>;
  run: (input: Record<string, unknown>, context?: ToolContext) => unknown | Promise<unknown>;
  always?: boolean;
};

export type ToolContext = {
  /** Aborts when the agent run is cancelled. Tools should pass this to their own async work. */
  signal?: AbortSignal;
};

export type AgentOptions = {
  /** Maximum number of model turns before the run fails. Defaults to 8. */
  maxSteps?: number;
};

export type Skill = {
  /** When the assistant should use this skill. */
  description: string;
  /** Load the full instructions only when the assistant requests them. */
  load: () => string | Promise<string>;
};

/** Queue user messages for injection at the next safe model-turn boundary. */
export class SteeringQueue {
  private pending: string[] = [];

  send(message: string): void {
    if (!message.trim()) throw new Error("Steering messages must not be empty");
    this.pending.push(message);
  }

  /** @internal Consumed by agent after a model response and its tool calls finish. */
  takePending(): string[] {
    const messages = this.pending;
    this.pending = [];
    return messages;
  }
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return dot / (Math.sqrt(aa * bb) || 1);
};

const env = (globalThis as any).process?.env ?? {};

/** Read an OpenAI-compatible chat-completions SSE response into one assistant message. */
async function readChatStream(
  response: Response,
  onTextDelta: (text: string) => void | Promise<void>,
): Promise<any> {
  if (!response.body) throw new Error("Streaming response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = new Map<number, any>();

  const consumeEvent = async (event: string) => {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;

    const chunk = JSON.parse(data);
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string") {
      content += delta.content;
      await onTextDelta(delta.content);
    }
    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? 0;
      let call = toolCalls.get(index);
      if (!call) {
        call = { id: "", type: "function", function: { name: "", arguments: "" } };
        toolCalls.set(index, call);
      }
      if (part.id) call.id = part.id;
      if (part.type) call.type = part.type;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  };

  const consumeLines = async (final = false) => {
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const event = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)![0];
      buffer = buffer.slice(boundary + separator.length);
      await consumeEvent(event);
    }
    if (final && buffer.trim()) {
      await consumeEvent(buffer);
      buffer = "";
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    await consumeLines();
  }
  buffer += decoder.decode();
  await consumeLines(true);

  const message: any = { role: "assistant", content };
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
  }
  return message;
}

export async function agent(
  prompt: string,
  tools: Record<string, Tool>,
  system = "You are a helpful assistant.",
  model = env.MODEL ?? "gpt-4o-mini",
  skills: Record<string, Skill> = {},
  steering?: SteeringQueue,
  onTextDelta?: (text: string) => void | Promise<void>,
  signal?: AbortSignal,
  options: AgentOptions = {},
): Promise<string> {
  const maxSteps = options.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new RangeError("maxSteps must be a positive safe integer");
  }
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    if (signal.reason !== undefined) throw signal.reason;
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  };
  throwIfAborted();
  const skillNames = Object.keys(skills);
  if (skillNames.length && Object.hasOwn(tools, "read_skill")) {
    throw new Error('"read_skill" is reserved when using the built-in skill support');
  }
  const skillTool: Tool = {
    description: "Load the full instructions for an available skill when it is relevant to the user's request.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: skillNames, description: "Name of the skill to load" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    run: async ({ name }, context) => {
      if (context?.signal?.aborted) {
        if (context.signal.reason !== undefined) throw context.signal.reason;
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      const skill = skills[String(name ?? "")];
      if (!skill) throw new Error(`Unknown skill: ${String(name ?? "")}`);
      return skill.load();
    },
  };
  const allTools = skillNames.length ? { ...tools, read_skill: skillTool } : tools;
  const skillIndex = skillNames.length
    ? `\nAvailable skills (load relevant instructions with read_skill before applying them):\n${skillNames.map(name => `- ${name}: ${skills[name].description}`).join("\n")}`
    : "";
  const messages: any[] = [
    {
      role: "system",
      content: `${system}\nDiscover tools with search_tools before using them; only matching tools are loaded.${skillIndex}`,
    },
    { role: "user", content: prompt },
  ];
  const definition = (name: string) => ({
    type: "function",
    function: { name, description: allTools[name].description, parameters: allTools[name].parameters },
  });
  const always = Object.keys(allTools).filter(name => allTools[name].always || name === "read_skill");
  const searchTool = {
    type: "function",
    function: {
      name: "search_tools",
      description: "Find tools by name or description. Matching tools become available next turn.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What capability is needed" } },
        required: ["query"],
      },
    },
  };
  const loaded = new Map<string, { found: number; used: number; touched: number }>();
  let clock = 0;
  let index: { names: string[]; vectors: number[][] } | undefined;
  const injectSteering = (): number => {
    const incoming = steering?.takePending() ?? [];
    for (const content of incoming) messages.push({ role: "user", content });
    return incoming.length;
  };
  const cap = (limit: number) => Math.max(0, limit - always.length - 1);
  if (always.length + 1 > 100) throw new Error("Always-available tools exceed the 100-tool hard cap");
  const embed = async (input: string[]) => {
    throwIfAborted();
    const base = env.BASE_URL ?? "https://api.openai.com/v1/chat/completions";
    const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    const chatCompletionsPath = "/chat/completions";
    const url = trimmedBase.endsWith(chatCompletionsPath)
      ? `${trimmedBase.slice(0, -chatCompletionsPath.length)}/embeddings`
      : `${trimmedBase}/embeddings`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: env.EMBEDDING_MODEL ?? "text-embedding-3-small", input }),
      signal,
    });
    if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
    const data = (await response.json() as any).data as { index: number; embedding: number[] }[];
    return data.sort((a, b) => a.index - b.index).map(item => item.embedding);
  };

  for (let step = 0; step < maxSteps; step++) {
    throwIfAborted();
    const available = new Set([...always, ...loaded.keys()]);
    const response = await fetch(env.BASE_URL ?? "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: [searchTool, ...[...available].map(definition)],
        ...(onTextDelta ? { stream: true } : {}),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`LLM ${response.status}: ${await response.text()}`);
    const choice = onTextDelta
      ? await readChatStream(response, onTextDelta)
      : (await response.json() as any).choices[0].message;
    messages.push(choice);
    if (!choice.tool_calls?.length) {
      if (injectSteering()) continue;
      return choice.content ?? "";
    }

    for (const call of choice.tool_calls) {
      throwIfAborted();
      const input = JSON.parse(call.function.arguments);
      let result: unknown;
      if (call.function.name === "search_tools") {
        const query = String(input.query ?? "").trim();
        if (!query) {
          result = [];
        } else {
          if (!index) {
            const deferred = Object.entries(allTools).filter(([, tool]) => !tool.always && tool !== skillTool);
            index = {
              names: deferred.map(([name]) => name),
              vectors: deferred.length
                ? await embed(deferred.map(([name, tool]) => `${name}: ${tool.description} ${JSON.stringify(tool.parameters)}`))
                : [],
            };
          }
          const queryVector = (await embed([query]))[0];
          const matches = index.names
            .map((name, i) => ({ name, score: cosine(queryVector, index!.vectors[i]) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
          for (const { name } of matches) {
            const existing = loaded.get(name);
            if (existing) existing.found = existing.touched = ++clock;
            else {
              const soft = cap(25), hard = cap(100);
              if (loaded.size >= soft && loaded.size < hard) {
                const unused = [...loaded]
                  .filter(([, state]) => !state.used)
                  .sort((a, b) => a[1].found - b[1].found)[0];
                if (unused) loaded.delete(unused[0]);
              }
              if (loaded.size >= hard) {
                const lru = [...loaded].sort((a, b) => a[1].touched - b[1].touched)[0];
                if (lru) loaded.delete(lru[0]);
              }
              if (loaded.size < hard) loaded.set(name, { found: ++clock, used: 0, touched: clock });
            }
          }
          result = matches
            .filter(({ name }) => loaded.has(name))
            .map(({ name, score }) => ({ name, description: allTools[name].description, score }));
        }
      } else {
        const tool = allTools[call.function.name];
        if (!tool || !available.has(call.function.name)) throw new Error(`Unknown or not-yet-loaded tool: ${call.function.name}`);
        if (!tool.always) {
          const state = loaded.get(call.function.name)!;
          state.used = state.touched = ++clock;
        }
        try {
          result = await tool.run(input, { signal });
        } catch (error) {
          // Cancellation is a control-flow signal, not an ordinary tool failure to recover from.
          throwIfAborted();
          result = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
    injectSteering();
  }
  throw new Error(`Agent reached the ${maxSteps}-step limit`);
}
