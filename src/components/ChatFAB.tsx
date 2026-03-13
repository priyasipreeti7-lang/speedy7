import { MessageSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatFABProps {
  isOpen: boolean;
  onClick: () => void;
}

export function ChatFAB({ isOpen, onClick }: ChatFABProps) {
  return (
    <Button
      variant="fab"
      size="icon"
      className="fixed bottom-6 right-6 w-14 h-14 z-50 animate-bounce-in"
      onClick={onClick}
    >
      {isOpen ? <X className="w-6 h-6" /> : <MessageSquare className="w-6 h-6" />}
    </Button>
  );
}
