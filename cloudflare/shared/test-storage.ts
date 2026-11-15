export function memoryState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get(key: string) {
      return structuredClone(data.get(key));
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === "string") data.set(key, structuredClone(value));
      else
        for (const [k, v] of Object.entries(key))
          data.set(k, structuredClone(v));
    },
    async delete(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys)
        data.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return new Map(
        [...data]
          .filter(([key]) => key.startsWith(prefix))
          .map(([k, v]) => [k, structuredClone(v)]),
      );
    },
    async setAlarm(time: number) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async transaction<T>(fn: (storage: unknown) => Promise<T>) {
      return fn(storage);
    },
  };
  return {
    ctx: { storage } as unknown as DurableObjectState,
    data,
    get alarm() {
      return alarm;
    },
  };
}
