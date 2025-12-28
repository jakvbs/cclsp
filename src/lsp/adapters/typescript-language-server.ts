import type { LSPServerConfig } from '../../types.js';
import type { InitializeParams, ServerAdapter } from './types.js';

/**
 * typescript-language-server behaves best with push diagnostics.
 *
 * In practice, advertising pull-diagnostics client capabilities can lead to no
 * publishDiagnostics being sent (even though the server does not implement
 * textDocument/diagnostic). This adapter forces the push path.
 */
export class TypeScriptLanguageServerAdapter implements ServerAdapter {
  readonly name = 'typescript-language-server';

  matches(config: LSPServerConfig): boolean {
    return config.command.some((cmd) => cmd.includes('typescript-language-server'));
  }

  customizeInitializeParams(params: InitializeParams): InitializeParams {
    const capabilities = (params.capabilities ?? {}) as any;
    capabilities.textDocument ??= {};

    // Prefer push diagnostics; do not advertise pull-diagnostics for this server.
    if (capabilities.textDocument.diagnostic) {
      delete capabilities.textDocument.diagnostic;
    }

    // Explicitly advertise publishDiagnostics support.
    capabilities.textDocument.publishDiagnostics ??= {
      relatedInformation: true,
      versionSupport: true,
    };

    // typescript-language-server commonly uses workspace/configuration.
    capabilities.workspace ??= {};
    capabilities.workspace.configuration = true;

    return {
      ...params,
      capabilities,
    };
  }
}
