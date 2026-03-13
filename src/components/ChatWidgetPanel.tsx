import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Mic, MicOff, Volume2, VolumeX, X, Bot, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import ReactMarkdown from "react-markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  audioUrl?: string;
}

interface ChatWidgetPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export function ChatWidgetPanel({ isOpen, onClose }: ChatWidgetPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isOnCall, setIsOnCall] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Create or get conversation
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

  // Save message to DB
  const saveMessage = async (convId: string, role: string, content: string) => {
    await supabase.from("messages").insert({ conversation_id: convId, role, content });
  };

  // Send text message
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

      // Stream AI response
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

      if (!resp.ok) {
        throw new Error(`Chat failed: ${resp.status}`);
      }

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
          } catch {
            // partial JSON
          }
        }
      }

      if (convId) await saveMessage(convId, "assistant", assistantContent);

      // TTS if not muted
      if (!isMuted && assistantContent) {
        playTTS(assistantContent, assistantId);
      }

      // Send to GHL
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

  // TTS playback
  const playTTS = async (text: string, msgId: string) => {
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({ text, voiceId: "EXAVITQu4vr4xnSDxMaL" }),
      });
      if (!resp.ok) return;
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, audioUrl: url } : m)));
      const audio = new Audio(url);
      currentAudioRef.current = audio;
      audio.play();
    } catch (err) {
      console.error("TTS error:", err);
    }
  };

  // Voice recording
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

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        // Simple browser-based speech recognition fallback
        if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
          // Already handled by SpeechRecognition below
        }
      };

      // Use Web Speech API for real-time transcription
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = "en-US";
        recognition.onresult = (event: any) => {
          const transcript = event.results[0][0].transcript;
          setInput(transcript);
        };
        recognition.onerror = () => setIsRecording(false);
        recognition.onend = () => setIsRecording(false);
        recognition.start();
      }

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Mic error:", err);
    }
  };

  const recognitionRef = useRef<any>(null);
  const isOnCallRef = useRef(false);

  // Start continuous listening for the call
  const startListening = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: "Speech recognition is not supported in this browser." },
      ]);
      setIsOnCall(false);
      isOnCallRef.current = false;
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;

    recognition.onresult = async (event: any) => {
      const transcript = event.results[0][0].transcript;
      if (!transcript.trim() || !isOnCallRef.current) return;

      // Show user message
      const userMsgId = crypto.randomUUID();
      setMessages((prev) => [...prev, { id: userMsgId, role: "user", content: transcript }]);

      // Send to Voiceflow
      try {
        const { data, error } = await supabase.functions.invoke("voiceflow-call", {
          body: { action: "message", conversationId, userMessage: transcript },
        });
        if (error) throw error;

        if (data?.message) {
          const aiMsgId = crypto.randomUUID();
          setMessages((prev) => [...prev, { id: aiMsgId, role: "assistant", content: data.message }]);

          // Play TTS and restart listening after audio finishes
          if (!isMuted) {
            try {
              const resp = await fetch(`${SUPABASE_URL}/functions/v1/tts`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${SUPABASE_KEY}`,
                },
                body: JSON.stringify({ text: data.message, voiceId: "EXAVITQu4vr4xnSDxMaL" }),
              });
              if (resp.ok) {
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                setMessages((prev) => prev.map((m) => (m.id === aiMsgId ? { ...m, audioUrl: url } : m)));
                const audio = new Audio(url);
                currentAudioRef.current = audio;
                audio.onended = () => {
                  if (isOnCallRef.current) startListening();
                };
                audio.play();
                return; // Don't restart listening yet, wait for audio
              }
            } catch (ttsErr) {
              console.error("TTS error during call:", ttsErr);
            }
          }

          // If muted or TTS failed, check for transfer or restart listening
          if (data?.shouldTransfer) {
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "assistant", content: "🔄 Transferring you to a human agent..." },
            ]);
            setIsOnCall(false);
            isOnCallRef.current = false;
            return;
          }
        }

        // Restart listening if still on call
        if (isOnCallRef.current) startListening();
      } catch (err) {
        console.error("Voiceflow message error:", err);
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", content: "Sorry, I didn't catch that. Could you repeat?" },
        ]);
        if (isOnCallRef.current) startListening();
      }
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === "no-speech" && isOnCallRef.current) {
        startListening(); // Retry on silence
        return;
      }
      if (isOnCallRef.current && event.error !== "aborted") {
        setTimeout(() => {
          if (isOnCallRef.current) startListening();
        }, 1000);
      }
    };

    recognition.onend = () => {
      // Auto-restart if recognition ends without result and still on call
      // (handled by onresult and onerror above, this is a fallback)
    };

    recognition.start();
  }, [conversationId, isMuted]);

  // Voiceflow AI call
  const toggleCall = async () => {
    if (isOnCall) {
      setIsOnCall(false);
      isOnCallRef.current = false;
      recognitionRef.current?.abort();
      currentAudioRef.current?.pause();
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: "📞 Call ended." },
      ]);
      return;
    }

    setIsOnCall(true);
    isOnCallRef.current = true;
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "assistant", content: "📞 Starting AI call... Connecting to support agent." },
    ]);

    try {
      const { data, error } = await supabase.functions.invoke("voiceflow-call", {
        body: { action: "start", conversationId },
      });
      if (error) throw error;

      if (data?.message) {
        const callMsgId = crypto.randomUUID();
        setMessages((prev) => [...prev, { id: callMsgId, role: "assistant", content: data.message }]);

        if (!isMuted) {
          // Play greeting TTS, then start listening
          try {
            const resp = await fetch(`${SUPABASE_URL}/functions/v1/tts`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SUPABASE_KEY}`,
              },
              body: JSON.stringify({ text: data.message, voiceId: "EXAVITQu4vr4xnSDxMaL" }),
            });
            if (resp.ok) {
              const blob = await resp.blob();
              const url = URL.createObjectURL(blob);
              setMessages((prev) => prev.map((m) => (m.id === callMsgId ? { ...m, audioUrl: url } : m)));
              const audio = new Audio(url);
              currentAudioRef.current = audio;
              audio.onended = () => {
                if (isOnCallRef.current) startListening();
              };
              audio.play();
              return;
            }
          } catch (ttsErr) {
            console.error("TTS error:", ttsErr);
          }
        }
        // If muted or TTS failed, start listening immediately
        startListening();
      } else {
        startListening();
      }
    } catch (err) {
      console.error("Call error:", err);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: "Failed to start call. Please try again." },
      ]);
      setIsOnCall(false);
      isOnCallRef.current = false;
    }
  };

  // Send data to GoHighLevel
  const sendToGHL = async (userMsg: string, aiResponse: string) => {
    try {
      await supabase.functions.invoke("ghl-sync", {
        body: { userMessage: userMsg, aiResponse, conversationId },
      });
    } catch (err) {
      console.error("GHL sync error:", err);
    }
  };

  // Full cleanup: stop call, recording, audio, and pending requests
  const cleanupAll = useCallback(() => {
    // Abort any in-flight fetch requests
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    // Stop call — always try, not just if ref is true
    setIsOnCall(false);
    isOnCallRef.current = false;
    try {
      recognitionRef.current?.abort();
    } catch {}
    recognitionRef.current = null;

    // Stop recording
    try {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    mediaRecorderRef.current = null;
    setIsRecording(false);

    // Stop any playing audio
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      currentAudioRef.current = null;
    }

    // Reset loading state and clear messages
    setIsLoading(false);
    setMessages([]);
    setInput("");
    setConversationId(null);
  }, []);

  // Cleanup on unmount or when panel closes
  useEffect(() => {
    if (!isOpen) {
      cleanupAll();
    }
    return () => cleanupAll();
  }, [isOpen, cleanupAll]);

  // Play/stop audio
  const handlePlayAudio = (url: string) => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    audio.play();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed bottom-24 right-6 w-[380px] max-h-[600px] bg-chat-bg rounded-2xl shadow-widget border border-border flex flex-col overflow-hidden animate-slide-up z-50">
      {/* Header */}
      <div className="gradient-primary px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-primary-foreground/20 flex items-center justify-center">
            <Bot className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-primary-foreground">Support Assistant</h3>
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
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
            onClick={() => {
              cleanupAll();
              onClose();
            }}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 chat-scrollbar min-h-[300px]">
        {messages.length === 0 && (
          <div className="text-center py-10">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
              <Bot className="w-6 h-6 text-primary" />
            </div>
            <p className="text-sm text-foreground font-medium">👋 How can we help?</p>
            <p className="text-xs text-muted-foreground mt-1">
              Type a message or use voice input to get started.
            </p>
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
      <div className="p-3 border-t border-border">
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
