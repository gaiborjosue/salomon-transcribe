import { Copy, Share2, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { formatShareCode, SHARE_CODE_PREFIX } from "@/lib/share-code-utils"

export function ShareSessionDrawer({
  code,
  open,
  viewerCount,
  onCopyCode,
  onOpenChange,
  onShareCode,
}: {
  code?: string
  open: boolean
  viewerCount: number
  onCopyCode: () => void
  onOpenChange: (open: boolean) => void
  onShareCode: () => void
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="border-white/10 bg-[#171717] text-white">
        <DrawerHeader className="space-y-2 text-left">
          <DrawerTitle className="text-lg font-semibold tracking-tight text-white">
            Share live session
          </DrawerTitle>
          <DrawerDescription className="text-white/45">
            Anyone with this code can follow the same translated session live.
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
            <p className="text-[11px] font-medium tracking-[0.18em] uppercase text-white/35">
              Share code
            </p>
            <div className="mt-2 text-3xl font-semibold tracking-[0.28em] text-white">
              {code ?? "......"}
            </div>
            <p className="mt-3 text-sm text-white/45">
              Best for others in the same service to join without processing the same
              audio again.
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-white/55">
              <Users className="h-3.5 w-3.5" />
              {viewerCount} joined live
            </div>
          </div>
        </div>
        <DrawerFooter>
          <Button
            type="button"
            onClick={onCopyCode}
            className="h-12 rounded-xl bg-white text-black hover:bg-white/92"
          >
            <Copy className="h-4 w-4" />
            Copy code
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onShareCode}
            className="h-12 rounded-xl text-white hover:bg-white/6 hover:text-white"
          >
            <Share2 className="h-4 w-4" />
            Share
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

export function JoinSessionDrawer({
  code,
  open,
  onCodeChange,
  onJoin,
  onOpenChange,
  onPasteCode,
}: {
  code: string
  open: boolean
  onCodeChange: (code: string) => void
  onJoin: () => void
  onOpenChange: (open: boolean) => void
  onPasteCode: () => void
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="border-white/10 bg-[#171717] text-white">
        <DrawerHeader className="space-y-2 text-left">
          <DrawerTitle className="text-lg font-semibold tracking-tight text-white">
            Join with code
          </DrawerTitle>
          <DrawerDescription className="text-white/45">
            Enter a live session code to follow the same translation feed.
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-2">
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel className="text-white/72">Share code</FieldLabel>
              <FieldContent>
                <Input
                  value={code}
                  onChange={(event) => onCodeChange(formatShareCode(event.target.value))}
                  placeholder={`${SHARE_CODE_PREFIX}-AB12CD`}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-12 border-white/10 bg-transparent text-center font-medium tracking-[0.24em] text-white placeholder:text-white/22"
                />
                <FieldDescription className="text-white/35">
                  Use the code shared by the host. If your browser allows it, we will
                  prefill a copied code automatically.
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>
        </div>
        <DrawerFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onPasteCode}
            className="h-12 rounded-xl text-white hover:bg-white/6 hover:text-white"
          >
            Paste code
          </Button>
          <Button
            type="button"
            onClick={onJoin}
            className="h-12 rounded-xl bg-white text-black hover:bg-white/92"
          >
            Join session
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
