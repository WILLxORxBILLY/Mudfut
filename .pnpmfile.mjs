// Preserve the runtime dependency remediations in the pnpm 11 install hook.
export const hooks = {
  updateConfig(config) {
    return {
      ...config,
      overrides: {
        ...config.overrides,
        "body-parser@>=2.0.0 <2.4.0": "2.4.0",
        "undici@>=6.23.0 <6.29.1": "6.29.1",
        "undici@>=8.0.0 <8.12.2": "8.12.2",
        "openai@7.19.0>undici": "8.12.2",
        "source-map-js@<1.2.2": "1.2.2",
        "@modelcontextprotocol/sdk@<1.32.0": "1.32.0",
        "vite@>=7.0.0 <7.3.7": "7.3.7",
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
        "@letta-ai/letta-agent-sdk@0.8.38": "patches/@letta-ai__letta-agent-sdk@0.8.38.patch",
        "@letta-ai/letta-agent-sdk@0.8.44": "patches/@letta-ai__letta-agent-sdk@0.8.44.patch",
      },
    };
  },
};
