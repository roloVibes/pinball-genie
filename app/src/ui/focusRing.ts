// ui/focusRing.ts — the two DOM walks every focus trap in this app needs:
// "what can Tab land on inside this dialog" and "is this node inside it".
//
// WHY ITS OWN FILE (2026-10-14). These lived privately in ui/sheet.ts. The
// first-run guide (ui/howto.ts) is aria-modal and needed the same Tab trap,
// but importing ui/sheet.ts from it would drag sheet.ts and sheet.css into
// the CORE bundle — howto.ts is statically imported by main.ts/app.ts, while
// sheet.ts otherwise only arrives with the lazy glossary/map chunks. A
// dependency-free module both can import keeps one implementation without
// moving anything into the first download.
//
// WALKS `.children` BY HAND rather than calling querySelectorAll or
// Node.contains: this app's suites drive the real modules against hand-rolled
// fake DOM elements (tests/study.test.mjs's FakeElement and friends), which
// implement children/tagName/getAttribute but no selector engine and no
// contains(). A focus trap that only works in a browser is a focus trap no
// test can prove.

const FOCUSABLE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'])

/** Focusable descendants of `root`, in DOM order. Skips `hidden` subtrees,
 *  disabled controls, tabindex="-1", and an <a> with no href (not a link). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  const visit = (el: HTMLElement): void => {
    const kids = (el.children ?? []) as unknown as ArrayLike<unknown>
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as HTMLElement | undefined
      if (!child || typeof child.tagName !== 'string') continue
      if (child.hidden) continue
      const tabindex = child.getAttribute?.('tabindex') ?? null
      const disabled = (child as HTMLButtonElement).disabled === true
      const naturally = FOCUSABLE_TAGS.has(child.tagName) && !(child.tagName === 'A' && !child.getAttribute?.('href'))
      if (!disabled && tabindex !== '-1' && (naturally || tabindex !== null)) out.push(child)
      visit(child)
    }
  }
  visit(root)
  return out
}

/** `root.contains(node)`, done by walking children (see this file's header). */
export function containsNode(root: HTMLElement, node: unknown): boolean {
  if (!node) return false
  if (root === node) return true
  const kids = (root.children ?? []) as unknown as ArrayLike<unknown>
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as HTMLElement | undefined
    if (child && typeof child.tagName === 'string' && containsNode(child, node)) return true
  }
  return false
}
