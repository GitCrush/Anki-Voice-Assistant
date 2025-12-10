// client/src/stt.ts
export type SpeechOnceOpts = {
  rmsThreshold?: number;
  startFrames?: number;
  endFrames?: number;        // now defaulted so ~3s silence needed to stop
  frameMs?: number;
  maxUtteranceMs?: number;
  mimeType?: string;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
};

export class SpeechOnce {
  _ac: AudioContext | null = null;
  _stream: MediaStream | null = null;
  _analyser: AnalyserNode | null = null;
  _timeData!: Uint8Array<ArrayBuffer>;
  _rec: MediaRecorder | null = null;
  _chunks: BlobPart[] = [];
  _running = false;

  constructor(public opts: SpeechOnceOpts = {}) {}

  static async blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async start(): Promise<void> {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ac = new AC();
    this._ac = ac;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this._stream = stream;

    const src = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    this._analyser = analyser;
    this._timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));

    const preferred = [
      this.opts.mimeType || "",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].filter(Boolean);

    let rec: MediaRecorder;
    try {
      const isSup = (t: string) =>
        (window as any).MediaRecorder?.isTypeSupported
          ? (window as any).MediaRecorder.isTypeSupported(t)
          : true;
      const supported = preferred.find((t) => isSup(t));
      rec = supported ? new MediaRecorder(stream, { mimeType: supported }) : new MediaRecorder(stream);
    } catch {
      rec = new MediaRecorder(stream);
    }
    this._rec = rec;

    this._rec.ondataavailable = (ev: any) => {
      if (ev && ev.data && ev.data.size > 0) this._chunks.push(ev.data);
    };

    this._running = true;
  }

  _rms(buf: Uint8Array<ArrayBuffer>): number {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  async recordOneUtterance(): Promise<Blob | null> {
    if (!this._running || !this._analyser || !this._rec) return null;

    const frameMsDefault = 50;
    const {
      rmsThreshold = 0.02,
      startFrames = 4,
      frameMs = frameMsDefault,
      // 3s silence → endFrames ≈ 3000ms / frameMs
      endFrames = Math.max(1, Math.round(3000 / Math.max(1, frameMs))),
      maxUtteranceMs = 60000,
      onStartRecording,
      onStopRecording,
    } = this.opts;

    let speakingFrames = 0;
    let silenceFrames = 0;
    let recording = false;
    this._chunks = [];
    const startedAt = performance.now();

    const done = await new Promise<Blob | null>((resolve) => {
      const tick = () => {
        if (!this._running || !this._analyser) {
          resolve(null);
          return;
        }
        this._analyser.getByteTimeDomainData(this._timeData);
        const energy = this._rms(this._timeData);

        if (!recording) {
          speakingFrames = energy > rmsThreshold ? speakingFrames + 1 : 0;
          if (speakingFrames >= startFrames) {
            try { this._rec!.start(250); } catch {}
            recording = true;
            silenceFrames = 0;
            onStartRecording?.();
          }
        } else {
          silenceFrames = energy <= rmsThreshold ? silenceFrames + 1 : 0;
          if (silenceFrames >= endFrames) {
            try { this._rec!.requestData(); } catch {}
            try { this._rec!.stop(); } catch {}
            setTimeout(() => {
              const mime = (this._rec!.mimeType || "audio/webm").split(";")[0];
              const blob = this._chunks.length ? new Blob(this._chunks, { type: mime }) : null;
              onStopRecording?.();
              resolve(blob);
            }, 150);
            return;
          }
        }

        if (performance.now() - startedAt > maxUtteranceMs) {
          try { this._rec!.requestData(); } catch {}
          try { this._rec!.stop(); } catch {}
          setTimeout(() => {
            const mime = (this._rec!.mimeType || "audio/webm").split(";")[0];
            const blob = this._chunks.length ? new Blob(this._chunks, { type: mime }) : null;
            onStopRecording?.();
            resolve(blob);
          }, 150);
          return;
        }

        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    return done;
  }

  async stop(): Promise<void> {
    this._running = false;
    try { this._stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { await this._ac?.close(); } catch {}
    this._stream = null;
    this._analyser = null;
    this._rec = null;
  }
}
