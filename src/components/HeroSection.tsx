import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Bot } from "lucide-react";

interface HeroSectionProps {
  onOpenChat: () => void;
}

export function HeroSection({ onOpenChat }: HeroSectionProps) {
  return (
    <section className="gradient-hero pt-32 pb-20 px-6">
      <div className="max-w-3xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-medium mb-6 animate-fade-in">
          <Bot className="w-4 h-4" />
          AI-Powered Support
        </div>
        <h1 className="text-4xl md:text-5xl lg:text-6xl font-extrabold text-foreground leading-tight mb-6">
          Customer support that{" "}
          <span className="text-primary">never sleeps</span>
        </h1>
        <p className="text-lg text-muted-foreground max-w-xl mx-auto mb-10 leading-relaxed">
          Instant AI responses with voice capabilities. Resolve queries faster, reduce wait times, and deliver exceptional support 24/7.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Button variant="hero" size="lg" onClick={onOpenChat} className="gap-2">
            Try the Widget <ArrowRight className="w-4 h-4" />
          </Button>
          <Button variant="hero-outline" size="lg" asChild>
            <a href="#features">View Demo</a>
          </Button>
        </div>
      </div>
    </section>
  );
}
