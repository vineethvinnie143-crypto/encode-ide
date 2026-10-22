import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { boxToImage, center, contains, fitImage, insideImage, toImage, toScreen } from './geometry'

describe('fitting an image', () => {
  it('sends a window that fits as it is', () => {
    assert.deepEqual(fitImage(800, 600), { width: 800, height: 600, scale: 1 })
    assert.deepEqual(fitImage(1568, 700), { width: 1568, height: 700, scale: 1 })
  })

  it('shrinks by the longest edge or by the pixel budget, whichever asks for more', () => {
    const wide = fitImage(3200, 800)
    assert.equal(wide.width, 1568)
    assert.equal(wide.height, 392)
    const square = fitImage(2000, 2000)
    assert.ok(square.width * square.height <= 1_150_000 * 1.001)
    assert.equal(square.width, square.height)
  })

  it('never makes an image larger, and survives an empty window', () => {
    assert.equal(fitImage(100, 50).scale, 1)
    assert.deepEqual(fitImage(0, 50), { width: 0, height: 0, scale: 1 })
  })
})

describe('coordinates', () => {
  const capture = { box: [100, 50, 2000, 1000] as const, scale: 0.5, width: 1000, height: 500 }

  it('turns a pixel of the image into a pixel of the screen and back', () => {
    assert.deepEqual(toScreen([10, 20], capture), [120, 90])
    assert.deepEqual(toImage([120, 90], capture), [10, 20])
    for (const point of [[0, 0], [999, 499], [500, 250]] as const) {
      assert.deepEqual(toImage(toScreen(point, capture), capture), point)
    }
  })

  it('maps a screen box into the image and clips it', () => {
    assert.deepEqual(boxToImage([100, 50, 200, 100], capture), [0, 0, 100, 50])
    assert.deepEqual(boxToImage([-50, -50, 100, 100], capture), [0, 0, 0, 0])
    assert.deepEqual(boxToImage([2000, 900, 500, 500], capture), [950, 425, 50, 75])
  })

  it('knows the centre of a box and what it contains', () => {
    assert.deepEqual(center([10, 20, 100, 40]), [60, 40])
    assert.equal(contains([10, 20, 100, 40], [109, 59]), true)
    assert.equal(contains([10, 20, 100, 40], [110, 59]), false)
  })

  it('accepts only whole pixels inside the image', () => {
    assert.equal(insideImage([0, 0], capture), true)
    assert.equal(insideImage([999, 499], capture), true)
    assert.equal(insideImage([1000, 0], capture), false)
    assert.equal(insideImage([-1, 5], capture), false)
    assert.equal(insideImage([1.5, 5], capture), false)
  })
})
