import { useEffect, useRef, useState } from 'react'
import './xixi-input.css'

type Props = {
  value: string
  onChange: (value: string) => void
  id?: string
}

/** The parent supplies the label and owns the draft; typing never submits it. */
export function XixiInput({ value, onChange, id = 'wb-xixi-input' }: Props) {
  const [pulse, setPulse] = useState<number | null>(null)
  const pulseSequence = useRef(0)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(pulseTimer.current), [])

  const stopPulse = () => {
    clearTimeout(pulseTimer.current)
    setPulse(null)
  }
  const flash = () => {
    clearTimeout(pulseTimer.current)
    const next = ++pulseSequence.current
    setPulse(next)
    // The fallback also clears the flash if animation events are suppressed.
    pulseTimer.current = setTimeout(() => setPulse(current => current === next ? null : current), 480)
  }

  return <div className="wb-input-shell" data-pulsing={pulse !== null}>
    {pulse !== null && <span key={pulse} className="home-input-flash" aria-hidden="true" onAnimationEnd={event => {
      if (event.target === event.currentTarget) {
        setPulse(current => current === pulse ? null : current)
      }
    }}>
      <span className="home-input-glow" />
      <span className="home-input-rim" />
    </span>}
    <textarea className="wb-input-textarea" id={id} rows={3} maxLength={4000} placeholder="哪里需要一起想想" value={value}
      onChange={event => {
        const next = event.currentTarget.value
        const input = event.nativeEvent as InputEvent
        // Composition updates and pasted text pulse once per actual change;
        // deletion, selection and unchanged composition commits stay quiet.
        const inserted = input.inputType
          ? input.inputType.startsWith('insert')
          : next.length > value.length || Boolean(input.data)
        if (next !== value && inserted) flash()
        onChange(next)
      }}
      onBlur={stopPulse} />
  </div>
}
