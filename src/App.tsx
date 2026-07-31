import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { FrequencyRunway, type RunwayState } from './components/FrequencyRunway'
import {
  MAX_MESSAGE_BYTES,
  MAX_PAYLOAD_BYTES,
  TRANSFER_FLAG_MESSAGE,
  buildMessageTransfer,
  buildTransfer,
  estimateFrameCount,
  type TransferEstimateInput,
} from './audio/protocol'
import {
  UltrasonicReceiver,
  type ReceivedTransfer,
  type ReceiverProgress,
} from './audio/receiver'
import {
  UltrasonicTransmitter,
  estimateTransferSeconds,
  type TransmitProgress,
} from './audio/transmitter'

type Mode = 'send' | 'receive'
type SendPayloadKind = 'message' | 'file'
type SendStatus = 'idle' | 'ready' | 'preparing' | 'sending' | 'sent' | 'error'
type ReceiveStatus = 'permission' | 'requesting' | 'listening' | 'receiving' | 'complete' | 'error'
type CopyStatus = 'idle' | 'copied'

interface OutgoingPayload extends TransferEstimateInput {
  kind: SendPayloadKind
  label: string
}

interface DownloadableTransfer extends ReceivedTransfer {
  url: string
}

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(1, Math.round(totalSeconds))
  if (seconds < 60) return `~${seconds} sec`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder < 5 ? `~${minutes} min` : `~${minutes}m ${remainder}s`
}

function getExtension(name: string): string {
  const extension = name.includes('.') ? name.split('.').pop() : 'file'
  return (extension || 'file').slice(0, 4)
}

function decodeReceivedMessage(transfer: ReceivedTransfer): string | null {
  if ((transfer.flags & TRANSFER_FLAG_MESSAGE) === 0) return null
  try {
    return UTF8_DECODER.decode(transfer.data)
  } catch {
    return null
  }
}

function getMessageDraftStatus(message: string, byteLength: number): SendStatus {
  if (byteLength > MAX_MESSAGE_BYTES) return 'error'
  return message.trim().length > 0 ? 'ready' : 'idle'
}

function describeMicrophoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'Microphone access was blocked. Allow it in this site’s settings and try again.'
    }
    if (error.name === 'NotFoundError') {
      return 'No microphone was found. Connect one or use this device’s built-in microphone.'
    }
    if (error.name === 'NotReadableError') {
      return 'Another app is using the microphone. Close it there, then try again.'
    }
  }
  return error instanceof Error ? error.message : 'The microphone could not start.'
}

function PikaIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  )
}

function SendIcon() {
  return <PikaIcon path="M4.934 12 3.09 5.732c-.481-1.635 1.05-3.147 2.665-2.628a54 54 0 0 1 12.64 5.963C19.525 9.793 21 10.442 21 12s-1.474 2.207-2.605 2.933a54 54 0 0 1-12.64 5.963c-1.614.519-3.146-.993-2.665-2.628zm0 0h4.9" />
}

function ReceiveIcon() {
  return <PikaIcon path="M3 15a5 5 0 0 0 5 5h8a5 5 0 0 0 5-5M9 12.188a15 15 0 0 0 2.556 2.655A.7.7 0 0 0 12 15m3-2.812a15 15 0 0 1-2.556 2.655A.7.7 0 0 1 12 15m0 0V4" />
}

function UploadIcon() {
  return <PikaIcon path="M3 15a5 5 0 0 0 5 5h8a5 5 0 0 0 5-5M9 6.812a15 15 0 0 1 2.556-2.655A.7.7 0 0 1 12 4m3 2.812a15 15 0 0 0-2.556-2.655A.7.7 0 0 0 12 4m0 0v11" />
}

function MicIcon() {
  return <PikaIcon path="M12 20a8 8 0 0 1-8-8m8 8a8 8 0 0 0 8-8m-8 8v2m0-6a4 4 0 0 1-4-4V7a4 4 0 1 1 8 0v5a4 4 0 0 1-4 4Z" />
}

function ShieldIcon() {
  return <PikaIcon path="m9.133 12.02 2.007 2.004a13.06 13.06 0 0 1 3.993-4.29m-4.25-7.366L5.497 4.314a3 3 0 0 0-1.98 2.706l-.127 3.309a11 11 0 0 0 5.543 9.978l1.521.867a3 3 0 0 0 2.915.032l1.489-.806a11 11 0 0 0 5.728-10.516l-.227-2.95a3 3 0 0 0-1.972-2.592l-5.465-1.974a3 3 0 0 0-2.038 0Z" />
}

function AlertIcon() {
  return <PikaIcon path="M12 13V9m0 7.375v.001M10.61 3.284a3.55 3.55 0 0 1 2.78 0c2.651 1.128 8.915 11.138 8.731 13.813a3.63 3.63 0 0 1-1.424 2.645c-2.212 1.677-15.182 1.677-17.394 0a3.63 3.63 0 0 1-1.424-2.645c-.184-2.675 6.08-12.685 8.731-13.813Z" />
}

function CopyIcon() {
  return <PikaIcon path="M16.902 16.902a4 4 0 0 0 .643-.147 5 5 0 0 0 3.21-3.21C21 12.792 21 11.861 21 10s0-2.792-.245-3.545a5 5 0 0 0-3.21-3.21C16.792 3 15.861 3 14 3s-2.792 0-3.545.245a5 5 0 0 0-3.21 3.21 4 4 0 0 0-.147.643m9.804 9.804C17 16.239 17 15.372 17 14c0-1.861 0-2.792-.245-3.545a5 5 0 0 0-3.21-3.21C12.792 7 11.861 7 10 7c-1.373 0-2.24 0-2.902.098m9.804 9.804a4 4 0 0 1-.147.643 5 5 0 0 1-3.21 3.21C12.792 21 11.861 21 10 21s-2.792 0-3.545-.245a5 5 0 0 1-3.21-3.21C3 16.792 3 15.861 3 14s0-2.792.245-3.545a5 5 0 0 1 3.21-3.21c.198-.065.407-.112.643-.147" />
}

function GitHubIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path
        d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.184 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.866-.014-1.7-2.782.605-3.369-1.345-3.369-1.345-.455-1.157-1.11-1.465-1.11-1.465-.908-.62.069-.608.069-.608 1.004.071 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.91.832.091-.647.35-1.088.636-1.338-2.221-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.03-2.689-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.56 9.56 0 0 1 12 6.844a9.54 9.54 0 0 1 2.504.337c1.909-1.296 2.747-1.026 2.747-1.026.546 1.378.203 2.397.1 2.65.64.701 1.028 1.596 1.028 2.689 0 3.847-2.337 4.695-4.566 4.943.359.31.678.921.678 1.856 0 1.34-.012 2.421-.012 2.75 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.021C22 6.484 17.523 2 12 2Z"
        fill="currentColor"
      />
    </svg>
  )
}

function GumboWordmark() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 1023 200">
      <path
        d="M783.528 30.0439C789.299 30.0439 794.005 32.1296 797.689 36.3467C801.374 40.5636 803.193 45.7574 803.193 52.0605V75.2324C803.193 81.8909 801.462 87.0851 798 90.7695C794.538 94.4538 789.699 96.451 783.573 96.8506V98.8037C790.143 99.2033 795.292 101.29 799.109 105.107C802.927 108.925 804.791 114.296 804.791 121.221V148.521C804.791 154.957 802.971 160.24 799.287 164.457C795.603 168.674 790.898 170.761 785.127 170.761H633.046V30.0439H783.528ZM391.429 146.125C391.429 153.05 389.386 158.909 385.258 163.614C381.13 168.32 375.936 170.673 369.633 170.673H242.898L242.854 170.717C236.551 170.717 231.357 168.365 227.229 163.659C223.1 158.954 221.059 153.094 221.059 146.169V30.0439H289.642V120.023C289.642 125.794 291.418 129.922 294.969 132.408C298.52 134.894 303.27 136.137 309.307 136.137C315.344 136.137 320.049 134.938 323.467 132.497C326.885 130.1 328.572 125.972 328.572 120.201V30H391.429V146.125ZM185.459 30.0439C191.762 30.0439 196.957 32.3517 201.085 37.0127C205.213 41.6735 207.255 47.533 207.255 54.5908V79.1387H138.494V73.2354C138.494 68.7963 136.896 65.5557 133.7 63.6025C130.504 61.6494 126.065 60.6729 120.428 60.6729C114.79 60.6729 110.573 61.6494 107.377 63.6025C104.181 65.5557 102.583 68.7964 102.583 73.2354V127.479C102.583 131.918 104.225 135.159 107.51 137.112C110.795 139.065 115.235 140.042 120.872 140.042C126.509 140.042 130.682 139.065 133.834 137.112C136.985 135.159 138.539 131.918 138.539 127.479V119.401H114.169V88.1504H207.299V170.672H155.629V150.651H153.854C153.321 156.555 151.146 161.349 147.284 165.078C143.422 168.807 138.539 170.672 132.635 170.672H55.7959V170.716C49.4925 170.716 44.2982 168.364 40.1699 163.658C36.0417 158.953 34 153.093 34 146.168V54.5908C34.0001 47.533 36.0418 41.6735 40.1699 37.0127C44.2982 32.3517 49.4925 30.0439 55.7959 30.0439H185.459ZM516.344 73.0576H517.897L546.795 30.0439H616.932V170.716H549.947V111.188H548.394L505.956 170.716H499.653L457.216 110.967H455.44V170.716H406.3V30.0439H487.445L516.344 73.0576ZM966.861 30.0439C973.165 30.0439 978.359 32.3517 982.487 37.0127C986.615 41.6735 988.657 47.5331 988.657 54.5908V146.168C988.657 153.093 986.616 158.953 982.487 163.658C978.359 168.364 973.165 170.716 966.861 170.716H837.198C830.895 170.716 825.701 168.364 821.572 163.658C817.444 158.953 815.402 153.093 815.402 146.168V54.5908C815.402 47.533 817.444 41.6736 821.572 37.0127C825.701 32.3517 830.895 30.0439 837.198 30.0439H966.861ZM700.607 140.842H728.308C731.592 140.842 733.767 139.643 734.877 137.29C735.987 134.937 736.563 131.786 736.563 127.88C736.563 123.974 735.987 120.688 734.877 118.469C733.767 116.249 731.548 115.14 728.308 115.14H700.607V140.842ZM901.83 62.8926C896.193 62.8926 891.975 63.8246 888.779 65.7334C885.583 67.6422 883.985 70.8829 883.985 75.4551V125.172C883.985 129.744 885.628 133.028 888.912 134.981C892.193 136.932 896.624 137.908 902.251 137.911C907.745 137.909 912.044 136.977 915.191 135.07C918.343 133.162 919.896 129.921 919.896 125.35V75.6318C919.896 71.0599 918.298 67.7754 915.103 65.8223C911.906 63.8691 907.468 62.8926 901.83 62.8926ZM700.607 83.4893H727.73C730.616 83.4892 732.658 82.4239 733.9 80.249C735.143 78.0739 735.765 75.2324 735.765 71.7256C735.765 67.9084 735.143 65.0233 733.9 62.9814C732.658 60.9396 730.571 59.9181 727.73 59.918H700.607V83.4893Z"
        fill="currentColor"
      />
    </svg>
  )
}

export default function App() {
  const [mode, setMode] = useState<Mode>('send')
  const [sendPayloadKind, setSendPayloadKind] = useState<SendPayloadKind>('message')
  const [message, setMessage] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [sendStatus, setSendStatus] = useState<SendStatus>('idle')
  const [sendProgress, setSendProgress] = useState<TransmitProgress | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [receiveStatus, setReceiveStatus] = useState<ReceiveStatus>('permission')
  const [receiveProgress, setReceiveProgress] = useState<ReceiverProgress>({
    state: 'listening',
    signalLevel: 0,
    receivedFrames: 0,
    totalFrames: null,
    progress: 0,
    frameLabel: null,
  })
  const [receiveError, setReceiveError] = useState<string | null>(null)
  const [received, setReceived] = useState<DownloadableTransfer | null>(null)
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const transmitterRef = useRef<UltrasonicTransmitter | null>(null)
  const transmitAbortRef = useRef<AbortController | null>(null)
  const receiverRef = useRef<UltrasonicReceiver | null>(null)

  const messageBytes = UTF8_ENCODER.encode(message)
  const messageHasContent = message.trim().length > 0
  const messageTooLarge = messageBytes.length > MAX_MESSAGE_BYTES
  let outgoingPayload: OutgoingPayload | null = null
  if (sendPayloadKind === 'message' && messageHasContent && !messageTooLarge) {
    outgoingPayload = {
      kind: 'message',
      name: '',
      mimeType: '',
      size: messageBytes.length,
      label: 'Plaintext message',
    }
  } else if (sendPayloadKind === 'file' && file) {
    outgoingPayload = {
      kind: 'file',
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      label: file.name,
    }
  }
  const frameCount = outgoingPayload ? estimateFrameCount(outgoingPayload) : 0
  const estimatedSeconds = estimateTransferSeconds(frameCount)
  const receivedIsMessage = received
    ? (received.flags & TRANSFER_FLAG_MESSAGE) !== 0
    : false
  const receivedMessage = received ? decodeReceivedMessage(received) : null
  const receivedFileName = received?.name || (receivedIsMessage ? 'message.bin' : 'sonicdrop.bin')
  const sendBusy = sendStatus === 'preparing' || sendStatus === 'sending'
  const receiveBusy =
    receiveStatus === 'requesting'
    || receiveStatus === 'listening'
    || receiveStatus === 'receiving'
  let broadcastButtonLabel = 'Broadcast file'
  if (sendStatus === 'sent') {
    broadcastButtonLabel = 'Broadcast again'
  } else if (sendPayloadKind === 'message') {
    broadcastButtonLabel = 'Broadcast message'
  }

  useEffect(() => () => {
    transmitterRef.current?.stop()
    void receiverRef.current?.stop()
  }, [])

  useEffect(() => {
    const currentUrl = received?.url
    return () => {
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [received?.url])

  const updateMessage = (nextMessage: string) => {
    if (sendBusy) return

    const nextSize = UTF8_ENCODER.encode(nextMessage).length
    setMessage(nextMessage)
    setSendProgress(null)
    setSendError(null)
    setSendStatus(getMessageDraftStatus(nextMessage, nextSize))
  }

  const switchSendPayload = (nextKind: SendPayloadKind) => {
    if (sendBusy || nextKind === sendPayloadKind) return

    setSendPayloadKind(nextKind)
    setSendProgress(null)
    setSendError(null)
    if (nextKind === 'message') {
      setSendStatus(getMessageDraftStatus(message, messageBytes.length))
    } else {
      setSendStatus(file ? 'ready' : 'idle')
    }
  }

  const handlePayloadTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentKind: SendPayloadKind,
  ) => {
    if (sendBusy) return
    let nextKind: SendPayloadKind | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextKind = currentKind === 'message' ? 'file' : 'message'
    } else if (event.key === 'Home') {
      nextKind = 'message'
    } else if (event.key === 'End') {
      nextKind = 'file'
    }
    if (!nextKind) return

    event.preventDefault()
    switchSendPayload(nextKind)
    document.getElementById(`payload-tab-${nextKind}`)?.focus()
  }

  const chooseFile = (nextFile: File | null) => {
    if (sendBusy) return

    setSendError(null)
    setSendProgress(null)

    if (!nextFile) return
    if (nextFile.size === 0) {
      setFile(null)
      setSendStatus('error')
      setSendError('That file is empty. Choose a file with at least one byte.')
      return
    }
    if (nextFile.size > MAX_PAYLOAD_BYTES) {
      setFile(null)
      setSendStatus('error')
      setSendError(`Keep files under ${formatBytes(MAX_PAYLOAD_BYTES)}. At this bitrate, that ceiling already takes about seven minutes.`)
      return
    }

    try {
      estimateFrameCount({
        name: nextFile.name,
        mimeType: nextFile.type || 'application/octet-stream',
        size: nextFile.size,
      })
    } catch (error) {
      setFile(null)
      setSendStatus('error')
      setSendError(error instanceof Error ? error.message : 'That file metadata is too large.')
      return
    }

    setFile(nextFile)
    setSendStatus('ready')
  }

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(false)
    chooseFile(event.dataTransfer.files.item(0))
  }

  const startBroadcast = async () => {
    if (!outgoingPayload || transmitterRef.current) return

    setSendStatus('preparing')
    setSendError(null)
    setSendProgress(null)
    const abortController = new AbortController()
    const transmitter = new UltrasonicTransmitter()
    transmitAbortRef.current = abortController
    transmitterRef.current = transmitter

    try {
      const transfer = outgoingPayload.kind === 'message'
        ? await buildMessageTransfer(message)
        : await buildTransfer(
            outgoingPayload.name,
            outgoingPayload.mimeType,
            new Uint8Array(await file!.arrayBuffer()),
          )
      setSendStatus('sending')
      await transmitter.send(transfer.frames, {
        signal: abortController.signal,
        onProgress: (progress) => setSendProgress((current) => {
          if (
            current
            && current.frameIndex === progress.frameIndex
            && Math.round(current.progress * 100) === Math.round(progress.progress * 100)
            && Math.round(current.remainingSeconds) === Math.round(progress.remainingSeconds)
          ) {
            return current
          }
          return progress
        }),
      })
      setSendStatus('sent')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setSendStatus('ready')
      } else {
        setSendStatus('error')
        setSendError(error instanceof Error ? error.message : 'The broadcast could not start.')
      }
    } finally {
      if (transmitAbortRef.current === abortController) transmitAbortRef.current = null
      if (transmitterRef.current === transmitter) transmitterRef.current = null
    }
  }

  const stopBroadcast = () => {
    transmitAbortRef.current?.abort()
    transmitterRef.current?.stop()
  }

  const startListening = async () => {
    if (receiverRef.current) return

    setReceiveStatus('requesting')
    setReceiveError(null)
    setCopyStatus('idle')
    if (received) {
      setReceived(null)
    }

    const receiver = new UltrasonicReceiver({
      onProgress: (progress) => {
        setReceiveProgress(progress)
        setReceiveStatus((current) => current === progress.state ? current : progress.state)
        if (progress.state === 'receiving') setReceiveError(null)
      },
      onComplete: (transfer) => {
        const blob = new Blob([transfer.data.slice().buffer], {
          type: (transfer.flags & TRANSFER_FLAG_MESSAGE) !== 0
            ? 'text/plain;charset=utf-8'
            : transfer.mimeType || 'application/octet-stream',
        })
        setReceived({ ...transfer, url: URL.createObjectURL(blob) })
        setCopyStatus('idle')
        setReceiveProgress((current) => ({ ...current, progress: 1 }))
        setReceiveStatus('complete')
        if (receiverRef.current === receiver) receiverRef.current = null
      },
      onError: (error) => {
        setReceiveError(`${error.message} Waiting for the next clean frame.`)
      },
      onFatalError: (error) => {
        if (receiverRef.current !== receiver) return
        receiverRef.current = null
        setReceiveStatus('error')
        setReceiveError(error.message)
      },
    })

    receiverRef.current = receiver
    try {
      await receiver.start()
      if (receiverRef.current !== receiver) {
        await receiver.stop()
        return
      }
      setReceiveStatus('listening')
    } catch (error) {
      if (receiverRef.current !== receiver) return
      receiverRef.current = null
      setReceiveStatus('error')
      setReceiveError(describeMicrophoneError(error))
    }
  }

  const stopListening = async () => {
    const receiver = receiverRef.current
    if (receiverRef.current === receiver) receiverRef.current = null
    await receiver?.stop()
    setReceiveStatus('permission')
    setReceiveError(null)
    setCopyStatus('idle')
    setReceiveProgress({
      state: 'listening',
      signalLevel: 0,
      receivedFrames: 0,
      totalFrames: null,
      progress: 0,
      frameLabel: null,
    })
  }

  const copyReceivedMessage = async () => {
    if (receivedMessage === null) return

    try {
      await navigator.clipboard.writeText(receivedMessage)
      setCopyStatus('copied')
      setReceiveError(null)
    } catch {
      setReceiveError('Copy was blocked. Select the message text and copy it manually.')
    }
  }

  const switchMode = (nextMode: Mode) => {
    if (nextMode === mode) return
    stopBroadcast()
    void receiverRef.current?.stop()
    receiverRef.current = null
    if (receiveBusy) setReceiveStatus('permission')
    setMode(nextMode)
  }

  const handleModeTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentMode: Mode,
  ) => {
    let nextMode: Mode | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextMode = currentMode === 'send' ? 'receive' : 'send'
    } else if (event.key === 'Home') {
      nextMode = 'send'
    } else if (event.key === 'End') {
      nextMode = 'receive'
    }
    if (!nextMode) return

    event.preventDefault()
    switchMode(nextMode)
    document.getElementById(`transfer-tab-${nextMode}`)?.focus()
  }

  const sendRunway = (): {
    state: RunwayState
    progress: number
    status: string
    detail: string
    frameLabel?: string
  } => {
    if (sendStatus === 'error') {
      return {
        state: 'error',
        progress: 0,
        status: 'Broadcast paused',
        detail: messageTooLarge && sendPayloadKind === 'message'
          ? `Trim the message to ${formatBytes(MAX_MESSAGE_BYTES)} or less.`
          : sendError || 'Check what you selected.',
      }
    }
    if (sendStatus === 'preparing') {
      return { state: 'sending', progress: 0, status: 'Packing the frames', detail: 'Adding error correction and checksums…' }
    }
    if (sendStatus === 'sending') {
      return {
        state: 'sending',
        progress: sendProgress?.progress ?? 0,
        status: outgoingPayload?.kind === 'message'
          ? 'Broadcasting message'
          : `Broadcasting ${outgoingPayload?.label ?? 'file'}`,
        detail: `${formatDuration(sendProgress?.remainingSeconds ?? estimatedSeconds)} remaining`,
        frameLabel: sendProgress ? `${Math.min(sendProgress.frameIndex + 1, sendProgress.frameCount)} / ${sendProgress.frameCount} frames` : undefined,
      }
    }
    if (sendStatus === 'sent') {
      return {
        state: 'complete',
        progress: 1,
        status: 'Broadcast finished',
        detail: 'All frames were sent. Check the receiving device for verification.',
        frameLabel: `${frameCount} frames sent`,
      }
    }
    if (outgoingPayload) {
      return {
        state: 'ready',
        progress: 0,
        status: 'Ready to broadcast',
        detail: outgoingPayload.kind === 'message'
          ? `${formatBytes(outgoingPayload.size)} plaintext message`
          : outgoingPayload.label,
        frameLabel: `${frameCount} frames queued`,
      }
    }
    return {
      state: 'idle',
      progress: 0,
      status: 'Carrier standing by',
      detail: sendPayloadKind === 'message'
        ? 'Write a short message to map into ultrasonic frames.'
        : 'Choose a small file to map into ultrasonic frames.',
    }
  }

  const receiveRunway = (): {
    state: RunwayState
    progress: number
    status: string
    detail: string
    frameLabel?: string
  } => {
    if (receiveStatus === 'error') {
      return { state: 'error', progress: 0, status: 'Microphone unavailable', detail: receiveError || 'Check browser permissions.' }
    }
    if (receiveStatus === 'requesting') {
      return { state: 'listening', progress: 0, status: 'Opening the microphone', detail: 'Audio remains in this tab.' }
    }
    if (receiveStatus === 'receiving') {
      return {
        state: 'receiving',
        progress: receiveProgress.progress,
        status: 'Ultrasonic frames found',
        detail: 'Keep the devices still and close together.',
        frameLabel: receiveProgress.frameLabel || undefined,
      }
    }
    if (receiveStatus === 'complete') {
      return {
        state: 'complete',
        progress: 1,
        status: receivedIsMessage ? 'Message landed' : 'File landed',
        detail: receivedIsMessage ? 'Plaintext verified.' : received?.name || 'Checksum verified.',
      }
    }
    if (receiveStatus === 'listening') {
      return { state: 'listening', progress: 0, status: 'Listening above 20 kHz', detail: 'Start the sender and keep this tab open.' }
    }
    return { state: 'idle', progress: 0, status: 'Microphone is off', detail: '' }
  }

  const runway = mode === 'send' ? sendRunway() : receiveRunway()

  let receivedPanel: ReactNode = null
  if (receiveStatus === 'complete' && received && receivedMessage !== null) {
    receivedPanel = (
      <div className="received-message">
        <div className="received-message__heading">
          <span>Verified plaintext</span>
          <strong>{formatBytes(received.data.byteLength)}</strong>
        </div>
        <textarea
          aria-label="Received message"
          className="received-message__body"
          readOnly
          value={receivedMessage}
        />
      </div>
    )
  } else if (receiveStatus === 'complete' && received) {
    receivedPanel = (
      <div className="received-file">
        <span className="selected-file__glyph">{getExtension(receivedFileName)}</span>
        <strong>{receivedFileName}</strong>
        <p>{formatBytes(received.data.byteLength)} · checksum verified</p>
      </div>
    )
  }

  let receiverControls: ReactNode
  if (receiveStatus === 'complete' && received && receivedMessage !== null) {
    receiverControls = (
      <div className="button-row">
        <button className="primary-button" type="button" onClick={() => void copyReceivedMessage()}>
          {copyStatus === 'copied' ? 'Copied' : 'Copy message'} <CopyIcon />
        </button>
        <button className="secondary-button" type="button" onClick={() => void startListening()}>
          Listen again
        </button>
      </div>
    )
  } else if (receiveStatus === 'complete' && received) {
    receiverControls = (
      <div className="button-row">
        <a className="download-button" href={received.url} download={receivedFileName}>
          Save file <ReceiveIcon />
        </a>
        <button className="secondary-button" type="button" onClick={() => void startListening()}>
          Listen again
        </button>
      </div>
    )
  } else if (receiveBusy) {
    receiverControls = (
      <button className="secondary-button" type="button" onClick={() => void stopListening()}>
        Stop listening
      </button>
    )
  } else {
    receiverControls = (
      <button className="primary-button" type="button" onClick={() => void startListening()}>
        Start listening <MicIcon />
      </button>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="SonicDrop home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          SonicDrop
        </a>
        <div className="topbar__status">
          <span className="topbar__status-dot" aria-hidden="true" />
          <span>Local only</span>
        </div>
      </header>

      <main id="top">
        <section className="intro" aria-labelledby="page-title">
          <h1 id="page-title">Air-gapped data transfers. <span>Sent with sound.</span></h1>
          <p className="intro__copy">Plaintext and tiny files, device to device.</p>
        </section>

        <div className="mode-switch" role="tablist" aria-label="Choose a transfer role">
          <button
            aria-controls="transfer-panel"
            aria-selected={mode === 'send'}
            id="transfer-tab-send"
            onClick={() => switchMode('send')}
            onKeyDown={(event) => handleModeTabKeyDown(event, 'send')}
            role="tab"
            tabIndex={mode === 'send' ? 0 : -1}
            type="button"
          >
            <SendIcon /> Send
          </button>
          <button
            aria-controls="transfer-panel"
            aria-selected={mode === 'receive'}
            id="transfer-tab-receive"
            onClick={() => switchMode('receive')}
            onKeyDown={(event) => handleModeTabKeyDown(event, 'receive')}
            role="tab"
            tabIndex={mode === 'receive' ? 0 : -1}
            type="button"
          >
            <ReceiveIcon /> Receive
          </button>
        </div>

        <div className={`workbench workbench--${mode}`}>
          {mode === 'send' ? (
            <>
              <section
                aria-busy={sendBusy}
                aria-labelledby="transfer-tab-send"
                className="action-card"
                id="transfer-panel"
                role="tabpanel"
              >
                <h2 className="action-card__heading">What do you want to send?</h2>

                <div className="payload-composer">
                  <div className="payload-tabs" role="tablist" aria-label="Choose what to send">
                    {(['message', 'file'] as const).map((kind) => (
                      <button
                        aria-controls={`payload-panel-${kind}`}
                        aria-selected={sendPayloadKind === kind}
                        disabled={sendBusy}
                        id={`payload-tab-${kind}`}
                        key={kind}
                        onClick={() => switchSendPayload(kind)}
                        onKeyDown={(event) => handlePayloadTabKeyDown(event, kind)}
                        role="tab"
                        tabIndex={sendPayloadKind === kind ? 0 : -1}
                        type="button"
                      >
                        {kind === 'message' ? 'Message' : 'File'}
                      </button>
                    ))}
                  </div>

                  <div
                    aria-labelledby="payload-tab-message"
                    className="payload-panel"
                    hidden={sendPayloadKind !== 'message'}
                    id="payload-panel-message"
                    role="tabpanel"
                  >
                    <label className="message-editor">
                      <span className="message-editor__label">Message</span>
                      <textarea
                        aria-describedby="message-byte-guidance"
                        aria-errormessage={messageTooLarge ? 'message-size-error' : undefined}
                        aria-invalid={messageTooLarge}
                        aria-label="Message"
                        disabled={sendBusy}
                        onChange={(event) => updateMessage(event.currentTarget.value)}
                        placeholder="Meet at gate B12. Bring the blue folder."
                        rows={3}
                        value={message}
                      />
                      <span className="message-editor__footer" id="message-byte-guidance">
                        <span>Best under 280 B</span>
                        <strong
                          aria-live="polite"
                          className={messageTooLarge ? 'byte-count byte-count--over' : 'byte-count'}
                        >
                          {formatBytes(messageBytes.length)} / {formatBytes(MAX_MESSAGE_BYTES)}
                        </strong>
                      </span>
                    </label>
                  </div>

                  <div
                    aria-labelledby="payload-tab-file"
                    className="payload-panel"
                    hidden={sendPayloadKind !== 'file'}
                    id="payload-panel-file"
                    role="tabpanel"
                  >
                    <label
                      aria-disabled={sendBusy}
                      className={`file-drop${dragging ? ' file-drop--dragging' : ''}${sendBusy ? ' file-drop--disabled' : ''}`}
                      onDragEnter={(event) => { event.preventDefault(); if (!sendBusy) setDragging(true) }}
                      onDragLeave={() => setDragging(false)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={handleDrop}
                    >
                      <input
                        aria-label={file ? `Choose a different file; ${file.name} selected` : 'Choose a file'}
                        className="sr-only"
                        disabled={sendBusy}
                        onChange={(event) => chooseFile(event.currentTarget.files?.item(0) ?? null)}
                        type="file"
                      />
                      {file ? (
                        <span className="selected-file">
                          <span className="selected-file__glyph">{getExtension(file.name)}</span>
                          <span>
                            <strong className="selected-file__name">{file.name}</strong>
                            <span className="selected-file__meta">{formatBytes(file.size)} · {file.type || 'unknown type'}</span>
                          </span>
                          <span className="selected-file__change">Change</span>
                        </span>
                      ) : (
                        <span className="file-drop__empty">
                          <span className="file-drop__icon"><UploadIcon /></span>
                          <strong>Choose a file or drop it here</strong>
                          <small>Best under 1 KB · max {formatBytes(MAX_PAYLOAD_BYTES)}</small>
                        </span>
                      )}
                    </label>
                  </div>
                </div>

                {outgoingPayload && (
                  <div className="transfer-facts" aria-label="Estimated transfer details">
                    <div className="transfer-fact"><span>Frames</span><strong>{frameCount}</strong></div>
                    <div className="transfer-fact"><span>Air time</span><strong>{formatDuration(estimatedSeconds)}</strong></div>
                  </div>
                )}

                {sendPayloadKind === 'message' && messageTooLarge && (
                  <div className="error-note" id="message-size-error" role="status">
                    <AlertIcon />
                    <span>Message is {formatBytes(messageBytes.length - MAX_MESSAGE_BYTES)} over the limit. Trim it or send it as a text file.</span>
                  </div>
                )}
                {sendError && <div className="error-note" role="alert"><AlertIcon /><span>{sendError}</span></div>}
                <div className="action-card__spacer" />

                {sendBusy ? (
                  <button className="secondary-button" type="button" onClick={stopBroadcast}>Stop broadcast</button>
                ) : (
                  <button className="primary-button" type="button" disabled={!outgoingPayload} onClick={() => void startBroadcast()}>
                    {broadcastButtonLabel} <SendIcon />
                  </button>
                )}
                <div className="quiet-note"><ShieldIcon /><span>Output is low and above 20 kHz, but hardware distortion and hearing vary. Stop if anyone detects sound.</span></div>
              </section>

              <FrequencyRunway
                state={runway.state}
                progress={runway.progress}
                status={runway.status}
                detail={runway.detail}
                frameLabel={runway.frameLabel}
                signalLevel={receiveProgress.signalLevel}
              />
            </>
          ) : (
            <section
              aria-busy={receiveBusy}
              aria-labelledby="transfer-tab-receive"
              className="receive-stage"
              id="transfer-panel"
              role="tabpanel"
            >
              <FrequencyRunway
                controls={receiverControls}
                state={runway.state}
                progress={runway.progress}
                status={runway.status}
                detail={runway.detail}
                frameLabel={runway.frameLabel}
                signalLevel={receiveProgress.signalLevel}
              />

              {receiveError && <div className="error-note receive-stage__error" role="alert"><AlertIcon /><span>{receiveError}</span></div>}
              {receivedPanel}
            </section>
          )}
        </div>

        <section className="principles" aria-label="How SonicDrop works">
          <div className="principle"><span className="principle__index">01</span><div><strong>Frame it</strong><p>Your message or file becomes tiny checksummed packets.</p></div></div>
          <div className="principle"><span className="principle__index">02</span><div><strong>Send it quietly</strong><p>Four carriers encode the data above 20 kHz.</p></div></div>
          <div className="principle"><span className="principle__index">03</span><div><strong>Verify it</strong><p>The receiver rebuilds and hashes everything before showing it.</p></div></div>
        </section>
      </main>

      <footer className="site-footer">
        <span className="site-footer__credit">Built by</span>
        <a
          aria-label="Gumbo — product and engineering studio"
          className="site-footer__gumbo"
          href="https://www.hellogumbo.com/"
        >
          <GumboWordmark />
        </a>
        <div className="site-footer__meta">
          <span>Open source · sonicdrop.io</span>
          <a
            aria-label="View SonicDrop on GitHub"
            className="site-footer__github"
            href="https://github.com/hellogumbo/sonicdrop"
            rel="noopener noreferrer"
            target="_blank"
            title="View SonicDrop on GitHub"
          >
            <GitHubIcon />
          </a>
        </div>
      </footer>
    </div>
  )
}
