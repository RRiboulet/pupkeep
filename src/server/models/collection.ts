// The provider catalog and where its credentials come from (PLAN §11.1, §11.2,
// §14.3, §16 P4-08).
//
// Two rules from the plan decide this module's shape:
//
//   * **keys live in `~/.pupkeep/secrets.json`** (P1-05), never in the
//     environment. So the `Models` collection is built with a `CredentialStore`
//     over the serialized JSON store, and with an `AuthContext` that resolves
//     **nothing** from the environment — otherwise a stray `OPENCODE_API_KEY` in
//     the phone's shell would silently become the household's key, which is the
//     exact seam P1-05's file rules exist to close;
//   * **only the two providers the plan allows** are registered (OpenCode Go and
//     OpenRouter). A catalog that carried every built-in provider would widen
//     the surface the picker and the probe must police for no benefit.
//
// The collection is catalog-first: `getModels()` answers without a credential, so
// the picker can list what *could* be used and the Settings screen can say "no
// key yet" rather than showing an empty list. A provider with no stored key is
// reported in `configured` — the probe skips it (a missing key is not a reason to
// mark its models `unauthorized` and drop them from the allowlist), and so does
// `pickInitialModel`.

import type { AuthContext, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { JsonFileStore } from "../json-file.ts";
import type { SecretsConfig } from "../config.ts";

/** The providers this build registers, in the plan's order. */
export const PROVIDERS = ["opencode-go", "openrouter"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** The providers `secrets.json` currently holds a key for. Read live, not cached. */
export async function providersWithKeys(secrets: JsonFileStore<SecretsConfig>): Promise<ReadonlySet<string>> {
  const config = await secrets.read();
  return new Set(
    Object.entries(config.providerKeys)
      .filter(([, key]) => key.trim() !== "")
      .map(([provider]) => provider),
  );
}

export interface AppModels {
  /** The catalog: model ids, prices, api shapes. */
  readonly models: Models;
  /** Providers with a stored key. The probe and the default picker use it. */
  readonly configured: ReadonlySet<string>;
}

/**
 * The environment is never a credential source here. `read` on the store wins
 * first anyway, but a keyless provider must fail rather than pick up the host's
 * shell — `models.getAuth` falls back to ambient resolution only when nothing is
 * stored, and this context makes that fallback resolve nothing.
 */
const NO_ENVIRONMENT: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

/**
 * A `CredentialStore` over `secrets.json`. `read` is the hot path (one call per
 * provider request), `modify`/`delete` serve the login-shaped flows this build
 * does not have — implemented honestly rather than throwing, so a future
 * OAuth-style provider is not blocked by this seam.
 */
export function createSecretCredentials(secrets: JsonFileStore<SecretsConfig>): CredentialStore {
  const keyOf = async (providerId: string): Promise<string | undefined> => {
    const config = await secrets.read();
    const key = config.providerKeys[providerId];
    return key === undefined || key === "" ? undefined : key;
  };

  return {
    read: async (providerId): Promise<Credential | undefined> => {
      const key = await keyOf(providerId);
      return key === undefined ? undefined : { type: "api_key", key };
    },
    list: async () => {
      const config = await secrets.read();
      return Object.keys(config.providerKeys).map((providerId) => ({ providerId, type: "api_key" as const }));
    },
    modify: async (providerId, change) => {
      const key = await keyOf(providerId);
      const current: Credential | undefined = key === undefined ? undefined : { type: "api_key", key };
      const next = await change(current);
      if (next === undefined) return current;
      if (next.type !== "api_key" || next.key === undefined) {
        // This store holds API keys only; an OAuth credential would need a
        // different home, and pretending to store it would lose the login.
        throw new Error(`secrets.json stores API keys only; "${providerId}" asked for ${next.type}`);
      }
      const saved = next.key;
      await secrets.update((config) => ({
        ...config,
        providerKeys: { ...config.providerKeys, [providerId]: saved },
      }));
      return next;
    },
    delete: async (providerId) => {
      await secrets.update((config) => {
        const providerKeys = { ...config.providerKeys };
        delete providerKeys[providerId];
        return { ...config, providerKeys };
      });
    },
  };
}

/**
 * Build the catalog. The secrets file is read once for `configured`; the store
 * above remains the live credential path, so a key saved from Settings takes
 * effect on the next request without a restart.
 */
export async function createAppModels(secrets: JsonFileStore<SecretsConfig>): Promise<AppModels> {
  const config = await secrets.read();
  const models = createModels({
    credentials: createSecretCredentials(secrets),
    authContext: NO_ENVIRONMENT,
  });
  models.setProvider(opencodeGoProvider());
  models.setProvider(openrouterProvider());
  return { models, configured: await providersWithKeys(secrets) };
}
