import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userMessage, aiResponse, conversationId, contactInfo } = await req.json();
    const GHL_API_KEY = Deno.env.get("GHL_API_KEY");
    if (!GHL_API_KEY) throw new Error("GHL_API_KEY is not configured");

    const headers = {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    };

    // Search for existing contact by conversation ID
    let contactId: string | null = null;

    if (contactInfo?.email || contactInfo?.phone) {
      const searchQuery = contactInfo.email || contactInfo.phone;
      const searchResp = await fetch(
        `https://rest.gohighlevel.com/v1/contacts/lookup?email=${encodeURIComponent(searchQuery)}`,
        { headers }
      );
      if (searchResp.ok) {
        const searchData = await searchResp.json();
        contactId = searchData.contacts?.[0]?.id || null;
      }
    }

    // Build contact payload with enriched data
    const contactPayload: Record<string, any> = {
      name: contactInfo?.name || "Website Visitor",
      tags: ["ai-support", "chat-widget", "nrcia"],
      source: "SupportAI Widget",
      customField: {
        last_message: userMessage,
        ai_response: aiResponse,
        conversation_id: conversationId,
        source: "SupportAI Widget",
        last_interaction: new Date().toISOString(),
      },
    };

    if (contactInfo?.email) contactPayload.email = contactInfo.email;
    if (contactInfo?.phone) contactPayload.phone = contactInfo.phone;

    let response: Response;

    if (contactId) {
      // Update existing contact
      response = await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(contactPayload),
      });
    } else {
      // Create new contact
      response = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
        method: "POST",
        headers,
        body: JSON.stringify(contactPayload),
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error("GHL error:", response.status, errText);
      return new Response(JSON.stringify({ success: false, error: "GHL sync failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const returnedContactId = data.contact?.id || contactId;

    // Add conversation note to the contact
    if (returnedContactId && userMessage) {
      try {
        await fetch(`https://rest.gohighlevel.com/v1/contacts/${returnedContactId}/notes/`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            body: `**User:** ${userMessage}\n\n**AI Response:** ${aiResponse}\n\n_Conversation ID: ${conversationId}_`,
          }),
        });
      } catch (noteErr) {
        console.warn("Failed to add note:", noteErr);
      }
    }

    return new Response(JSON.stringify({ success: true, contactId: returnedContactId }), {
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
