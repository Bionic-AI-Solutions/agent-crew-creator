import { useCallback, useEffect, useState } from "react";
import { decodeJwt } from "jose";
import type { ConnectionDetails } from "./types";

const ONE_MINUTE_MS = 60_000;

/** Stable anonymous visitor ID persisted in localStorage. */
function getVisitorId(): string {
  const KEY = "bionic-embed-visitor-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export default function useEmbedConnection(platformOrigin: string, embedToken: string) {
  const [connectionDetails, setConnectionDetails] = useState<ConnectionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchConnectionDetails = useCallback(async () => {
    setConnectionDetails(null);
    setError(null);
    try {
      const res = await fetch(`${platformOrigin}/api/embed/connection-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embedToken,
          visitorId: getVisitorId(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: ConnectionDetails = await res.json();
      setConnectionDetails(data);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [platformOrigin, embedToken]);

  useEffect(() => {
    fetchConnectionDetails().catch(() => {});
  }, [fetchConnectionDetails]);

  const isExpired = useCallback(() => {
    const token = connectionDetails?.participantToken;
    if (!token) return true;
    try {
      const payload = decodeJwt(token);
      if (!payload.exp) return true;
      return Date.now() >= (payload.exp * 1000 - ONE_MINUTE_MS);
    } catch {
      return true;
    }
  }, [connectionDetails?.participantToken]);

  const existingOrRefresh = useCallback(async () => {
    if (isExpired() || !connectionDetails) {
      return fetchConnectionDetails();
    }
    return connectionDetails;
  }, [connectionDetails, fetchConnectionDetails, isExpired]);

  return {
    connectionDetails,
    error,
    refreshConnectionDetails: fetchConnectionDetails,
    existingOrRefreshConnectionDetails: existingOrRefresh,
  };
}
