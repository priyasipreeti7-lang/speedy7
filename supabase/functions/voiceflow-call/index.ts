import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { action, conversationId, userMessage } = await req.json();
    const VOICEFLOW_API_KEY = Deno.env.get("VOICEFLOW_API_KEY");
    if (!VOICEFLOW_API_KEY) throw new Error("VOICEFLOW_API_KEY is not configured");

    const userId = conversationId || crypto.randomUUID();

    if (action === "start") {
      // Launch Voiceflow conversation
      const response = await fetch(
        `https://general-runtime.voiceflow.com/state/user/${userId}/interact`,
        {
          method: "POST",
          headers: {
            Authorization: VOICEFLOW_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: { type: "launch" },
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error("Voiceflow launch error:", response.status, errText);
        throw new Error("Failed to launch Voiceflow conversation");
      }

      const traces = await response.json();
      const textTraces = traces
        .filter((t: any) => t.type === "text" || t.type === "speak")
        .map((t: any) => t.payload?.message || t.payload?.text || "")
        .filter(Boolean);

      return new Response(
        JSON.stringify({
          message: textTraces.join("\n") || "Hello! I'm your AI phone support agent. How can I help you today?",
          traces,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "message") {
      // Send message to Voiceflow
      const response = await fetch(
        `https://general-runtime.voiceflow.com/state/user/${userId}/interact`,
        {
          method: "POST",
          headers: {
            Authorization: VOICEFLOW_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: { type: "text", payload: userMessage },
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to send message to Voiceflow");
      }

      const traces = await response.json();
      const textTraces = traces
        .filter((t: any) => t.type === "text" || t.type === "speak")
        .map((t: any) => t.payload?.message || t.payload?.text || "")
        .filter(Boolean);

      // Check if agent wants to transfer to human
      const transferTrace = traces.find((t: any) => t.type === "end" || (t.payload?.message || "").toLowerCase().includes("transfer"));

      return new Response(
        JSON.stringify({
          message: textTraces.join("\n") || "I'm processing your request...",
          shouldTransfer: !!transferTrace,
          traces,
        }),
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
