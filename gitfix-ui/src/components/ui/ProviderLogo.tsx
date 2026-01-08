import React from 'react';
import { Bot } from 'lucide-react';

interface ProviderLogoProps {
  provider?: string;
  className?: string;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({ provider, className = "w-4 h-4" }) => {
  const normalized = provider?.toLowerCase() || '';

  if (normalized.includes('claude') || normalized.includes('anthropic')) {
    // Anthropic / Claude Logo (Stylized)
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.5 12H15V14H17.5C18.88 14 20 12.88 20 11.5C20 10.12 18.88 9 17.5 9H13.5V17H12V7H17.5C19.98 7 22 9.02 22 11.5C22 13.98 19.98 16 17.5 16H15V18H11V12H9V14H7V10H9V12H11V6H13.5V8H17.5C19.43 8 21 9.57 21 11.5C21 13.43 19.43 15 17.5 15H15V17H13.5V12H17.5Z" fillOpacity="0.8"/>
        <path d="M4 4H10V10H4V4Z" fill="currentColor" />
      </svg>
    );
  }

  if (normalized.includes('gemini') || normalized.includes('google')) {
    // Google Gemini Logo (Sparkle)
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M13.05 2.5L14.7 9.9L22.1 11.55L14.7 13.2L13.05 20.6L11.4 13.2L4 11.55L11.4 9.9L13.05 2.5Z" />
      </svg>
    );
  }

  if (normalized.includes('codex') || normalized.includes('openai') || normalized.includes('gpt')) {
    // OpenAI Logo (Swirl/Hexagon approximation)
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
         <path d="M18.364 5.63604L16.9497 4.22183L11.2929 9.87868L12.7071 11.2929L18.364 5.63604Z" />
         <path d="M11.2929 9.87868L5.63604 4.22183L4.22183 5.63604L9.87868 11.2929L11.2929 9.87868Z" />
         <path d="M5.63604 18.364L4.22183 19.7782L9.87868 14.1213L11.2929 15.5355L5.63604 18.364Z" />
         <path d="M18.364 18.364L19.7782 19.7782L14.1213 14.1213L12.7071 15.5355L18.364 18.364Z" />
         <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" fill="none"/>
      </svg>
    );
  }

  // Fallback
  return <Bot className={className} />;
};
