import { useState } from "react";
import { BulkBar } from "../components/BulkBar";
import { Confirm } from "../components/Confirm";
import { CopyPanel } from "../components/CopyPanel";
import { Drawer } from "../components/Drawer";
import { DropNotice } from "../components/DropNotice";
import { SaveBar } from "../components/SaveBar";
import { Table } from "../components/Table";
import type { State } from "../model";
import { install } from "../port";
import { useValue } from "../signals";
import * as store from "../store";
import { type MemoryOptions, memoryPort } from "./memory-port";

export type Live = typeof store;

export interface SurfaceProps {
  state: State;
  port?: MemoryOptions;
  readOnly?: boolean;
  setup?: (live: Live) => void;
}

function reset(): void {
  store.state.value = null;
  store.saving.value = false;
  store.farewell.value = null;
  store.environment.value = "";
  store.search.value = "";
  store.unfilledOnly.value = false;
  store.selected.value = new Set();
  store.extras.value = [];
  store.awaitingApproval.value = new Set();
  store.expanded.value = new Set();
  store.spotlight.value = null;
  store.focusing.value = null;
  store.drafts.value = new Map();
  store.variableGroupRemovals.value = new Set();
  store.variableGroupsOn.value = new Set();
  store.baselines.value = new Map();
  store.revealErrors.value = new Map();
  store.problems.value = new Map();
  store.outcome.value = null;
  store.dragTarget.value = null;
  store.dropped.value = null;
  store.removing.value = null;
  store.copying.value = null;
  store.copyLoading.value = false;
  store.drawer.value = null;
  store.history.value = null;
  store.historyError.value = null;
  store.finishing.value = false;
  store.finishError.value = null;
}

export function Surface({ state, port, readOnly = false, setup }: SurfaceProps) {
  useState(() => {
    reset();
    install(memoryPort(state, port));
    store.state.value = state;
    store.expanded.value = new Set(state.matrix.columns.filter((folder) => folder !== ""));
    setup?.(store);
    return null;
  });
  const current = useValue(store.state);
  if (!current) return null;
  return (
    <div
      data-variables
      data-read-only={readOnly || undefined}
      className="flex flex-1 flex-col gap-4"
    >
      <DropNotice />
      <Table />
      {!readOnly && <BulkBar />}
      {!readOnly && <SaveBar />}
      <Drawer />
      <CopyPanel />
      <Confirm />
    </div>
  );
}
