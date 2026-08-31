// Minimal stand-in for the OpenClaw plugin API surface openwave registers
// against. Records everything the plugin wires so tests can assert on it and
// fire hooks by name.
//
// eslint-disable @typescript-eslint/no-explicit-any

export type Recorded = {
  hooks: Map<string, Array<(e: any, c: any) => any>>;
  tools: any[];
  injections: any[];
  lifecycles: any[];
};

export function makeMockApi(pluginConfig: Record<string, unknown>) {
  const rec: Recorded = { hooks: new Map(), tools: [], injections: [], lifecycles: [] };
  const api = {
    pluginConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection(inj: any) {
          rec.injections.push(inj);
          return { enqueued: true, id: "mock", sessionKey: inj.sessionKey };
        },
      },
    },
    lifecycle: {
      registerRuntimeLifecycle(l: any) { rec.lifecycles.push(l); },
    },
    registerTool(t: any) { rec.tools.push(t); },
    registerMemoryEmbeddingProvider() {},
    registerMemoryPromptSupplement() {},
    registerMemoryCorpusSupplement() {},
    on(name: string, handler: (e: any, c: any) => any) {
      if (!rec.hooks.has(name)) rec.hooks.set(name, []);
      rec.hooks.get(name)!.push(handler);
    },
  };
  const fire = (name: string, event: any, ctx: any) =>
    Promise.all((rec.hooks.get(name) ?? []).map((h) => h(event, ctx)));
  return { api, rec, fire };
}
