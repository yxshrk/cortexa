export class MeetingAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingAudioError";
  }
}

export async function captureMeetingAudio(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new MeetingAudioError("MEDIA_DEVICES_UNAVAILABLE");
  }

  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: { echoCancellation: false, noiseSuppression: false },
  });

  display.getVideoTracks().forEach((track) => {
    track.stop();
    display.removeTrack(track);
  });

  if (display.getAudioTracks().length === 0) {
    throw new MeetingAudioError("TAB_AUDIO_MISSING");
  }

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextCtor();
  const dest = ctx.createMediaStreamDestination();

  ctx.createMediaStreamSource(display).connect(dest);
  ctx.createMediaStreamSource(mic).connect(dest);

  return dest.stream;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
