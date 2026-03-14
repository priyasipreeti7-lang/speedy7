import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_TEXT_LENGTH = 1000;
const MIN_TEXT_LENGTH = 40;
const FALLBACK_REDUCTION_FACTOR = 0.9;

function parseQuotaDetails(errorText: string) {
  const match = errorText.match(/You have\s+(\d+)\s+credits remaining, while\s+(\d+)\s+credits are required/i);
  if (!match) return null;

  const available = Number(match[1]);
  const required = Number(match[2]);
  if (Number.isNaN(available) || Number.isNaN(required) || required <= 0) return null;

  return { available, required };
}

async function requestTTS(apiKey: string, voiceId: string, text: string) {
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_22050_32`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75,
          style: 0.2,
          use_speaker_boost: true,
          speed: 1.15,
        },
      }),
    }
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { text, voiceId } = await req.json();
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
    if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not configured");

    const selectedVoiceId = voiceId || "EXAVITQu4vr4xnSDxMaL";
    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "Text is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let candidateText = text.slice(0, MAX_TEXT_LENGTH).trim();

    // Retry once with a shorter text if provider quota is too low for the original content.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await requestTTS(ELEVENLABS_API_KEY, selectedVoiceId, candidateText);

      if (response.ok) {
        return new Response(response.body, {
          headers: {
            ...corsHeaders,
            "Content-Type": "audio/mpeg",
            "Transfer-Encoding": "chunked",
          },
        });
      }

      const errText = await response.text();
      console.error("ElevenLabs error:", response.status, errText);

      const isQuotaError = errText.includes("quota_exceeded");
      const isAbuseBlocked = errText.includes("detected_unusual_activity");

      if (isAbuseBlocked) {
        return new Response(
          JSON.stringify({
            error: "TTS provider blocked free-tier usage",
            details: errText,
          }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (!isQuotaError || attempt === 1) {
        return new Response(
          JSON.stringify({
            error: isQuotaError ? "TTS quota exceeded" : "TTS provider request failed",
            details: errText,
          }),
          {
            status: isQuotaError ? 402 : response.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const quota = parseQuotaDetails(errText);
      if (!quota || quota.available <= 0) {
        return new Response(JSON.stringify({ error: "TTS quota exceeded", details: errText }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const reducedLength = Math.max(
        MIN_TEXT_LENGTH,
        Math.floor(candidateText.length * (quota.available / quota.required) * FALLBACK_REDUCTION_FACTOR)
      );

      if (reducedLength >= candidateText.length) {
        return new Response(JSON.stringify({ error: "TTS quota exceeded", details: errText }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      candidateText = `${candidateText.slice(0, reducedLength).trim()}...`;
    }

    return new Response(JSON.stringify({ error: "TTS generation failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("TTS error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
