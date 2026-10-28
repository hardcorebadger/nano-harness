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
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  const definitions = Object.entries(tools).map(([name, tool]) => ({
    type: "function",
    function: { name, description: tool.description, parameters: tool.parameters },
  }));

  for (let step = 0; step < 8; step++) {
    const response = await fetch(process.env.BASE_URL ?? "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, tools: definitions }),
    });
    if (!response.ok) throw new Error(`LLM ${response.status}: ${await response.text()}`);
    const choice = (await response.json() as any).choices[0].message;
    messages.push(choice);
    if (!choice.tool_calls?.length) return choice.content ?? "";

    for (const call of choice.tool_calls) {
      const result = await tools[call.function.name].run(JSON.parse(call.function.arguments));
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  throw new Error("Agent reached the 8-step limit");
}
