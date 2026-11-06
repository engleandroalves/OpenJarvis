import { useEffect, useRef } from 'react';
import { useAppStore } from '../lib/store';
import { shouldAutoplayFinishedReply, useTtsStore } from '../lib/tts';
import { stripThinkTags } from '../lib/message-text';

/** Speak completed replies in whichever chat view is currently mounted. */
export function useVoiceAutoplay() {
  const activeId = useAppStore((s) => s.activeId);
  const messages = useAppStore((s) => s.messages);
  const streamState = useAppStore((s) => s.streamState);
  const voiceOutputEnabled = useAppStore((s) => s.settings.voiceOutputEnabled);
  const voiceAutoplay = useAppStore((s) => s.settings.voiceAutoplay);
  const streamingConversationRef = useRef<string | null>(null);

  useEffect(() => {
    if (voiceOutputEnabled) void useTtsStore.getState().ensureHealth();
  }, [voiceOutputEnabled]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    const tts = useTtsStore.getState();
    const finished = shouldAutoplayFinishedReply(
      streamingConversationRef.current, activeId, streamState.isStreaming, last, tts.autoSpokenId,
    );
    streamingConversationRef.current = streamState.isStreaming && streamState.conversationId === activeId
      ? activeId : null;
    if (!finished || !voiceOutputEnabled || !voiceAutoplay || !last || activeId === null) return;

    const conversationId = activeId;
    const messageId = last.id;
    void tts.ensureHealth().then(() => {
      const app = useAppStore.getState();
      const currentTts = useTtsStore.getState();
      const currentLast = app.messages[app.messages.length - 1];
      if (app.activeId !== conversationId || app.streamState.isStreaming) return;
      if (!app.settings.voiceOutputEnabled || !app.settings.voiceAutoplay) return;
      if (currentLast?.id !== messageId || currentTts.available !== true) return;
      if (currentTts.autoSpokenId === messageId) return;
      const text = stripThinkTags(currentLast.content);
      if (!text) return;
      currentTts.markAutoSpoken(messageId);
      void currentTts.speak(messageId, text);
    });
  }, [activeId, messages, streamState.isStreaming, streamState.conversationId, voiceOutputEnabled, voiceAutoplay]);
}
