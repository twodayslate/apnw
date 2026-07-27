declare module "cloudflare:test" {
  const env: import("../src/types").Env;
  function runInDurableObject<
    O extends DurableObject,
    R,
  >(
    stub: DurableObjectStub<O>,
    callback: (instance: O, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
  export { env, runInDurableObject };
}
