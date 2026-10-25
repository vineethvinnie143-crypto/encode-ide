# 0121. The Computer tool numbers what it shows, and checks what it hits

- Status: Accepted, builds on 0050 and 0120
- Date: 2026-10-25

## Context

After 0120, the owner asked what makes the Computer tool precise, and then for it "at its maximum precise level",
for anything on the screen and not only for applications. These were the weak points:

- **Matching a picture to a ref.** The model got an image and an outline with refs (e12), but nothing tied what it
  saw to a line of the outline. A model that saw "the second Save button" had to guess which ref that was, or fall
  back to a coordinate.
- **Coordinates were estimated by eye.** For what the outline does not list (a canvas, a game, a window whose
  application lists nothing), the model guessed pixels from the picture. A zoom showed the area at the screen's own
  size at most, so a 16-pixel icon stayed 16 pixels.
- **A click by coordinate was not checked.** The answer said "Clicked (120, 65)", whatever was there.
- **An element out of view failed.** An item scrolled out of a list was "not in view", and the model had to scroll
  by hand and look again.
- **The taskbar and the desktop were not reachable.** The notification area, quick settings and desktop icons all
  counted as "the shell", which is refused, so tray icons and the Wi-Fi and volume buttons could not be used.

## Decision

- **Numbers on the screenshot.** The helper draws, on the image it sends, a coloured tag with the number of each
  element's ref beside the element (12 for e12), and a thin frame around small ones. The model reads the number off
  the picture and acts on that ref.
  - Only elements a person would use get a number: those with an action other than scrolling, and controls (buttons,
    boxes, links, items, cells and the like). Containers would cover the picture with frames that say nothing.
  - Skipped: boxes under 4 pixels, anything under another window, and elements covering more than half the picture,
    except text and document areas.
  - At most 150 numbers. When there are more, those that act come first.
  - A tag sits above the element's top-left corner, or at the next of four places that hides no other tag.
  - The numbers are drawn after the helper compares the image with the previous one, so they never count as a
    change. Only a model that reads pictures gets them; a zoom gets none.
- **A grid where nothing can be numbered.** A window that lists nothing to number gets a grid labelled in its own
  pixels instead (a line every 100 pixels), so a coordinate is read, not guessed.
- **A zoom enlarges, with a grid in screenshot pixels.** A zoom is now sent as large as the image budget allows, up to
  four times the screen, and carries a grid whose labels are pixels of the screenshot it enlarges. The model reads
  the coordinate for the next step off the label, in the screenshot's pixels it already uses. The answer says how
  many times larger the zoom is.
- **The answer says what was hit.** Before a pointer action, the helper asks the window's interface which element is
  under the point (`AutomationElement.FromPoint`), walking up to the nearest element the outline would list. A click,
  move, drag or scroll by coordinate answers with it: `Clicked (120, 65) on e2 menuitem "File"`. An action on an
  element says what was hit instead when it was something else.
- **The landing point is checked.** For an action on an element, the pointer goes to the element's centre, unless the
  window's interface says something else is there. Then it tries points a quarter in from each side. If something of
  the window is over the element at every point tried, the answer says so.
- **Out of view is scrolled into view.** An element whose box is empty, off screen or outside its window is scrolled
  into view through its list's own interface (`ScrollItemPattern`) before the pointer goes there. The answer says it
  was.
- **The taskbar and the desktop are windows like others.**
  - The taskbar (both taskbars on two screens), the notification area, its overflow and quick settings are the
    application "Taskbar". It takes the pointer only: typing, keys and setting values are refused. A click on the
    taskbar can only press what is on it.
  - The desktop (its icons) is a window of File Explorer, under the same approval as File Explorer. Its caution now
    says that files deleted there skip eNCode's checkpoints, and that a program opened there runs without the command
    approval.
  - The Start menu, search and the Run box stay refused: they start programs and commands without the command
    approval. `open` is the way to start an application.
  - A taskbar window never counts as part of the program it belongs to, so a click meant for Explorer cannot land on
    the taskbar, and a click meant for the taskbar cannot land on Explorer.
- **The tool's description says how.** Numbers come first, coordinates only for what has no number, a zoom before
  clicking something small, and a check of what the answer says was hit. Signing out and shutting down join the steps
  to ask about first.

## Consequences

- The model acts by ref far more often, because it can see which ref a thing has. Clicks by coordinate are rarer, and
  each is read off a grid and checked after.
- Numbers cover some of the picture. Tags are small, take the first free place, and stay off containers. The outline
  still has every element, and a zoom shows the area clean.
- The hit check costs one interface call per pointer action. It is best effort: an application whose interface does
  not answer leaves the answer as it was before.
- Desktop icons and the taskbar are usable, under File Explorer's approval and the Taskbar's. Quick settings can turn
  Wi-Fi or Bluetooth off; the description already says to ask before anything that cannot be undone.
- Tests:
  - `parity.test.ts` checks the helper's numbering and grid rules against the cases the description gives, compiled
    with the real C#: which elements get numbers, where tags go, grid spacing and lines, and the zoom size.
  - `tool.test.ts` covers the requests, the text the model reads for numbers, grids, zoom and hits, and the
    taskbar's refusals. `validate.test.ts` covers the new fields.
  - The Windows integration test runs on a real desktop:
    - numbers are drawn and do not count as a change;
    - a zoom is four times larger, with grid lines at the right pixels;
    - a click by coordinate names the button it hit;
    - an item scrolled out of a list is scrolled back and double-clicked;
    - the taskbar and the desktop are listed when the runner has them.
