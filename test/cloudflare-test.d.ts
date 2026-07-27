declare module "cloudflare:test" {
  const env: import("../src/types").Env;
  function createExecutionContext(): ExecutionContext;
  function createMessageBatch<Body = unknown>(
    queueName: string,
    messages: Array<{
      id: string;
      timestamp: Date;
      attempts: number;
      body: Body;
    }>,
  ): MessageBatch<Body>;
  function getQueueResult(
    batch: MessageBatch,
    context: ExecutionContext,
  ): Promise<{
    outcome: string;
    ackAll: boolean;
    explicitAcks: string[];
    retryMessages: Array<{ msgId: string; delaySeconds?: number }>;
  }>;
  function runInDurableObject<
    O extends DurableObject,
    R,
  >(
    stub: DurableObjectStub<O>,
    callback: (instance: O, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
  export {
    createExecutionContext,
    createMessageBatch,
    env,
    getQueueResult,
    runInDurableObject,
  };
}
