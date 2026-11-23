import { useCallback, useEffect, useRef, useState } from 'react';

export function useScreenShare() {
  const [isSharing, setIsSharing] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const stopScreenShare = useCallback(() => {
    setPreviewStream((prev) => {
      prev?.getTracks().forEach((t) => t.stop());
      return null;
    });
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsSharing(false);
  }, []);

  const startScreenShare = useCallback(async () => {
    setScreenError(null);
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setScreenError('Screen sharing is not supported in this browser.');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.onended = () => {
          stopScreenShare();
        };
      }
      if (!videoRef.current) {
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        videoRef.current = v;
      }
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {});
      setPreviewStream(stream);
      setIsSharing(true);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Screen share cancelled';
      if (!/denied|cancel|abort/i.test(msg)) {
        setScreenError(msg);
      }
      return false;
    }
  }, [stopScreenShare]);

  const captureScreenFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || !isSharing || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }
    const maxW = 1440;
    const scale = video.videoWidth > maxW ? maxW / video.videoWidth : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  }, [isSharing]);

  useEffect(() => {
    return () => {
      stopScreenShare();
    };
  }, [stopScreenShare]);

  return {
    isSharing,
    previewStream,
    screenError,
    startScreenShare,
    stopScreenShare,
    captureScreenFrame,
  };
}
