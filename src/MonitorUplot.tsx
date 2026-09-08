import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

type MonitorTheme = {
  accent: string
  textSec: string
  textTer: string
  border: string
}

function readTheme(): MonitorTheme {
  const s = getComputedStyle(document.documentElement)
  const accent = (s.getPropertyValue('--accent').trim() || '#8ecbff').toLowerCase()
  const textSec = s.getPropertyValue('--text-secondary').trim() || '#aeb8c8'
  const textTer = s.getPropertyValue('--text-tertiary').trim() || '#737d90'
  const border = s.getPropertyValue('--border-medium').trim() || 'rgba(226,238,255,0.12)'
  return { accent, textSec, textTer, border }
}

const SAMPLE_MS = 2000

function formatClock(ts: number) {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function MonitorUplot({ values, label }: { values: number[]; label: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const tipTimeRef = useRef<HTMLSpanElement | null>(null)
  const tipValRef = useRef<HTMLSpanElement | null>(null)
  const [rebuildKey, setRebuildKey] = useState(0)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const theme = readTheme()

    const tip = tipRef.current
    const tipTime = tipTimeRef.current
    const tipVal = tipValRef.current
    const accent = theme.accent
    const isHex = /^#[0-9a-f]{6}$/i.test(accent)
    const c0 = isHex ? `${accent}59` : 'rgba(142,203,255,0.35)'
    const c1 = isHex ? `${accent}0a` : 'rgba(142,203,255,0.04)'

    const makeFill = () => {
      return ((self: uPlot) => {
        const g = self.ctx.createLinearGradient(0, 0, 0, self.height)
        g.addColorStop(0, c0)
        g.addColorStop(1, c1)
        return g
      }) as unknown as uPlot.Series['fill']
    }

    const opts: uPlot.Options = {
      width: Math.max(320, wrap.clientWidth || 520),
      height: 216,
      padding: [12, 10, 6, 6],
      scales: {
        x: { time: true },
        y: {
          range: (_self, dataMin, dataMax) => {
            if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMax <= dataMin) return [0, 100]
            const pad = Math.max(2, (dataMax - dataMin) * 0.2)
            const lo = Math.max(0, dataMin - pad)
            const hi = Math.min(100, dataMax + pad)
            return hi - lo < 8 ? [Math.max(0, lo - 4), Math.min(100, hi + 4)] : [lo, hi]
          },
        },
      },
      series: [
        {},
        {
          label,
          stroke: accent,
          width: 2,
          fill: makeFill(),
          points: { show: false },
        },
      ],
      axes: [
        {
          stroke: theme.textTer,
          grid: { stroke: theme.border, width: 1 },
          ticks: { stroke: theme.border },
          size: 28,
          font: '11px "Segoe UI Variable", "Inter", system-ui, sans-serif',
          values: (_self, ticks) => ticks.map((sec) => {
            const d = new Date(sec * 1000)
            const hh = String(d.getHours()).padStart(2, '0')
            const mm = String(d.getMinutes()).padStart(2, '0')
            return `${hh}:${mm}`
          }),
        },
        {
          stroke: theme.textTer,
          grid: { stroke: theme.border, width: 1 },
          ticks: { stroke: theme.border },
          size: 36,
          font: '11px "Segoe UI Variable", "Inter", system-ui, sans-serif',
          values: (_self, ticks) => ticks.map((t) => `${Math.round(t)}%`),
        },
      ],
      cursor: {
        x: true,
        y: true,
        points: { size: 6, stroke: accent, width: 2, fill: '#ffffff' },
        drag: { setScale: false, x: false, y: false },
      },
      legend: { show: false },
      hooks: {
        setCursor: [
          (self: uPlot) => {
            const idx = self.cursor.idx ?? -1
            if (idx < 0 || !tip || !tipTime || !tipVal) {
              if (tip) tip.style.opacity = '0'
              return
            }
            const ts = self.data[0]?.[idx] as number | undefined
            const val = self.data[1]?.[idx] as number | undefined
            if (ts == null || val == null) {
              if (tip) tip.style.opacity = '0'
              return
            }
            const x = self.valToPos(ts, 'x', true)
            const y = self.valToPos(val, 'y', true)
            tipTime.textContent = formatClock(ts)
            tipVal.textContent = `${val.toFixed(1)}%`
            tip.style.opacity = '1'
            const tipW = tip.offsetWidth
            const tipH = tip.offsetHeight
            const left = x + 12 + tipW > self.width ? x - tipW - 12 : x + 12
            const top = y - tipH / 2 < 0 ? 4 : y - tipH / 2
            tip.style.left = `${Math.max(0, left)}px`
            tip.style.top = `${top}px`
          },
        ],
        setScale: [
          (self: uPlot) => {
            if (tip) tip.style.opacity = '0'
            void self
          },
        ],
      },
    }

    const plot = new uPlot(opts, [[], []], wrap)
    plotRef.current = plot

    const ro = new ResizeObserver(() => {
      const width = wrap.clientWidth
      if (width > 0) plot.setSize({ width, height: 216 })
    })
    ro.observe(wrap)

    return () => {
      ro.disconnect()
      plot.destroy()
      plotRef.current = null
    }
  }, [label, rebuildKey])

  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => {
      setRebuildKey((k) => k + 1)
    })
    observer.observe(el, { attributes: true, attributeFilter: ['style', 'data-appearance', 'class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const plot = plotRef.current
    if (!plot || values.length < 2) return
    const wrap = wrapRef.current
    if (wrap && wrap.clientWidth > 0 && plot.width !== wrap.clientWidth) {
      plot.setSize({ width: wrap.clientWidth, height: 216 })
    }
    const n = values.length
    const now = Date.now()
    const t0 = now - (n - 1) * SAMPLE_MS
    const times = new Float64Array(n)
    const vals = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      times[i] = t0 + i * SAMPLE_MS
      const raw = values[i]
      vals[i] = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0
    }
    plot.setData([times as unknown as number[], vals as unknown as number[]])
  }, [rebuildKey, values])

  return (
    <div className="monitor-uplot" ref={wrapRef}>
      <div className="uplot-tip" ref={tipRef} style={{ opacity: 0 }}>
        <span className="uplot-tip-time" ref={tipTimeRef} />
        <span className="uplot-tip-val" ref={tipValRef} />
      </div>
    </div>
  )
}

export default MonitorUplot
