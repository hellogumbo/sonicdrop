import {
  AUDIO_SAMPLE_RATE,
  FRAME_SAMPLES,
  assembleTransfer,
  type AssembledTransfer,
  type DecodedFrame,
  type DecodedPcmFrame,
} from './protocol'
import type { DecoderWorkerResponse } from './decoder.worker'

const CAPTURE_CHUNK_SAMPLES = 2048
const ROLLING_BUFFER_SECONDS = 9
const DECODE_INTERVAL_MS = 320

const CAPTURE_WORKLET_SOURCE = `
class SonicDropCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${CAPTURE_CHUNK_SAMPLES});
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const writable = Math.min(this.buffer.length - this.offset, channel.length - sourceOffset);
      this.buffer.set(channel.subarray(sourceOffset, sourceOffset + writable), this.offset);
      this.offset += writable;
      sourceOffset += writable;

      if (this.offset === this.buffer.length) {
        let sum = 0;
        for (let index = 0; index < this.buffer.length; index += 1) {
          sum += this.buffer[index] * this.buffer[index];
        }
        const rms = Math.sqrt(sum / this.buffer.length);
        const samples = this.buffer;
        this.port.postMessage({ samples, rms }, [samples.buffer]);
        this.buffer = new Float32Array(${CAPTURE_CHUNK_SAMPLES});
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('sonicdrop-capture', SonicDropCaptureProcessor);
`

export class UnsupportedUltrasonicInputError extends Error {
  constructor(message = 'This audio input cannot use SonicDrop’s ultrasonic carrier.') {
    super(message)
    this.name = 'UnsupportedUltrasonicInputError'
  }
}

export interface ReceiverProgress {
  state: 'listening' | 'receiving'
  signalLevel: number
  receivedFrames: number
  totalFrames: number | null
  progress: number
  frameLabel: string | null
}

export type ReceivedTransfer = Pick<AssembledTransfer, 'flags' | 'name' | 'mimeType' | 'data'>

interface ReceiverOptions {
  onProgress?: (progress: ReceiverProgress) => void
  onComplete?: (transfer: ReceivedTransfer) => void
  onError?: (error: Error) => void
  onFatalError?: (error: Error) => void
}

interface CaptureMessage {
  samples: Float32Array
  rms: number
}

export class UltrasonicReceiver {
  private readonly options: ReceiverOptions
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private decoder: Worker | null = null
  private silentOutput: GainNode | null = null
  private captureBuffer = new Float32Array(AUDIO_SAMPLE_RATE * ROLLING_BUFFER_SECONDS)
  private captureLength = 0
  private lastDecodeAt = 0
  private decodePending = false
  private decodeTimer: number | null = null
  private decodeSnapshotLength = 0
  private decodePrefixDiscarded = 0
  private activeTransferId: number | null = null
  private activeFlags: number | null = null
  private totalFrames: number | null = null
  private frames = new Map<number, DecodedFrame>()
  private signalLevel = 0
  private lastPublishedProgressKey = ''
  private stopped = true

  constructor(options: ReceiverOptions = {}) {
    this.options = options
  }

  async start(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new UnsupportedUltrasonicInputError(
        'Microphone listening needs HTTPS or a localhost address in a supported browser.',
      )
    }

    if (typeof AudioWorkletNode === 'undefined') {
      throw new UnsupportedUltrasonicInputError('AudioWorklet capture is not available in this browser.')
    }

    this.stopped = false
    try {
      this.decoder = new Worker(new URL('./decoder.worker.ts', import.meta.url), {
        type: 'module',
        name: 'sonicdrop-decoder',
      })
      this.decoder.onmessage = (event: MessageEvent<DecoderWorkerResponse>) => {
        void this.handleDecodeResult(event.data)
      }
      this.decoder.onerror = () => {
        if (this.stopped) return
        this.options.onFatalError?.(new Error('The acoustic decoder could not continue.'))
        void this.stop()
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: AUDIO_SAMPLE_RATE },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })

      if (this.stopped) {
        throw new DOMException('Listening cancelled', 'AbortError')
      }

      const track = this.stream.getAudioTracks()[0]
      const label = track?.label.toLowerCase() ?? ''
      if (/airpods|bluetooth|headset|hands-free/.test(label)) {
        throw new UnsupportedUltrasonicInputError(
          'Bluetooth and headset microphones usually remove this frequency band. Use the built-in microphone.',
        )
      }
      const captureRate = track?.getSettings().sampleRate
      if (captureRate !== undefined && captureRate !== AUDIO_SAMPLE_RATE) {
        throw new UnsupportedUltrasonicInputError(
          `SonicDrop needs a native 48 kHz microphone path. This input reports ${captureRate.toLocaleString()} Hz.`,
        )
      }

      this.context = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: AUDIO_SAMPLE_RATE,
      })

      if (this.context.sampleRate !== AUDIO_SAMPLE_RATE) {
        throw new UnsupportedUltrasonicInputError(
          `SonicDrop needs a 48 kHz microphone path. This device opened at ${this.context.sampleRate.toLocaleString()} Hz.`,
        )
      }

      const workletBlob = new Blob([CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' })
      const workletUrl = URL.createObjectURL(workletBlob)
      try {
        await this.context.audioWorklet.addModule(workletUrl)
      } finally {
        URL.revokeObjectURL(workletUrl)
      }

      this.source = this.context.createMediaStreamSource(this.stream)
      this.worklet = new AudioWorkletNode(this.context, 'sonicdrop-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      this.silentOutput = this.context.createGain()
      this.silentOutput.gain.value = 0

      this.worklet.port.onmessage = (event: MessageEvent<CaptureMessage>) => {
        this.handleCapture(event.data)
      }

      this.source.connect(this.worklet)
      this.worklet.connect(this.silentOutput)
      this.silentOutput.connect(this.context.destination)
      await this.context.resume()
      this.publishProgress()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.decodeTimer !== null) {
      window.clearTimeout(this.decodeTimer)
      this.decodeTimer = null
    }
    this.decodePending = false
    this.decodeSnapshotLength = 0
    this.decodePrefixDiscarded = 0
    this.decoder?.terminate()
    this.decoder = null
    this.worklet?.disconnect()
    this.source?.disconnect()
    this.silentOutput?.disconnect()
    this.worklet = null
    this.source = null
    this.silentOutput = null
    this.stopTracks()

    if (this.context && this.context.state !== 'closed') {
      await this.context.close()
    }
    this.context = null
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }

  private handleCapture({ samples, rms }: CaptureMessage): void {
    if (this.stopped) return

    this.signalLevel = Math.min(1, rms * 20)
    this.appendSamples(samples)

    const now = performance.now()
    if (
      !this.decodePending &&
      now - this.lastDecodeAt >= DECODE_INTERVAL_MS &&
      this.captureLength >= FRAME_SAMPLES
    ) {
      this.lastDecodeAt = now
      this.decodePending = true
      this.decodeTimer = window.setTimeout(() => {
        this.decodeTimer = null
        this.tryDecode()
      }, 0)
    } else {
      this.publishProgress()
    }
  }

  private appendSamples(samples: Float32Array): void {
    const overflow = this.captureLength + samples.length - this.captureBuffer.length
    if (overflow > 0) {
      this.consumeSamples(overflow)
      if (this.decodeSnapshotLength > 0) {
        this.decodePrefixDiscarded += overflow
      }
    }

    this.captureBuffer.set(samples, this.captureLength)
    this.captureLength += samples.length
  }

  private tryDecode(): void {
    if (this.stopped) {
      this.decodePending = false
      return
    }

    const decoder = this.decoder
    if (!decoder) {
      this.decodePending = false
      this.options.onError?.(new Error('The acoustic decoder is not available.'))
      return
    }

    try {
      this.decodeSnapshotLength = this.captureLength
      this.decodePrefixDiscarded = 0
      const capture = this.captureBuffer.slice(0, this.decodeSnapshotLength)
      decoder.postMessage(capture, [capture.buffer])
    } catch (error) {
      this.decodePending = false
      this.decodeSnapshotLength = 0
      this.decodePrefixDiscarded = 0
      const receiverError = error instanceof Error ? error : new Error('The acoustic decoder could not start.')
      this.options.onError?.(receiverError)
    }
  }

  private async handleDecodeResult({ decoded, error }: DecoderWorkerResponse): Promise<void> {
    if (this.stopped) {
      this.decodePending = false
      return
    }

    let consumedDecodedFrame = false
    try {
      if (error) {
        throw new Error(error)
      }
      if (!decoded) {
        const discardableSamples =
          this.decodeSnapshotLength
          - (FRAME_SAMPLES - 1)
          - this.decodePrefixDiscarded
        if (discardableSamples > 0) this.consumeSamples(discardableSamples)
        this.publishProgress()
        return
      }

      this.consumeSamples(decoded.endSample - this.decodePrefixDiscarded)
      consumedDecodedFrame = true
      await this.acceptFrame(decoded)
    } catch (caught) {
      if (this.stopped) return
      const receiverError = caught instanceof Error ? caught : new Error('The acoustic frame was not valid.')
      this.options.onError?.(receiverError)
      if (!consumedDecodedFrame) {
        const discardableSnapshotSamples = Math.min(
          this.decodeSnapshotLength,
          Math.round(AUDIO_SAMPLE_RATE * 0.5),
        ) - this.decodePrefixDiscarded
        if (discardableSnapshotSamples > 0) this.consumeSamples(discardableSnapshotSamples)
      }
    } finally {
      this.decodePending = false
      this.decodeSnapshotLength = 0
      this.decodePrefixDiscarded = 0
    }
  }

  private async acceptFrame(decoded: DecodedPcmFrame): Promise<void> {
    const frame = decoded.frame

    const transferChanged =
      this.activeTransferId !== null
      && (
        frame.transferId !== this.activeTransferId
        || frame.frameCount !== this.totalFrames
        || frame.flags !== this.activeFlags
      )
    if (transferChanged) {
      this.frames.clear()
    }

    this.activeTransferId = frame.transferId
    this.activeFlags = frame.flags
    this.totalFrames = frame.frameCount
    const existingFrame = this.frames.get(frame.frameIndex)
    if (
      existingFrame
      && existingFrame.raw.every((byte, index) => byte === frame.raw[index])
    ) {
      return
    }
    this.frames.set(frame.frameIndex, frame)
    this.publishProgress()

    if (this.frames.size === frame.frameCount) {
      const transfer = await assembleTransfer([...this.frames.values()])
      if (this.stopped) return
      this.options.onComplete?.(transfer)
      await this.stop()
    }
  }

  private consumeSamples(count: number): void {
    const consumed = Math.min(this.captureLength, Math.max(0, Math.round(count)))
    this.captureBuffer.copyWithin(0, consumed, this.captureLength)
    this.captureLength -= consumed
  }

  private publishProgress(): void {
    const totalFrames = this.totalFrames
    const receivedFrames = this.frames.size
    const state = receivedFrames > 0 ? 'receiving' : 'listening'
    const signalStep = Math.round(this.signalLevel * 20)
    const progressKey = `${state}:${receivedFrames}:${totalFrames ?? '-'}:${signalStep}`
    if (progressKey === this.lastPublishedProgressKey) return
    this.lastPublishedProgressKey = progressKey

    this.options.onProgress?.({
      state,
      signalLevel: signalStep / 20,
      receivedFrames,
      totalFrames,
      progress: totalFrames ? receivedFrames / totalFrames : 0,
      frameLabel: totalFrames ? `${receivedFrames} / ${totalFrames} frames` : null,
    })
  }
}
