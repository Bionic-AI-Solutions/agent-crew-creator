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
 * Longest accessible name kept.
 *
 * A name is written by the page, so its length is chosen by the page. Without
 * a cap, one element with a 50,000-character aria-label crowds out every real
 * control in the agent's listing -- a page can blind the agent to itself with
 * a single attribute.
 */
export const MAX_NAME_CHARS = 120;

/**
 * Flatten a name into something that cannot be mistaken for structure.
 *
 * The listing becomes one line per control in the model's context, so a name
 * containing a newline could forge a line -- a whole fake [PAGE] block, fake
 * refs, fake rules. Collapsing every run of whitespace, including newlines and
 * control characters, removes the ability to forge a line at all rather than
 * relying on the model to disbelieve one.
 */
export function cleanName(raw: string): string {
  const flat = raw
    // Control characters.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    // Invisible characters are removed, not spaced: a zero-width space inside
    // a word is not a word break, and turning it into one would make the name
    // read differently from how it looks.
    // The Unicode format category, not a remembered list of ranges: the list
    // missed soft hyphen, the Arabic letter mark and the entire tag block.
    // Plus the invisibles Unicode does not classify as Cf.
    .replace(/[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/gu, "")
    // Unpaired surrogates. Matching a VALID pair first is what makes this
    // right: the previous version used a lookbehind-ish chained pair of
    // regexes, and in a run of three lone low surrogates the middle one was
    // consumed as the harmless prefix of the next match and survived.
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) =>
      m.length === 2 ? m : " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= MAX_NAME_CHARS) return flat;
  // Truncate to MAX_NAME_CHARS - 1 so the result including the ellipsis is
  // exactly MAX_NAME_CHARS. Adding it on top produced 121 characters, and the
  // agent re-cleans to 120 -- cutting off the ellipsis and nothing else, so
  // the model saw truncated text that looked complete.
  let cut = flat.slice(0, MAX_NAME_CHARS - 1);
  // Never end on half a character. A lone surrogate survives JSON but is not
  // encodable as UTF-8, so it would be a crash waiting for the first consumer
  // that touches the raw name instead of a JSON-escaped copy of it.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + "…";
}

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
function rawAccessibleName(el: Element, doc: Document): string {
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
 * An element's accessible name, flattened and bounded.
 *
 * Every caller goes through here; nothing reads the raw attribute, so there
 * is no path by which an unflattened name reaches the listing.
 */
export function accessibleName(el: Element, doc: Document = el.ownerDocument): string {
  return cleanName(rawAccessibleName(el, doc));
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
 * Which element each ref names, so a ref identifies a control rather than a
 * position in a list.
 *
 * Refs used to be assigned by position on every capture and resolved by
 * re-walking the DOM at act time, which meant `ref_3` was only ever "whatever
 * is third right now". Between the listing the agent read and the click it
 * sent -- a toast appearing, a table row loading, any ordinary re-render --
 * the same ref became a different control, and the agent pressed it
 * confidently. Adding an expected-name check caught most of that, but not the
 * case that matters most in real UI: a table of rows each with its own
 * "Edit", where the name matches perfectly and the row is wrong.
 *
 * So a ref now sticks to its element. An element that was ref_3 keeps ref_3
 * for as long as it is on the page, whatever moves around it, and a ref whose
 * element is gone resolves to nothing rather than to its replacement. Refs
 * are not renumbered, so they are not contiguous -- that is the point.
 *
 * Per document, because a same-origin iframe is a different page with its own
 * numbering. WeakRef/WeakMap throughout: nothing here keeps a removed element
 * alive.
 */
interface RefRegistry {
  byElement: WeakMap<Element, string>;
  byRef: Map<string, WeakRef<Element>>;
  /** Refs mean nothing across a navigation; this is how we notice one. */
  url: string;
}

/**
 * Never reused, for the lifetime of the page.
 *
 * Deliberately NOT per registry. It was, and a registry is rebuilt whenever
 * the URL changes -- so numbering restarted at 1 and refs were handed out
 * again to different elements. A ref the agent was still holding then
 * resolved, in the new registry, to whatever now owned that string, and the
 * name check was the only thing left standing between that and a click. On a
 * table of identically-named controls it is not standing at all, which is the
 * precise failure the whole identity design exists to prevent -- reintroduced
 * by the reset, and reachable by a plain history.pushState. The agent's own
 * click can cause one.
 *
 * Monotonic means a stale ref finds nothing, which is the honest answer.
 */
let nextRef = 1;

const registries = new WeakMap<Document, RefRegistry>();

/**
 * Drops byRef entries once their element has been collected.
 *
 * byRef is a strong Map of WeakRefs: the elements can be collected but the
 * entries never were, so a long-lived page accumulated one dead entry per
 * control it had ever shown. Measured at ~14 MB after an hour of a churning
 * SPA -- in the customer's page, not ours.
 *
 * Guarded because FinalizationRegistry is absent in older environments and in
 * some test runtimes; without it the Map simply behaves as it did before.
 */
const refCleanup =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<{ reg: RefRegistry; ref: string }>(({ reg, ref }) => {
        if (reg.byRef.get(ref)?.deref() === undefined) reg.byRef.delete(ref);
      })
    : null;

function registryFor(doc: Document, url: string): RefRegistry {
  let reg = registries.get(doc);
  if (!reg || reg.url !== url) {
    reg = { byElement: new WeakMap(), byRef: new Map(), url };
    registries.set(doc, reg);
  }
  return reg;
}

/**
 * The ref this element already has, or one that has never been used.
 *
 * The byRef check is not redundant: a registry rebuilt by a navigation, or a
 * ref whose WeakRef has been collected, must not hand the same string to two
 * different elements.
 */
function refFor(reg: RefRegistry, el: Element): string {
  const existing = reg.byElement.get(el);
  if (existing && reg.byRef.get(existing)?.deref() === el) return existing;
  const ref = `ref_${nextRef++}`;
  reg.byElement.set(el, ref);
  reg.byRef.set(ref, new WeakRef(el));
  refCleanup?.register(el, { reg, ref });
  return ref;
}

/** Exposed for tests only; nothing in the widget resets numbering. */
export function __resetRefNumberingForTest(): void {
  nextRef = 1;
}

/**
 * The name the agent is shown for a control -- the single definition of it.
 *
 * capturePage used to compute this inline while usePageActions called
 * accessibleName directly at act time, and the two disagreed on password
 * fields: listed as "" so nothing about their contents can leave the browser,
 * but accessibleName gives them their label, so the agent's echoed name never
 * matched and the action was refused as "the page changed" instead of as the
 * password field it is. Two definitions of one thing is how that happens, so
 * there is one.
 *
 * A password field is listed so the agent knows the box exists, and named
 * empty so nothing about its content can leave the browser. The value is
 * never read on any path -- see accessibleName.
 */
export function listedName(el: Element, doc: Document): string {
  return isPasswordField(el) ? "" : accessibleName(el, doc);
}

/**
 * Capture the current page as a listing the agent can name controls from.
 *
 * A ref names one control and keeps naming it -- see RefRegistry above. The
 * agent should still act on the newest listing, because a control can be
 * removed, renamed or scrolled out of view between captures; what it can no
 * longer do is act on the WRONG control by using a ref that outlived the
 * arrangement it was numbered in.
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

  const reg = registryFor(doc, win.location?.href ?? "");
  const elements: PageElement[] = kept.map((entry) => ({
    ref: refFor(reg, entry.el),
    role: elementRole(entry.el),
    name: listedName(entry.el, doc),
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
  if (!/^ref_\d+$/.test(ref)) return null;

  // Resolved by identity, never by re-walking the DOM to that position. The
  // whole point of the registry is that "the element this ref named" and
  // "whatever is in that slot now" are different questions, and only the
  // first one is safe to act on.
  const reg = registries.get(doc);
  if (!reg || reg.url !== (win.location?.href ?? "")) return null;

  const el = reg.byRef.get(ref)?.deref();
  if (!el) return null;
  // Gone from the page, or hidden since: either way it is not something to
  // act on, and the caller asks for a fresh listing instead.
  if (!el.isConnected || el.ownerDocument !== doc) return null;
  if (!isRendered(el, win)) return null;
  return el;
}
