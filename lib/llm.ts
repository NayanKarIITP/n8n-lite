// lib/llm.ts
//
// Thin wrapper so the execution engine never knows which provider is
// behind it. Configure via env vars:
//   LLM_API_KEY   - API key for the provider
//   LLM_MODEL     - model name, e.g. "llama-3.1-8b-instant" (Groq),
//                    "gemini-1.5-flash" (Gemini), or an OpenRouter model id
//   LLM_PROVIDER  - "groq" | "gemini" | "openrouter" | "stub" (default: stub
//                    if LLM_API_KEY is unset)
//
// If LLM_API_KEY is not set, callLLM runs in stub mode: it waits a short
// artificial delay and returns a deterministic-but-varied response so the
// conditional_branch demo still works end to end. Swapping to a real
// provider requires ONLY setting the three env vars above — no code
// changes to callers.

export interface LLMCallResult {
  output: string;
  provider: "groq" | "gemini" | "openrouter" | "stub";
  model: string;
}

function resolveProvider(): "groq" | "gemini" | "openrouter" | "stub" {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === "groq" || explicit === "gemini" || explicit === "openrouter" || explicit === "stub") {
    return explicit;
  }
  return process.env.LLM_API_KEY ? "groq" : "stub";
}

export async function callLLM(prompt: string): Promise<LLMCallResult> {
  const provider = resolveProvider();
  const model = process.env.LLM_MODEL || "llama-3.1-8b-instant";
  const apiKey = process.env.LLM_API_KEY;

  if (provider === "stub" || !apiKey) {
    return stubLLM(prompt, model);
  }

  switch (provider) {
    case "groq":
      return callGroq(prompt, model, apiKey);
    case "openrouter":
      return callOpenRouter(prompt, model, apiKey);
    case "gemini":
      return callGemini(prompt, model, apiKey);
    default:
      return stubLLM(prompt, model);
  }
}

async function callGroq(prompt: string, model: string, apiKey: string): Promise<LLMCallResult> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return { output: json.choices[0]?.message?.content ?? "", provider: "groq", model };
}

async function callOpenRouter(prompt: string, model: string, apiKey: string): Promise<LLMCallResult> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter API error ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return { output: json.choices[0]?.message?.content ?? "", provider: "openrouter", model };
}

async function callGemini(prompt: string, model: string, apiKey: string): Promise<LLMCallResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    candidates: { content: { parts: { text: string }[] } }[];
  };
  const output = json.candidates[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return { output, provider: "gemini", model };
}

async function stubLLM(prompt: string, model: string): Promise<LLMCallResult> {
  // Artificial delay to mimic real network latency so the UI's
  // running -> completed transition is visible in the demo.
  await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 700));

  // Deterministic-but-content-aware stub: if the prompt hints at approval
  // language, respond with APPROVE so the conditional_branch demo path is
  // reachable without a real key. Otherwise respond with REJECT.
  const lower = prompt.toLowerCase();
  const shouldApprove =
    lower.includes("approve") || lower.includes("good") || lower.includes("yes") || lower.includes("positive");

  const output = shouldApprove
    ? "APPROVE: The request meets the criteria and is recommended for approval."
    : "REJECT: The request does not clearly meet the criteria; recommend manual review.";

  return { output, provider: "stub", model: model + " (stub)" };
}
