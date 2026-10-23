import { basic } from './scenarios/basic.mjs'
import { pointer } from './scenarios/pointer.mjs'
import { scale } from './scenarios/scale.mjs'
import { text } from './scenarios/text.mjs'
import { find } from './scenarios/find.mjs'
import { review } from './scenarios/review.mjs'
import { edit } from './scenarios/edit.mjs'
import { host } from './scenarios/host.mjs'
import { fold } from './scenarios/fold.mjs'
import { structure } from './scenarios/structure.mjs'
import { hints } from './scenarios/hints.mjs'

export const scenarios = [...basic, ...pointer, ...scale, ...text, ...find, ...review, ...edit, ...host, ...fold, ...structure, ...hints]
