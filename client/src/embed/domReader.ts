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

/**
 * DOM methods called off the prototype, not off the element.
 *
 * A form's named controls become properties of the form element, so
 * `<form role="search"><input name="hasAttribute">` -- ARIA's own recommended
 * search markup plus one attacker-chosen name -- replaces `form.hasAttribute`
 * with an input. Calling it threw straight out of capturePage, and while the
 * publisher caught that and degraded to vision-only, the RPC handlers did not
 * and every action answered "the page did not respond".
 *
 * Reading through the prototype cannot be clobbered by anything the page
 * names.
 */
/**
 * Resolved per call, from the element's OWN realm.
 *
 * Not captured once at module scope: this module is imported before any DOM
 * exists in some environments, and a same-origin iframe's elements belong to
 * a different realm whose prototypes are different objects -- the same reason
 * domGate.ts judges by tagName rather than instanceof.
 */
/**
 * The element's document, read off Node.prototype rather than the instance.
 *
 * `el.ownerDocument` is itself a shadowable read -- `<input
 * name="ownerDocument">` inside a form replaces it -- and every realm-safe
 * helper started from it, so that one name switched them all off (they fail
 * closed: the element drops out of the listing). The widget only ever
 * captures its own document, so the widget's own Node.prototype is the right
 * getter; the instance read stays as the fallback for anything else.
 */
function ownerDoc(el: Element): Document | null {
  try {
    // Walk the element's OWN prototype chain for the getter, rather than
    // reading it off a global `Node`. The chain is the element's realm by
    // construction, so this is right for an iframe's element too, and it
    // does not depend on any global existing -- the test harness for this
    // file has none, and a global-based version silently fell back to the
    // shadowed instance read there. Markup cannot alter a prototype chain;
    // only script can, which is the documented residual risk.
    let proto: object | null = Object.getPrototypeOf(el);
    for (let depth = 0; proto && depth < 12; depth++) {
      const desc = Object.getOwnPropertyDescriptor(proto, "ownerDocument");
      if (desc?.get) {
        const doc = desc.get.call(el) as Document | null | undefined;
        return doc ?? null;
      }
      proto = Object.getPrototypeOf(proto);
    }
  } catch {
    // fall through
  }
  try {
    return el.ownerDocument ?? null;
  } catch {
    return null;
  }
}

/**
 * Call a method the page may have shadowed on the instance.
 *
 * `el.click()` and `el.focus()` were the two DOM WRITES left on the action
 * path after the reads were hardened. A `<form role="button">` is a listing
 * entry and passes the gate; its `<input name="click">` replaced form.click
 * with the input, and the handler threw "el.click is not a function" into
 * "the page did not respond". Confirmed in Chromium on real markup.
 */
export function safeInvoke(el: Element, name: "click" | "focus"): boolean {
  try {
    const view = ownerDoc(el)?.defaultView as unknown as
      | Record<string, { prototype: Record<string, unknown> } | undefined>
      | undefined;
    for (const iface of ["HTMLElement", "SVGElement", "Element"]) {
      const fn = view?.[iface]?.prototype?.[name];
      if (typeof fn === "function") {
        (fn as (this: Element) => void).call(el);
        return true;
      }
    }
    const own = (el as unknown as Record<string, unknown>)[name];
    if (typeof own === "function") {
      (own as (this: Element) => void).call(el);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function realmMethod<T extends Function>(el: Element, name: string): T | null {
  try {
    const view = ownerDoc(el)?.defaultView as unknown as
      | { Element?: { prototype: Record<string, unknown> } }
      | undefined;
    const proto = view?.Element?.prototype;
    const fn = proto ? proto[name] : undefined;
    if (typeof fn === "function") return fn as unknown as T;
    // No realm to ask (a detached node in a bare environment): fall back to
    // the element's own method, which is what we had before this existed.
    const own = (el as unknown as Record<string, unknown>)[name];
    return typeof own === "function" ? (own as unknown as T) : null;
  } catch {
    return null;
  }
}

export function safeHasAttribute(el: Element, name: string): boolean {
  const fn = realmMethod<(this: Element, n: string) => boolean>(el, "hasAttribute");
  if (!fn) return false;
  try {
    return fn.call(el, name);
  } catch {
    return false;
  }
}

export function safeGetAttribute(el: Element, name: string): string | null {
  const fn = realmMethod<(this: Element, n: string) => string | null>(el, "getAttribute");
  if (!fn) return null;
  try {
    return fn.call(el, name);
  } catch {
    return null;
  }
}

/** A property whose getter lives on a prototype the page can shadow. */
function realmGetter<T>(el: Element, protoName: "Element" | "Node", prop: string): T | null {
  try {
    const view = ownerDoc(el)?.defaultView as unknown as
      | Record<string, { prototype: object } | undefined>
      | undefined;
    const proto = view?.[protoName]?.prototype;
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, prop) : undefined;
    if (desc?.get) return desc.get.call(el) as T;
    const own = (el as unknown as Record<string, unknown>)[prop];
    return (own === undefined ? null : (own as T));
  } catch {
    return null;
  }
}

/**
 * The element's tag name, which a form's own markup can shadow.
 *
 * Confirmed in Chromium: `<form><input name="tagName">` replaces
 * `form.tagName` with the input, because HTMLFormElement's named properties
 * are declared [LegacyOverrideBuiltIns]. Then `el.tagName.toLowerCase()`
 * throws, straight out of capturePage -- and the RPC handlers do not catch,
 * so every action answers "the page did not respond". No script required;
 * `<form role="search">` plus one chosen input name does it, and role="search"
 * is what puts the form in the listing in the first place.
 */
export function safeTagName(el: Element): string {
  const name = realmGetter<string>(el, "Element", "tagName");
  return typeof name === "string" ? name : "";
}

/** Text content, shadowable the same way. */
export function safeTextContent(el: Element | null | undefined): string {
  if (!el) return "";
  const text = realmGetter<string>(el, "Node", "textContent");
  return typeof text === "string" ? text : "";
}

/** The id attribute, shadowable the same way. */
export function safeId(el: Element): string {
  const id = realmGetter<string>(el, "Element", "id");
  return typeof id === "string" ? id : "";
}

/** The layout box, whose method is shadowable the same way. */
export function safeRect(el: Element): DOMRect | null {
  const fn = realmMethod<(this: Element) => DOMRect>(el, "getBoundingClientRect");
  if (!fn) return null;
  try {
    return fn.call(el);
  } catch {
    return null;
  }
}

export function safeClosest(el: Element, selector: string): Element | null {
  const fn = realmMethod<(this: Element, s: string) => Element | null>(el, "closest");
  if (!fn) return null;
  try {
    return fn.call(el, selector);
  } catch {
    return null;
  }
}

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
  /** Rendered controls dropped to stay under the cap. An exact count. */
  truncated?: number;
  /** Interactive elements the walk never examined. A bound, not a count. */
  unexamined?: number;
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
 * The hard ceiling on how many interactive elements are examined at all.
 *
 * Deliberately far above MAX_ELEMENTS. A low ceiling truncates by DOCUMENT
 * ORDER, which is not the same as truncating by usefulness: a page with 3000
 * hidden menu items declared before its visible controls -- an ordinary shape
 * for a mail or admin app -- produced an EMPTY listing, and an empty listing
 * is goals 2 and 3 gone. The early exit below is what keeps the common case
 * cheap; this is only the backstop for a page that is enormous AND mostly
 * hidden.
 */
export const MAX_RAW_ELEMENTS = 20000;

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
    safeTagName(el).toLowerCase() === "input" &&
    (safeGetAttribute(el, "type") || "").toLowerCase() === "password"
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
  const ariaLabel = safeGetAttribute(el, "aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = safeGetAttribute(el, "aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => safeTextContent(doc.getElementById(id)).trim())
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  // A <label for=...> or a wrapping <label> is how most form fields are named.
  //
  // Compared by attribute rather than built into a selector: an id may contain
  // quotes, brackets or a leading digit, and CSS.escape is not everywhere the
  // widget runs -- a throw here would lose the whole capture, not one name.
  const ownId = safeId(el);
  if (ownId) {
    for (const label of Array.from(doc.querySelectorAll("label[for]"))) {
      if (safeGetAttribute(label, "for") === ownId) {
        const text = safeTextContent(label).trim();
        if (text) return text;
        break;
      }
    }
  }
  const wrapping = safeClosest(el, "label");
  const wrappingText = safeTextContent(wrapping).trim();
  if (wrappingText) return wrappingText;

  if (!isPasswordField(el)) {
    const text = safeTextContent(el).trim();
    if (text) return text;
  }

  for (const attr of ["placeholder", "title", "alt"]) {
    const value = safeGetAttribute(el, attr);
    if (value?.trim()) return value.trim();
  }

  const valueAttr = safeGetAttribute(el, "value");
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
  const explicit = safeGetAttribute(el, "role");
  if (explicit?.trim()) return explicit.trim().toLowerCase();

  const tag = safeTagName(el).toLowerCase();
  if (tag === "a") return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    // Absent type means text, matching how the browser treats it.
    const type = (safeGetAttribute(el, "type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return type;
    if (type === "submit" || type === "button" || type === "reset") return "button";
    // A graphical submit button. The gate already refuses clicking it; the
    // listing called it a textbox, which is not what it is.
    if (type === "image") return "button";
    if (type === "password") return "password";
    return "textbox";
  }
  if (safeHasAttribute(el, "contenteditable")) return "textbox";
  return tag;
}

/**
 * Whether the element is rendered at all.
 *
 * Not the same question as "in the viewport" -- a control below the fold is
 * still real and still worth listing, it just sorts later.
 */
/** How far up to look for an ancestor that hides this control. */
const MAX_RENDER_ANCESTORS = 60;

/**
 * Does this `clip-path` clip away everything, rather than merely shape it?
 *
 * Treating any non-`none` clip-path as hiding was wrong in the direction that
 * breaks the feature: `clip-path: inset(0 round 12px)` is how a rounded-corner
 * card is drawn, and every control inside one vanished from the listing.
 * Confirmed in Chromium -- the button was plainly legible and hit-testable at
 * its own centre, and the reader dropped it.
 *
 * Only the shapes that leave nothing count. Anything else is decoration.
 *
 * `mask-image` used to be checked here too and no longer is. A fade edge
 * (`linear-gradient(black 80%, transparent)`) is an ordinary scroll-container
 * treatment, and nothing short of sampling the mask distinguishes it from one
 * that hides everything. Missing a fully-masked ancestor means the listing may
 * name a control the user cannot see; dropping every control under a fade
 * means the agent cannot guide anyone through a scrolling panel. The first is
 * a smaller wrong than the second.
 */
export function clipsEverything(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "none") return false;
  // inset() hides everything only when OPPOSITE sides meet: top+bottom or
  // left+right reaching 100%. Reading just the first value was wrong in the
  // direction that breaks the feature -- `inset(50% 0 0 0)` clips only the
  // top half, and a button in the fully painted bottom half was dropped from
  // the listing. Confirmed in Chromium: legible, hit-testable, and gone.
  const inset = /^inset\((.*)\)$/.exec(v);
  if (inset) {
    // Shorthand expands like margin: 1 = all, 2 = tb lr, 3 = t lr b, 4 = t r b l.
    // A side given in anything but % (or zero) cannot be judged, and an
    // unjudgeable side counts as 0 -- towards listing, never towards hiding.
    const raw = inset[1].split(/\bround\b/)[0].trim().split(/\s+/).filter(Boolean);
    const pct = raw.map((t) => (t.endsWith("%") ? parseFloat(t) : parseFloat(t) === 0 ? 0 : 0));
    const [a = 0, b = a, c = a, d = b] = pct;
    const [top, right, bottom, left] =
      pct.length === 1 ? [a, a, a, a] : pct.length === 2 ? [a, b, a, b] : pct.length === 3 ? [a, b, c, b] : [a, b, c, d];
    return top + bottom >= 100 || left + right >= 100;
  }
  if (/^circle\(\s*0(px|%|\s|\))/.test(v)) return true;
  if (/^ellipse\(\s*0(px|%)?\s/.test(v)) return true;
  // A polygon whose every vertex is the same point has no area.
  const poly = /^polygon\((.*)\)$/.exec(v);
  if (poly) {
    const points = poly[1].split(",").map((pt) => pt.trim().replace(/\s+/g, " "));
    if (points.length > 0 && points.every((pt) => pt === points[0])) return true;
  }
  return false;
}

export function isRendered(el: Element, win: Window): boolean {
  if (safeHasAttribute(el, "hidden")) return false;
  if (safeGetAttribute(el, "aria-hidden") === "true") return false;
  const style = win.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  const rect = safeRect(el);
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;

  // Ancestors too, for the properties that do not inherit and do not change
  // the element's own box: `opacity`, `clip-path` and `mask`. A control under
  // an `opacity: 0` panel was listed as visible:true, so the [PAGE] block
  // told the agent an invisible control was on the user's screen -- and the
  // agent then told the user to click it. `visibility` needs no walk because
  // it inherits, and `display:none` on an ancestor already zeroes the rect.
  //
  // These are the same properties controlVisibility.ts walks for our own
  // bar; the page's controls deserve the same reading.
  let node: Element | null = el.parentElement;
  for (let i = 0; i < MAX_RENDER_ANCESTORS && node; i++) {
    let ancestorStyle: CSSStyleDeclaration;
    try {
      ancestorStyle = win.getComputedStyle(node);
    } catch {
      return false;
    }
    if (ancestorStyle.opacity === "0") return false;
    if (clipsEverything(ancestorStyle.clipPath)) return false;
    node = node.parentElement;
  }
  return true;
}

function isInViewport(el: Element, win: Window): boolean {
  const rect = safeRect(el);
  if (!rect) return false;
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

  // The cap bounds the WALK, not just the listing. MAX_ELEMENTS trimmed the
  // output while every interactive element on the page was still measured --
  // and measuring means getComputedStyle plus a rect each. On a page with
  // 40,000 of them that was 205ms unthrottled and 816ms at 4x CPU throttle,
  // on the host page's main thread, twice per click. This is someone else's
  // page and someone else's conversation; it does not get to cost that.
  //
  // Deliberately more than MAX_ELEMENTS: off-screen controls sort after
  // visible ones, so the walk needs headroom to find visible controls that
  // appear late in document order before it stops.
  const all = doc.querySelectorAll(INTERACTIVE_SELECTOR);
  const walkLimit = Math.min(all.length, MAX_RAW_ELEMENTS);
  let onScreen = 0;
  let unexamined = 0;
  let exitedEarly = false;
  for (let i = 0; i < walkLimit; i++) {
    const el = all[i];
    if (!isRendered(el, win)) continue;
    const visible = isInViewport(el, win);
    if (visible) onScreen += 1;
    seen.push({ el, visible });
    // Enough on-screen controls to fill the listing: everything after this
    // would be trimmed anyway, so measuring it is pure cost. This is what
    // makes a huge page cheap -- 40,000 interactive elements went from 816ms
    // at 4x CPU throttle to a few milliseconds -- without truncating by
    // document order, which is what an unconditional cap did.
    if (onScreen >= MAX_ELEMENTS) {
      // Everything after this point is unexamined, and the agent has to be
      // told the listing is partial -- that is what makes it re-read or ask
      // the user to scroll rather than concluding a control does not exist.
      unexamined = all.length - (i + 1);
      exitedEarly = true;
      break;
    }
  }
  // The hard ceiling truncates too, and used to do so SILENTLY: `unexamined`
  // was only set on the early-exit path, so a page whose interactive
  // elements outnumbered MAX_RAW_ELEMENTS without ever reaching 200 on
  // screen got a listing with nothing to say it was partial -- the exact
  // defect the early exit was added to fix, moved to a higher threshold.
  if (!exitedEarly && all.length > walkLimit) unexamined = all.length - walkLimit;

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
  // Two different facts, kept apart. `truncated` is rendered controls that
  // did not fit: an exact count of things the agent could have been told
  // about. `unexamined` is raw elements the walk never looked at -- a bound,
  // not a count, since most may be hidden scaffolding ([role="row"],
  // [role="presentation"]) that would never have been listed. Folding the
  // second into the first told the model "30000 more controls" on an ARIA
  // grid with 200.
  const dropped = ordered.length - kept.length;
  if (dropped > 0) listing.truncated = dropped;
  if (unexamined > 0) listing.unexamined = unexamined;
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
