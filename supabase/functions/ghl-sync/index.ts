import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userMessage, aiResponse, conversationId } = await req.json();
    const GHL_API_KEY = Deno.env.get("GHL_API_KEY");
    if (!GHL_API_KEY) throw new Error("GHL_API_KEY is not configured");

    // Create or update contact in GoHighLevel
    const response = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Website Visitor",
        tags: ["ai-support", "chat-widget"],
        customField: {
          last_message: userMessage,
          ai_response: aiResponse,
          conversation_id: conversationId,
          source: "SupportAI Widget",
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("GHL error:", response.status, errText);
      // Don't throw - GHL sync is non-critical
      return new Response(JSON.stringify({ success: false, error: "GHL sync failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify({ success: true, contactId: data.contact?.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("GHL sync error:", e);
    return new Response(JSON.stringify({ success: false, error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
