"use client"

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react"
import type { ReactNode, RefObject } from "react"
import { X } from "lucide-react"
import { AnimatePresence, motion, MotionConfig } from "motion/react"

import { cn } from "@/lib/utils"

// Adapted from Cult UI Popover. See cult-popover.LICENSE.md.
// https://www.cult-ui.com/r/popover.json
const TRANSITION = {
  type: "spring" as const,
  bounce: 0.05,
  duration: 0.3,
}

interface PopoverContextType {
  isOpen: boolean
  setOpen: (open: boolean) => void
  uniqueId: string
  rootRef: RefObject<HTMLDivElement | null>
  triggerRef: RefObject<HTMLButtonElement | null>
}

const PopoverContext = createContext<PopoverContextType | undefined>(undefined)

function usePopover() {
  const context = useContext(PopoverContext)
  if (!context) {
    throw new Error("Popover components must be used within PopoverRoot")
  }
  return context
}

interface PopoverPartProps {
  children: ReactNode
  className?: string
}

export function PopoverRoot({
  children,
  className,
  open,
  onOpenChange,
}: PopoverPartProps & {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const uniqueId = useId()
  const [internalOpen, setInternalOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const isOpen = open ?? internalOpen
  const setOpen = useCallback((next: boolean) => {
    if (open === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }, [open, onOpenChange])

  return (
    <PopoverContext.Provider value={{ isOpen, setOpen, uniqueId, rootRef, triggerRef }}>
      <MotionConfig transition={TRANSITION} reducedMotion="user">
        <div ref={rootRef} className={cn("relative isolate flex items-center justify-center", className)}>
          {children}
        </div>
      </MotionConfig>
    </PopoverContext.Provider>
  )
}

export function PopoverTrigger({ children, className }: PopoverPartProps) {
  const { isOpen, setOpen, uniqueId, triggerRef } = usePopover()

  return (
    <motion.button
      ref={triggerRef}
      type="button"
      layoutId={`popover-${uniqueId}`}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      aria-controls={isOpen ? `popover-${uniqueId}` : undefined}
      className={cn(
        "flex h-9 items-center border border-zinc-950/10 bg-white px-3 text-zinc-950 dark:border-zinc-50/10 dark:bg-zinc-700 dark:text-zinc-50",
        className
      )}
      style={{ borderRadius: 8 }}
      onClick={() => setOpen(!isOpen)}
    >
      <motion.span layoutId={`popover-label-${uniqueId}`} className="flex w-full min-w-0 items-center justify-between gap-1">
        {children}
      </motion.span>
    </motion.button>
  )
}

export function PopoverContent({ children, className }: PopoverPartProps) {
  const { isOpen, setOpen, uniqueId, rootRef, triggerRef } = usePopover()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) {
      if (panelRef.current?.contains(document.activeElement)) {
        triggerRef.current?.focus({ preventScroll: true })
      }
      return
    }

    panelRef.current?.focus({ preventScroll: true })

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault()
        setOpen(false)
      }
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen, setOpen, rootRef, triggerRef])

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={panelRef}
          layoutId={`popover-${uniqueId}`}
          id={`popover-${uniqueId}`}
          role="dialog"
          aria-labelledby={`popover-label-${uniqueId}`}
          tabIndex={-1}
          className={cn(
            "absolute z-50 h-[200px] w-[364px] overflow-hidden border border-zinc-950/10 bg-white outline-none dark:bg-zinc-700",
            className
          )}
          style={{ borderRadius: 12 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function PopoverLabel({ children, className }: PopoverPartProps) {
  const { uniqueId } = usePopover()

  return (
    <motion.span
      layoutId={`popover-label-${uniqueId}`}
      id={`popover-label-${uniqueId}`}
      className={cn("absolute top-3 left-4 text-sm text-zinc-500 select-none dark:text-zinc-400", className)}
    >
      {children}
    </motion.span>
  )
}

export function PopoverCloseButton({ className }: { className?: string }) {
  const { setOpen } = usePopover()

  return (
    <button
      type="button"
      className={cn("flex items-center", className)}
      onClick={() => setOpen(false)}
      aria-label="Close popover"
    >
      <X aria-hidden="true" size={16} />
    </button>
  )
}
