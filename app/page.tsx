"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import Vapi from "@vapi-ai/web";
import { parseSse } from "@/lib/sse";
import { personaUi } from "@/persona/ui";

// Vapi public key + assistant id are public by design (they ship to every browser).
// Override per deployment with NEXT_PUBLIC_VAPI_PUBLIC_KEY / NEXT_PUBLIC_VAPI_ASSISTANT_ID.
const VAPI_PUBLIC_KEY   = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY   ?? personaUi.vapi.publicKey;
const VAPI_ASSISTANT_ID = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID ?? personaUi.vapi.assistantId;

type Message = { role: "user" | "assistant"; content: string };
type TranscriptLine = { role: "user" | "assistant"; text: string; final: boolean };

const SUGGESTED_QUESTIONS = personaUi.suggestedQuestions;

export default function Home() {
  // ── Chat state ──
  const [messages, setMessages] = useState<Message[]>([{
    role: "assistant",
    content: personaUi.greeting,
  }]);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [bookingStep, setBookingStep]   = useState<"idle" | "day_shown" | "slots_shown" | "awaiting_email">("idle");
  const [allSlots, setAllSlots]         = useState<{ start: string; end: string }[] | null>(null);
  const [pendingSlots, setPendingSlots] = useState<{ start: string; end: string }[] | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<{ start: string; end: string } | null>(null);
  const [slotPage, setSlotPage]         = useState(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Voice call state ──
  const [callStatus, setCallStatus]     = useState<"idle" | "connecting" | "active">("idle");
  const [isSpeaking, setIsSpeaking]     = useState(false);
  const [callError, setCallError]       = useState<string | null>(null);
  const [transcript, setTranscript]     = useState<TranscriptLine[]>([]);
  const vapiRef        = useRef<Vapi | null>(null);
  const voiceBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { voiceBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [transcript]);
  useEffect(() => {
    if (!loading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [loading]);

  // ── Voice call logic ──
  const startCall = useCallback(async () => {
    setCallStatus("connecting");
    setCallError(null);
    setTranscript([]);
    const vapi = new Vapi(VAPI_PUBLIC_KEY);
    vapiRef.current = vapi;

    vapi.on("call-start",   () => setCallStatus("active"));
    vapi.on("speech-start", () => setIsSpeaking(true));
    vapi.on("speech-end",   () => setIsSpeaking(false));
    vapi.on("call-end", () => {
      setCallStatus("idle");
      setIsSpeaking(false);
      vapiRef.current = null;
    });
    vapi.on("error", (e) => {
      console.error("Vapi error:", e);
      setCallError("The call ended unexpectedly. Please try again.");
      setCallStatus("idle");
      setIsSpeaking(false);
      vapiRef.current = null;
    });

    // Live transcript from Vapi message events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vapi.on("message", (msg: any) => {
      if (msg?.type !== "transcript") return;
      const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
      const text: string = msg.transcript ?? "";
      const isFinal: boolean = msg.transcriptType === "final";

      setTranscript((prev) => {
        const last = prev[prev.length - 1];
        // Update the last line if same role and not yet final
        if (last && last.role === role && !last.final) {
          return [...prev.slice(0, -1), { role, text, final: isFinal }];
        }
        return [...prev, { role, text, final: isFinal }];
      });
    });

    try {
      await vapi.start(VAPI_ASSISTANT_ID);
    } catch (e) {
      console.error("Vapi start error:", e);
      setCallError("Couldn't start the call. Please allow microphone access and try again.");
      setCallStatus("idle");
      vapiRef.current = null;
    }
  }, []);

  const endCall = useCallback(() => { vapiRef.current?.stop(); }, []);

  // ── Chat logic ──
  const abortRef = useRef<AbortController | null>(null);

  // Stop in-flight requests and any live call when the page unmounts.
  useEffect(() => () => {
    abortRef.current?.abort();
    vapiRef.current?.stop();
  }, []);

  const applyBookingState = (d: Record<string, unknown>) => {
    if (d.bookingStep  !== undefined) setBookingStep(d.bookingStep as typeof bookingStep);
    if (d.allSlots     !== undefined) setAllSlots(d.allSlots as typeof allSlots);
    if (d.pendingSlots !== undefined) setPendingSlots(d.pendingSlots as typeof pendingSlots);
    if (d.selectedSlot !== undefined) setSelectedSlot(d.selectedSlot as typeof selectedSlot);
    if (d.slotPage     !== undefined) setSlotPage(d.slotPage as number);
  };

  const addAssistant = (content: string) => setMessages((p) => [...p, { role: "assistant", content }]);
  const setLastAssistant = (content: string) =>
    setMessages((p) => [...p.slice(0, -1), { role: "assistant", content }]);

  /** Read an SSE body: grow the last assistant bubble token by token, then apply the final state. */
  const readStream = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let acc = "";
    let started = false;
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      for (const ev of parsed.events) {
        if (ev.type === "token") {
          acc += ev.text;
          if (!started) { started = true; addAssistant(acc); } else { setLastAssistant(acc); }
        } else if (ev.type === "done") {
          finished = true;
          if (started) setLastAssistant(ev.reply); else addAssistant(ev.reply);
          started = true;
          applyBookingState(ev);
        } else if (ev.type === "error") {
          finished = true;
          if (started) setLastAssistant(acc ? `${acc}\n\n_(interrupted: ${ev.error})_` : ev.error); else addAssistant(ev.error);
          started = true;
        }
      }
    }
    if (!finished) {
      const note = "The connection dropped before I finished — please try again.";
      if (started) setLastAssistant(`${acc}\n\n_(${note})_`); else addAssistant(note);
    }
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;
    const userMessage: Message = { role: "user", content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
        body: JSON.stringify({ messages: newMessages, bookingStep, allSlots, pendingSlots, selectedSlot, slotPage }),
        signal: controller.signal,
      });
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
        await readStream(res.body);
      } else {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.error) {
          addAssistant(data?.error ?? "Sorry, something went wrong. Please try again.");
        } else {
          addAssistant(data.reply);
          applyBookingState(data);
        }
      }
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") addAssistant("Connection error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-dvh bg-gray-950 text-gray-100 flex flex-col">

      {/* ── Header ── */}
      <header className="border-b border-gray-800 px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap gap-y-2 items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center font-bold text-lg">{personaUi.initials}</div>
          <div>
            <h1 className="font-semibold text-white">{personaUi.displayName}</h1>
            <p className="text-xs text-gray-400">{personaUi.tagline}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {callStatus === "idle" && (
            <button onClick={startCall}
              className="flex items-center gap-2 text-sm bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
              <span className="w-2 h-2 bg-white rounded-full" />
              Voice Call
            </button>
          )}
          {callStatus === "connecting" && (
            <button disabled className="flex items-center gap-2 text-sm bg-emerald-700 opacity-70 px-4 py-2 rounded-lg cursor-not-allowed">
              <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
              Connecting…
            </button>
          )}
          {callStatus === "active" && (
            <button onClick={endCall}
              className="flex items-center gap-2 text-sm bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
              <span className={`w-2 h-2 bg-white rounded-full ${isSpeaking ? "animate-ping" : ""}`} />
              End Call
            </button>
          )}
          <button
            onClick={() => sendMessage(personaUi.bookMessage)}
            disabled={loading || bookingStep !== "idle" || callStatus !== "idle"}
            className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
            {bookingStep !== "idle" ? "Booking…" : "Book a Call"}
          </button>
        </div>
      </header>

      {/* ── Voice Call Overlay ── */}
      {callStatus !== "idle" && (
        <div role="dialog" aria-modal="true" aria-label="Live voice call" className="fixed inset-0 z-50 bg-gray-950 flex flex-col">
          {/* Status bar */}
          <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 flex-shrink-0">
            <div className="flex items-center gap-3">
              {/* Animated avatar */}
              <div className={`w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center font-bold text-lg relative ${isSpeaking ? "ring-2 ring-emerald-400 ring-offset-2 ring-offset-gray-950" : ""}`}>
                {personaUi.initials}
                {isSpeaking && (
                  <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-20 animate-ping" />
                )}
              </div>
              <div>
                <p className="font-semibold text-white text-sm">
                  {callStatus === "connecting" ? "Connecting…" : isSpeaking ? `${personaUi.shortName} is speaking…` : "Listening…"}
                </p>
                <p className="text-xs text-gray-400">Live voice call · Google Calendar booking enabled</p>
              </div>
            </div>
            <button onClick={endCall}
              className="flex items-center gap-2 text-sm bg-red-600 hover:bg-red-700 px-5 py-2 rounded-lg transition-colors font-medium">
              ✕ End Call
            </button>
          </div>

          {/* Transcript area */}
          <div className="flex-1 overflow-y-auto px-4 py-6 max-w-2xl mx-auto w-full space-y-3">
            {transcript.length === 0 && callStatus === "active" && (
              <div className="text-center text-gray-400 text-sm mt-16">
                <div className="flex justify-center gap-1 mb-3">
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
                Waiting for {personaUi.shortName} to speak…
              </div>
            )}

            {transcript.map((line, i) => (
              <div key={i} className={`flex ${line.role === "user" ? "justify-end" : "justify-start"}`}>
                {line.role === "assistant" && (
                  <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold mr-2 mt-1 flex-shrink-0">{personaUi.initials}</div>
                )}
                <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed transition-opacity
                  ${line.role === "user"
                    ? "bg-blue-600 text-white rounded-br-sm"
                    : "bg-gray-800 text-gray-100 rounded-bl-sm"}
                  ${!line.final ? "opacity-60 italic" : "opacity-100"}`}>
                  {line.text}
                </div>
                {line.role === "user" && (
                  <div className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center text-xs font-bold ml-2 mt-1 flex-shrink-0">You</div>
                )}
              </div>
            ))}
            <div ref={voiceBottomRef} />
          </div>

          {/* Footer hint */}
          <div className="border-t border-gray-800 px-4 py-3 text-center text-xs text-gray-400 flex-shrink-0">
            Speak naturally · Ask about skills, projects, availability · Say &quot;book a meeting&quot; to schedule
          </div>
        </div>
      )}

      {/* ── Chat Interface ── */}
      <main className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-col flex-1 min-h-0 max-w-3xl mx-auto w-full">
          <div role="log" aria-live="polite" aria-label="Conversation" className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && (
                  <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold mr-2 mt-1 flex-shrink-0">{personaUi.initials}</div>
                )}
                <div className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-br-sm"
                    : "bg-gray-800 text-gray-100 rounded-bl-sm"}`}>
                  {msg.role === "user" ? msg.content : (
                    <ReactMarkdown skipHtml disallowedElements={["img"]} unwrapDisallowed components={{
                      p:      ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      ul:     ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
                      ol:     ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
                      li:     ({ children }) => <li>{children}</li>,
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      a:      ({ href, children }) => <a href={href} className="text-blue-400 underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                    }}>
                      {msg.content}
                    </ReactMarkdown>
                  )}
                </div>
              </div>
            ))}
            {loading && messages[messages.length - 1]?.role === "user" && (
              <div className="flex justify-start" role="status" aria-label={`${personaUi.shortName} is typing`}>
                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold mr-2 flex-shrink-0">{personaUi.initials}</div>
                <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {callError && (
            <p role="alert" className="mx-4 mb-2 rounded-lg bg-red-950 border border-red-800 px-3 py-2 text-sm text-red-200">{callError}</p>
          )}

          {messages.length <= 1 && (
            <div className="px-4 pb-3 flex flex-wrap gap-2">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button key={q} onClick={() => sendMessage(q)}
                  className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-2 rounded-full transition-colors text-gray-300">
                  {q}
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-gray-800 px-4 py-4">
            <form onSubmit={(e) => { e.preventDefault(); sendMessage(input); }} className="flex gap-2">
              <input type="text" aria-label="Message" value={input} onChange={(e) => setInput(e.target.value)}
                ref={inputRef}
                placeholder={personaUi.placeholder}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
                disabled={loading} autoFocus maxLength={1000} />
              <button type="submit" disabled={loading || !input.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed px-5 py-3 rounded-xl transition-colors text-sm font-medium">
                Send
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
