import { useCallback, useRef, useState } from 'react';
import { authFetch } from '../utils/roomAuth';

export function useVoiceRecorder(roomId: string) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone access denied');
    }
  }, []);

  const stopAndTranscribe = useCallback(async (): Promise<string | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return null;

    setIsRecording(false);
    setIsTranscribing(true);

    try {
      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
        };
        recorder.stop();
      });

      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = String(reader.result || '');
          const commaIdx = result.indexOf(',');
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(new Error('Failed to encode audio'));
        reader.readAsDataURL(blob);
      });

      const res = await authFetch('/api/ai/transcribe', roomId, {
        method: 'POST',
        body: JSON.stringify({
          roomId,
          audioBase64: base64,
          mimeType: (recorder.mimeType || 'audio/webm').split(';')[0],
        }),
      });

      const data = (await res.json()) as { transcript?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Transcription failed');
      return data.transcript || '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voice transcription failed');
      return null;
    } finally {
      setIsTranscribing(false);
    }
  }, [roomId]);

  return {
    isRecording,
    isTranscribing,
    error,
    startRecording,
    stopAndTranscribe,
  };
}
