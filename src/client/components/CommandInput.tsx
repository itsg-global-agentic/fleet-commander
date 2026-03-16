import { useState, useRef, useEffect } from 'react';
import { useApi } from '../hooks/useApi';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CommandInputProps {
  teamId: number;
}

type FeedbackState = null | { type: 'success'; message: string } | { type: 'error'; message: string };

export function CommandInput({ teamId }: CommandInputProps) {
  const api = useApi();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear feedback timer on unmount
  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const showFeedback = (fb: FeedbackState) => {
    setFeedback(fb);
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, 3000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setFeedback(null);

    try {
      await api.post(`teams/${teamId}/send-message`, { message: trimmed });
      setMessage('');
      showFeedback({ type: 'success', message: 'Message sent' });
      // Refocus the input after successful send
      inputRef.current?.focus();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to send message';
      showFeedback({ type: 'error', message: errMsg });
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={sending}
          placeholder="Send message to team..."
          className="flex-1 bg-dark-base border border-dark-border rounded px-3 py-2 text-sm text-dark-text placeholder-dark-muted focus:outline-none focus:border-dark-accent transition-colors disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || !message.trim()}
          className="px-4 py-2 text-sm font-medium rounded bg-dark-accent text-white hover:bg-dark-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </form>

      {/* Feedback toast */}
      {feedback && (
        <div
          className={`mt-2 text-xs px-2 py-1 rounded ${
            feedback.type === 'success'
              ? 'text-[#3FB950] bg-[#3FB950]/10'
              : 'text-[#F85149] bg-[#F85149]/10'
          }`}
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}
