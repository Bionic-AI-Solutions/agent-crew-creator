/**
 * Client Preview — a blank stand-in for a customer's website, so an agent can
 * be exercised exactly as a visitor meets it.
 *
 * Opens in its own browser tab (no dashboard chrome) because the widget is
 * `position: fixed` and needs a whole viewport to sit in, the same as it would
 * on a real page.
 *
 * The widget itself is NOT reimplemented here — the page loads the very
 * artefacts a customer pastes into their site:
 *   popup  → <script src="/api/embed/widget.js" data-bionic-embed-token="...">
 *   iframe → <iframe src="/embed/:token">
 * so anything that breaks here breaks in the field too.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, ExternalLink } from "lucide-react";

/** Read-only view of the query string this page was opened with. */
function useQueryParams() {
  return useMemo(() => new URLSearchParams(window.location.search), []);
}

/**
 * Switching agent reloads the page rather than swapping the widget in place.
 *
 * The popup bundle is an IIFE that mounts itself on load and holds a live
 * LiveKit room; there is no teardown handle to call. A reload guarantees the
 * previous room is gone and the next agent starts from a clean visitor
 * session — which is what we are trying to observe in the first place.
 */
function navigateTo(appId: number, agentId: number | null) {
  const qs = new URLSearchParams({ app: String(appId) });
  if (agentId !== null) qs.set("agent", String(agentId));
  window.location.search = qs.toString();
}

type EmbedRow = {
  id: number;
  token: string;
  label: string;
  mode: string;
  theme: string;
  allowVoice: boolean;
  allowChat: boolean;
  allowVideo: boolean;
  allowScreenShare: boolean;
  allowAvatar: boolean;
  allowDomRead: boolean;
  allowDomControl: boolean;
  showTranscription: boolean;
  allowedOrigins: string[] | null;
  agentId: number;
  agentName: string;
  agentDeployed: boolean;
  agentAvatarEnabled: boolean;
};

export default function ClientPreview() {
  const params = useQueryParams();
  const { data: apps, isLoading: appsLoading } = trpc.appsCrud.list.useQuery();

  const urlAppId = params.get("app") ? Number(params.get("app")) : null;
  // One app is the common case — do not make the user pick from a list of one.
  const appId = urlAppId ?? (apps && apps.length === 1 ? apps[0].id : null);

  const { data: tokens, isLoading: tokensLoading } = trpc.embed.listByApp.useQuery(
    { appId: appId! },
    { enabled: appId !== null },
  );

  const urlAgentId = params.get("agent") ? Number(params.get("agent")) : null;
  const selected: EmbedRow | null = useMemo(() => {
    if (!tokens || tokens.length === 0) return null;
    return (tokens.find((t) => t.agentId === urlAgentId) ?? tokens[0]) as EmbedRow;
  }, [tokens, urlAgentId]);

  const loading = appsLoading || (appId !== null && tokensLoading);

  return (
    <div className="relative min-h-screen w-full bg-white dark:bg-neutral-950">
      {/* The page is deliberately blank: anything drawn here would be scenery
          the customer's real site does not have, and would only make the
          widget harder to judge. */}

      <AgentPicker
        apps={apps ?? []}
        appId={appId}
        tokens={(tokens ?? []) as EmbedRow[]}
        selected={selected}
        loading={loading}
      />

      {selected && <EmbedMount row={selected} />}
    </div>
  );
}

/** Bottom-left harness control. Nothing a visitor would ever see. */
function AgentPicker({
  apps,
  appId,
  tokens,
  selected,
  loading,
}: {
  apps: { id: number; name: string }[];
  appId: number | null;
  tokens: EmbedRow[];
  selected: EmbedRow | null;
  loading: boolean;
}) {
  const platformOrigin = window.location.origin;
  const restricted =
    selected?.allowedOrigins &&
    selected.allowedOrigins.length > 0 &&
    !selected.allowedOrigins.includes(platformOrigin);

  return (
    <div className="fixed bottom-4 left-4 z-[2147483646] w-64 rounded-lg bg-neutral-900/95 p-3 text-neutral-100 shadow-2xl backdrop-blur">
      <div className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.13em] text-neutral-400">
        Agent under test
      </div>

      {loading ? (
        <p className="py-1 text-xs text-neutral-400">Loading agents…</p>
      ) : apps.length === 0 ? (
        <Empty text="No apps yet." href="/apps" cta="Create an app" />
      ) : appId === null ? (
        <select
          className="w-full cursor-pointer rounded border border-white/20 bg-white/10 px-2.5 py-1.5 text-[13px]"
          defaultValue=""
          onChange={(e) => navigateTo(Number(e.target.value), null)}
        >
          <option value="" disabled>
            Choose an app…
          </option>
          {apps.map((a) => (
            <option key={a.id} value={a.id} className="text-neutral-900">
              {a.name}
            </option>
          ))}
        </select>
      ) : tokens.length === 0 ? (
        <Empty
          text="No active embed tokens in this app."
          href="/agents"
          cta="Create one in Agent Builder"
        />
      ) : (
        <>
          <select
            className="w-full cursor-pointer rounded border border-white/20 bg-white/10 px-2.5 py-1.5 text-[13px]"
            value={selected?.agentId ?? ""}
            onChange={(e) => navigateTo(appId, Number(e.target.value))}
          >
            {tokens.map((t) => (
              <option key={t.id} value={t.agentId} className="text-neutral-900">
                {t.agentName} — {t.mode}
                {t.label !== "default" ? ` (${t.label})` : ""}
              </option>
            ))}
          </select>

          {selected && <CapabilityChips row={selected} />}

          {selected && !selected.agentDeployed && (
            <Warning>Agent is not deployed — the widget will not find a worker.</Warning>
          )}

          {restricted && (
            <Warning>
              Token is limited to {selected!.allowedOrigins!.join(", ")}. Add {platformOrigin} to its
              allowed origins to preview it here.
            </Warning>
          )}
        </>
      )}

      <div className="mt-2 font-mono text-[9px] tracking-wide text-neutral-500">
        preview control · not on the live page
      </div>
    </div>
  );
}

/** Mirrors what the token actually turns on, so the widget can be read against it. */
function CapabilityChips({ row }: { row: EmbedRow }) {
  const chips: [string, boolean][] = [
    [row.mode, true],
    [row.theme, true],
    ["mic", row.allowVoice],
    ["chat", row.allowChat],
    ["cam", row.allowVideo],
    ["screen", row.allowScreenShare],
    ["dom read", row.allowDomRead],
    ["dom control", row.allowDomControl],
    ["avatar", row.allowAvatar && row.agentAvatarEnabled],
    ["transcript", row.showTranscription],
  ];
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {chips.map(([label, on]) => (
        <span
          key={label}
          className={
            "rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider " +
            (on ? "bg-orange-500 text-neutral-900" : "bg-white/10 text-neutral-400")
          }
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-amber-300">
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Empty({ text, href, cta }: { text: string; href: string; cta: string }) {
  return (
    <div className="space-y-1.5 py-1">
      <p className="text-xs text-neutral-400">{text}</p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-orange-400 hover:underline"
      >
        {cta} <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

/**
 * Mounts the real customer-facing artefact for this token.
 *
 * Popup mode injects the same <script> tag the Embed tab hands out. The bundle
 * appends its own shadow-DOM host to <body> and positions itself bottom-right,
 * so nothing here needs to lay it out. Cleanup removes both the script and the
 * host it created; a stale host would otherwise leave a dead trigger button
 * behind under React strict-mode's double effect.
 */
function EmbedMount({ row }: { row: EmbedRow }) {
  const mounted = useRef(false);
  const [iframeFailed, setIframeFailed] = useState(false);

  useEffect(() => {
    if (row.mode !== "popup") return;
    if (mounted.current) return;
    mounted.current = true;

    const script = document.createElement("script");
    script.src = "/api/embed/widget.js";
    script.dataset.bionicEmbedToken = row.token;
    script.defer = true;
    document.body.appendChild(script);

    return () => {
      mounted.current = false;
      script.remove();
      document.getElementById("bionic-embed-wrapper")?.remove();
    };
  }, [row.mode, row.token]);

  if (row.mode !== "iframe") return null;

  return (
    <div className="fixed bottom-4 right-4 z-[2147483645] h-[600px] w-[400px] overflow-hidden rounded-2xl shadow-2xl">
      {iframeFailed ? (
        <div className="flex h-full items-center justify-center bg-neutral-100 p-6 text-center text-sm text-neutral-600">
          The embed page did not load. Check that this token is still active.
        </div>
      ) : (
        <iframe
          key={row.token}
          src={`/embed/${row.token}`}
          title={`${row.agentName} embed`}
          allow="microphone; camera; display-capture"
          className="h-full w-full border-0"
          onError={() => setIframeFailed(true)}
        />
      )}
    </div>
  );
}
