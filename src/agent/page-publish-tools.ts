/**
 * Publishing the page's own redesign: the tools a thread gets when the page runs no
 * installed Morph, so what it applied can become a new root package.
 *
 * The fork tools (morph-tools.ts) publish a draft of an installed release. These publish
 * the thread itself: its applied code and the site's design, read when the tool runs, so
 * the release is what the page wears now. The two share tool names, so the model learns one
 * publish flow: read the source, show it, confirm it with `ask_user`, publish it.
 */
import type { NativeTool } from "@clavia/tardigrade"
import { Effect } from "effect"
import { pageSourceId } from "../marketplace/compiler/page"
import type { PackageSource } from "../marketplace/compiler/source"
import type { ExtensionPublisher } from "../marketplace/publishing/extension"
import type { AppliedPages } from "./applied"
import { Designs } from "./designs"
import { pageSourceOf } from "./page-package"
import { PAGE_DRAFT_ID, type PublishAuthorization, type QuestionController } from "./question"
import { asAnswer, failure, object, str, ToolFailure } from "./tool-input"
import type { World } from "./world"

/** Where a page's own redesign publishes to. */
export type PagePublisher = Pick<ExtensionPublisher, "publishPage">

export interface PagePublishContext {
  readonly publisher: PagePublisher
  /** What the thread applied so far, by path, read when a tool runs, so a later write counts. */
  readonly applied: () => AppliedPages
}

/** The license a page redesign publishes under when the reader names none. */
export const DEFAULT_LICENSE = "MIT"

const NOTHING_APPLIED = "nothing is applied on this page yet; redesign it before publishing"

export const pagePublishToolsFor = (
  publish: PagePublishContext,
  site: string,
  questions?: QuestionController
): ReadonlyArray<NativeTool<World>> => {
  /** The source as it would publish now, the paths it covers, and its id. */
  const current = Effect.fn("pagePublish.current")(function* () {
    const applied = publish.applied()
    const design = yield* Effect.flatMap(Designs, (designs) => designs.get(site))
    const built = yield* Effect.try({ try: () => pageSourceOf(applied, design), catch: failure })
    if (built === undefined) return yield* new ToolFailure({ message: NOTHING_APPLIED })
    const revisionId = yield* Effect.promise(() => pageSourceId(built.source))
    return { ...built, revisionId }
  })

  const listing = (source: PackageSource, paths: ReadonlyArray<string>, revisionId: string) => ({
    parent: null,
    draftId: PAGE_DRAFT_ID,
    revisionId,
    entry: source.entry,
    paths,
    files: Object.keys(source.files).sort(),
    license: DEFAULT_LICENSE
  })

  return [
    {
      spec: {
        name: "read_morph_source",
        description:
          "Read the redesign this thread applied, as the package it would publish: the skin files, style.css and design.css, and the paths it covers. A thread that redesigned several pages of the site publishes them as one package, each page under pages/, chosen by pathname. Omit path to list the files with the revision ID a publish confirmation needs. This page runs no installed Morph, so there is no parent.",
        inputSchema: object({ path: { type: "string", description: "One package-relative source path." } }, [])
      },
      run: (input) =>
        asAnswer(
          Effect.map(current(), ({ source, paths, revisionId }) => {
            const path = str(input, "path")
            if (path === undefined) return listing(source, paths, revisionId)
            const content = source.files[path]
            return content === undefined ? { error: `source file ${JSON.stringify(path)} does not exist` } : { path, content }
          })
        )
    },
    {
      spec: {
        name: "publish_morph",
        description:
          `Publish the redesign this thread applied as a new Morph package on the marketplace. First call read_morph_source and show the reader the name, slug, summary, version, license, revision ID and file list. Then use ask_user with one publish option and a publish_morph authorization carrying those exact fields, the revision ID, draftId "${PAGE_DRAFT_ID}" and an empty addedPermissions. The answer comes back with its own callId: pass that as confirmationCallId. GitHub sign-in starts here when needed. The page has to be the tab in front: its before and after pictures are taken now.`,
        inputSchema: object(
          {
            name: { type: "string" },
            slug: { type: "string", description: "handle/name, lowercase, where handle is the reader's GitHub handle." },
            summary: { type: "string" },
            version: { type: "string", description: "A semantic version, 1.0.0 for a first release." },
            license: { type: "string", description: `An SPDX license id. Default ${DEFAULT_LICENSE}.` },
            confirmationCallId: { type: "string", description: "The callId the accepted ask_user answer carried." }
          },
          ["name", "slug", "summary", "version", "confirmationCallId"]
        )
      },
      run: (input) =>
        asAnswer(
          Effect.flatMap(current(), ({ source, paths, revisionId }) =>
            Effect.tryPromise({
              try: async () => {
                const releaseInput = {
                  name: str(input, "name") ?? "",
                  slug: str(input, "slug") ?? "",
                  summary: str(input, "summary") ?? "",
                  version: str(input, "version") ?? ""
                }
                const authorization: PublishAuthorization = {
                  action: "publish_morph",
                  draftId: PAGE_DRAFT_ID,
                  revisionId,
                  ...releaseInput,
                  addedPermissions: []
                }
                if (questions?.authorizePublish(str(input, "confirmationCallId") ?? "", authorization) !== true) {
                  throw new Error("the reader must confirm this exact release before publishing")
                }
                const release = await publish.publisher.publishPage(source, paths, {
                  ...releaseInput,
                  license: str(input, "license") ?? DEFAULT_LICENSE,
                  approvePermissionWidening: false
                })
                questions?.spendPublish(str(input, "confirmationCallId") ?? "")
                return {
                  ok: true,
                  releaseId: release.id,
                  status: release.state,
                  slug: release.slug,
                  paths,
                  version: release.version,
                  commit: release.commit,
                  receipt: release.receipt
                }
              },
              catch: failure
            })
          )
        )
    }
  ]
}
