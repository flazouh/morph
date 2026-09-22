import { motion, useReducedMotion } from "motion/react"
import { EASE_OUT } from "@/lib/ease"
import { ThreadMascot, type ThreadMascotIdentity } from "./Mascot"

/** Before the first message: a mascot and one invite to type. */
export function EmptyState({ mascot }: { readonly mascot: ThreadMascotIdentity }) {
  const reduce = useReducedMotion() ?? false
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-10">
      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.4, ease: EASE_OUT }}
      >
        <motion.div
          animate={reduce ? undefined : { y: [0, -5, 0] }}
          transition={reduce ? undefined : { duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        >
          <ThreadMascot {...mascot} size={100} label="Friendly shape" />
        </motion.div>
      </motion.div>
      <motion.h1
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.4, delay: reduce ? 0 : 0.08, ease: EASE_OUT }}
        className="mt-5 text-center text-[15px] font-medium tracking-tight text-foreground"
      >
        What should we restyle?
      </motion.h1>
    </div>
  )
}
