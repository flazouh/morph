import type { Compiler } from "../skin/service"
import type { Designs } from "./designs"
import type { Page } from "./page"
import type { Web } from "./web"

/** Everything a tool may reach: the page, the site designs, the skin compiler, and the web. */
export type World = Page | Designs | Compiler | Web
