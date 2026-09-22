# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The existing Chrome extension uses React, TypeScript, Vite, Bun, and Manifest V3.

The marketplace uses Railway for accounts, private data, catalog indexes, popularity, reports, and publishing operations.

Public redesign packages and their open-source history live on GitHub.

## Users

The primary users want a better interface for a website without building one themselves.

Creators use the extension agent to make, test, version, and publish redesigns.

## Product Purpose

Redesign lets people replace part or all of a website with an installable community redesign.

Success means a person can find a compatible redesign, inspect it, install it, update it, and undo it safely.

## Positioning

Each marketplace item is both an immediate browser installation and an open-source project that another creator can inspect and fork.

## Operating Context

People discover redesigns in a full web marketplace.

The extension card stays available across page navigation and handles creation, current-site matches, installs, active redesigns, and rollback.

Browsing and installing do not require an account. Forking and publishing require sign-in.

## Capabilities and Constraints

- A package includes editable source, compiled output, and a manifest.
- The manifest records URL scope, page scope, author, license, compatibility, and version metadata.
- Installs must show permissions and source before activation.
- Updates must preserve version history and one-click rollback.
- Reports, popularity, and private account data live on Railway.
- Public source packages and version history live on GitHub.
- OpenRouter credentials are only for creation.
- GitHub or account credentials are only for publishing.

## Evidence on Hand

The extension can compile React skin sources, persist scripts and styles, restore an open card after navigation, and publish a redesign to the marketplace.

No public marketplace data, customer proof, or production usage metrics exist yet. Product surfaces must not invent them.

## Product Principles

- Install without an account.
- Keep public redesign code inspectable and forkable.
- Explain scope and permissions before activation.
- Make every installed version reversible.
- Keep creation credentials separate from marketplace use.

## Accessibility & Inclusion

Marketplace and extension controls must support keyboard use, visible focus, reduced motion, readable contrast, and semantic status messages.
