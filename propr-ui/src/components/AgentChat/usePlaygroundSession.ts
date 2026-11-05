import { useCallback, useRef, useState } from 'react';
import { chatWithAgents, type ChatQuery, type ChatResult } from '../../api/proprApi';

export interface PlaygroundMessage {
  role: 'user' | 'assistant';
  content?: string;
  results?: ChatResult[];
  timestamp: number;
}

/**
 * One logical Playground conversation. The page owns it so the responsive
 * mobile/desktop panels and the mobile Configuration/Playground tabs only
 * change how the conversation is shown: unmounting or hiding a ChatPanel
 * never drops the unsent draft, the transcript, or a pending response.
 */
export interface PlaygroundSession {
  messages: PlaygroundMessage[];
  input: string;
  setInput: (input: string) => void;
  isLoading: boolean;
  /** Sends the current draft; ignored while a request is pending. */
  send: (queries: ChatQuery[]) => Promise<void>;
  /** Clears the transcript and discards any response still pending. */
  clear: () => void;
}

export function usePlaygroundSession(): PlaygroundSession {
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Refs make the guards synchronous, so two rendered panels or a repeated
  // Enter cannot start a second request before React re-renders.
  const messagesRef = useRef(messages);
  const inputRef = useRef(input);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);

  const updateMessages = useCallback((update: (current: PlaygroundMessage[]) => PlaygroundMessage[]) => {
    messagesRef.current = update(messagesRef.current);
    setMessages(messagesRef.current);
  }, []);

  const updateInput = useCallback((next: string) => {
    inputRef.current = next;
    setInput(next);
  }, []);

  const send = useCallback(async (queries: ChatQuery[]) => {
    const prompt = inputRef.current;
    if (pendingRef.current || !prompt.trim() || queries.length === 0) return;

    const generation = generationRef.current;
    // Context is a simplified string of past messages.
    const context = messagesRef.current.map(m =>
      m.role === 'user' ? `User: ${m.content}` : `Assistant: (Previous response hidden)`
    ).join('\n');
    pendingRef.current = true;
    setIsLoading(true);
    updateMessages(current => [...current, { role: 'user', content: prompt, timestamp: Date.now() }]);
    updateInput('');

    let reply: PlaygroundMessage;
    try {
      const { results } = await chatWithAgents(queries, prompt, context);
      reply = { role: 'assistant', results, timestamp: Date.now() };
    } catch (err) {
      console.error(err);
      reply = {
        role: 'assistant',
        results: [{
          agentId: 'error',
          agentAlias: 'System',
          model: 'N/A',
          error: (err as Error).message || 'Failed to get response',
          durationMs: 0
        }],
        timestamp: Date.now()
      };
    }

    // A clear while the request was pending started a new conversation.
    if (generation !== generationRef.current) return;
    updateMessages(current => [...current, reply]);
    pendingRef.current = false;
    setIsLoading(false);
  }, [updateInput, updateMessages]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    pendingRef.current = false;
    setIsLoading(false);
    updateMessages(() => []);
  }, [updateMessages]);

  return { messages, input, setInput: updateInput, isLoading, send, clear };
}
