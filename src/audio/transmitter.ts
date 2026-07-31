import {
  AUDIO_SAMPLE_RATE,
  FRAME_DURATION_SECONDS,
  modulateFrame,
} from './protocol'

export class UnsupportedUltrasonicAudioError extends Error {
  constructor(message = 'This audio output cannot use SonicDrop’s ultrasonic carrier.') {
    super(message)
    this.name = 'UnsupportedUltrasonicAudioError'
  }
}

export interface TransmitProgress {
  frameIndex: number
  frameCount: number
  progress: number
  elapsedSeconds: number
  remainingSeconds: number
}

interface TransmitOptions {
  signal?: AbortSignal
  onProgress?: (progress: TransmitProgress) => void
}

export function estimateTransferSeconds(frameCount: number): number {
  return frameCount * FRAME_DURATION_SECONDS
}

export class UltrasonicTransmitter {
  private context: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private stopped = false

  async send(frames: readonly Uint8Array[], options: TransmitOptions = {}): Promise<void> {
    if (frames.length === 0) {
      throw new Error('There is nothing to broadcast.')
    }

    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) {
      throw new UnsupportedUltrasonicAudioError('Web Audio is not available in this browser.')
    }

    this.stopped = false
    this.context = new AudioContextClass({
      latencyHint: 'playback',
      sampleRate: AUDIO_SAMPLE_RATE,
    })

    if (this.context.sampleRate !== AUDIO_SAMPLE_RATE) {
      const actualRate = this.context.sampleRate
      await this.context.close()
      this.context = null
      throw new UnsupportedUltrasonicAudioError(
        `SonicDrop needs a 48 kHz output. This device opened at ${actualRate.toLocaleString()} Hz.`,
      )
    }

    const abort = () => this.stop()
    options.signal?.addEventListener('abort', abort, { once: true })

    try {
      await this.context.resume()
      const startedAt = performance.now()

      for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        if (this.stopped || options.signal?.aborted) {
          throw new DOMException('Broadcast cancelled', 'AbortError')
        }

        await this.playFrame(frames[frameIndex], frameIndex, frames.length, startedAt, options)
      }

      const elapsedSeconds = (performance.now() - startedAt) / 1000
      options.onProgress?.({
        frameIndex: frames.length,
        frameCount: frames.length,
        progress: 1,
        elapsedSeconds,
        remainingSeconds: 0,
      })
    } finally {
      options.signal?.removeEventListener('abort', abort)
      this.source = null
      if (this.context && this.context.state !== 'closed') {
        await this.context.close()
      }
      this.context = null
    }
  }

  stop(): void {
    this.stopped = true
    if (this.source) {
      try {
        this.source.stop()
      } catch {
        // The source may already have reached its natural end.
      }
    }
  }

  private playFrame(
    frame: Uint8Array,
    frameIndex: number,
    frameCount: number,
    transferStartedAt: number,
    options: TransmitOptions,
  ): Promise<void> {
    const context = this.context
    if (!context) {
      return Promise.reject(new Error('Audio output is not open.'))
    }

    const samples = modulateFrame(frame)
    const buffer = context.createBuffer(1, samples.length, AUDIO_SAMPLE_RATE)
    buffer.copyToChannel(samples, 0)

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    this.source = source

    const frameStartedAt = context.currentTime

    return new Promise((resolve, reject) => {
      let animationFrame = 0

      const update = () => {
        if (this.stopped || options.signal?.aborted) {
          reject(new DOMException('Broadcast cancelled', 'AbortError'))
          return
        }

        const frameProgress = Math.min(1, (context.currentTime - frameStartedAt) / buffer.duration)
        const progress = (frameIndex + frameProgress) / frameCount
        const elapsedSeconds = (performance.now() - transferStartedAt) / 1000
        const totalSeconds = estimateTransferSeconds(frameCount)

        options.onProgress?.({
          frameIndex,
          frameCount,
          progress,
          elapsedSeconds,
          remainingSeconds: Math.max(0, totalSeconds * (1 - progress)),
        })

        if (frameProgress < 1) {
          animationFrame = requestAnimationFrame(update)
        }
      }

      source.onended = () => {
        cancelAnimationFrame(animationFrame)
        this.source = null
        if (this.stopped || options.signal?.aborted) {
          reject(new DOMException('Broadcast cancelled', 'AbortError'))
        } else {
          resolve()
        }
      }

      source.start()
      animationFrame = requestAnimationFrame(update)
    })
  }
}
