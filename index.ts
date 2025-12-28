#!/usr/bin/env node

import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { applyWorkspaceEdit } from './src/file-editor.js';
import { LSPClient } from './src/lsp-client.js';
import type { Hover, MarkedString, MarkupContent } from './src/types.js';
import { uriToPath } from './src/utils.js';

function formatHoverContents(contents: MarkupContent | MarkedString | MarkedString[]): string {
  if (typeof contents === 'string') return contents;

  if (Array.isArray(contents)) {
    return contents.map(formatHoverContents).join('\n\n');
  }

  if ('kind' in contents) {
    return contents.value;
  }

  if ('language' in contents) {
    return `\`\`\`${contents.language}\n${contents.value}\n\`\`\``;
  }

  return String(contents);
}

// Handle subcommands
const args = process.argv.slice(2);
if (args.length > 0) {
  const subcommand = args[0];

  if (subcommand === 'setup') {
    const { main } = await import('./src/setup.js');
    await main();
    process.exit(0);
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Available subcommands:');
    console.error('  setup    Configure cclsp for your project');
    console.error('');
    console.error('Run without arguments to start the MCP server.');
    process.exit(1);
  }
}

const lspClient = new LSPClient();

const server = new Server(
  {
    name: 'cclsp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'find_definition',
        description:
          'Find the definition of a symbol by name and kind in a file. Returns definitions for all matching symbols.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            symbol_name: {
              type: 'string',
              description: 'The name of the symbol',
            },
            symbol_kind: {
              type: 'string',
              description: 'The kind of symbol (function, class, variable, method, etc.)',
            },
          },
          required: ['file_path', 'symbol_name'],
        },
      },
      {
        name: 'find_references',
        description:
          'Find all references to a symbol across the entire workspace. Returns references for all matching symbols.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file where the symbol is defined',
            },
            symbol_name: {
              type: 'string',
              description: 'The name of the symbol',
            },
            symbol_kind: {
              type: 'string',
              description: 'The kind of symbol (function, class, variable, method, etc.)',
            },
            include_declaration: {
              type: 'boolean',
              description: 'Whether to include the declaration',
              default: true,
            },
          },
          required: ['file_path', 'symbol_name'],
        },
      },
      {
        name: 'rename_symbol',
        description:
          'Rename a symbol by name and kind in a file. If multiple symbols match, returns candidate positions and suggests using rename_symbol_strict. By default, this will apply the rename to the files. Use dry_run to preview changes without applying them.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            symbol_name: {
              type: 'string',
              description: 'The name of the symbol',
            },
            symbol_kind: {
              type: 'string',
              description: 'The kind of symbol (function, class, variable, method, etc.)',
            },
            new_name: {
              type: 'string',
              description: 'The new name for the symbol',
            },
            dry_run: {
              type: 'boolean',
              description:
                'If true, only preview the changes without applying them (default: false)',
            },
          },
          required: ['file_path', 'symbol_name', 'new_name'],
        },
      },
      {
        name: 'rename_symbol_strict',
        description:
          'Rename a symbol at a specific position in a file. Use this when rename_symbol returns multiple candidates. By default, this will apply the rename to the files. Use dry_run to preview changes without applying them.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            line: {
              type: 'number',
              description: 'The line number (1-indexed)',
            },
            character: {
              type: 'number',
              description: 'The character position in the line (1-indexed)',
            },
            new_name: {
              type: 'string',
              description: 'The new name for the symbol',
            },
            dry_run: {
              type: 'boolean',
              description:
                'If true, only preview the changes without applying them (default: false)',
            },
          },
          required: ['file_path', 'line', 'character', 'new_name'],
        },
      },
      {
        name: 'get_diagnostics',
        description:
          'Get language diagnostics (errors, warnings, hints) for a file. Uses LSP textDocument/diagnostic to pull current diagnostics.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file to get diagnostics for',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'restart_server',
        description:
          'Manually restart LSP servers. Can restart servers for specific file extensions or all running servers.',
        inputSchema: {
          type: 'object',
          properties: {
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Array of file extensions to restart servers for (e.g., ["ts", "tsx"]). If not provided, all servers will be restarted.',
            },
          },
        },
      },
      {
        name: 'hover',
        description:
          'Get hover information (documentation, type info) for a symbol at a specific position in a file.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to the file',
            },
            line: {
              type: 'number',
              description: 'Line number (1-indexed)',
            },
            character: {
              type: 'number',
              description: 'Character position (1-indexed)',
            },
          },
          required: ['file_path', 'line', 'character'],
        },
      },
      {
        name: 'find_implementation',
        description:
          'Find implementations of an interface, abstract method, or type. Similar to find_definition but returns implementing classes/functions.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to the file containing the symbol',
            },
            symbol_name: {
              type: 'string',
              description: 'Name of the interface/method to find implementations for',
            },
            symbol_kind: {
              type: 'string',
              description: 'Kind of symbol (interface, method, class, etc.)',
            },
          },
          required: ['file_path', 'symbol_name'],
        },
      },
      {
        name: 'workspace_symbol',
        description:
          'Search for symbols (functions, classes, variables, etc.) across the entire workspace. Queries all running LSP servers.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Symbol name pattern to search for (supports partial matching)',
            },
            file_path: {
              type: 'string',
              description: 'Optional: file to narrow search to its LSP server',
            },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: file extensions to limit search (e.g., ["ts", "tsx"])',
            },
            limit: {
              type: 'number',
              description: 'Max results to return (default: 100)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'call_hierarchy',
        description:
          'Navigate call relationships for functions/methods. Use action="prepare" first to get item IDs, then "incoming" or "outgoing" with the item_id.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['prepare', 'incoming', 'outgoing'],
              description:
                'Action: "prepare" finds callable at position, "incoming/outgoing" gets callers/callees',
            },
            file_path: {
              type: 'string',
              description: 'Path to file (required for prepare)',
            },
            symbol_name: {
              type: 'string',
              description: 'Symbol name (for prepare)',
            },
            symbol_kind: {
              type: 'string',
              description: 'Symbol kind (for prepare)',
            },
            line: {
              type: 'number',
              description: 'Line number (1-indexed) for disambiguation',
            },
            character: {
              type: 'number',
              description: 'Character position (1-indexed) for disambiguation',
            },
            item_id: {
              type: 'string',
              description: 'Item ID from prepare result (required for incoming/outgoing)',
            },
          },
          required: ['action'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'find_definition') {
      const { file_path, symbol_name, symbol_kind } = args as {
        file_path: string;
        symbol_name: string;
        symbol_kind?: string;
      };
      const absolutePath = resolve(file_path);

      const result = await lspClient.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
      const { matches: symbolMatches, warning } = result;

      process.stderr.write(
        `[DEBUG find_definition] Found ${symbolMatches.length} symbol matches for "${symbol_name}"\n`
      );

      if (symbolMatches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`,
            },
          ],
        };
      }

      const results = [];
      for (const match of symbolMatches) {
        process.stderr.write(
          `[DEBUG find_definition] Processing match: ${match.name} (${lspClient.symbolKindToString(match.kind)}) at ${match.position.line}:${match.position.character}\n`
        );
        try {
          const locations = await lspClient.findDefinition(absolutePath, match.position);
          process.stderr.write(
            `[DEBUG find_definition] findDefinition returned ${locations.length} locations\n`
          );

          if (locations.length > 0) {
            const locationResults = locations
              .map((loc) => {
                const filePath = uriToPath(loc.uri);
                const { start, end } = loc.range;
                return `${filePath}:${start.line + 1}:${start.character + 1}`;
              })
              .join('\n');

            results.push(
              `Results for ${match.name} (${lspClient.symbolKindToString(match.kind)}) at ${file_path}:${match.position.line + 1}:${match.position.character + 1}:\n${locationResults}`
            );
          } else {
            process.stderr.write(
              `[DEBUG find_definition] No definition found for ${match.name} at position ${match.position.line}:${match.position.character}\n`
            );
          }
        } catch (error) {
          process.stderr.write(`[DEBUG find_definition] Error processing match: ${error}\n`);
          // Continue trying other symbols if one fails
        }
      }

      if (results.length === 0) {
        const responseText = warning
          ? `${warning}\n\nFound ${symbolMatches.length} symbol(s) but no definitions could be retrieved. Please ensure the language server is properly configured.`
          : `Found ${symbolMatches.length} symbol(s) but no definitions could be retrieved. Please ensure the language server is properly configured.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      const responseText = warning ? `${warning}\n\n${results.join('\n\n')}` : results.join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    }

    if (name === 'find_references') {
      const {
        file_path,
        symbol_name,
        symbol_kind,
        include_declaration = true,
      } = args as {
        file_path: string;
        symbol_name: string;
        symbol_kind?: string;
        include_declaration?: boolean;
      };
      const absolutePath = resolve(file_path);

      const result = await lspClient.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
      const { matches: symbolMatches, warning } = result;

      if (symbolMatches.length === 0) {
        const responseText = warning
          ? `${warning}\n\nNo symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`
          : `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      const results = [];
      for (const match of symbolMatches) {
        try {
          const locations = await lspClient.findReferences(
            absolutePath,
            match.position,
            include_declaration
          );

          if (locations.length > 0) {
            const locationResults = locations
              .map((loc) => {
                const filePath = uriToPath(loc.uri);
                const { start, end } = loc.range;
                return `${filePath}:${start.line + 1}:${start.character + 1}`;
              })
              .join('\n');

            results.push(
              `Results for ${match.name} (${lspClient.symbolKindToString(match.kind)}) at ${file_path}:${match.position.line + 1}:${match.position.character + 1}:\n${locationResults}`
            );
          }
        } catch (error) {
          // Continue trying other symbols if one fails
        }
      }

      if (results.length === 0) {
        const responseText = warning
          ? `${warning}\n\nFound ${symbolMatches.length} symbol(s) but no references could be retrieved. Please ensure the language server is properly configured.`
          : `Found ${symbolMatches.length} symbol(s) but no references could be retrieved. Please ensure the language server is properly configured.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      const responseText = warning ? `${warning}\n\n${results.join('\n\n')}` : results.join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    }

    if (name === 'rename_symbol') {
      const {
        file_path,
        symbol_name,
        symbol_kind,
        new_name,
        dry_run = false,
      } = args as {
        file_path: string;
        symbol_name: string;
        symbol_kind?: string;
        new_name: string;
        dry_run?: boolean;
      };
      const absolutePath = resolve(file_path);

      const result = await lspClient.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
      const { matches: symbolMatches, warning } = result;

      if (symbolMatches.length === 0) {
        const responseText = warning
          ? `${warning}\n\nNo symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`
          : `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      if (symbolMatches.length > 1) {
        const candidatesList = symbolMatches
          .map(
            (match) =>
              `- ${match.name} (${lspClient.symbolKindToString(match.kind)}) at line ${match.position.line + 1}, character ${match.position.character + 1}`
          )
          .join('\n');

        const responseText = warning
          ? `${warning}\n\nMultiple symbols found matching "${symbol_name}"${symbol_kind ? ` with kind "${symbol_kind}"` : ''}. Please use rename_symbol_strict with one of these positions:\n\n${candidatesList}`
          : `Multiple symbols found matching "${symbol_name}"${symbol_kind ? ` with kind "${symbol_kind}"` : ''}. Please use rename_symbol_strict with one of these positions:\n\n${candidatesList}`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      // Single match - proceed with rename
      const match = symbolMatches[0];
      if (!match) {
        throw new Error('Unexpected error: no match found');
      }
      try {
        const workspaceEdit = await lspClient.renameSymbol(absolutePath, match.position, new_name);

        if (workspaceEdit?.changes && Object.keys(workspaceEdit.changes).length > 0) {
          const changes = [];
          for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
            const filePath = uriToPath(uri);
            changes.push(`File: ${filePath}`);
            for (const edit of edits) {
              const { start, end } = edit.range;
              changes.push(
                `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${edit.newText}"`
              );
            }
          }

          // Apply changes if not in dry run mode
          if (!dry_run) {
            const editResult = await applyWorkspaceEdit(workspaceEdit, { lspClient });

            if (!editResult.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Failed to apply rename: ${editResult.error}`,
                  },
                ],
              };
            }

            const responseText = warning
              ? `${warning}\n\nSuccessfully renamed ${match.name} (${lspClient.symbolKindToString(match.kind)}) to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`
              : `Successfully renamed ${match.name} (${lspClient.symbolKindToString(match.kind)}) to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`;

            return {
              content: [
                {
                  type: 'text',
                  text: responseText,
                },
              ],
            };
          }
          // Dry run mode - show preview
          const responseText = warning
            ? `${warning}\n\n[DRY RUN] Would rename ${match.name} (${lspClient.symbolKindToString(match.kind)}) to "${new_name}":\n${changes.join('\n')}`
            : `[DRY RUN] Would rename ${match.name} (${lspClient.symbolKindToString(match.kind)}) to "${new_name}":\n${changes.join('\n')}`;

          return {
            content: [
              {
                type: 'text',
                text: responseText,
              },
            ],
          };
        }
        const responseText = warning
          ? `${warning}\n\nNo rename edits available for ${match.name} (${lspClient.symbolKindToString(match.kind)}). The symbol may not be renameable or the language server doesn't support renaming this type of symbol.`
          : `No rename edits available for ${match.name} (${lspClient.symbolKindToString(match.kind)}). The symbol may not be renameable or the language server doesn't support renaming this type of symbol.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error renaming symbol: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'rename_symbol_strict') {
      const {
        file_path,
        line,
        character,
        new_name,
        dry_run = false,
      } = args as {
        file_path: string;
        line: number;
        character: number;
        new_name: string;
        dry_run?: boolean;
      };
      const absolutePath = resolve(file_path);

      try {
        const workspaceEdit = await lspClient.renameSymbol(
          absolutePath,
          { line: line - 1, character: character - 1 }, // Convert to 0-indexed
          new_name
        );

        if (workspaceEdit?.changes && Object.keys(workspaceEdit.changes).length > 0) {
          const changes = [];
          for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
            const filePath = uriToPath(uri);
            changes.push(`File: ${filePath}`);
            for (const edit of edits) {
              const { start, end } = edit.range;
              changes.push(
                `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${edit.newText}"`
              );
            }
          }

          // Apply changes if not in dry run mode
          if (!dry_run) {
            const editResult = await applyWorkspaceEdit(workspaceEdit, { lspClient });

            if (!editResult.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Failed to apply rename: ${editResult.error}`,
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: `Successfully renamed symbol at line ${line}, character ${character} to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`,
                },
              ],
            };
          }
          // Dry run mode - show preview
          return {
            content: [
              {
                type: 'text',
                text: `[DRY RUN] Would rename symbol at line ${line}, character ${character} to "${new_name}":\n${changes.join('\n')}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `No rename edits available at line ${line}, character ${character}. Please verify the symbol location and ensure the language server is properly configured.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error renaming symbol: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'get_diagnostics') {
      const { file_path } = args as { file_path: string };
      const absolutePath = resolve(file_path);

      try {
        const diagnostics = await lspClient.getDiagnostics(absolutePath);

        if (diagnostics.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No diagnostics found for ${file_path}. The file has no errors, warnings, or hints.`,
              },
            ],
          };
        }

        const severityMap = {
          1: 'Error',
          2: 'Warning',
          3: 'Information',
          4: 'Hint',
        };

        const diagnosticMessages = diagnostics.map((diag) => {
          const severity = diag.severity ? severityMap[diag.severity] || 'Unknown' : 'Unknown';
          const code = diag.code ? ` [${diag.code}]` : '';
          const source = diag.source ? ` (${diag.source})` : '';
          const { start, end } = diag.range;

          return `• ${severity}${code}${source}: ${diag.message}\n  Location: Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: `Found ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'} in ${file_path}:\n\n${diagnosticMessages.join('\n\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting diagnostics: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'restart_server') {
      const { extensions } = args as { extensions?: string[] };

      try {
        const result = await lspClient.restartServers(extensions);

        let response = result.message;

        if (result.restarted.length > 0) {
          response += `\n\nRestarted servers:\n${result.restarted.map((s) => `• ${s}`).join('\n')}`;
        }

        if (result.failed.length > 0) {
          response += `\n\nFailed to restart:\n${result.failed.map((s) => `• ${s}`).join('\n')}`;
        }

        return {
          content: [
            {
              type: 'text',
              text: response,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error restarting servers: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'hover') {
      const { file_path, line, character } = args as {
        file_path: string;
        line: number;
        character: number;
      };
      const absolutePath = resolve(file_path);

      try {
        const result = await lspClient.hover(absolutePath, {
          line: line - 1,
          character: character - 1,
        });

        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: `No hover information at ${file_path}:${line}:${character}`,
              },
            ],
          };
        }

        const text = formatHoverContents(result.contents);
        return {
          content: [
            {
              type: 'text',
              text,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting hover info: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'find_implementation') {
      const { file_path, symbol_name, symbol_kind } = args as {
        file_path: string;
        symbol_name: string;
        symbol_kind?: string;
      };
      const absolutePath = resolve(file_path);

      const result = await lspClient.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
      const { matches: symbolMatches, warning } = result;

      if (symbolMatches.length === 0) {
        const responseText = warning
          ? `${warning}\n\nNo symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}.`
          : `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      const results = [];
      for (const match of symbolMatches) {
        try {
          const locations = await lspClient.goToImplementation(absolutePath, match.position);

          if (locations.length > 0) {
            const locationResults = locations
              .map((loc) => {
                const filePath = uriToPath(loc.uri);
                const { start } = loc.range;
                return `${filePath}:${start.line + 1}:${start.character + 1}`;
              })
              .join('\n');

            results.push(
              `Implementations for ${match.name} (${lspClient.symbolKindToString(match.kind)}) at ${file_path}:${match.position.line + 1}:${match.position.character + 1}:\n${locationResults}`
            );
          }
        } catch (error) {
          // Continue trying other symbols if one fails
        }
      }

      if (results.length === 0) {
        const responseText = warning
          ? `${warning}\n\nFound ${symbolMatches.length} symbol(s) but no implementations could be retrieved.`
          : `Found ${symbolMatches.length} symbol(s) but no implementations could be retrieved.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      const responseText = warning ? `${warning}\n\n${results.join('\n\n')}` : results.join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    }

    if (name === 'workspace_symbol') {
      const { query, file_path, extensions, limit } = args as {
        query: string;
        file_path?: string;
        extensions?: string[];
        limit?: number;
      };

      try {
        const result = await lspClient.workspaceSymbol(query, {
          filePath: file_path ? resolve(file_path) : undefined,
          extensions,
          limit,
        });

        if (result.noServers) {
          return {
            content: [
              {
                type: 'text',
                text: 'No LSP servers are currently running. Use a file-based tool first to start a server, or check your cclsp configuration.',
              },
            ],
          };
        }

        if (result.results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found matching "${query}"`,
              },
            ],
          };
        }

        const formatted = result.results
          .map((sym) => {
            const loc = 'location' in sym ? sym.location : undefined;
            const filePath = loc && 'uri' in loc ? uriToPath(loc.uri) : 'unknown';
            const line =
              loc && 'range' in loc && loc.range
                ? (loc.range as { start: { line: number } }).start.line + 1
                : '?';
            return `${sym.name} (${lspClient.symbolKindToString(sym.kind)}) - ${filePath}:${line}`;
          })
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `Found ${result.results.length} symbols:\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error searching symbols: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'call_hierarchy') {
      const { action, file_path, symbol_name, symbol_kind, line, character, item_id } = args as {
        action: 'prepare' | 'incoming' | 'outgoing';
        file_path?: string;
        symbol_name?: string;
        symbol_kind?: string;
        line?: number;
        character?: number;
        item_id?: string;
      };

      try {
        if (action === 'prepare') {
          if (!file_path || !symbol_name) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'file_path and symbol_name are required for prepare action',
                },
              ],
            };
          }

          const absolutePath = resolve(file_path);
          let position: { line: number; character: number };

          if (line !== undefined && character !== undefined) {
            position = { line: line - 1, character: character - 1 };
          } else {
            const { matches } = await lspClient.findSymbolsByName(
              absolutePath,
              symbol_name,
              symbol_kind
            );

            if (matches.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Symbol "${symbol_name}" not found in ${file_path}`,
                  },
                ],
              };
            }

            if (matches.length > 1) {
              const candidates = matches
                .map(
                  (m) =>
                    `• ${m.name} (${lspClient.symbolKindToString(m.kind)}) at line ${m.position.line + 1}, character ${m.position.character + 1}`
                )
                .join('\n');

              return {
                content: [
                  {
                    type: 'text',
                    text: `Multiple symbols found matching "${symbol_name}". Please use line/character to disambiguate:\n\n${candidates}`,
                  },
                ],
              };
            }

            const firstMatch = matches[0];
            if (!firstMatch) {
              throw new Error('Unexpected empty matches array');
            }
            position = firstMatch.position;
          }

          const items = await lspClient.prepareCallHierarchy(absolutePath, position);

          if (items.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No call hierarchy available for this symbol',
                },
              ],
            };
          }

          const formatted = items
            .map(
              (item) =>
                `• ${item.name} (${lspClient.symbolKindToString(item.kind)}) - item_id: ${item._itemId}`
            )
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `Call hierarchy items:\n${formatted}\n\nUse item_id with action="incoming" or "outgoing"`,
              },
            ],
          };
        }

        if (action === 'incoming' || action === 'outgoing') {
          if (!item_id) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'item_id is required for incoming/outgoing action',
                },
              ],
            };
          }

          const calls =
            action === 'incoming'
              ? await lspClient.incomingCalls(item_id)
              : await lspClient.outgoingCalls(item_id);

          if (calls.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No ${action} calls found`,
                },
              ],
            };
          }

          const formatted = calls
            .map((call) => {
              const item = 'from' in call ? call.from : call.to;
              const filePath = uriToPath(item.uri);
              const callLine = item.selectionRange.start.line + 1;
              return `• ${item.name} (${lspClient.symbolKindToString(item.kind)}) - ${filePath}:${callLine}`;
            })
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `${action === 'incoming' ? 'Incoming' : 'Outgoing'} calls:\n${formatted}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Unknown action: ${action}. Use "prepare", "incoming", or "outgoing".`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error in call hierarchy: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

process.on('SIGINT', () => {
  lspClient.dispose();
  process.exit(0);
});

process.on('SIGTERM', () => {
  lspClient.dispose();
  process.exit(0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('CCLSP Server running on stdio\n');

  // Preload LSP servers for file types found in the project
  try {
    await lspClient.preloadServers();
  } catch (error) {
    process.stderr.write(`Failed to preload LSP servers: ${error}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Server error: ${error}\n`);
  lspClient.dispose();
  process.exit(1);
});
