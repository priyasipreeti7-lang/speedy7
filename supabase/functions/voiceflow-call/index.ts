import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const extractTraceMessages = (traces: any[]) => {
  return traces
    .filter((t: any) => t.type === "text" || t.type === "speak")
    .map((t: any) => t.payload?.message || t.payload?.text || "")
    .filter(Boolean);
};

const extractButtons = (traces: any[]) => {
  const choiceTraces = traces.filter(
    (t: any) => t.type === "choice" || t.type === "visual" || t.payload?.buttons
  );
  const buttons: Array<{ label: string; value: string }> = [];
  for (const trace of choiceTraces) {
    const traceButtons = trace.payload?.buttons || trace.payload?.choices || [];
    for (const btn of traceButtons) {
      buttons.push({
        label: btn.name || btn.label || btn.text || "",
        value: btn.request?.payload || btn.value || btn.name || "",
      });
    }
  }
  return buttons;
};

const checkForEnd = (traces: any[]) => {
  return traces.some(
    (t: any) =>
      t.type === "end" ||
      t.type === "path" && t.payload?.path === "transfer" ||
      (t.payload?.message || "").toLowerCase().includes("transfer")
  );
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { action, conversationId, userMessage, buttonValue } = await req.json();
    const VOICEFLOW_API_KEY = Deno.env.get("VOICEFLOW_API_KEY");
    if (!VOICEFLOW_API_KEY) throw new Error("VOICEFLOW_API_KEY is not configured");

    const userId = conversationId || crypto.randomUUID();
    const baseUrl = `https://general-runtime.voiceflow.com/state/user/${userId}`;
    const headers = {
      Authorization: VOICEFLOW_API_KEY,
      "Content-Type": "application/json",
    };

    if (action === "start") {
      const response = await fetch(`${baseUrl}/interact`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: { type: "launch" } }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("Voiceflow launch error:", response.status, errText);
        throw new Error("Failed to launch Voiceflow conversation");
      }

      const traces = await response.json();
      const textMessages = extractTraceMessages(traces);
      const buttons = extractButtons(traces);

      return new Response(
        JSON.stringify({
          message: textMessages.join("\n") || "Hello! I'm your AI phone support agent. How can I help you today?",
          buttons,
          userId,
          traces,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "message") {
      const actionPayload = buttonValue
        ? { type: "intent", payload: { query: buttonValue, intent: { name: buttonValue } } }
        : { type: "text", payload: userMessage };

      const response = await fetch(`${baseUrl}/interact`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: actionPayload }),
      });

      if (!response.ok) throw new Error("Failed to send message to Voiceflow");

      const traces = await response.json();
      const textMessages = extractTraceMessages(traces);
      const buttons = extractButtons(traces);
      const shouldTransfer = checkForEnd(traces);

      return new Response(
        JSON.stringify({
          message: textMessages.join("\n") || "I'm processing your request...",
          buttons,
          shouldTransfer,
          traces,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "reset") {
      // Reset conversation state
      const response = await fetch(`${baseUrl}`, {
        method: "DELETE",
        headers,
      });

      return new Response(
        JSON.stringify({ success: response.ok, userId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Voiceflow error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
