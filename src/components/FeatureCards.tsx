import { MessageSquare, Headphones, Volume2 } from "lucide-react";

const features = [
  {
    icon: MessageSquare,
    title: "Text Chat",
    description: "AI-powered responses with streaming, context-aware conversations.",
  },
  {
    icon: Headphones,
    title: "Voice Input",
    description: "Speak naturally — your voice is transcribed and answered instantly.",
  },
  {
    icon: Volume2,
    title: "Audio Replies",
    description: "AI responses read aloud with natural ElevenLabs voices.",
  },
];

export function FeatureCards() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto px-6">
      {features.map((feature) => (
        <div
          key={feature.title}
          className="bg-card rounded-xl p-6 shadow-card border border-border hover:border-primary/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
            <feature.icon className="w-5 h-5 text-primary" />
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">{feature.title}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">{feature.description}</p>
        </div>
      ))}
    </div>
  );
}
