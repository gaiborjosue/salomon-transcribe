"use client"

import { useId, type ReactElement } from "react"

import { cn } from "@/lib/utils"

type BacklightProps = {
  blur?: number
  children: ReactElement
  className?: string
}

export function Backlight({
  blur = 18,
  children,
  className,
}: BacklightProps) {
  const id = useId()

  return (
    <div className={cn("relative overflow-visible", className)}>
      <svg width="0" height="0" aria-hidden="true" className="absolute">
        <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="blurred" />
          <feColorMatrix type="saturate" in="blurred" values="4" />
          <feComposite in="SourceGraphic" operator="over" />
        </filter>
      </svg>

      <div className="overflow-visible" style={{ filter: `url(#${id})` }}>
        {children}
      </div>
    </div>
  )
}
