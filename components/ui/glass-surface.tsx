"use client"

import { useEffect, useId, useRef } from "react"

// Rounded-surface renderer adapted from React Bits Glass Surface by David Haz.
// https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Components/GlassSurface/GlassSurface.tsx
// See glass-surface.LICENSE.md.
const channels = [
  { name: "red", scale: -180, matrix: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" },
  { name: "green", scale: -170, matrix: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" },
  { name: "blue", scale: -160, matrix: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" },
]

function createDisplacementMap(width: number, height: number, radius: number, strength: number) {
  const edge = Math.min(width, height) * 0.035
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="red" x1="100%" x2="0%" y1="0%" y2="0%">
        <stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/>
      </linearGradient>
      <linearGradient id="blue" x1="0%" x2="0%" y1="0%" y2="100%">
        <stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/>
      </linearGradient>
      <filter id="soft" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" color-interpolation-filters="sRGB">
        <feGaussianBlur stdDeviation="${11 * strength}"/>
      </filter>
    </defs>
    <rect width="${width}" height="${height}" fill="black"/>
    <rect width="${width}" height="${height}" rx="${radius}" fill="url(#red)"/>
    <rect width="${width}" height="${height}" rx="${radius}" fill="url(#blue)" style="mix-blend-mode:difference"/>
    <rect x="${edge}" y="${edge}" width="${width - edge * 2}" height="${height - edge * 2}" rx="${radius}" fill="hsl(0 0% 50% / 0.93)" filter="url(#soft)"/>
  </svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function GlassSurfaceFilter() {
  const filterId = `glass-surface-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const definition = useRef<HTMLSpanElement>(null)
  const image = useRef<SVGFEImageElement>(null)
  const filter = useRef<SVGFilterElement>(null)

  useEffect(() => {
    const surface = definition.current?.closest<HTMLElement>(".glass-surface")
    const map = image.current
    const filterElement = filter.current
    const svgFilter = `url("#${filterId}")`
    if (
      !surface || !map || !filterElement ||
      !/\b(?:Chrome|Chromium|HeadlessChrome)\//.test(navigator.userAgent) ||
      !CSS.supports("backdrop-filter", svgFilter)
    ) return

    const preference = window.matchMedia("(prefers-reduced-transparency: reduce)")
    let lastGeometry = ""
    const displacementMaps = filterElement.getElementsByTagName("feDisplacementMap")
    const update = () => {
      if (preference.matches) {
        surface.style.removeProperty("--glass-surface-filter")
        return
      }

      const { offsetWidth: width, offsetHeight: height } = surface
      if (!width || !height) return
      const minDimension = Math.min(width, height)
      const surfaceStyle = getComputedStyle(surface)
      const corner = surfaceStyle.borderTopLeftRadius
      const radius = corner.endsWith("%")
        ? minDimension * parseFloat(corner) / 100
        : Math.min(parseFloat(corner) || 0, minDimension / 2)
      const refraction = Number(surfaceStyle.getPropertyValue("--glass-surface-refraction").trim() || "1")
      const geometry = `${width}:${height}:${radius}:${refraction}`

      if (geometry !== lastGeometry) {
        lastGeometry = geometry
        const strength = Math.min(1, minDimension / 80)
        map.setAttribute("href", createDisplacementMap(width, height, radius, strength))
        channels.forEach(({ scale }, index) => {
          displacementMaps[index].setAttribute("scale", String(scale * strength * refraction))
        })
      }
      surface.style.setProperty("--glass-surface-filter", `${svgFilter} var(--glass-surface-frost, saturate(1))`)
    }

    const resize = new ResizeObserver(update)
    resize.observe(surface)
    preference.addEventListener("change", update)
    update()

    return () => {
      resize.disconnect()
      preference.removeEventListener("change", update)
      surface.style.removeProperty("--glass-surface-filter")
    }
  }, [filterId])

  return (
    <span ref={definition} aria-hidden="true" className="pointer-events-none absolute size-0 overflow-hidden">
      <svg className="size-0" width="0" height="0" focusable="false">
        <defs>
          <filter ref={filter} id={filterId} colorInterpolationFilters="sRGB" x="0%" y="0%" width="100%" height="100%">
            <feImage ref={image} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
            {channels.map(({ name, matrix }) => (
              <Channel key={name} name={name} matrix={matrix} />
            ))}
            <feBlend in="red" in2="green" mode="screen" result="rg" />
            <feBlend in="rg" in2="blue" mode="screen" />
          </filter>
        </defs>
      </svg>
    </span>
  )
}

function Channel({ name, matrix }: { name: string; matrix: string }) {
  return (
    <>
      <feDisplacementMap
        in="SourceGraphic"
        in2="map"
        scale="0"
        xChannelSelector="R"
        yChannelSelector="G"
        result={`displaced-${name}`}
      />
      <feColorMatrix in={`displaced-${name}`} type="matrix" values={matrix} result={name} />
    </>
  )
}
