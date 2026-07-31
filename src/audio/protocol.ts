/**
 * SonicDrop's strict ultrasonic wire format.
 *
 * The physical layer is deliberately fixed at 48 kHz. There is no audible
 * compatibility mode: callers must reject audio contexts opened at any other
 * sample rate.
 */

export const AUDIO_SAMPLE_RATE = 48_000
export const TONE_FREQUENCIES = [20_800, 21_120, 21_440, 21_760] as const
export const SYMBOL_SAMPLES = 600
export const PEAK_AMPLITUDE = 0.12

export const FRAME_BYTES = 80
export const FRAME_PAYLOAD_BYTES = 63
export const MAX_PAYLOAD_BYTES = 4_096
export const MAX_MESSAGE_BYTES = 512
export const TRANSFER_FLAG_MESSAGE = 0x01
const LOGICAL_HASH_BYTES = 32
export const MAX_TRANSFER_FRAMES = frameCountForLogicalLength(
  4 + 1 + 0xff + 1 + 0xff + LOGICAL_HASH_BYTES + MAX_PAYLOAD_BYTES,
)

export const LEADER_SYMBOL_COUNT = 8
export const SYNC_SYMBOLS = [
  0, 3, 1, 2, 0, 2, 3, 1,
  3, 0, 2, 1, 0, 1, 3, 2,
  2, 0, 1, 3, 1, 2, 0, 3,
  3, 1, 0, 2, 1, 3, 2, 0,
] as const
export const BODY_SYMBOL_COUNT = FRAME_BYTES * 6
export const PREAMBLE_SYMBOL_COUNT = LEADER_SYMBOL_COUNT + SYNC_SYMBOLS.length
export const TRAILING_SILENCE_SAMPLES = Math.round(AUDIO_SAMPLE_RATE * 0.05)
export const FRAME_SIGNAL_SAMPLES =
  (PREAMBLE_SYMBOL_COUNT + BODY_SYMBOL_COUNT) * SYMBOL_SAMPLES
export const FRAME_SAMPLES = FRAME_SIGNAL_SAMPLES + TRAILING_SILENCE_SAMPLES
export const FRAME_DURATION_SECONDS = FRAME_SAMPLES / AUDIO_SAMPLE_RATE

const MAGIC_S = 0x53
const MAGIC_D = 0x44
const PROTOCOL_VERSION = 2
const CRC_OFFSET = 76
const HAMMING_BITS = 12
const FADE_SAMPLES = Math.round(AUDIO_SAMPLE_RATE * 0.01)
const ANALYSIS_GUARD_SAMPLES = 100
const ANALYSIS_SAMPLES = SYMBOL_SAMPLES - ANALYSIS_GUARD_SAMPLES * 2
const GRAY_DIBIT_TONE_MAP = [0, 1, 3, 2] as const
const ANALYSIS_WINDOW = Float64Array.from(
  { length: ANALYSIS_SAMPLES },
  (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (ANALYSIS_SAMPLES - 1)),
)
const GOERTZEL_COEFFICIENTS = new Map<number, number>()
const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export type ProtocolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_FRAME'
  | 'CRC_MISMATCH'
  | 'INCOMPLETE_TRANSFER'
  | 'HASH_MISMATCH'

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

export interface TransferInput {
  name: string
  mime: string
  data: Uint8Array
  flags?: number
}

export interface TransferEstimateInput {
  name: string
  mimeType: string
  size: number
}

export interface EncodedTransfer {
  /** Stable transfer identifier: the first 32 bits of the full transfer-envelope SHA-256. */
  id: number
  name: string
  mimeType: string
  bytes: number
  /** Validated 80-byte frames, ready for `modulateFrame`. */
  frames: Uint8Array[]
  /** Backwards-compatible descriptive aliases and verification metadata. */
  transferId: number
  flags: number
  mime: string
  size: number
  sha256: Uint8Array
}

export interface ParsedRawFrame {
  version: number
  flags: number
  transferId: number
  frameIndex: number
  frameCount: number
  payloadLength: number
  payload: Uint8Array
  crc32: number
  raw: Uint8Array
}

/** A raw frame after Hamming correction and CRC/header validation. */
export type DecodedFrame = ParsedRawFrame

export interface RawFrameFields {
  flags?: number
  transferId: number
  frameIndex: number
  frameCount: number
  payload: Uint8Array
}

export interface AssembledTransfer {
  transferId: number
  flags: number
  name: string
  mimeType: string
  mime: string
  size: number
  sha256: Uint8Array
  data: Uint8Array
}

export interface DecodedPcmFrame {
  frame: DecodedFrame
  /** Inclusive frame start in the supplied PCM buffer. */
  startSample: number
  /** Exclusive end, including the 50 ms trailing silence. */
  endSample: number
}

export interface HammingDecodeResult {
  byte: number
  corrected: boolean
  syndrome: number
  correctedWord: number
}

export interface DemodulatedFrame extends DecodedPcmFrame {
  rawFrame: Uint8Array
  /** Exclusive end of modulated signal, before trailing silence. */
  signalEndSample: number
  correctedCodewords: number
  frequencyOffsetHz: number
  confidence: number
}

/** Standard reflected IEEE CRC-32 (polynomial 0xEDB88320). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff

  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0)
    }
  }

  return (crc ^ 0xffff_ffff) >>> 0
}

/** Encode one byte as an even-parity Hamming(12,8) word. */
export function hammingEncodeByte(byte: number): number {
  assertIntegerInRange(byte, 0, 0xff, 'byte')
  const bits = new Uint8Array(HAMMING_BITS + 1)
  let sourceBit = 7

  for (let position = 1; position <= HAMMING_BITS; position += 1) {
    if (!isParityPosition(position)) {
      bits[position] = (byte >>> sourceBit) & 1
      sourceBit -= 1
    }
  }

  for (const parityPosition of [1, 2, 4, 8]) {
    let parity = 0
    for (let position = 1; position <= HAMMING_BITS; position += 1) {
      if ((position & parityPosition) !== 0) {
        parity ^= bits[position]
      }
    }
    bits[parityPosition] = parity
  }

  return packHammingBits(bits)
}

/** Decode and, when possible, correct one bad bit in a Hamming(12,8) word. */
export function hammingDecodeWord(word: number): HammingDecodeResult {
  assertIntegerInRange(word, 0, 0x0fff, 'Hamming word')
  const bits = unpackHammingBits(word)
  let syndrome = 0

  for (let position = 1; position <= HAMMING_BITS; position += 1) {
    if (bits[position] === 1) {
      syndrome ^= position
    }
  }

  if (syndrome > HAMMING_BITS) {
    throw new ProtocolError(
      'INVALID_FRAME',
      `Hamming syndrome ${syndrome} cannot identify a codeword bit.`,
    )
  }

  if (syndrome !== 0) {
    bits[syndrome] ^= 1
  }

  let byte = 0
  for (let position = 1; position <= HAMMING_BITS; position += 1) {
    if (!isParityPosition(position)) {
      byte = (byte << 1) | bits[position]
    }
  }

  return {
    byte,
    corrected: syndrome !== 0,
    syndrome,
    correctedWord: packHammingBits(bits),
  }
}

/** Build and CRC-seal one fixed-width 80-byte raw frame. */
export function createRawFrame(fields: RawFrameFields): Uint8Array {
  const flags = fields.flags ?? 0
  assertIntegerInRange(flags, 0, 0xff, 'flags')
  assertIntegerInRange(fields.transferId, 0, 0xffff_ffff, 'transferId')
  assertIntegerInRange(fields.frameIndex, 0, 0xffff, 'frameIndex')
  assertIntegerInRange(fields.frameCount, 1, MAX_TRANSFER_FRAMES, 'frameCount')

  if (fields.frameIndex >= fields.frameCount) {
    throw new ProtocolError('INVALID_ARGUMENT', 'frameIndex must be below frameCount.')
  }
  if (fields.payload.length > FRAME_PAYLOAD_BYTES) {
    throw new ProtocolError(
      'INVALID_ARGUMENT',
      `Frame payloads are limited to ${FRAME_PAYLOAD_BYTES} bytes.`,
    )
  }

  const raw = new Uint8Array(FRAME_BYTES)
  const view = new DataView(raw.buffer)
  raw[0] = MAGIC_S
  raw[1] = MAGIC_D
  raw[2] = PROTOCOL_VERSION
  raw[3] = flags
  view.setUint32(4, fields.transferId, false)
  view.setUint16(8, fields.frameIndex, false)
  view.setUint16(10, fields.frameCount, false)
  raw[12] = fields.payload.length
  raw.set(fields.payload, 13)
  view.setUint32(CRC_OFFSET, crc32(raw.subarray(0, CRC_OFFSET)), false)
  return raw
}

/** Parse a raw frame and reject bad length, header fields, padding, or CRC. */
export function parseRawFrame(rawFrame: Uint8Array): ParsedRawFrame {
  if (rawFrame.length !== FRAME_BYTES) {
    throw new ProtocolError(
      'INVALID_FRAME',
      `A raw frame must be exactly ${FRAME_BYTES} bytes.`,
    )
  }

  const raw = Uint8Array.from(rawFrame)
  const view = new DataView(raw.buffer)
  if (raw[0] !== MAGIC_S || raw[1] !== MAGIC_D) {
    throw new ProtocolError('INVALID_FRAME', 'Frame magic is not SD.')
  }
  if (raw[2] !== PROTOCOL_VERSION) {
    throw new ProtocolError('INVALID_FRAME', `Unsupported protocol version ${raw[2]}.`)
  }

  const payloadLength = raw[12]
  if (payloadLength > FRAME_PAYLOAD_BYTES) {
    throw new ProtocolError('INVALID_FRAME', 'Frame payload length exceeds 63 bytes.')
  }

  const frameIndex = view.getUint16(8, false)
  const frameCount = view.getUint16(10, false)
  if (frameCount === 0 || frameCount > MAX_TRANSFER_FRAMES || frameIndex >= frameCount) {
    throw new ProtocolError('INVALID_FRAME', 'Frame index/count fields are inconsistent.')
  }

  for (let index = 13 + payloadLength; index < CRC_OFFSET; index += 1) {
    if (raw[index] !== 0) {
      throw new ProtocolError('INVALID_FRAME', 'Frame payload padding must be zero.')
    }
  }

  const expectedCrc = view.getUint32(CRC_OFFSET, false)
  const actualCrc = crc32(raw.subarray(0, CRC_OFFSET))
  if (actualCrc !== expectedCrc) {
    throw new ProtocolError('CRC_MISMATCH', 'Frame CRC-32 check failed.')
  }

  return {
    version: raw[2],
    flags: raw[3],
    transferId: view.getUint32(4, false),
    frameIndex,
    frameCount,
    payloadLength,
    payload: raw.slice(13, 13 + payloadLength),
    crc32: expectedCrc,
    raw,
  }
}

/** Hash, frame, and CRC-seal a file for transmission. */
export async function buildEncodedTransfer(input: TransferInput): Promise<EncodedTransfer> {
  if (input.data.length > MAX_PAYLOAD_BYTES) {
    throw new ProtocolError(
      'INVALID_ARGUMENT',
      `Payloads are limited to ${MAX_PAYLOAD_BYTES.toLocaleString()} bytes.`,
    )
  }

  const { nameBytes, mimeBytes } = encodeTransferMetadata(input.name, input.mime)

  const flags = input.flags ?? 0
  assertIntegerInRange(flags, 0, 0xff, 'flags')
  const data = Uint8Array.from(input.data)
  assertMessageTransferContract(
    flags,
    nameBytes.length,
    mimeBytes.length,
    data.length,
    'INVALID_ARGUMENT',
  )
  const sha256 = await sha256Bytes(data)

  const logicalLength =
    4 + 1 + nameBytes.length + 1 + mimeBytes.length + LOGICAL_HASH_BYTES + data.length
  const logical = new Uint8Array(logicalLength)
  const logicalView = new DataView(logical.buffer)
  let offset = 0
  logicalView.setUint32(offset, data.length, false)
  offset += 4
  logical[offset] = nameBytes.length
  offset += 1
  logical.set(nameBytes, offset)
  offset += nameBytes.length
  logical[offset] = mimeBytes.length
  offset += 1
  logical.set(mimeBytes, offset)
  offset += mimeBytes.length
  logical.set(sha256, offset)
  offset += LOGICAL_HASH_BYTES
  logical.set(data, offset)

  const transferId = await transferIdForEnvelope(flags, logical)

  const frameCount = frameCountForLogicalLength(logical.length)
  const frames = Array.from({ length: frameCount }, (_, frameIndex) => {
    const payloadOffset = frameIndex * FRAME_PAYLOAD_BYTES
    return createRawFrame({
      flags,
      transferId,
      frameIndex,
      frameCount,
      payload: logical.slice(payloadOffset, payloadOffset + FRAME_PAYLOAD_BYTES),
    })
  })

  return {
    id: transferId,
    name: input.name,
    mimeType: input.mime,
    bytes: data.length,
    frames,
    transferId,
    flags,
    mime: input.mime,
    size: data.length,
    sha256,
  }
}

/** Positional convenience API used by the app. */
export function buildTransfer(
  name: string,
  mimeType: string,
  data: Uint8Array,
): Promise<EncodedTransfer> {
  return buildEncodedTransfer({ name, mime: mimeType, data })
}

/** Encode a compact UTF-8 message without filename or MIME metadata. */
export async function buildMessageTransfer(message: string): Promise<EncodedTransfer> {
  const data = UTF8_ENCODER.encode(message)
  if (data.length === 0) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Messages must contain at least one UTF-8 byte.')
  }
  if (data.length > MAX_MESSAGE_BYTES) {
    throw new ProtocolError(
      'INVALID_ARGUMENT',
      `Messages are limited to ${MAX_MESSAGE_BYTES.toLocaleString()} UTF-8 bytes.`,
    )
  }
  return buildEncodedTransfer({
    name: '',
    mime: '',
    data,
    flags: TRANSFER_FLAG_MESSAGE,
  })
}

/** Estimate the exact fixed-width frame count without reading the file bytes. */
export function estimateFrameCount({
  name,
  mimeType,
  size,
}: TransferEstimateInput): number {
  assertIntegerInRange(size, 0, MAX_PAYLOAD_BYTES, 'payload size')
  const { nameBytes, mimeBytes } = encodeTransferMetadata(name, mimeType)
  return frameCountForLogicalLength(
    4 + 1 + nameBytes.length + 1 + mimeBytes.length + LOGICAL_HASH_BYTES + size,
  )
}

/** Reassemble unordered/duplicate frames, then validate metadata and SHA-256. */
export async function assembleTransfer(
  rawFrames: readonly (Uint8Array | DecodedFrame)[],
): Promise<AssembledTransfer> {
  if (rawFrames.length === 0) {
    throw new ProtocolError('INCOMPLETE_TRANSFER', 'No frames were supplied.')
  }

  const framesByIndex = new Map<number, ParsedRawFrame>()
  let transferId: number | undefined
  let frameCount: number | undefined
  let flags: number | undefined

  for (const rawFrame of rawFrames) {
    const frame = parseRawFrame(rawFrame instanceof Uint8Array ? rawFrame : rawFrame.raw)
    transferId ??= frame.transferId
    frameCount ??= frame.frameCount
    flags ??= frame.flags

    if (
      frame.transferId !== transferId
      || frame.frameCount !== frameCount
      || frame.flags !== flags
    ) {
      throw new ProtocolError('INVALID_FRAME', 'Frames belong to different transfers.')
    }

    const existing = framesByIndex.get(frame.frameIndex)
    if (existing && !bytesEqual(existing.raw, frame.raw)) {
      throw new ProtocolError('INVALID_FRAME', `Frame ${frame.frameIndex} conflicts with a duplicate.`)
    }
    framesByIndex.set(frame.frameIndex, frame)
  }

  if (frameCount === undefined || transferId === undefined || flags === undefined) {
    throw new ProtocolError('INCOMPLETE_TRANSFER', 'Transfer header is missing.')
  }
  if (framesByIndex.size !== frameCount) {
    throw new ProtocolError(
      'INCOMPLETE_TRANSFER',
      `Received ${framesByIndex.size} of ${frameCount} frames.`,
    )
  }

  const orderedFrames: ParsedRawFrame[] = []
  for (let index = 0; index < frameCount; index += 1) {
    const frame = framesByIndex.get(index)
    if (!frame) {
      throw new ProtocolError('INCOMPLETE_TRANSFER', `Frame ${index} is missing.`)
    }
    orderedFrames.push(frame)
  }

  const logical = concatBytes(orderedFrames.map((frame) => frame.payload))
  if (logical.length < 4 + 1 + 1 + LOGICAL_HASH_BYTES) {
    throw new ProtocolError('INVALID_FRAME', 'Logical transfer header is truncated.')
  }

  const logicalView = new DataView(logical.buffer, logical.byteOffset, logical.byteLength)
  const size = logicalView.getUint32(0, false)
  if (size > MAX_PAYLOAD_BYTES) {
    throw new ProtocolError('INVALID_FRAME', 'Declared payload size exceeds the protocol limit.')
  }

  let offset = 4
  const nameLength = logical[offset]
  offset += 1
  ensureLogicalBytes(logical, offset, nameLength + 1 + LOGICAL_HASH_BYTES)
  const name = decodeUtf8(logical.slice(offset, offset + nameLength), 'filename')
  offset += nameLength

  const mimeLength = logical[offset]
  offset += 1
  ensureLogicalBytes(logical, offset, mimeLength + LOGICAL_HASH_BYTES + size)
  const mime = decodeUtf8(logical.slice(offset, offset + mimeLength), 'MIME type')
  offset += mimeLength

  const expectedHash = logical.slice(offset, offset + LOGICAL_HASH_BYTES)
  offset += LOGICAL_HASH_BYTES
  if (logical.length !== offset + size) {
    throw new ProtocolError('INVALID_FRAME', 'Logical transfer length does not match payload size.')
  }
  assertMessageTransferContract(
    flags,
    nameLength,
    mimeLength,
    size,
    'INVALID_FRAME',
  )
  const data = logical.slice(offset)
  const actualHash = await sha256Bytes(data)
  if (!bytesEqual(actualHash, expectedHash)) {
    throw new ProtocolError('HASH_MISMATCH', 'Payload SHA-256 check failed.')
  }

  const expectedTransferId = await transferIdForEnvelope(flags, logical)
  if (transferId !== expectedTransferId) {
    throw new ProtocolError('HASH_MISMATCH', 'Transfer ID does not match the transfer envelope.')
  }

  return {
    transferId,
    flags,
    name,
    mimeType: mime,
    mime,
    size,
    sha256: actualHash,
    data,
  }
}

/** App-facing PCM decoder with only the frame and consumed sample range. */
export function decodeFrameFromPcm(pcm: Float32Array): DecodedPcmFrame | null {
  const decoded = findAndDemodulateFrame(pcm)
  if (!decoded) {
    return null
  }
  return {
    frame: decoded.frame,
    startSample: decoded.startSample,
    endSample: decoded.endSample,
  }
}

/** Convert a validated frame into its 480 Gray-mapped 4-CPFSK body symbols. */
export function encodeFrameBodySymbols(rawFrame: Uint8Array): Uint8Array {
  parseRawFrame(rawFrame)
  const symbols = new Uint8Array(BODY_SYMBOL_COUNT)
  let symbolOffset = 0

  for (const byte of rawFrame) {
    const word = hammingEncodeByte(byte)
    for (let shift = 10; shift >= 0; shift -= 2) {
      symbols[symbolOffset] = GRAY_DIBIT_TONE_MAP[(word >>> shift) & 0b11]
      symbolOffset += 1
    }
  }

  return symbols
}

/** Decode 480 tone indices through Gray mapping and Hamming(12,8). */
export function decodeFrameBodySymbols(symbols: Uint8Array): {
  rawFrame: Uint8Array
  correctedCodewords: number
} {
  if (symbols.length !== BODY_SYMBOL_COUNT) {
    throw new ProtocolError(
      'INVALID_FRAME',
      `A frame body must contain ${BODY_SYMBOL_COUNT} tone symbols.`,
    )
  }

  const rawFrame = new Uint8Array(FRAME_BYTES)
  let symbolOffset = 0
  let correctedCodewords = 0

  for (let byteIndex = 0; byteIndex < FRAME_BYTES; byteIndex += 1) {
    let word = 0
    for (let dibitIndex = 0; dibitIndex < 6; dibitIndex += 1) {
      const tone = symbols[symbolOffset]
      if (tone > 3) {
        throw new ProtocolError('INVALID_FRAME', `Invalid tone index ${tone}.`)
      }
      word = (word << 2) | GRAY_DIBIT_TONE_MAP[tone]
      symbolOffset += 1
    }
    const decoded = hammingDecodeWord(word)
    rawFrame[byteIndex] = decoded.byte
    correctedCodewords += decoded.corrected ? 1 : 0
  }

  return { rawFrame, correctedCodewords }
}

/** Render one CRC-valid raw frame as strict 48 kHz ultrasonic PCM. */
export function modulateFrame(rawFrame: Uint8Array): Float32Array<ArrayBuffer> {
  const body = encodeFrameBodySymbols(rawFrame)
  const symbols = new Uint8Array(PREAMBLE_SYMBOL_COUNT + BODY_SYMBOL_COUNT)
  symbols.fill(0, 0, LEADER_SYMBOL_COUNT)
  symbols.set(SYNC_SYMBOLS, LEADER_SYMBOL_COUNT)
  symbols.set(body, PREAMBLE_SYMBOL_COUNT)
  return renderSymbols(symbols, true)
}

/**
 * Find and decode the first complete CRC-valid frame in a PCM buffer.
 * Returns null for silence, a partial frame, or candidates that fail Hamming/CRC.
 */
export function findAndDemodulateFrame(pcm: Float32Array): DemodulatedFrame | null {
  if (pcm.length < FRAME_SAMPLES) {
    return null
  }

  const lastStart = pcm.length - FRAME_SAMPLES
  const candidateHop = 150
  const candidateStarts: number[] = []
  for (let candidate = 0; candidate <= lastStart; candidate += candidateHop) {
    candidateStarts.push(candidate)
  }
  if (candidateStarts.at(-1) !== lastStart) {
    candidateStarts.push(lastStart)
  }

  // Scan each possible frame-start region once. Searching around every sample
  // of a long tone-0 leader creates heavily overlapping work and lets a steady
  // ultrasonic interferer monopolize the decoder.
  for (const estimatedStart of candidateStarts) {
    const energies = measureToneEnergies(pcm, estimatedStart + ANALYSIS_GUARD_SAMPLES, 0)
    const totalEnergy = sumEnergies(energies)
    if (totalEnergy <= 1e-12 || energies[0] / totalEnergy < 0.68) {
      continue
    }
    if (preambleScore(pcm, estimatedStart, 0) < 0.62) {
      continue
    }

    const searchStart = Math.max(0, estimatedStart - candidateHop)
    const searchEnd = Math.min(lastStart, estimatedStart + candidateHop)
    const coarse = findBestSyncStart(pcm, searchStart, searchEnd)
    if (!coarse || coarse.score < 0.62) {
      continue
    }

    const alignedStart = refineExactWaveformAlignment(pcm, coarse.startSample)
    const frequencyEstimate = estimateFrequencyOffset(pcm, alignedStart)
    if (frequencyEstimate.score < 0.62) {
      continue
    }

    const bodyStart = alignedStart + PREAMBLE_SYMBOL_COUNT * SYMBOL_SAMPLES
    const symbols = new Uint8Array(BODY_SYMBOL_COUNT)
    let confidenceTotal = 0

    for (let symbolIndex = 0; symbolIndex < BODY_SYMBOL_COUNT; symbolIndex += 1) {
      const start = bodyStart + symbolIndex * SYMBOL_SAMPLES + ANALYSIS_GUARD_SAMPLES
      const bodyEnergies = measureToneEnergies(pcm, start, frequencyEstimate.offsetHz)
      const decision = strongestTone(bodyEnergies)
      symbols[symbolIndex] = decision.tone
      confidenceTotal += decision.confidence
    }

    try {
      const decoded = decodeFrameBodySymbols(symbols)
      const frame = parseRawFrame(decoded.rawFrame)
      return {
        rawFrame: decoded.rawFrame,
        frame,
        startSample: alignedStart,
        endSample: alignedStart + FRAME_SAMPLES,
        signalEndSample: alignedStart + FRAME_SIGNAL_SAMPLES,
        correctedCodewords: decoded.correctedCodewords,
        frequencyOffsetHz: frequencyEstimate.offsetHz,
        confidence: confidenceTotal / BODY_SYMBOL_COUNT,
      }
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        throw error
      }
    }
  }

  return null
}

function isParityPosition(position: number): boolean {
  return position === 1 || position === 2 || position === 4 || position === 8
}

function packHammingBits(bits: Uint8Array): number {
  let word = 0
  for (let position = 1; position <= HAMMING_BITS; position += 1) {
    word = (word << 1) | bits[position]
  }
  return word
}

function unpackHammingBits(word: number): Uint8Array {
  const bits = new Uint8Array(HAMMING_BITS + 1)
  for (let position = 1; position <= HAMMING_BITS; position += 1) {
    bits[position] = (word >>> (HAMMING_BITS - position)) & 1
  }
  return bits
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError(
      'INVALID_ARGUMENT',
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    )
  }
}

function frameCountForLogicalLength(logicalLength: number): number {
  return Math.max(1, Math.ceil(logicalLength / FRAME_PAYLOAD_BYTES))
}

function encodeTransferMetadata(
  name: string,
  mimeType: string,
): { nameBytes: Uint8Array; mimeBytes: Uint8Array } {
  const nameBytes = UTF8_ENCODER.encode(name)
  const mimeBytes = UTF8_ENCODER.encode(mimeType)
  if (nameBytes.length > 0xff || mimeBytes.length > 0xff) {
    throw new ProtocolError(
      'INVALID_ARGUMENT',
      'UTF-8 filename and MIME type must each fit in 255 bytes.',
    )
  }
  return { nameBytes, mimeBytes }
}

function assertMessageTransferContract(
  flags: number,
  nameLength: number,
  mimeLength: number,
  size: number,
  errorCode: 'INVALID_ARGUMENT' | 'INVALID_FRAME',
): void {
  if ((flags & TRANSFER_FLAG_MESSAGE) === 0) return
  if (size < 1 || size > MAX_MESSAGE_BYTES || nameLength !== 0 || mimeLength !== 0) {
    throw new ProtocolError(
      errorCode,
      `Message transfers require 1–${MAX_MESSAGE_BYTES} UTF-8 bytes and no file metadata.`,
    )
  }
}

async function transferIdForEnvelope(flags: number, logical: Uint8Array): Promise<number> {
  const identity = new Uint8Array(1 + logical.length)
  identity[0] = flags
  identity.set(logical, 1)
  return transferIdFromHash(await sha256Bytes(identity))
}

function transferIdFromHash(hash: Uint8Array): number {
  return new DataView(hash.buffer, hash.byteOffset, hash.byteLength).getUint32(0, false)
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stableCopy = Uint8Array.from(bytes)
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', stableCopy.buffer))
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const combined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

function ensureLogicalBytes(bytes: Uint8Array, offset: number, needed: number): void {
  if (offset + needed > bytes.length) {
    throw new ProtocolError('INVALID_FRAME', 'Logical transfer metadata is truncated.')
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new ProtocolError('INVALID_FRAME', `Transfer ${label} is not valid UTF-8.`)
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

function renderSymbols(
  symbols: Uint8Array,
  includeTrailingSilence: boolean,
): Float32Array<ArrayBuffer> {
  const signalSamples = symbols.length * SYMBOL_SAMPLES
  const trailingSamples = includeTrailingSilence ? TRAILING_SILENCE_SAMPLES : 0
  const pcm = new Float32Array(signalSamples + trailingSamples)
  let phase = 0
  let outputIndex = 0

  for (const tone of symbols) {
    if (tone > 3) {
      throw new ProtocolError('INVALID_ARGUMENT', `Invalid tone index ${tone}.`)
    }
    const phaseStep = 2 * Math.PI * TONE_FREQUENCIES[tone] / AUDIO_SAMPLE_RATE
    for (let sample = 0; sample < SYMBOL_SAMPLES; sample += 1) {
      let envelope = 1
      if (outputIndex < FADE_SAMPLES) {
        envelope *= 0.5 - 0.5 * Math.cos(Math.PI * outputIndex / FADE_SAMPLES)
      }
      const remaining = signalSamples - 1 - outputIndex
      if (includeTrailingSilence && remaining < FADE_SAMPLES) {
        envelope *= 0.5 - 0.5 * Math.cos(Math.PI * remaining / FADE_SAMPLES)
      }

      pcm[outputIndex] = PEAK_AMPLITUDE * envelope * Math.sin(phase)
      phase += phaseStep
      if (phase >= 2 * Math.PI) {
        phase %= 2 * Math.PI
      }
      outputIndex += 1
    }
  }

  return pcm
}

function measureToneEnergies(
  pcm: Float32Array,
  startSample: number,
  frequencyOffsetHz: number,
): [number, number, number, number] {
  return TONE_FREQUENCIES.map((frequency) => goertzelPower(
    pcm,
    startSample,
    frequency + frequencyOffsetHz,
  )) as [number, number, number, number]
}

function goertzelPower(
  pcm: Float32Array,
  startSample: number,
  frequency: number,
): number {
  let coefficient = GOERTZEL_COEFFICIENTS.get(frequency)
  if (coefficient === undefined) {
    coefficient = 2 * Math.cos(2 * Math.PI * frequency / AUDIO_SAMPLE_RATE)
    GOERTZEL_COEFFICIENTS.set(frequency, coefficient)
  }
  let previous = 0
  let previousPrevious = 0

  for (let index = 0; index < ANALYSIS_SAMPLES; index += 1) {
    const current =
      pcm[startSample + index] * ANALYSIS_WINDOW[index]
      + coefficient * previous
      - previousPrevious
    previousPrevious = previous
    previous = current
  }

  return Math.max(
    0,
    previous * previous
      + previousPrevious * previousPrevious
      - coefficient * previous * previousPrevious,
  )
}

function sumEnergies(energies: readonly number[]): number {
  return energies[0] + energies[1] + energies[2] + energies[3]
}

function preambleScore(pcm: Float32Array, startSample: number, frequencyOffsetHz: number): number {
  let score = 0

  for (let index = 0; index < SYNC_SYMBOLS.length; index += 1) {
    const symbolStart =
      startSample
      + (LEADER_SYMBOL_COUNT + index) * SYMBOL_SAMPLES
      + ANALYSIS_GUARD_SAMPLES
    const energies = measureToneEnergies(pcm, symbolStart, frequencyOffsetHz)
    const total = sumEnergies(energies)
    if (total <= 1e-12) {
      return 0
    }
    score += energies[SYNC_SYMBOLS[index]] / total
  }

  return score / SYNC_SYMBOLS.length
}

function findBestSyncStart(
  pcm: Float32Array,
  searchStart: number,
  searchEnd: number,
): { startSample: number; score: number } | null {
  let bestStart = searchStart
  let bestScore = 0

  for (let candidate = searchStart; candidate <= searchEnd; candidate += 25) {
    const score = preambleScore(pcm, candidate, 0)
    if (score > bestScore) {
      bestStart = candidate
      bestScore = score
    }
  }

  if (bestScore === 0) {
    return null
  }

  const refineStart = Math.max(searchStart, bestStart - 30)
  const refineEnd = Math.min(searchEnd, bestStart + 30)
  for (let candidate = refineStart; candidate <= refineEnd; candidate += 1) {
    const score = preambleScore(pcm, candidate, 0)
    if (score > bestScore) {
      bestStart = candidate
      bestScore = score
    }
  }

  return { startSample: bestStart, score: bestScore }
}

let cachedPreambleTemplate: Float32Array<ArrayBuffer> | undefined
let cachedPreambleTemplatePower: number | undefined

function preambleTemplate(): Float32Array<ArrayBuffer> {
  if (!cachedPreambleTemplate) {
    const symbols = new Uint8Array(PREAMBLE_SYMBOL_COUNT)
    symbols.set(SYNC_SYMBOLS, LEADER_SYMBOL_COUNT)
    cachedPreambleTemplate = renderSymbols(symbols, false)
  }
  return cachedPreambleTemplate
}

function refineExactWaveformAlignment(pcm: Float32Array, estimatedStart: number): number {
  // Preserve sample-exact consumed ranges for buffers produced directly by
  // `modulateFrame`. Acoustic/noisy captures fall through to correlation.
  const exactBoundary = findExactSilentBoundary(pcm, estimatedStart)
  if (exactBoundary !== null) {
    return exactBoundary
  }

  const template = preambleTemplate()
  if (cachedPreambleTemplatePower === undefined) {
    cachedPreambleTemplatePower = 0
    for (const sample of template) {
      cachedPreambleTemplatePower += sample * sample
    }
  }

  let bestStart = estimatedStart
  let bestCorrelation = 0
  const firstCandidate = Math.max(0, estimatedStart - 125)
  const lastCandidate = Math.min(
    pcm.length - FRAME_SAMPLES,
    estimatedStart + 125,
  )

  for (let candidate = firstCandidate; candidate <= lastCandidate; candidate += 1) {
    let dot = 0
    let inputPower = 0
    for (let index = 0; index < template.length; index += 1) {
      const input = pcm[candidate + index]
      dot += input * template[index]
      inputPower += input * input
    }
    const correlation =
      Math.abs(dot)
      / Math.sqrt(cachedPreambleTemplatePower * inputPower + Number.EPSILON)
    if (correlation > bestCorrelation) {
      bestStart = candidate
      bestCorrelation = correlation
    }
  }

  return bestCorrelation >= 0.55 ? bestStart : estimatedStart
}

function findExactSilentBoundary(pcm: Float32Array, estimatedStart: number): number | null {
  const firstCandidate = Math.max(0, estimatedStart - 150)
  const lastCandidate = Math.min(pcm.length - 2, estimatedStart + 150)

  for (let candidate = firstCandidate; candidate <= lastCandidate; candidate += 1) {
    if (pcm[candidate] !== 0 || pcm[candidate + 1] === 0) {
      continue
    }

    let precededBySilence = true
    const silenceStart = Math.max(0, candidate - 32)
    for (let index = silenceStart; index < candidate; index += 1) {
      if (pcm[index] !== 0) {
        precededBySilence = false
        break
      }
    }
    if (precededBySilence) {
      return candidate
    }
  }

  return null
}

function estimateFrequencyOffset(
  pcm: Float32Array,
  startSample: number,
): { offsetHz: number; score: number } {
  let bestOffset = 0
  let bestScore = 0

  for (let offset = -100; offset <= 100; offset += 10) {
    const score = preambleScore(pcm, startSample, offset)
    if (score > bestScore) {
      bestOffset = offset
      bestScore = score
    }
  }

  return { offsetHz: bestOffset, score: bestScore }
}

function strongestTone(energies: [number, number, number, number]): {
  tone: number
  confidence: number
} {
  let bestTone = 0
  let best = energies[0]
  let secondBest = 0

  for (let tone = 1; tone < energies.length; tone += 1) {
    const energy = energies[tone]
    if (energy > best) {
      secondBest = best
      best = energy
      bestTone = tone
    } else if (energy > secondBest) {
      secondBest = energy
    }
  }

  return {
    tone: bestTone,
    confidence: best <= Number.EPSILON ? 0 : (best - secondBest) / best,
  }
}
