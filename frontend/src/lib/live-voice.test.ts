import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveVoiceSession } from './live-voice';

vi.mock('./api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from './api';

describe('GPT-Live client delegation', () => {
  afterEach(() => vi.clearAllMocks());

  it('passes transcript context to the backend and returns its result once', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'event-id' });
    const send = vi.fn();
    const session = new LiveVoiceSession(vi.fn()) as any;
    session.channel = { readyState: 'open', send };
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ text: 'Verified answer' }) } as Response);
    await session.handleEvent(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'What time is it?' }), 0);
    const delegation = JSON.stringify({ type: 'session.delegation.created', delegation: { target: 'client', id: 'id-1' } });
    await session.handleEvent(delegation, 0);
    await session.handleEvent(delegation, 0);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string).text).toContain('What time is it?');
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
      type: 'session.commentary.append', delegation_id: 'id-1', content: 'Verified answer',
    });
    vi.unstubAllGlobals();
  });

  it('does not dispatch a delegation without transcript context', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'event-id' });
    const error = vi.fn();
    const session = new LiveVoiceSession(error) as any;
    session.channel = { readyState: 'open', send: vi.fn() };
    await session.handleEvent(JSON.stringify({ type: 'session.delegation.created', delegation: { target: 'client', id: 'id-2' } }), 0);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
