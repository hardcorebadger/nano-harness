export type Tool = {
  description: string;
  parameters: Record<string, unknown>;
  run: (input: Record<string, unknown>) => unknown | Promise<unknown>;
};

export async function agent(
  prompt: string,
  tools: Record<string, Tool>,
  system = "You are a helpful assistant.",
  model = process.env.MODEL ?? "gpt-4o-mini",
): Promise<string> {
  const messages: any[] = [
    {
      role: "system",
      content: `${system}\nDiscover tools with search_tools before using them; only matching tools are loaded.`,
    },
    { role: "user", content: prompt },
  ];
  const definition = (name: string) => ({
    type: "function",
    function: { name, description: tools[name].description, parameters: tools[name].parameters },
  });
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
  const loaded = new Set<string>();

  for (let step = 0; step < 8; step++) {
    const response = await fetch(process.env.BASE_URL ?? "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, tools: [searchTool, ...[...loaded].map(definition)] }),
    });
    if (!response.ok) throw new Error(`LLM ${response.status}: ${await response.text()}`);
    const choice = (await response.json() as any).choices[0].message;
    messages.push(choice);
    if (!choice.tool_calls?.length) return choice.content ?? "";

    for (const call of choice.tool_calls) {
      const input = JSON.parse(call.function.arguments);
      let result: unknown;
      if (call.function.name === "search_tools") {
        const query = String(input.query ?? "").toLowerCase();
        const words = query.match(/[a-z0-9_]+/g) ?? [];
        const matches = Object.entries(tools)
          .map(([name, tool]) => ({
            name,
            tool,
            score: words.filter(word => `${name} ${tool.description}`.toLowerCase().includes(word)).length,
          }))
          .filter(match => match.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        matches.forEach(({ name }) => loaded.add(name));
        result = matches.map(({ name, tool }) => ({ name, description: tool.description }));
      } else {
        const tool = tools[call.function.name];
        if (!tool || !loaded.has(call.function.name)) throw new Error(`Unknown or undiscovered tool: ${call.function.name}`);
        result = await tool.run(input);
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  throw new Error("Agent reached the 8-step limit");
}
