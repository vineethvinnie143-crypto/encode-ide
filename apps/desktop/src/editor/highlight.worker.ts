/** The editors' highlighting worker: tokenizes on its own thread what the editors send it. */
import { serveHighlighting, type HighlightPort } from '@encode/editor/highlight-worker'

serveHighlighting(self as unknown as HighlightPort)
