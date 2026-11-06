import { apiFetch } from './api';

export interface HybridSettings {
  voice_mode: 'local' | 'gpt_live';
  mode: 'local' | 'openai' | 'automatic';
  local_model: string;
  openai_model: string;
  default_local_model: string;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status})`);
  }
  return response.json();
}

export const getHybridSettings = () => jsonRequest<HybridSettings>('/v1/speech/hybrid/settings');
export const saveHybridSettings = (settings: HybridSettings) => jsonRequest<HybridSettings>(
  '/v1/speech/hybrid/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
  },
);

export class LiveVoiceSession {
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private channel: RTCDataChannel | null = null;
  private audio: HTMLAudioElement | null = null;
  private transcript = '';
  private transcriptRole = '';
  private generation = 0;
  private pending = new Set<string>();

  constructor(private onError: (error: string) => void) {}

  async start(): Promise<void> {
    const generation = ++this.generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const peer = new RTCPeerConnection();
      this.peer = peer;
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      const audio = new Audio();
      this.audio = audio;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        void audio.play().catch(() => this.onError('Audio playback was blocked by the browser.'));
      };
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.onmessage = (event) => void this.handleEvent(event.data, generation);
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed') this.onError('Live voice connection failed.');
      };
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve) => {
        if (peer.iceGatheringState === 'complete') return resolve();
        const timer = window.setTimeout(resolve, 5000);
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') { window.clearTimeout(timer); resolve(); }
        });
      });
      if (generation !== this.generation) return;
      const session = await jsonRequest<{ sdp: string }>('/v1/speech/live/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: peer.localDescription?.sdp }),
      });
      if (generation !== this.generation) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: session.sdp });
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private async handleEvent(raw: string, generation: number): Promise<void> {
    let event: any;
    try { event = JSON.parse(raw); } catch { return; }
    if ((event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') && typeof event.delta === 'string') {
      const role = event.type === 'session.input_transcript.delta' ? 'User' : 'Assistant';
      const prefix = this.transcriptRole === role ? '' : `\n${role}: `;
      this.transcriptRole = role;
      this.transcript = (this.transcript + prefix + event.delta).slice(-12000);
    }
    if (event.type !== 'session.delegation.created' || event.delegation?.target !== 'client') return;
    const id = event.delegation.id;
    if (typeof id !== 'string' || this.pending.has(id)) return;
    this.pending.add(id);
    const text = this.transcript.trim();
    try {
      if (!text) throw new Error('No transcript available for the delegated task.');
      const result = await jsonRequest<{ text: string }>('/v1/speech/live/delegate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (generation !== this.generation || this.channel?.readyState !== 'open') return;
      this.channel.send(JSON.stringify({
        type: 'session.commentary.append', event_id: crypto.randomUUID(), delegation_id: id, content: result.text,
      }));
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : 'Delegation failed.';
      this.onError(message);
      if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify({
        type: 'session.commentary.append', event_id: crypto.randomUUID(), delegation_id: id,
        content: 'The delegated task could not be completed. Please ask the user to try again.',
      }));
    }
  }

  stop(): void {
    this.generation++;
    const channel = this.channel;
    const peer = this.peer;
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    const closeTransport = () => { channel?.close(); peer?.close(); };
    if (channel?.readyState === 'open') {
      const timer = window.setTimeout(closeTransport, 2000);
      channel.addEventListener('message', (event) => {
        try {
          if (JSON.parse(event.data).type === 'session.closed') {
            window.clearTimeout(timer);
            closeTransport();
          }
        } catch { /* Ignore non-JSON events while closing. */ }
      });
      try { channel.send(JSON.stringify({ type: 'session.close' })); }
      catch { window.clearTimeout(timer); closeTransport(); }
    } else closeTransport();
    this.channel = null; this.peer = null; this.stream = null; this.audio = null;
    this.pending.clear(); this.transcript = ''; this.transcriptRole = '';
  }
}
