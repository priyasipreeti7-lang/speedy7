import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Mic, MicOff, Volume2, VolumeX, Bot, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import ReactMarkdown from "react-markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  audioUrl?: string;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export function ChatWidget() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isOnCall, setIsOnCall] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [voiceflowUserId, setVoiceflowUserId] = useState<string | null>(null);
  const [voiceflowStarted, setVoiceflowStarted] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<any>(null);
  const isOnCallRef = useRef(false);

  // Launch Voiceflow session on first use
  const ensureVoiceflowSession = useCallback(async () => {
    if (voiceflowStarted && voiceflowUserId) return voiceflowUserId;
    const sessionId = voiceflowUserId || crypto.randomUUID();
    try {
      const { data, error } = await supabase.functions.invoke("voiceflow-call", {
        body: { action: "start", conversationId: sessionId },
      });
      if (error) throw error;
      const userId = data?.userId || sessionId;
      setVoiceflowUserId(userId);
      setVoiceflowStarted(true);
      // Show Voiceflow welcome message if available
      if (data?.message && messages.length === 0) {
        const welcomeId = crypto.randomUUID();
        setMessages((prev) => [...prev, { id: welcomeId, role: "assistant", content: data.message }]);
      }
      return userId;
    } catch (err) {
      console.error("Voiceflow session start error:", err);
      setVoiceflowUserId(sessionId);
      setVoiceflowStarted(true);
      return sessionId;
    }
  }, [voiceflowStarted, voiceflowUserId, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const ensureConversation = useCallback(async () => {
    if (conversationId) return conversationId;
    const { data, error } = await supabase
      .from("conversations")
      .insert({ status: "active" })
      .select("id")
      .single();
    if (error || !data) {
      console.error("Failed to create conversation:", error);
      return null;
    }
    setConversationId(data.id);
    return data.id;
  }, [conversationId]);

  const saveMessage = async (convId: string, role: string, content: string) => {
    await supabase.from("messages").insert({ conversation_id: convId, role, content });
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const userText = input.trim();
    setInput("");

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: userText };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const convId = await ensureConversation();
      if (convId) await saveMessage(convId, "user", userText);

      let assistantContent = "";
      const assistantId = crypto.randomUUID();

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          messages: messages.map((m) => ({ role: m.role, content: m.content })).concat({ role: "user", content: userText }),
        }),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`Chat failed: ${resp.status}`);

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              assistantContent += delta;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.id === assistantId) {
                  return prev.map((m) => (m.id === assistantId ? { ...m, content: assistantContent } : m));
                }
                return [...prev, { id: assistantId, role: "assistant", content: assistantContent }];
              });
            }
          } catch {}
        }
      }

      if (convId) await saveMessage(convId, "assistant", assistantContent);
      if (!isMuted && assistantContent) playTTS(assistantContent, assistantId);
      sendToGHL(userText, assistantContent);
    } catch (err) {
      console.error("Chat error:", err);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: "Sorry, something went wrong. Please try again." },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const speakWithBrowser = (text: string, onEnd?: () => void) => {
    if (!("speechSynthesis" in window)) { onEnd?.(); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1;
    utterance.pitch = 1.0;
    utterance.lang = "en-US";
    if (onEnd) utterance.onend = () => onEnd();
    window.speechSynthesis.speak(utterance);
  };

  const playTTSWithFallback = async (text: string, msgId: string, onEnded?: () => void): Promise<void> => {
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({ text, voiceId: "EXAVITQu4vr4xnSDxMaL" }),
      });
      if (resp.ok) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, audioUrl: url } : m)));
        const audio = new Audio(url);
        currentAudioRef.current = audio;
        if (onEnded) audio.onended = () => onEnded();
        try { await audio.play(); return; } catch (playErr) {
          console.warn("Audio autoplay blocked, falling back to browser speech:", playErr);
        }
      }
    } catch (err) {
      console.warn("TTS error, falling back:", err);
    }
    speakWithBrowser(text, onEnded);
  };

  const playTTS = (text: string, msgId: string) => { playTTSWithFallback(text, msgId); };

  const toggleRecording = async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorder.onstop = () => { stream.getTracks().forEach((t) => t.stop()); };

      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = "en-US";
        recognition.onresult = (event: any) => { setInput(event.results[0][0].transcript); };
        recognition.onerror = () => setIsRecording(false);
        recognition.onend = () => setIsRecording(false);
        recognition.start();
      }
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) { console.error("Mic error:", err); }
  };

  const startListening = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: "Speech recognition is not supported in this browser." }]);
      setIsOnCall(false);
      isOnCallRef.current = false;
      return;
    }
    try { recognitionRef.current?.abort(); } catch {}

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;

    recognition.onresult = async (event: any) => {
      const lastResult = event.results[event.results.length - 1];
      if (!lastResult.isFinal) return;
      const transcript = lastResult[0].transcript;
      if (!transcript.trim() || !isOnCallRef.current) return;

      const userMsgId = crypto.randomUUID();
      setMessages((prev) => [...prev, { id: userMsgId, role: "user", content: transcript }]);

      try {
        const { data, error } = await supabase.functions.invoke("voiceflow-call", {
          body: { action: "message", conversationId, userMessage: transcript },
        });
        if (error) throw error;
        if (data?.message) {
          const aiMsgId = crypto.randomUUID();
          setMessages((prev) => [...prev, { id: aiMsgId, role: "assistant", content: data.message }]);
          if (!isMuted) {
            await playTTSWithFallback(data.message, aiMsgId, () => { if (isOnCallRef.current) startListening(); });
            return;
          }
          if (data?.shouldTransfer) {
            setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: "🔄 Transferring you to a human agent..." }]);
            setIsOnCall(false);
            isOnCallRef.current = false;
            return;
          }
        }
        if (isOnCallRef.current) startListening();
      } catch (err) {
        console.error("Voiceflow message error:", err);
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: "Sorry, I didn't catch that. Could you repeat?" }]);
        if (isOnCallRef.current) startListening();
      }
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: "Microphone access is blocked. Please allow microphone permission." }]);
        setIsOnCall(false);
        isOnCallRef.current = false;
        return;
      }
      if (event.error === "no-speech" && isOnCallRef.current) {
        setTimeout(() => { if (isOnCallRef.current) startListening(); }, 350);
        return;
      }
      if (isOnCallRef.current && event.error !== "aborted") {
        setTimeout(() => { if (isOnCallRef.current) startListening(); }, 1000);
      }
    };

    recognition.onend = () => {
      if (isOnCallRef.current) {
        setTimeout(() => { if (isOnCallRef.current) startListening(); }, 300);
      }
    };

    try { recognition.start(); } catch (startErr) {
      console.error("Speech recognition start error:", startErr);
      if (isOnCallRef.current) { setTimeout(() => { if (isOnCallRef.current) startListening(); }, 500); }
    }
  }, [conversationId, isMuted]);

  const toggleCall = async () => {
    if (isOnCall) {
      setIsOnCall(false);
      isOnCallRef.current = false;
      recognitionRef.current?.abort();
      currentAudioRef.current?.pause();
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: "📞 Call ended." }]);
      return;
    }
    setIsOnCall(true);
    isOnCallRef.current = true;
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: "📞 Starting AI call... Connecting to support agent." }]);

    try {
      const { data, error } = await supabase.functions.invoke("voiceflow-call", { body: { action: "start", conversationId } });
      if (error) throw error;
      if (data?.message) {
        const callMsgId = crypto.randomUUID();
        setMessages((prev) => [...prev, { id: callMsgId, role: "assistant", content: data.message }]);
        if (!isMuted) {
          await playTTSWithFallback(data.message, callMsgId, () => { if (isOnCallRef.current) startListening(); });
          return;
        }
        startListening();
      } else {
        startListening();
      }
    } catch (err) {
      console.error("Call error:", err);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: "Failed to start call. Please try again." }]);
      setIsOnCall(false);
      isOnCallRef.current = false;
    }
  };

  const sendToGHL = async (userMsg: string, aiResponse: string) => {
    try {
      await supabase.functions.invoke("ghl-sync", { body: { userMessage: userMsg, aiResponse, conversationId } });
    } catch (err) { console.error("GHL sync error:", err); }
  };

  const handlePlayAudio = (url: string) => {
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null; }
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    audio.play();
  };

  return (
    <div className="w-full max-w-lg h-[90vh] max-h-[700px] bg-background rounded-2xl shadow-widget border border-border flex flex-col overflow-hidden">
      {/* Header */}
      <div className="gradient-primary px-5 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-primary-foreground/20 flex items-center justify-center">
            <Bot className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-primary-foreground">NRCIA Assistant</h1>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-online" />
              <span className="text-xs text-primary-foreground/70">Online</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
            onClick={() => setIsMuted(!isMuted)}
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 hover:bg-primary-foreground/10 ${isOnCall ? "text-recording" : "text-primary-foreground/70 hover:text-primary-foreground"}`}
            onClick={toggleCall}
          >
            {isOnCall ? <PhoneOff className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 chat-scrollbar">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
              <Bot className="w-6 h-6 text-primary" />
            </div>
            <p className="text-sm text-foreground font-medium">Hi! 👋 Welcome!</p>
            <p className="text-xs text-muted-foreground mt-1">How can we help you today?</p>
            <div className="grid grid-cols-2 gap-2 mt-5 px-4">
              {[
                { label: "Send Email", icon: "✉️", action: "I want to send an email" },
                { label: "Send SMS", icon: "💬", action: "I want to send an SMS" },
                { label: "Join NRCIA", icon: "🏠", action: "I want to join the NRCIA Association" },
                { label: "Chat", icon: "💭", action: "I want to chat with support" },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={() => { setInput(item.action); }}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-card hover:bg-accent/50 text-sm text-foreground font-medium transition-colors text-left"
                >
                  <span className="text-base">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-fade-in`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-chat-user-bubble text-chat-user-text rounded-br-md"
                  : "bg-chat-ai-bubble text-chat-ai-text rounded-bl-md"
              }`}
            >
              {msg.role === "assistant" ? (
                <div className="prose prose-sm max-w-none">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                msg.content
              )}
              {msg.audioUrl && (
                <button
                  onClick={() => handlePlayAudio(msg.audioUrl!)}
                  className="mt-1.5 flex items-center gap-1 text-xs opacity-60 hover:opacity-100 transition-opacity"
                >
                  <Volume2 className="w-3 h-3" /> Play audio
                </button>
              )}
            </div>
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start animate-fade-in">
            <div className="bg-chat-ai-bubble rounded-2xl rounded-bl-md px-4 py-3">
              <div className="flex gap-1.5">
                <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border shrink-0">
        <div className="flex items-center gap-2 bg-chat-input-bg rounded-xl px-3 py-1.5">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder={isOnCall ? "On call..." : "Type a message..."}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none py-2"
            disabled={isLoading}
          />
          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 shrink-0 ${isRecording ? "text-recording animate-pulse-ring" : "text-muted-foreground hover:text-foreground"}`}
            onClick={toggleRecording}
          >
            {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-primary hover:text-primary/80"
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
