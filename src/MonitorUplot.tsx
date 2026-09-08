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
  const d = new Date(ts * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

// 速率格式化（输入为 MB/s）
function fmtRate(v: number) {
  if (!Number.isFinite(v) || v < 0) return '0 B/s'
  if (v >= 1024) return `${(v / 1024).toFixed(2)} GB/s`
  if (v >= 1) return `${v.toFixed(2)} MB/s`
  if (v >= 1 / 1024) return `${(v * 1024).toFixed(1)} KB/s`
  return `${(v * 1024 * 1024).toFixed(0)} B/s`
}

const UP_COLOR = '#4a8cf7'
const DOWN_COLOR = '#22c9a0'

function MonitorUplot({
  values,
  values2,
  label,
  label2,
}: {
  values: number[]
  values2?: number[]
  label: string
  label2?: string
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const tipTimeRef = useRef<HTMLSpanElement | null>(null)
  const tipValRef = useRef<HTMLDivElement | null>(null)
  const [rebuildKey, setRebuildKey] = useState(0)

  // 是否网络速率双系列图
  const isRate = Boolean(values2)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const theme = readTheme()

    const tip = tipRef.current
    const tipTime = tipTimeRef.current
    const tipVal = tipValRef.current
    const accent = theme.accent

    const makeFill = (color: string) => {
      const hex = /^#[0-9a-f]{6}$/i.test(color)
      const c0 = hex ? `${color}66` : 'rgba(142,203,255,0.35)'
      const c1 = hex ? `${color}08` : 'rgba(142,203,255,0.04)'
      return ((self: uPlot) => {
        const g = self.ctx.createLinearGradient(0, 0, 0, self.height)
        g.addColorStop(0, c0)
        g.addColorStop(1, c1)
        return g
      }) as unknown as uPlot.Series['fill']
    }

    const color1 = isRate ? UP_COLOR : accent
    const color2 = DOWN_COLOR

    const opts: uPlot.Options = {
      width: Math.max(320, wrap.clientWidth || 520),
      height: 260,
      padding: [12, 10, 6, 6],
      scales: {
        x: { time: true },
        y: isRate ? {} : { range: [0, 100] },
      },
      series: [
        {},
        {
          label,
          stroke: color1,
          width: 2,
          fill: makeFill(color1),
          points: { show: false },
        },
        ...(isRate
          ? [
              {
                label: label2 ?? '下载',
                stroke: color2,
                width: 2,
                fill: makeFill(color2),
                points: { show: false },
              },
            ]
          : []),
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
            if (d.getSeconds() !== 0) return ''
            const hh = String(d.getHours()).padStart(2, '0')
            const mm = String(d.getMinutes()).padStart(2, '0')
            return `${hh}:${mm}`
          }),
        },
        {
          stroke: theme.textTer,
          grid: { stroke: theme.border, width: 1 },
          ticks: { stroke: theme.border },
          size: 52,
          font: '11px "Segoe UI Variable", "Inter", system-ui, sans-serif',
          values: (_self, ticks) => ticks.map((t) => (isRate ? fmtRate(t) : `${Math.round(t)}%`)),
        },
      ],
      cursor: {
        x: true,
        y: true,
        points: { size: 6, stroke: '#ffffff', width: 2, fill: accent },
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
            const v1 = self.data[1]?.[idx] as number | undefined
            if (ts == null || v1 == null) {
              if (tip) tip.style.opacity = '0'
              return
            }
            const x = self.valToPos(ts, 'x', true)
            const y = self.valToPos(v1, 'y', true)
            tipTime.textContent = formatClock(ts)
            if (isRate) {
              const v2 = self.data[2]?.[idx] as number | undefined
              tipVal.innerHTML =
                `<span class="uplot-tip-row"><i style="background:${UP_COLOR}"></i>${label ?? '上传'} ${fmtRate(v1)}</span>` +
                `<span class="uplot-tip-row"><i style="background:${DOWN_COLOR}"></i>${label2 ?? '下载'} ${fmtRate(v2 ?? 0)}</span>`
            } else {
              tipVal.innerHTML = `<span class="uplot-tip-row"><i style="background:${accent}"></i>${label ?? ''} ${v1.toFixed(1)}%</span>`
            }
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

    const initialData = (isRate
      ? [[0, 1], [null, null], [null, null]]
      : [[0, 1], [null, null]]) as unknown as uPlot.AlignedData
    const plot = new uPlot(opts, initialData, wrap)
    plotRef.current = plot

    const ro = new ResizeObserver(() => {
      const width = wrap.clientWidth
      if (width > 0) plot.setSize({ width, height: 260 })
    })
    ro.observe(wrap)

    return () => {
      ro.disconnect()
      plot.destroy()
      plotRef.current = null
    }
  }, [label, label2, rebuildKey, isRate])

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
      plot.setSize({ width: wrap.clientWidth, height: 260 })
    }
    const n = values.length
    const now = Date.now()
    const nowSec = now / 1000
    if (n === 0) {
      const empty = isRate
        ? [[nowSec - 1200, nowSec], [null, null], [null, null]]
        : [[nowSec - 1200, nowSec], [null, null]]
      plot.setData(empty as unknown as uPlot.AlignedData)
      plot.setScale('x', { min: nowSec - 1200, max: nowSec })
      return
    }
    const t0 = now - (n - 1) * SAMPLE_MS
    const times = new Float64Array(n)
    const vals: (number | null)[] = new Array(n).fill(null)
    const vals2: (number | null)[] | undefined = isRate ? new Array(n).fill(null) : undefined
    for (let i = 0; i < n; i++) {
      times[i] = (t0 + i * SAMPLE_MS) / 1000
      const raw = values[i]
      vals[i] = Number.isFinite(raw) ? (isRate ? Math.max(0, raw) : Math.max(0, Math.min(100, raw))) : null
      if (vals2 && values2) {
        const raw2 = values2[i]
        vals2[i] = Number.isFinite(raw2) ? Math.max(0, raw2) : null
      }
    }
    if (isRate && vals2) {
      plot.setData([times as unknown as number[], vals as (number | null)[], vals2 as (number | null)[]] as unknown as uPlot.AlignedData)
      // Y 轴 0 到数据最大值（真实，不放大）
      let maxV = 0
      for (let i = 0; i < n; i++) {
        if (vals[i] != null && vals[i]! > maxV) maxV = vals[i]!
        if (vals2[i] != null && vals2[i]! > maxV) maxV = vals2[i]!
      }
      plot.setScale('y', { min: 0, max: maxV > 0 ? maxV * 1.15 : 1 })
    } else {
      plot.setData([times as unknown as number[], vals as (number | null)[]] as unknown as uPlot.AlignedData)
    }
    // X 轴固定 20 分钟窗口（数据从右往左增长）
    plot.setScale('x', { min: nowSec - 1200, max: nowSec })
  }, [rebuildKey, values, values2, isRate])

  return (
    <div className="monitor-uplot" ref={wrapRef}>
      <div className="uplot-tip" ref={tipRef} style={{ opacity: 0 }}>
        <span className="uplot-tip-time" ref={tipTimeRef} />
        <div className="uplot-tip-vals" ref={tipValRef} />
      </div>
    </div>
  )
}

export default MonitorUplot
