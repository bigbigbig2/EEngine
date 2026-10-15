export interface CookedTextureCatalogEntry {
  readonly uri: string;
  readonly identity: string;
}

/** Deduplicate immutable payloads, never authored texture/sampler bindings.
 * Every alias is still checked against its catalog identity before binding. */
export function uniqueCookedTextures(
  entries: readonly CookedTextureCatalogEntry[],
  criticalUris: ReadonlySet<string>,
) {
  const aliases = new Map<string, string>();
  const products = new Map<string, CookedTextureCatalogEntry & { critical: boolean }>();
  for (const entry of entries) {
    if (!entry.uri || !/^[a-f0-9]{64}$/.test(entry.identity)) {
      throw new Error("Invalid Cooked texture catalog identity");
    }
    if (aliases.has(entry.uri) && aliases.get(entry.uri) !== entry.identity) {
      throw new Error("Cooked texture URI has conflicting Product identities");
    }
    aliases.set(entry.uri, entry.identity);
    const prior = products.get(entry.identity);
    if (prior) {
      prior.critical ||= criticalUris.has(entry.uri);
    } else {
      products.set(entry.identity, { ...entry, critical: criticalUris.has(entry.uri) });
    }
  }
  return {
    aliases,
    reads: [...products.values()].sort((a, b) => Number(b.critical) - Number(a.critical)),
  };
}
