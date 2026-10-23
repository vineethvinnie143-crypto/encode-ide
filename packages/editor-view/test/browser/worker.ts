/** The highlighting worker the test page starts: the editor's own, as the app's renderer starts it. */
import { serveHighlighting, type HighlightPort } from '@encode/editor/highlight-worker'

serveHighlighting(self as unknown as HighlightPort)
