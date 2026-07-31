import type { CSSProperties, ReactNode } from 'react'
import { TONE_FREQUENCIES } from '../audio/protocol'

export type RunwayState =
  | 'idle'
  | 'ready'
  | 'sending'
  | 'listening'
  | 'receiving'
  | 'complete'
  | 'error'

interface FrequencyRunwayProps {
  state: RunwayState
  progress: number
  status: string
  detail: string
  signalLevel?: number
  frameLabel?: string
  controls?: ReactNode
}

const LANES = TONE_FREQUENCIES.map((frequency) => (frequency / 1000).toFixed(2))
const BAND_LABEL = `${(TONE_FREQUENCIES[0] / 1000).toFixed(1)}—${(
  TONE_FREQUENCIES[TONE_FREQUENCIES.length - 1] / 1000
).toFixed(1)} kHz`
const CELL_COUNT = 20

export function FrequencyRunway({
  state,
  progress,
  status,
  detail,
  signalLevel = 0,
  frameLabel,
  controls,
}: FrequencyRunwayProps) {
  const completedCells = Math.round(Math.min(1, Math.max(0, progress)) * CELL_COUNT)
  const isMoving = state === 'sending' || state === 'receiving'

  return (
    <section className={`runway runway--${state}`} aria-label="Ultrasonic carrier monitor">
      <div className="runway__header">
        <p className="runway__band">{BAND_LABEL}</p>
        <span className="band-badge">
          <span className="band-badge__dot" aria-hidden="true" />
          Ultrasound only
        </span>
      </div>

      {controls && <div className="runway__controls">{controls}</div>}

      <div className="runway__scale" aria-hidden="true">
        <span>frame start</span>
        <span>payload</span>
        <span>checksum</span>
      </div>

      <div className="runway__lanes" aria-hidden="true">
        {LANES.map((frequency, laneIndex) => (
          <div className="carrier-lane" key={frequency}>
            <span className="carrier-lane__label">{frequency}</span>
            <div className="carrier-lane__track">
              {Array.from({ length: CELL_COUNT }, (_, cellIndex) => {
                const active = cellIndex < completedCells
                const cursor = isMoving && cellIndex === completedCells
                const style = {
                  '--cell-index': cellIndex,
                  '--lane-index': laneIndex,
                } as CSSProperties

                return (
                  <span
                    className={`packet-cell${active ? ' packet-cell--filled' : ''}${
                      cursor ? ' packet-cell--cursor' : ''
                    }`}
                    key={cellIndex}
                    style={style}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {state === 'listening' && (
        <div className="signal-meter" aria-label={`Microphone signal ${Math.round(signalLevel * 100)}%`}>
          <span>mic input</span>
          <div className="signal-meter__track">
            <span style={{ transform: `scaleX(${Math.max(0.02, signalLevel)})` }} />
          </div>
          <span>{Math.round(signalLevel * 100)}%</span>
        </div>
      )}

      <div className="runway__readout">
        <span className="runway__state-mark" aria-hidden="true" />
        <div>
          <strong aria-atomic="true" aria-live="polite">{status}</strong>
          {detail && <span>{detail}</span>}
        </div>
        {frameLabel && <code>{frameLabel}</code>}
        {(state === 'sending' || state === 'receiving' || state === 'complete') && (
          <strong className="runway__percent">{Math.round(progress * 100)}%</strong>
        )}
      </div>
    </section>
  )
}
