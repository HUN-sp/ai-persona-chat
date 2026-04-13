"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import Vapi from "@vapi-ai/web";

const VAPI_PUBLIC_KEY   = "de0ffe0b-48dd-46b1-b342-b5747a508468";
const VAPI_ASSISTANT_ID = "a080d640-6fcd-45af-948a-915eda767641";

type Message = { role: "user" | "assistant"; content: string };
type TranscriptLine = { role: "user" | "assistant"; text: string; final: boolean };

const SUGGESTED_QUESTIONS = [
  "Why are you the right person for this role?",
  "Tell me about your Market Data Publisher project",
  "What is your educational background?",
  "When are you available for an interview?",
  "What open source work have you done?",
];

export default function Home() {
  // ── Chat state ──
  const [messages, setMessages] = useState<Message[]>([{
    role: "assistant",
    content: "Hi! I'm Vinay Kumar Chopra's AI representative. I can answer questions about my background, skills, projects, and help you schedule a meeting. What would you like to know?",
  }]);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [bookingStep, setBookingStep]   = useState<"idle" | "slots_shown" | "awaiting_email">("idle");
  const [pendingSlots, setPendingSlots] = useState<{ start: string; end: string }[] | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<{ start: string; end: string } | null>(null);
  const [slotPage, setSlotPage]         = useState(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // ── Voice call state ──
  const [callStatus, setCallStatus]     = useState<"idle" | "connecting" | "active">("idle");
  const [isSpeaking, setIsSpeaking]     = useState(false);
  const [transcript, setTranscript]     = useState<TranscriptLine[]>([]);
  const vapiRef        = useRef<Vapi | null>(null);
  const voiceBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { voiceBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [transcript]);

  // ── Voice call logic ──
  const startCall = useCallback(async () => {
    setCallStatus("connecting");
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
      setCallStatus("idle");
      vapiRef.current = null;
    }
  }, []);

  const endCall = useCallback(() => { vapiRef.current?.stop(); }, []);

  // ── Chat logic ──
  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;
    const userMessage: Message = { role: "user", content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    try {
      const res  = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages, bookingStep, pendingSlots, selectedSlot, slotPage }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages((p) => [...p, { role: "assistant", content: `Sorry, something went wrong: ${data.error}` }]);
      } else {
        setMessages((p) => [...p, { role: "assistant", content: data.reply }]);
        if (data.bookingStep  !== undefined) setBookingStep(data.bookingStep);
        if (data.pendingSlots !== undefined) setPendingSlots(data.pendingSlots);
        if (data.selectedSlot !== undefined) setSelectedSlot(data.selectedSlot);
        if (data.slotPage     !== undefined) setSlotPage(data.slotPage);
      }
    } catch {
      setMessages((p) => [...p, { role: "assistant", content: "Connection error. Please try again." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">

      {/* ── Header ── */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center font-bold text-lg">VK</div>
          <div>
            <h1 className="font-semibold text-white">Vinay Kumar Chopra</h1>
            <p className="text-xs text-gray-400">AI Representative · CS @ BITS Pilani</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {callStatus === "idle" && (
            <button onClick={startCall}
              className="flex items-center gap-2 text-sm bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-lg transition-colors">
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
              className="flex items-center gap-2 text-sm bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg transition-colors">
              <span className={`w-2 h-2 bg-white rounded-full ${isSpeaking ? "animate-ping" : ""}`} />
              End Call
            </button>
          )}
          <button
            onClick={() => sendMessage("I'd like to book a call with Vinay")}
            disabled={loading || bookingStep !== "idle" || callStatus !== "idle"}
            className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded-lg transition-colors">
            {bookingStep !== "idle" ? "Booking…" : "Book a Call"}
          </button>
        </div>
      </header>

      {/* ── Voice Call Overlay ── */}
      {callStatus !== "idle" && (
        <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col" style={{ top: "65px" }}>
          {/* Status bar */}
          <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 flex-shrink-0">
            <div className="flex items-center gap-3">
              {/* Animated avatar */}
              <div className={`w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center font-bold text-lg relative ${isSpeaking ? "ring-2 ring-emerald-400 ring-offset-2 ring-offset-gray-950" : ""}`}>
                VK
                {isSpeaking && (
                  <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-20 animate-ping" />
                )}
              </div>
              <div>
                <p className="font-semibold text-white text-sm">
                  {callStatus === "connecting" ? "Connecting…" : isSpeaking ? "Vinay is speaking…" : "Listening…"}
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
              <div className="text-center text-gray-500 text-sm mt-16">
                <div className="flex justify-center gap-1 mb-3">
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
                Waiting for Vinay to speak…
              </div>
            )}

            {transcript.map((line, i) => (
              <div key={i} className={`flex ${line.role === "user" ? "justify-end" : "justify-start"}`}>
                {line.role === "assistant" && (
                  <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold mr-2 mt-1 flex-shrink-0">VK</div>
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
          <div className="border-t border-gray-800 px-4 py-3 text-center text-xs text-gray-500 flex-shrink-0">
            Speak naturally · Ask about skills, projects, availability · Say "book a meeting" to schedule
          </div>
        </div>
      )}

      {/* ── Chat Interface ── */}
      <div className="flex flex-1 overflow-hidden" style={{ height: "calc(100vh - 65px)" }}>
        <div className="flex flex-col flex-1 max-w-3xl mx-auto w-full">
          <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && (
                  <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold mr-2 mt-1 flex-shrink-0">VK</div>
                )}
                <div className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-br-sm"
                    : "bg-gray-800 text-gray-100 rounded-bl-sm"}`}>
                  {msg.role === "user" ? msg.content : (
                    <ReactMarkdown components={{
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
            {loading && (
              <div className="flex justify-start">
                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold mr-2 flex-shrink-0">VK</div>
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
              <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about Vinay's skills, projects, or availability…"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                disabled={loading} />
              <button type="submit" disabled={loading || !input.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed px-5 py-3 rounded-xl transition-colors text-sm font-medium">
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
