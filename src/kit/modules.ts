import { HugeiconsIcon } from "@hugeicons/react"
import { GodRays, GrainGradient, MeshGradient, StaticMeshGradient } from "@paper-design/shaders-react"
import * as motion from "motion/react"
import * as React from "react"
import * as ReactDOM from "react-dom"
import * as jsxRuntime from "react/jsx-runtime"
import { AnimatedBadge } from "@/components/motion/animated-badge"
import { BouncyAccordion } from "@/components/motion/bouncy-accordion"
import { Button, ButtonLink } from "@/components/motion/button/base"
import { Checkbox } from "@/components/motion/checkbox"
import { Input } from "@/components/motion/input"
import { Loader } from "@/components/motion/loader"
import { NumberTicker } from "@/components/motion/number-ticker"
import { RadioGroup, RadioGroupItem } from "@/components/motion/radio"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/motion/select"
import { Switch } from "@/components/motion/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/motion/tabs"
import { TextReveal } from "@/components/motion/text-reveal"
import { TiltCard } from "@/components/motion/tilt-card"
import { Tooltip } from "@/components/motion/tooltip"
import { cn } from "@/lib/utils"
import { MODULE_IDS, isModuleId, type ModuleId } from "./module-ids"
import type { SkinExtras } from "./skin-script"

/**
 * What a compiled skin may `require`: React, so the skin and the kit share one copy;
 * motion; `beui`, the components under the names the docs give them; Hugeicons; and
 * Paper Shaders. The icon component lives here, while each skin carries only its imported
 * icon data (see ICONS_MODULE). A name outside this table is refused twice.
 */
export const beui = {
  Button,
  ButtonLink,
  Badge: AnimatedBadge,
  NumberTicker,
  TextReveal,
  Tooltip,
  Switch,
  Checkbox,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Accordion: BouncyAccordion,
  Loader,
  TiltCard,
  MeshGradient,
  GrainGradient,
  StaticMeshGradient,
  GodRays,
  cn
} as const

export const modules: Readonly<Record<ModuleId, unknown>> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-dom": ReactDOM,
  "motion/react": motion,
  beui,
  "@hugeicons/react": { HugeiconsIcon },
  "@hugeicons/core-free-icons": {}
}

export const requireModule = (id: string, extras: SkinExtras = {}): unknown => {
  // By id, not by lookup: `require("constructor")` must not answer with Object.prototype's.
  if (!isModuleId(id)) throw new Error(`__beui.skin: no module named ${JSON.stringify(id)}; a skin may import ${MODULE_IDS.join(", ")}`)
  const extra = Object.hasOwn(extras, id) ? extras[id] : undefined
  return extra === undefined ? modules[id] : { ...(modules[id] as object), ...extra }
}
