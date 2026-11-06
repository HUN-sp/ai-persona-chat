/** RAG-grounded answer generation (retrieval + Groq). The only place the chat LLM is called. */

import Groq from "groq-sdk";
import { retrieve } from "./retriever";
import { SYSTEM_PROMPT } from "./persona";
import { GROQ_MODEL, MAX_TOKENS_CHAT } from "./config";
import type { ChatMessage } from "./chat-input";

let _groqClient: Groq | null = null;
function getClient(): Groq {
  if (!_groqClient) {
    _groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groqClient;
}

/**
 * Generate a RAG-grounded answer using conversation history + retrieved context.
 */
export async function generateRagAnswer(
  messages: ChatMessage[],
  lastMsg: string,
  maxTokens: number = MAX_TOKENS_CHAT,
): Promise<string> {
  // 1. Retrieve relevant context from the RAG index
  const context = await retrieve(lastMsg, 5);

  // 2. Build system prompt with RAG context
  const systemPrompt = context
    ? `${SYSTEM_PROMPT}\n\n---\n\nRELEVANT CONTEXT FROM RESUME & GITHUB:\n\n${context}`
    : SYSTEM_PROMPT;

  // 3. Send (bounded) conversation history to Groq for memory/context
  const response = await getClient().chat.completions.create({
    model: GROQ_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  });

  return response.choices[0]?.message?.content ?? "";
}
