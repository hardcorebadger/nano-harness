export type Tool = {
  description: string;
  parameters: Record<string, unknown>;
  run: (input: Record<string, unknown>) => unknown | Promise<unknown>;
  always?: boolean;
};

export type Skill = {
  /** When the assistant should use this skill. */
  description: string;
  /** Load the full skill instructions only when the assistant requests them. */
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

export async function agent(
  prompt: string,
  tools: Record<string, Tool>,
  system = "You are a helpful assistant.",
  model = env.MODEL ?? "gpt-4o-mini",
  skills: Record<string, Skill> = {},
  steering?: SteeringQueue,
): Promise<string> {
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
    run: async ({ name }) => {
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
    const base = env.BASE_URL ?? "https://api.openai.com/v1/chat/completions";
    const url = /\/chat\/completions\/?$/.test(base) ? base.replace(/\/chat\/completions\/?$/, "/embeddings") : `${base.replace(/\/$/, "")}/embeddings`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: env.EMBEDDING_MODEL ?? "text-embedding-3-small", input }),
    });
    if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
    const data = (await response.json() as any).data as { index: number; embedding: number[] }[];
    return data.sort((a, b) => a.index - b.index).map(item => item.embedding);
  };

  for (let step = 0; step < 8; step++) {
    const available = new Set([...always, ...loaded.keys()]);
    const response = await fetch(env.BASE_URL ?? "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, tools: [searchTool, ...[...available].map(definition)] }),
    });
    if (!response.ok) throw new Error(`LLM ${response.status}: ${await response.text()}`);
    const choice = (await response.json() as any).choices[0].message;
    messages.push(choice);
    if (!choice.tool_calls?.length) {
      if (injectSteering()) continue;
      return choice.content ?? "";
    }

    for (const call of choice.tool_calls) {
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
        result = await tool.run(input);
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
    injectSteering();
  }
  throw new Error("Agent reached the 8-step limit");
}
