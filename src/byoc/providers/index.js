import { runpod } from './runpod.js';
import { vastai } from './vastai.js';
import { lambda } from './lambda.js';
import { GpuProviderError } from './shared.js';

export { GpuProviderError } from './shared.js';

export const gpuProviders = { runpod, vastai, lambda };

export function getGpuProvider(id) {
  // Object.hasOwn, not a truthy lookup: otherwise 'constructor'/'toString'
  // resolve to inherited functions and skip this clean 400.
  if (typeof id !== 'string' || !Object.hasOwn(gpuProviders, id)) {
    throw new GpuProviderError(`Unknown GPU provider "${id}". Choose one of: ${Object.keys(gpuProviders).join(', ')}`, { status: 400 });
  }
  return gpuProviders[id];
}
