import { useState } from "react";
import { Navbar } from "@/components/Navbar";
import { HeroSection } from "@/components/HeroSection";
import { FeatureCards } from "@/components/FeatureCards";
import { ChatWidgetPanel } from "@/components/ChatWidgetPanel";
import { ChatFAB } from "@/components/ChatFAB";

const Index = () => {
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <HeroSection onOpenChat={() => setChatOpen(true)} />
      <section id="features" className="py-20">
        <FeatureCards />
      </section>
      <ChatWidgetPanel isOpen={chatOpen} onClose={() => setChatOpen(false)} />
      <ChatFAB isOpen={chatOpen} onClick={() => setChatOpen(!chatOpen)} />
    </div>
  );
};

export default Index;
