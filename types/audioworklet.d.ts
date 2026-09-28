// Globals of the AudioWorkletGlobalScope, which TypeScript's DOM lib doesn't include.

declare const sampleRate: number;
declare const currentTime: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
