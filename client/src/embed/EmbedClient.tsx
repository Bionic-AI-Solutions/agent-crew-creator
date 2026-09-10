import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePagePublisher } from "./usePagePublisher";
import { usePageActions, type ConfirmRequest } from "./usePageActions";
import ReactDOM from "react-dom/client";
import { Room, RoomEvent } from "livekit-client";
import { RoomAudioRenderer, RoomContext, StartAudio } from "@livekit/components-react";
import useEmbedConnection from "./useEmbedConnection";
import { PopupView } from "./PopupView";
import { useDocumentPip } from "./useDocumentPip";
// The same stylesheet the bundle injects into the shadow root. The PiP window
// is a separate document and inherits none of it, so it needs its own copy.
// @ts-ignore — CSS imported as string
import embedStyles from "./embed-styles.css?inline";
import type { EmbedConfig, EmbedErrorDetails } from "./types";

interface EmbedClientProps {
  platformOrigin: string;
  embedToken: string;
}

/**
 * Popup-mode embed client. Renders a floating trigger button
 * and an expandable panel with the agent session.
 */
/**
 * Publishing has to happen inside RoomContext, and EmbedClient itself is what
 * provides it — so the hook lives in a child that renders nothing.
 */
function PagePublisher({ enabled }: { enabled: boolean }) {
  usePagePublisher(enabled);
  return null;
}

/**
 * Control mode, and the banner that says it is on.
 *
 * The banner is not decoration and not optional. An agent that can click
 * things on someone's page must be visible while it can, and the stop button
 * has to be reachable at the moment someone wants it -- not in a settings
 * panel, and not behind the popup being open.
 *
 * Control starts OFF every session, whatever the token permits. Nobody should
 * arrive on a page to find an agent already able to press things.
 */
function PageActions({ config }: { config?: EmbedConfig }) {
  const [controlOn, setControlOn] = useState(false);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null);
  const permitted = !!config?.allowDomControl;

  // The bar itself, so the action path can verify the user can still see it.
  // Passed as a getter rather than the node: the hook reads it at the moment
  // it matters, not at the moment it was wired up.
  const barRef = useRef<HTMLDivElement | null>(null);
  const getControlBar = useCallback(() => barRef.current, []);

  /**
   * Put the bar in the top layer, and say what state it is actually in.
   *
   * The top layer paints above every element in the page, whatever its
   * z-index or stacking context, so a page cannot cover the bar with ordinary
   * content at all. Three review rounds were spent trying to DETECT covering
   * -- a scan, then a stacking comparison, then a paint probe -- and each was
   * defeated by something the previous one had not modelled. Verified in
   * Chromium: all of those fail against a top-layer bar, including the scrim
   * in a closed shadow root that was twice documented as a permanent limit.
   *
   * Three states, not a boolean, because "not in the top layer" has two very
   * different causes. A browser without the popover API is a fact of life and
   * the checks fall back. Failing to get there on a browser that HAS it means
   * something is interfering, and that must fail closed -- the previous
   * version returned false for both, and a page could reach it with one line:
   *   wrapper.shadowRoot.querySelector('[popover]').removeAttribute('popover')
   * which made showPopover throw, which turned off the only detector that
   * sees a pointer-events:none scrim. The bar stayed painted, so nothing else
   * noticed, and React never rewrote the attribute because its vdom still
   * believed it was there.
   *
   * `force` does a real re-assertion. showPopover() on an already-open
   * popover is a silent no-op -- measured -- so the guard that skipped it
   * when already open meant a page modal opened after ours left us
   * underneath forever. hide-then-show moves us back to the top of the
   * top-layer stack, which is the whole recovery.
   */
  const showInTopLayer = useCallback(
    (force = false): "top-layer" | "unsupported" | "failed" => {
      const el = barRef.current as
        | (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void })
        | null;
      if (!el) return "failed";
      if (typeof el.showPopover !== "function") return "unsupported";
      try {
        // Put back what the page may have taken away.
        if (el.getAttribute("popover") !== "manual") el.setAttribute("popover", "manual");
        const open = el.matches(":popover-open");
        if (force && open) el.hidePopover?.();
        if (force || !open) el.showPopover();
        return el.matches(":popover-open") ? "top-layer" : "failed";
      } catch {
        return "failed";
      }
    },
    [],
  );

  // Reverts to guidance whenever the permission goes away, so a token change
  // or a reconnect cannot leave control quietly enabled.
  useEffect(() => {
    if (!permitted) setControlOn(false);
  }, [permitted]);

  // A stable array. As a fresh literal it re-registered all four RPC methods
  // after every single action, since each action re-renders this component.
  const allowedOrigins = useMemo(() => [window.location.origin], []);
  const denylist = useMemo(
    () => config?.domActionDenylist ?? [],
    [config?.domActionDenylist],
  );

  const { confirm } = usePageActions({
    enabled: permitted && controlOn,
    readEnabled: !!config?.allowDomRead,
    denylist,
    allowedOrigins,
    getControlBar,
    reassertControlBar: showInTopLayer,
    onRefusal: (detail, confirmable) => {
      setLastEvent(`Asked you first: ${detail}`);
      if (confirmable) setPendingConfirm(confirmable);
    },
    onAction: (summary) => {
      setLastEvent(`Agent ${summary}`);
      setPendingConfirm(null);
    },
    // The agent may only act while the user can see that it can. If the bar
    // stops being visible -- hidden by the page's CSS, covered, detached --
    // control goes off rather than continuing invisibly.
    onControlRevoked: (detail) => {
      setControlOn(false);
      setPendingConfirm(null);
      setLastEvent(`Control stopped: ${detail}`);
    },
  });

  // Shown as soon as the bar exists, and again whenever its contents change
  // size, so it is in the top layer before anything can be pressed.
  useEffect(() => {
    if (!permitted) return;
    showInTopLayer();
  }, [permitted, controlOn, pendingConfirm, showInTopLayer]);

  if (!permitted) return null;

  return (
    <div
      ref={barRef}
      // "manual" so nothing else can light-dismiss it -- an Escape keypress
      // meant for the page must not take the Stop button away.
      popover="manual"
      className={`bionic-control-bar ${controlOn ? "bionic-control-on" : ""}`}
    >
      <span className="bionic-control-dot" aria-hidden="true" />
      <span className="bionic-control-text">
        {controlOn
          ? lastEvent ?? "The agent can act on this page"
          : lastEvent ?? "The agent can see this page but not touch it"}
      </span>
      {/*
        The agent is told to ask before anything irreversible, and the gate
        refuses those outright until someone says yes. Without a way to say
        yes, the user agreeing out loud changed nothing and the agent was
        refused again -- so the approval it was told to wait for lives here.
        One press, for the one control named, and it is spent.
      */}
      {controlOn && pendingConfirm && (
        <>
          <button
            type="button"
            className="bionic-control-btn"
            onClick={(event) => {
              // Only a real press counts. The widget mounts in an open shadow
              // root inside the host page's own document, so any script on
              // that page can find this button and .click() it the moment it
              // appears -- approving, with no human involved, the one thing
              // the agent was told to stop and ask about. isTrusted is false
              // for every synthetic click and cannot be forged from script.
              //
              // This is a correctness guard, not a security boundary: a page
              // running script can already press the real "Delete" button
              // itself, so it gains nothing here. What it stops is an
              // approval that nobody gave being recorded as one.
              if (!event.isTrusted) return;
              confirm(pendingConfirm.key);
              setLastEvent(`Allowed once: "${pendingConfirm.name}"`);
              setPendingConfirm(null);
            }}
          >
            Allow once
          </button>
          <button
            type="button"
            className="bionic-control-btn"
            onClick={() => {
              setPendingConfirm(null);
              setLastEvent(`Refused "${pendingConfirm.name}"`);
            }}
          >
            No
          </button>
        </>
      )}
      <button
        type="button"
        className="bionic-control-btn"
        onClick={() => {
          setControlOn((on) => !on);
          setLastEvent(null);
          setPendingConfirm(null);
        }}
      >
        {controlOn ? "Stop" : "Let it act"}
      </button>
    </div>
  );
}

export function EmbedClient({ platformOrigin, embedToken }: EmbedClientProps) {
  const room = useMemo(() => new Room(), []);
  const [popupOpen, setPopupOpen] = useState(false);
  const [error, setError] = useState<EmbedErrorDetails | null>(null);
  const isAnimating = useRef(false);

  const {
    connectionDetails,
    refreshConnectionDetails,
    existingOrRefreshConnectionDetails,
  } = useEmbedConnection(platformOrigin, embedToken);

  const handleToggle = () => {
    if (isAnimating.current) return;
    setError(null);
    setPopupOpen((open) => !open);
  };

  // Room event listeners
  useEffect(() => {
    const onDisconnected = () => {
      setPopupOpen(false);
      refreshConnectionDetails().catch(() => {});
    };
    const onMediaError = (err: Error) => {
      setError({
        title: "Media device error",
        description: `${err.name}: ${err.message}`,
      });
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaError);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaError);
    };
  }, [room, refreshConnectionDetails]);

  // Connect when popup opens
  useEffect(() => {
    if (!popupOpen || !connectionDetails || room.state !== "disconnected") return;

    const connect = async () => {
      try {
        const details = await existingOrRefreshConnectionDetails();
        await Promise.all([
          details.config.allowVoice
            ? room.localParticipant.setMicrophoneEnabled(true)
            : Promise.resolve(),
          room.connect(details.serverUrl, details.participantToken),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError({ title: "Connection failed", description: msg });
      }
    };

    connect();
  }, [popupOpen, connectionDetails, room, existingOrRefreshConnectionDetails]);

  const handleDisconnect = useCallback(() => {
    room.disconnect();
  }, [room]);

  // ── Pop out into an always-on-top window ──────────────────────
  const { supported: pipSupported, pipWindow, open: openPip, close: closePip } =
    useDocumentPip(embedStyles);
  const pipActive = pipWindow !== null;
  const pipRootRef = useRef<ReactDOM.Root | null>(null);

  const pipControl = useMemo(
    () =>
      pipSupported
        ? { active: pipActive, onToggle: () => (pipActive ? closePip() : openPip()) }
        : undefined,
    [pipSupported, pipActive, openPip, closePip],
  );

  // CSS transition callbacks
  const handleTransitionStart = () => { isAnimating.current = true; };
  const handleTransitionEnd = () => {
    isAnimating.current = false;
    if (!popupOpen && room.state !== "disconnected") {
      room.disconnect();
    }
  };

  const theme = connectionDetails?.config.theme || "light";

  /**
   * The popped-out widget is a SECOND React root rendered into the PiP
   * document, not the existing DOM moved across.
   *
   * React attaches its event listeners to the root container, so a subtree
   * relocated into another document keeps rendering but stops receiving
   * clicks — mute and end-call would go dead exactly where they are needed.
   * Two roots each attach listeners in their own document, and they stay in
   * step for free because every LiveKit hook reads from the one shared Room
   * object rather than from React state.
   */
  useEffect(() => {
    if (!pipWindow) return;
    const host = pipWindow.document.createElement("div");
    host.className = `bionic-pip-root bionic-theme-${theme}`;
    pipWindow.document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    pipRootRef.current = root;
    return () => {
      pipRootRef.current = null;
      // Unmounting a root synchronously from another root's cleanup makes
      // React warn; defer it past the current commit.
      queueMicrotask(() => root.unmount());
    };
  }, [pipWindow, theme]);

  useEffect(() => {
    if (!pipWindow || !pipRootRef.current || !connectionDetails) return;
    pipRootRef.current.render(
      <RoomContext.Provider value={room}>
        <PopupView
          config={connectionDetails.config}
          platformOrigin={platformOrigin}
          sessionStarted
          onError={setError}
          onDisconnect={handleDisconnect}
          pip={{ active: true, onToggle: closePip }}
        />
      </RoomContext.Provider>,
    );
  }, [pipWindow, connectionDetails, room, platformOrigin, handleDisconnect, closePip]);

  return (
    <RoomContext.Provider value={room}>
      <PagePublisher enabled={!!connectionDetails?.config.allowDomRead} />
      <PageActions config={connectionDetails?.config} />
      <RoomAudioRenderer />
      <StartAudio label="Start Audio" />

      {/* Trigger button */}
      <button className="bionic-trigger" onClick={handleToggle} title="Chat with agent">
        {!popupOpen ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        )}
      </button>

      {/* Popup panel */}
      <div
        className={`bionic-popup bionic-theme-${theme} ${popupOpen ? "bionic-popup-open" : "bionic-popup-closed"}`}
        onTransitionEnd={handleTransitionEnd}
      >
        <div className="bionic-popup-inner">
          {error ? (
            <div className="bionic-popup-error">
              <div className="bionic-error-title">{error.title}</div>
              <div className="bionic-error-desc">{error.description}</div>
              <button className="bionic-error-retry" onClick={handleToggle}>Close</button>
            </div>
          ) : pipActive ? (
            // Only one copy renders at a time: two live PopupViews would attach
            // the same avatar track to two <video> elements.
            <div className="bionic-popup-poppedout">
              <div className="bionic-poppedout-title">Playing in a floating window</div>
              <div className="bionic-poppedout-desc">
                The agent stays on top while you use other tabs.
              </div>
              <button className="bionic-error-retry" onClick={closePip}>
                Bring it back
              </button>
            </div>
          ) : connectionDetails ? (
            <PopupView
              config={connectionDetails.config}
              platformOrigin={platformOrigin}
              sessionStarted={popupOpen}
              onError={setError}
              onDisconnect={handleDisconnect}
              pip={pipControl}
            />
          ) : (
            <div className="bionic-popup-loading">
              <div className="bionic-loading-spinner" />
              <div>Connecting...</div>
            </div>
          )}
        </div>
      </div>
    </RoomContext.Provider>
  );
}
