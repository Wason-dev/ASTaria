/** Shared automatic input policy. Reserves space for output and tool rounds;
 * never rewrites a saved custom/off preference. Units are local estimates. */
export function automaticContextBudget(settings: { provider?: string } = {}) {
  if (settings.provider === 'local') return { hard: 24_000, soft: 16_000 }
  if (!settings.provider || settings.provider === 'deepseek') return { hard: 900_000, soft: 800_000 }
  // Compatible endpoints do not publish a trustworthy model window here.
  return { hard: 48_000, soft: 32_000 }
}
