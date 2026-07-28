import { runpod } from './runpod.js';
import { vastai } from './vastai.js';
import { lambda } from './lambda.js';
import { GpuProviderError } from './shared.js';

export { GpuProviderError } from './shared.js';

export const gpuProviders = { runpod, vastai, lambda };

export function getGpuProvider(id) {
  const provider = gpuProviders[id];
  if (!provider) {
    throw new GpuProviderError(`Unknown GPU provider "${id}". Choose one of: ${Object.keys(gpuProviders).join(', ')}`, { status: 400 });
  }
  return provider;
}
