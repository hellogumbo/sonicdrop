import { decodeFrameFromPcm, type DecodedPcmFrame } from './protocol'

export interface DecoderWorkerResponse {
  decoded: DecodedPcmFrame | null
  error: string | null
}

interface DecoderWorkerScope {
  onmessage: ((event: MessageEvent<Float32Array>) => void) | null
  postMessage(message: DecoderWorkerResponse): void
}

const workerScope = self as unknown as DecoderWorkerScope

workerScope.onmessage = ({ data }) => {
  try {
    workerScope.postMessage({ decoded: decodeFrameFromPcm(data), error: null })
  } catch (error) {
    workerScope.postMessage({
      decoded: null,
      error: error instanceof Error ? error.message : 'The acoustic decoder stopped unexpectedly.',
    })
  }
}
