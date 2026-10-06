import {
  type Coordinate,
  coordinateKey,
  type OtherValue,
  type State,
  type Version,
} from "../model";
import {
  type CopyResult,
  conflict,
  type Revealed,
  VariablesError,
  type VariablesPort,
} from "../port";

export interface MemoryOptions {
  values?: Record<string, string>;
  unreadable?: Record<string, string>;
  conflicts?: readonly string[];
  history?: Version[];
  historyError?: string;
  other?: { tier: string; values: OtherValue[] };
  latency?: number;
}

export function at(key: string, folder = "", environment = ""): Coordinate {
  return { key, folder, environment };
}

export function memoryPort(initial: State, options: MemoryOptions = {}): VariablesPort {
  let current = structuredClone(initial);
  const values = new Map(Object.entries(options.values ?? {}));
  const unreadable = new Map(Object.entries(options.unreadable ?? {}));
  const conflicts = new Set(options.conflicts ?? []);
  const wait = () => new Promise((resolve) => setTimeout(resolve, options.latency ?? 150));

  const store = (where: Coordinate, value: string | null) => {
    const key = coordinateKey(where);
    if (value === null) values.delete(key);
    else values.set(key, value);
    current = structuredClone(current);
    const row = current.matrix.rows.find((candidate) => candidate.key === where.key);
    const cell = row?.cells.find((candidate) => candidate.folder === where.folder);
    if (!cell) return;
    if (where.environment === "") {
      cell.set = value !== null;
      cell.version += 1;
      delete cell.problem;
      return;
    }
    const others = (cell.overrides ?? []).filter((o) => o.environment !== where.environment);
    const prior = cell.overrides?.find((o) => o.environment === where.environment);
    cell.overrides =
      value === null
        ? others
        : [...others, { environment: where.environment, version: (prior?.version ?? 0) + 1 }];
  };

  const refuse = (where: Coordinate) => {
    if (conflicts.has(coordinateKey(where))) {
      throw new VariablesError(conflict, "someone saved a newer version first");
    }
  };

  return {
    async read() {
      await wait();
      return current;
    },
    async reveal(cells): Promise<Revealed> {
      await wait();
      const out: Revealed = { values: [], errors: [] };
      for (const cell of cells) {
        const key = coordinateKey(cell);
        const error = unreadable.get(key);
        if (error !== undefined) out.errors.push({ ...cell, error });
        else out.values.push({ ...cell, value: values.get(key) ?? "" });
      }
      return out;
    },
    async set(where, value) {
      await wait();
      refuse(where);
      store(where, value);
    },
    async setInEnvSource(where, value) {
      await wait();
      store(where, value);
      return { awaitingApproval: false };
    },
    async remove(where) {
      await wait();
      refuse(where);
      store(where, null);
    },
    async history() {
      await wait();
      if (options.historyError) throw new Error(options.historyError);
      return options.history ?? [];
    },
    async other() {
      await wait();
      return options.other ?? { tier: current.other, values: [] };
    },
    async copy(cells): Promise<CopyResult[]> {
      await wait();
      return cells.map((cell) => {
        const where = { key: cell.key, folder: cell.folder, environment: cell.environment };
        if (conflicts.has(coordinateKey(where))) return { ...where, saved: false, conflict: true };
        const source = options.other?.values.find(
          (value) => coordinateKey(value) === coordinateKey(where),
        );
        store(where, source?.value ?? "");
        return { ...where, saved: true };
      });
    },
  };
}
