import { basic } from './scenarios/basic.mjs'
import { pointer } from './scenarios/pointer.mjs'
import { scale } from './scenarios/scale.mjs'
import { text } from './scenarios/text.mjs'
import { find } from './scenarios/find.mjs'
import { review } from './scenarios/review.mjs'
import { edit } from './scenarios/edit.mjs'

export const scenarios = [...basic, ...pointer, ...scale, ...text, ...find, ...review, ...edit]
