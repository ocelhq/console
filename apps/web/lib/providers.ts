const OCEL_CLOUD = "Ocel Cloud";

const edgeLabels: Record<string, string> = { "ocel-cloud": OCEL_CLOUD };

export interface Edge {
  kind: string;
  label: string;
}

export interface Target {
  label: string;
  home: string;
  own: boolean;
  edge(reported: string): Edge;
}

function edgeOf(reported: string, kind = reported.toLowerCase()): Edge {
  return { kind, label: edgeLabels[kind] ?? reported };
}

const ocelCloud: Target = {
  label: OCEL_CLOUD,
  home: OCEL_CLOUD,
  own: false,
  edge: (reported) =>
    reported.toLowerCase() === "none" ? edgeOf(reported, "ocel-cloud") : edgeOf(reported),
};

export function targetOf(provider: string | null): Target {
  if (provider?.toLowerCase() === "ocel") {
    return ocelCloud;
  }
  return {
    label: provider ?? "your cloud",
    home: "your cloud",
    own: true,
    edge: (reported) => edgeOf(reported),
  };
}
