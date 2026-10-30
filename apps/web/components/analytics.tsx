"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

// Views that show variable values, secrets or tokens. Replays draw their text as asterisks,
// and clicks inside them send no event; inputs are masked everywhere.
const PRIVATE = ["[data-variables]", "[data-slot='copy-panel']", "[data-private]"];
const privateChain = /data-variables|"copy-panel"|data-private/;

let started = false;
const waiting: (() => void)[] = [];

function whenStarted(run: () => void) {
  if (started) {
    run();
  } else {
    waiting.push(run);
  }
}

export function Analytics({
  token,
  host,
  uiHost,
}: {
  token: string;
  host: string;
  uiHost: string;
}) {
  useEffect(() => {
    if (started) {
      return;
    }
    posthog.init(token, {
      api_host: host,
      ui_host: uiHost,
      defaults: "2026-08-30",
      person_profiles: "identified_only",
      capture_exceptions: true,
      capture_heatmaps: true,
      session_recording: { maskAllInputs: true, maskTextSelector: PRIVATE.join(", ") },
      before_send: (event) =>
        event?.event === "$autocapture" &&
        privateChain.test(String(event.properties.$elements_chain ?? ""))
          ? null
          : event,
      loaded: () => {
        started = true;
        for (const run of waiting.splice(0)) {
          run();
        }
      },
    });
  }, [token, host, uiHost]);

  return null;
}

export function AnalyticsIdentity({
  userId,
  email,
  name,
  organization,
}: {
  userId: string;
  email: string;
  name: string;
  organization: { id: string; name: string; slug: string } | undefined;
}) {
  const organizationId = organization?.id;
  const organizationName = organization?.name;
  const organizationSlug = organization?.slug;

  useEffect(() => {
    whenStarted(() => {
      posthog.identify(userId, { email, name });
      if (organizationId) {
        posthog.group("organization", organizationId, {
          name: organizationName,
          slug: organizationSlug,
        });
      }
    });
  }, [userId, email, name, organizationId, organizationName, organizationSlug]);

  return null;
}

export function forgetAnalyticsUser() {
  if (started) {
    posthog.reset();
  }
}
