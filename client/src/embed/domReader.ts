/**
 * Read the page the widget is embedded in into a listing of controls.
 *
 * Vision tells the agent what the page looks like; this tells it what is on
 * the page and what each thing is called. The difference decides whether an
 * instruction can name a real control ("click Compose") or has to describe a
 * location and hope ("the button near the top right"), which is where the
 * observed defects came from: instructions that went backwards, the same step
 * repeated four times, and success claimed before it happened. None of those
 * are possible once success can be observed instead of guessed.
 *
 * Pure functions over a Document, so the rules below are testable without a
 * browser and without LiveKit.
 */

/** One control the agent may refer to, and in Phase B act on. */
export interface PageElement {
  ref: string;
  role: string;
  name: string;
  visible: boolean;
}

export interface PageListing {
  url: string;
  title: string;
  capturedAt: number;
  elements: PageElement[];
  /** Set when elements were dropped to stay under the cap. */
  truncated?: number;
}

/**
 * Interactive and labelled elements only, never the whole DOM.
 *
 * A listing that blows the context window is worse than no listing: it costs
 * tokens on every subsequent turn and buries the handful of controls that
 * matter among hundreds that do not.
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role]",
  "[contenteditable]:not([contenteditable=false])",
].join(",");

/**
 * Cap from the spec. Elements inside the viewport are kept first, because the
 * control the user is being guided to is almost always one they can see.
 */
export const MAX_ELEMENTS = 200;

/**
 * Roles whose value is never read, whatever else is true of them.
 *
 * By tag and attribute rather than `instanceof`: an element inside a
 * same-origin iframe belongs to another realm and is not an instance of this
 * realm's HTMLInputElement, so instanceof would answer "not a password field"
 * for exactly the fields most worth protecting.
 */
function isPasswordField(el: Element): boolean {
  return (
    el.tagName.toLowerCase() === "input" &&
    (el.getAttribute("type") || "").toLowerCase() === "password"
  );
}

/**
 * Resolve an element's accessible name.
 *
 * Order follows the spec: aria-label, aria-labelledby, visible text,
 * placeholder, title, alt. It is a deliberate simplification of the real
 * accname algorithm -- enough to name a control the way a user would read it,
 * and short enough to reason about.
 */
export function accessibleName(el: Element, doc: Document = el.ownerDocument): string {
  // A password field is named but never described by its content, so no
  // branch below can reach its value.
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  // A <label for=...> or a wrapping <label> is how most form fields are named.
  //
  // Compared by attribute rather than built into a selector: an id may contain
  // quotes, brackets or a leading digit, and CSS.escape is not everywhere the
  // widget runs -- a throw here would lose the whole capture, not one name.
  if (el.id) {
    for (const label of Array.from(doc.querySelectorAll("label[for]"))) {
      if (label.getAttribute("for") === el.id) {
        const text = label.textContent?.trim();
        if (text) return text;
        break;
      }
    }
  }
  const wrapping = el.closest("label");
  if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();

  if (!isPasswordField(el)) {
    const text = el.textContent?.trim();
    if (text) return text;
  }

  for (const attr of ["placeholder", "title", "alt"]) {
    const value = el.getAttribute(attr);
    if (value?.trim()) return value.trim();
  }

  const valueAttr = el.getAttribute("value");
  if (valueAttr?.trim() && !isPasswordField(el)) return valueAttr.trim();

  return "";
}

/**
 * The role the agent should call this element.
 *
 * An explicit role wins, because that is what assistive technology honours
 * and therefore what the page author meant.
 */
export function elementRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit?.trim()) return explicit.trim().toLowerCase();

  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    // Absent type means text, matching how the browser treats it.
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return type;
    if (type === "submit" || type === "button" || type === "reset") return "button";
    if (type === "password") return "password";
    return "textbox";
  }
  if (el.hasAttribute("contenteditable")) return "textbox";
  return tag;
}

/**
 * Whether the element is rendered at all.
 *
 * Not the same question as "in the viewport" -- a control below the fold is
 * still real and still worth listing, it just sorts later.
 */
export function isRendered(el: Element, win: Window): boolean {
  if (el.hasAttribute("hidden")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const style = win.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isInViewport(el: Element, win: Window): boolean {
  const rect = el.getBoundingClientRect();
  const height = win.innerHeight || 0;
  const width = win.innerWidth || 0;
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}

/**
 * Capture the current page as a listing the agent can name controls from.
 *
 * Refs are stable only within one capture. Every capture renumbers, so the
 * agent must act on the newest listing and never on a remembered ref -- a
 * ref that survived a re-render would point at whatever now sits in that
 * position, which is how an agent clicks the wrong thing confidently.
 */
export function capturePage(doc: Document, win: Window = doc.defaultView!): PageListing {
  const seen: { el: Element; visible: boolean }[] = [];

  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (!isRendered(el, win)) continue;
    seen.push({ el, visible: isInViewport(el, win) });
  }

  // Visible first, original document order preserved within each group, so
  // the listing still reads top-to-bottom the way the page does.
  const ordered = [
    ...seen.filter((e) => e.visible),
    ...seen.filter((e) => !e.visible),
  ];
  const kept = ordered.slice(0, MAX_ELEMENTS);

  const elements: PageElement[] = kept.map((entry, index) => ({
    ref: `ref_${index + 1}`,
    role: elementRole(entry.el),
    // A password field is listed so the agent knows the box exists, and named
    // empty so nothing about its content can leave the browser. The value is
    // never read on any path -- see accessibleName.
    name: isPasswordField(entry.el) ? "" : accessibleName(entry.el, doc),
    visible: entry.visible,
  }));

  const listing: PageListing = {
    url: win.location?.href ?? "",
    title: doc.title ?? "",
    capturedAt: Date.now(),
    elements,
  };
  if (ordered.length > kept.length) listing.truncated = ordered.length - kept.length;
  return listing;
}

/**
 * Resolve a ref back to its element, against a capture taken at the same
 * moment as the listing the agent is holding.
 *
 * Returns null rather than guessing. A ref the page no longer has is the
 * normal result of the page moving on, and the honest answer is to say so and
 * re-read, not to act on the nearest thing.
 */
export function resolveRef(
  ref: string,
  doc: Document,
  win: Window = doc.defaultView!,
): Element | null {
  const match = /^ref_(\d+)$/.exec(ref);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  if (index < 0) return null;

  const seen: { el: Element; visible: boolean }[] = [];
  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (!isRendered(el, win)) continue;
    seen.push({ el, visible: isInViewport(el, win) });
  }
  const ordered = [
    ...seen.filter((e) => e.visible),
    ...seen.filter((e) => !e.visible),
  ].slice(0, MAX_ELEMENTS);

  return ordered[index]?.el ?? null;
}
