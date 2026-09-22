# 0001. A page package covers every path the thread skinned

Status: accepted, 2026-09-16

## Context

A thread that redesigns two pages of one site could publish only one of them.

`Applied` held one `skin` slot, one `css` slot and one `script` slot for the whole
thread, and `appliedFrom` merged every tool result into those three. A second
`write_skin` on a second URL therefore replaced the first, and `read_morph_source`
listed only the page the reader was on last. Seen live on `f5bot.com`: the thread
skinned `/` and then `/login`, and the source read back as the login page alone.

`pageScopeOf` compounded it. It named `paths: [new URL(tab.url).pathname]`, so even a
package whose code covered two pages installed on one of them.

Everything downstream already took several paths. `parseManifest` validates a path
array, and `installer.ts` writes one registration per path. Only the two places above
were single-valued.

## Decision

A page package covers a set of paths. `Applied` keeps one slot set per path, the
package's entry chooses a page by `location.pathname`, and the release names every path.

A package with one path keeps exactly the layout it had: `page.tsx` at the root, its
components beside it, `style.css` and `design.css`. Nothing about an existing release
changes, and the digests of a single-page publish stay what they were.

A package with several paths gets a generated entry. Each path's files move under
`pages/<slug>/`, and the root `page.tsx` imports them and renders the one whose path
matches. The slug comes from the path and is only a folder name; the paths themselves
travel in the release's scope, not in the folder names.

Per-path CSS travels in the generated entry, not in `style.css`. CSS cannot ask which
path it is on, and scoping rules by rewriting them would need a CSS parser that the
extension and the server must agree on byte for byte. The entry already branches on the
path, so it injects that path's stylesheet itself. `style.css` keeps what is genuinely
shared: the site's design tokens.

## Consequences

The compiler accepts one more file shape, `pages/<slug>/…`, and refuses the same
everything else. Both sides run the same `compilePagePackage`, so the server needs no
separate rule; the generated entry is part of the source it receives and rebuilds.

A reader installing a two-page package gets two registrations carrying the same script
and stylesheet, which is what `installer.ts` already does for a multi-path manifest.

Per-path CSS arrives with the script rather than as a page stylesheet, so it lands one
frame later than a single-path package's `style.css`. Shared tokens still arrive as a
stylesheet, so the page's colours do not flash.

A thread recorded before this change has tool results with no path on them. Those read
as the page the thread is on now, which is what the old single-slot behaviour meant.
