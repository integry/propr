import React from 'react';
import { Bot } from 'lucide-react';

interface ProviderLogoProps {
  provider?: string;
  className?: string;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({ provider, className = "w-4 h-4" }) => {
  const normalized = provider?.toLowerCase() || '';

  if (normalized.includes('claude') || normalized.includes('anthropic')) {
    return <img src="/logos/claude.png" alt="Claude" className={className} />;
  }

  if (normalized.includes('gemini') || normalized.includes('google')) {
    return <img src="/logos/gemini.png" alt="Gemini" className={className} />;
  }

  if (normalized.includes('codex') || normalized.includes('openai') || normalized.includes('gpt')) {
    return <img src="/logos/openai.png" alt="OpenAI" className={className} />;
  }

  // Fallback
  return <Bot className={className} />;
};
