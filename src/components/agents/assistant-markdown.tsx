import { harden } from "rehype-harden"
import type { ReactNode } from "react"
import { Streamdown, defaultRehypePlugins, useIsCodeFenceIncomplete, type StreamdownProps } from "streamdown"
import { AgentCode, type AgentCodeLanguage } from "@/components/agents/agent-code"

export interface AssistantMarkdownProps {
  readonly text: string
  readonly streaming?: boolean
}

const LANGS: Record<string, AgentCodeLanguage> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  css: "css",
  diff: "diff",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  text: "text",
  tsx: "tsx",
  jsx: "tsx",
  typescript: "typescript",
  ts: "typescript"
}

const languageOf = (className: string | undefined): AgentCodeLanguage => {
  const raw = className?.replace(/^language-/, "").split(/\s/)[0]?.toLowerCase() ?? "text"
  return LANGS[raw] ?? "text"
}

const textOf = (children: unknown): string =>
  Array.isArray(children) ? children.map(textOf).join("") : typeof children === "string" || typeof children === "number" ? String(children) : ""

const allowedProtocols = new Set(["http:", "https:", "mailto:"])

/** Drop javascript, data, and relative URLs. */
export const safeUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === "invalid.invalid") return ""
    return allowedProtocols.has(parsed.protocol) ? url : ""
  } catch {
    return ""
  }
}

const rehypePlugins = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      defaultOrigin: "https://invalid.invalid",
      allowedProtocols: ["http", "https", "mailto"],
      // Prefixes are origin-matched against defaultOrigin; "*" plus safeUrl is the allow list.
      allowedLinkPrefixes: ["*"],
      allowedImagePrefixes: [],
      allowDataImages: false,
      linkBlockPolicy: "text-only",
      imageBlockPolicy: "remove"
    }
  ]
] as NonNullable<StreamdownProps["rehypePlugins"]>

function Fence(props: Record<string, unknown>) {
  const incomplete = useIsCodeFenceIncomplete()
  const code = textOf(props.children).replace(/\n$/, "")
  return <AgentCode code={code} language={languageOf(typeof props.className === "string" ? props.className : undefined)} className={incomplete ? "opacity-80" : undefined} />
}

const markdownComponents = {
  inlineCode: ({ children, className }: { children?: ReactNode; className?: string }) => <code className={className}>{children}</code>,
  code: Fence
} as StreamdownProps["components"]

export function AssistantMarkdown({ text, streaming = false }: AssistantMarkdownProps) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      skipHtml
      parseIncompleteMarkdown
      remend={{ linkMode: "text-only" }}
      disallowedElements={["img"]}
      unwrapDisallowed
      controls={false}
      lineNumbers={false}
      urlTransform={safeUrl}
      rehypePlugins={rehypePlugins}
      linkSafety={{ enabled: false }}
      components={markdownComponents}
    >
      {text}
    </Streamdown>
  )
}
