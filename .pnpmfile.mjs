// Preserve the runtime dependency remediations in the pnpm 11 install hook.
export const hooks = {
  updateConfig(config) {
    return {
      ...config,
      overrides: {
        ...config.overrides,
        "source-map-js@<1.2.2": "1.2.2",
        "@modelcontextprotocol/sdk@<1.31.0": "1.31.0",
        "sharp@<0.35.5": "0.35.5",
        // ponytail: this pilot runs under Node, not Linux Electron. Replace the
        // vendored native codec too; Electron support needs a patched rebuild.
        "@janhapke/sharp-electron": "npm:sharp@0.35.5",
        "brace-expansion@^2": "2.1.7",
        "brace-expansion@^5": "5.0.12",
      },
      patchedDependencies: {
        ...config.patchedDependencies,
        "@letta-ai/letta-code@0.34.14": "patches/@letta-ai__letta-code@0.34.14.patch",
      },
    };
  },
};
