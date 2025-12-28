import { beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LSPClient } from './lsp-client.js';
import { pathToUri } from './utils.js';

// Type for accessing private methods in tests
type LSPClientInternal = {
  startServer: (config: unknown) => Promise<unknown>;
  getServer: (filePath: string) => Promise<{ initializationPromise: Promise<void> }>;
  ensureFileOpen: (filePath: string) => Promise<void>;
  sendRequest: (method: string, params: unknown) => Promise<unknown>;
};

const TEST_DIR = process.env.RUNNER_TEMP
  ? `${process.env.RUNNER_TEMP}/cclsp-test`
  : '/tmp/cclsp-test';

const TEST_CONFIG_PATH = join(TEST_DIR, 'test-config.json');

describe('LSPClient', () => {
  beforeEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }

    mkdirSync(TEST_DIR, { recursive: true });

    // Create test config file
    const testConfig = {
      servers: [
        {
          extensions: ['ts', 'js', 'tsx', 'jsx'],
          command: ['npx', '--', 'typescript-language-server', '--stdio'],
          rootDir: '.',
        },
      ],
    };

    const configContent = JSON.stringify(testConfig, null, 2);

    // Use async file operations for better CI compatibility
    await writeFile(TEST_CONFIG_PATH, configContent);

    // Small delay to ensure filesystem consistency
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify file creation with retry logic for CI environments
    let fileExists = existsSync(TEST_CONFIG_PATH);
    let retries = 0;
    while (!fileExists && retries < 10) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      fileExists = existsSync(TEST_CONFIG_PATH);
      retries++;
    }

    if (!fileExists) {
      throw new Error(
        `Failed to create config file at ${TEST_CONFIG_PATH} after ${retries} retries`
      );
    }
  });

  it('should fail to create LSPClient when config file does not exist', () => {
    const stderrSpy = spyOn(process.stderr, 'write');
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    expect(() => {
      new LSPClient('/nonexistent/config.json');
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load config from /nonexistent/config.json')
    );

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should fail to create LSPClient when no configPath provided', () => {
    const stderrSpy = spyOn(process.stderr, 'write');
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    expect(() => {
      new LSPClient();
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'configPath is required when CCLSP_CONFIG_PATH environment variable is not set'
      )
    );

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should create LSPClient with valid config file', () => {
    const client = new LSPClient(TEST_CONFIG_PATH);
    expect(client).toBeDefined();
  });

  describe('preloadServers', () => {
    it('should scan directory and find file extensions', async () => {
      // Create test files with different extensions
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');
      await writeFile(join(TEST_DIR, 'test.js'), 'console.log("test");');
      await writeFile(join(TEST_DIR, 'test.py'), 'print("test")');

      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock process.stderr.write to capture output
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      // Mock startServer to avoid actually starting LSP servers
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockImplementation(async () => ({
        process: { kill: jest.fn() },
        initialized: true,
        openFiles: new Set(),
      }));

      await client.preloadServers(false);

      // Should attempt to start TypeScript server for .ts and .js files
      expect(startServerSpy).toHaveBeenCalled();

      stderrSpy.mockRestore();
      startServerSpy.mockRestore();
    });

    it('should handle missing .gitignore gracefully', async () => {
      // Create test file without .gitignore
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');

      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock startServer
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockImplementation(async () => ({
        process: { kill: jest.fn() },
        initialized: true,
        openFiles: new Set(),
      }));

      // Should not throw error
      await expect(async () => {
        await client.preloadServers(false);
      }).not.toThrow();

      startServerSpy.mockRestore();
    });

    it.skip('should handle preloading errors gracefully', async () => {
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');

      const client = new LSPClient(TEST_CONFIG_PATH);

      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      // Mock startServer to throw error
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockRejectedValue(new Error('Failed to start server'));

      // Should complete without throwing
      await client.preloadServers(false);

      // Should have logged the error to stderr
      expect(stderrSpy).toHaveBeenCalled();

      startServerSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  describe('initialization promise behavior', () => {
    it.skip('should wait for initialization on first call and pass through on subsequent calls', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      let initResolve: (() => void) | undefined;
      const initPromise = new Promise<void>((resolve) => {
        initResolve = resolve;
      });

      // Mock getServer to return a server state with our controlled promise
      const mockServerState = {
        initializationPromise: initPromise,
        process: { stdin: { write: jest.fn() } },
        initialized: false,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      // Mock ensureFileOpen to avoid file operations
      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      // Mock sendRequest to avoid actual LSP communication
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue([]);

      // Start first call (should wait)
      const firstCallPromise = client.findDefinition('test.ts', {
        line: 0,
        character: 0,
      });

      // Wait a bit to ensure call is waiting
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Resolve initialization
      initResolve?.();

      // Wait for call to complete
      await firstCallPromise;

      // Verify call was made
      expect(sendRequestSpy).toHaveBeenCalled();

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should handle multiple concurrent calls waiting for initialization', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      let initResolve: (() => void) | undefined;
      const initPromise = new Promise<void>((resolve) => {
        initResolve = resolve;
      });

      const mockServerState = {
        initializationPromise: initPromise,
        process: { stdin: { write: jest.fn() } },
        initialized: false,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue([]);

      // Start multiple concurrent calls
      const promises = [
        client.findDefinition('test.ts', { line: 0, character: 0 }),
        client.findReferences('test.ts', { line: 1, character: 0 }),
        client.renameSymbol('test.ts', { line: 2, character: 0 }, 'newName'),
      ];

      // Wait a bit to ensure all are waiting
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Resolve initialization - all should proceed
      initResolve?.();

      // All calls should complete successfully
      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);

      // Each method should have been called once
      expect(sendRequestSpy).toHaveBeenCalledTimes(3);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('Symbol kind fallback functionality', () => {
    it('should return fallback results when specified symbol kind not found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock getDocumentSymbols to return test symbols
      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12, // Function
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
        },
        {
          name: 'testVariable',
          kind: 13, // Variable
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } },
          selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 18 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'testFunction' with kind 'class' (should not match, then fallback to all kinds)
      const result = await client.findSymbolsByName('test.ts', 'testFunction', 'class');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.name).toBe('testFunction');
      expect(result.matches[0]?.kind).toBe(12); // Function
      expect(result.warning).toContain('No symbols found with kind "class"');
      expect(result.warning).toContain(
        'Found 1 symbol(s) with name "testFunction" of other kinds: function'
      );

      getDocumentSymbolsSpy.mockRestore();
    });

    it('should return multiple fallback results of different kinds', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock getDocumentSymbols to return symbols with same name but different kinds
      const mockSymbols = [
        {
          name: 'test',
          kind: 12, // Function
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
        },
        {
          name: 'test',
          kind: 13, // Variable
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 15 } },
          selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 10 } },
        },
        {
          name: 'test',
          kind: 5, // Class
          range: { start: { line: 5, character: 0 }, end: { line: 10, character: 1 } },
          selectionRange: { start: { line: 5, character: 6 }, end: { line: 5, character: 10 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'test' with kind 'interface' (should not match, then fallback to all kinds)
      const result = await client.findSymbolsByName('test.ts', 'test', 'interface');

      expect(result.matches).toHaveLength(3);
      expect(result.warning).toContain('No symbols found with kind "interface"');
      expect(result.warning).toContain(
        'Found 3 symbol(s) with name "test" of other kinds: function, variable, class'
      );

      getDocumentSymbolsSpy.mockRestore();
    });

    it('should not trigger fallback when correct symbol kind is found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12, // Function
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
        },
        {
          name: 'testVariable',
          kind: 13, // Variable
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } },
          selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 18 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'testFunction' with correct kind 'function'
      const result = await client.findSymbolsByName('test.ts', 'testFunction', 'function');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.name).toBe('testFunction');
      expect(result.warning).toBeUndefined(); // No warning expected

      getDocumentSymbolsSpy.mockRestore();
    });

    it('should return empty results when no symbols found even with fallback', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'otherFunction',
          kind: 12, // Function
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 22 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for non-existent symbol
      const result = await client.findSymbolsByName('test.ts', 'nonExistentSymbol', 'function');

      expect(result.matches).toHaveLength(0);
      expect(result.warning).toBeUndefined(); // No fallback triggered since no name matches found

      getDocumentSymbolsSpy.mockRestore();
    });
  });

  describe('Server restart functionality', () => {
    it('should setup restart timer when restartInterval is configured', () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock setTimeout to verify timer is set
      const setTimeoutSpy = spyOn(global, 'setTimeout').mockImplementation((() => 123) as any);

      const mockServerState = {
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: {
          extensions: ['ts'],
          command: ['echo', 'mock'],
          restartInterval: 0.1, // 0.1 minutes
        },
        restartTimer: undefined,
      };

      try {
        // Call setupRestartTimer directly
        (client as any).setupRestartTimer(mockServerState);

        // Verify setTimeout was called with correct interval (0.1 minutes = 6000ms)
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 6000);
      } finally {
        setTimeoutSpy.mockRestore();
        client.dispose();
      }
    });

    it('should not setup restart timer when restartInterval is not configured', () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock setTimeout to verify timer is NOT set
      const setTimeoutSpy = spyOn(global, 'setTimeout').mockImplementation((() => 123) as any);

      const mockServerState = {
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: {
          extensions: ['ts'],
          command: ['echo', 'mock'],
          // No restartInterval
        },
        restartTimer: undefined,
      };

      try {
        // Call setupRestartTimer directly
        (client as any).setupRestartTimer(mockServerState);

        // Verify setTimeout was NOT called
        expect(setTimeoutSpy).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
        client.dispose();
      }
    });

    it('should clear restart timer when disposing client', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTimer = setTimeout(() => {}, 1000);
      const mockServerState = {
        process: { kill: jest.fn() },
        restartTimer: mockTimer,
      };

      // Mock servers map to include our test server state
      const serversMap = new Map();
      serversMap.set('test-key', mockServerState);
      (client as any).servers = serversMap;

      const clearTimeoutSpy = spyOn(global, 'clearTimeout');

      client.dispose();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimer);
      expect(mockServerState.process.kill).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });
  });

  describe('restartServers', () => {
    it('should handle restart request for non-existent extensions', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const result = await client.restartServers(['xyz']);

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.message).toContain('No LSP servers found for extensions');
    });

    it('should handle restart request when no servers are running', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const result = await client.restartServers();

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.message).toBe('No LSP servers are currently running');
    });

    it('should restart servers for specific extensions', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock servers map with running servers
      const mockServerState = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts', 'tsx'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const serversMap = new Map();
      serversMap.set(JSON.stringify(mockServerState.config), mockServerState);
      (client as any).servers = serversMap;

      // Mock startServer to simulate successful restart
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: mockServerState.config,
      });

      const result = await client.restartServers(['ts']);

      expect(result.success).toBe(true);
      expect(result.restarted).toHaveLength(1);
      expect(result.restarted[0]).toContain('typescript-language-server');
      expect(result.failed).toHaveLength(0);
      expect(mockServerState.process.kill).toHaveBeenCalled();
      expect(startServerSpy).toHaveBeenCalledWith(mockServerState.config);

      startServerSpy.mockRestore();
    });

    it('should restart all servers when no extensions specified', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock multiple servers
      const mockServer1 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts', 'tsx'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const mockServer2 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['py'],
          command: ['pylsp'],
        },
        restartTimer: undefined,
      };

      const serversMap = new Map();
      serversMap.set(JSON.stringify(mockServer1.config), mockServer1);
      serversMap.set(JSON.stringify(mockServer2.config), mockServer2);
      (client as any).servers = serversMap;

      // Mock startServer
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: mockServer1.config,
      });

      const result = await client.restartServers();

      expect(result.success).toBe(true);
      expect(result.restarted).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(mockServer1.process.kill).toHaveBeenCalled();
      expect(mockServer2.process.kill).toHaveBeenCalled();
      expect(startServerSpy).toHaveBeenCalledTimes(2);

      startServerSpy.mockRestore();
    });

    it('should handle partial restart failures', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServer1 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const mockServer2 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['py'],
          command: ['pylsp'],
        },
        restartTimer: undefined,
      };

      const serversMap = new Map();
      serversMap.set(JSON.stringify(mockServer1.config), mockServer1);
      serversMap.set(JSON.stringify(mockServer2.config), mockServer2);
      (client as any).servers = serversMap;

      let callCount = 0;
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockImplementation(async (config) => {
        callCount++;
        if (callCount === 1) {
          return {
            process: { kill: jest.fn() },
            initialized: true,
            initializationPromise: Promise.resolve(),
            openFiles: new Set(),
            startTime: Date.now(),
            config,
          };
        }
        throw new Error('Failed to start server');
      });

      const result = await client.restartServers();

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.message).toContain('Restarted 1 server(s), but 1 failed');

      startServerSpy.mockRestore();
    });

    it('should clear restart timer before restarting', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTimer = setTimeout(() => {}, 1000);
      const mockServerState = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: mockTimer,
      };

      const serversMap = new Map();
      serversMap.set(JSON.stringify(mockServerState.config), mockServerState);
      (client as any).servers = serversMap;

      const clearTimeoutSpy = spyOn(global, 'clearTimeout');
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: mockServerState.config,
      });

      await client.restartServers(['ts']);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimer);

      clearTimeoutSpy.mockRestore();
      startServerSpy.mockRestore();
    });
  });

  describe('getDiagnostics', () => {
    it('should return diagnostics when server supports textDocument/diagnostic', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockDiagnostics = [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          severity: 1, // Error
          message: 'Test error message',
          source: 'test',
        },
        {
          range: {
            start: { line: 5, character: 2 },
            end: { line: 5, character: 8 },
          },
          severity: 2, // Warning
          message: 'Test warning message',
          source: 'test',
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
        serverCapabilities: { diagnosticProvider: {} },
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const syncFileContentSpy = spyOn(client, 'syncFileContent').mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({
        kind: 'full',
        items: mockDiagnostics,
      });

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual(mockDiagnostics);
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'textDocument/diagnostic',
        {
          textDocument: { uri: pathToUri('/test.ts') },
        }
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      syncFileContentSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array for unchanged report', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
        serverCapabilities: { diagnosticProvider: {} },
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const syncFileContentSpy = spyOn(client, 'syncFileContent').mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({
        kind: 'unchanged',
        resultId: 'test-result-id',
      });

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      syncFileContentSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return cached diagnostics from publishDiagnostics', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockDiagnostics = [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          severity: 1,
          message: 'Cached error',
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map([[pathToUri('/test.ts'), mockDiagnostics]]),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);
      const syncFileContentSpy = spyOn(client, 'syncFileContent').mockResolvedValue(undefined);
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual(mockDiagnostics);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Returning 1 cached diagnostics from publishDiagnostics')
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      syncFileContentSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should handle server not supporting textDocument/diagnostic', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
        serverCapabilities: { diagnosticProvider: {} },
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const syncFileContentSpy = spyOn(client, 'syncFileContent').mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockRejectedValue(new Error('Method not found'));

      const waitForDiagnosticsIdleSpy = spyOn(
        client as any,
        'waitForDiagnosticsIdle'
      ).mockImplementation(async () => {
        mockServerState.diagnostics.set(pathToUri('/test.ts'), []);
      });

      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual([]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('textDocument/diagnostic not supported or failed')
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      syncFileContentSpy.mockRestore();
      sendRequestSpy.mockRestore();
      waitForDiagnosticsIdleSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should handle unexpected response format', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
        serverCapabilities: { diagnosticProvider: {} },
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const syncFileContentSpy = spyOn(client, 'syncFileContent').mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({ unexpected: 'response' });

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      syncFileContentSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('hover', () => {
    it('should return hover info when available', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockHoverResult = {
        contents: { kind: 'markdown' as const, value: '```typescript\nfunction test(): void\n```' },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
      };

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { hoverProvider: true },
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockHoverResult);

      const result = await client.hover('/test.ts', { line: 0, character: 0 });

      expect(result).toEqual(mockHoverResult);
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'textDocument/hover',
        {
          textDocument: { uri: pathToUri('/test.ts') },
          position: { line: 0, character: 0 },
        },
        30000
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return null when server does not support hover', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { hoverProvider: false },
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.hover('/test.ts', { line: 0, character: 0 });

      expect(result).toBeNull();

      getServerSpy.mockRestore();
    });

    it('should return null when no hover info at position', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { hoverProvider: true },
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.hover('/test.ts', { line: 0, character: 0 });

      expect(result).toBeNull();

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('goToImplementation', () => {
    it('should return single location', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockLocation = {
        uri: 'file:///impl.ts',
        range: {
          start: { line: 10, character: 0 },
          end: { line: 10, character: 20 },
        },
      };

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { implementationProvider: true },
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockLocation);

      const result = await client.goToImplementation('/test.ts', { line: 0, character: 0 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockLocation);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return multiple locations', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockLocations = [
        {
          uri: 'file:///impl1.ts',
          range: { start: { line: 10, character: 0 }, end: { line: 10, character: 20 } },
        },
        {
          uri: 'file:///impl2.ts',
          range: { start: { line: 20, character: 0 }, end: { line: 20, character: 25 } },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { implementationProvider: true },
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockLocations);

      const result = await client.goToImplementation('/test.ts', { line: 0, character: 0 });

      expect(result).toHaveLength(2);
      expect(result[0]?.uri).toBe('file:///impl1.ts');
      expect(result[1]?.uri).toBe('file:///impl2.ts');

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should normalize LocationLink to Location', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockLocationLinks = [
        {
          targetUri: 'file:///impl.ts',
          targetRange: { start: { line: 10, character: 0 }, end: { line: 10, character: 20 } },
          targetSelectionRange: {
            start: { line: 10, character: 5 },
            end: { line: 10, character: 15 },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { implementationProvider: true },
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockLocationLinks);

      const result = await client.goToImplementation('/test.ts', { line: 0, character: 0 });

      expect(result).toHaveLength(1);
      expect(result[0]?.uri).toBe('file:///impl.ts');
      expect(result[0]?.range).toEqual({
        start: { line: 10, character: 0 },
        end: { line: 10, character: 20 },
      });

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array when server does not support implementation', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { implementationProvider: false },
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.goToImplementation('/test.ts', { line: 0, character: 0 });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
    });

    it('should return empty array when result is null', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { implementationProvider: true },
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.goToImplementation('/test.ts', { line: 0, character: 0 });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('workspaceSymbol', () => {
    it('should return results from single server via filePath', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'TestClass',
          kind: 5,
          location: {
            uri: 'file:///test.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('Test', { filePath: '/test.ts' });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.name).toBe('TestClass');
      expect(result.noServers).toBeUndefined();

      getServerSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return noServers when no servers are running', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Ensure servers map is empty
      (client as any).servers = new Map();

      const result = await client.workspaceSymbol('Test');

      expect(result.results).toEqual([]);
      expect(result.noServers).toBe(true);
    });

    it('should fan-out to all running servers', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols1 = [{ name: 'Symbol1', kind: 5, location: { uri: 'file:///a.ts' } }];
      const mockSymbols2 = [{ name: 'Symbol2', kind: 12, location: { uri: 'file:///b.py' } }];

      const mockServer1 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['ts'], command: ['ts-server'] },
      };

      const mockServer2 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['py'], command: ['py-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServer1);
      serversMap.set('py-server', mockServer2);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockImplementation(async (proc: unknown) => {
        // Branch on process identity for robustness
        if (proc === mockServer1.process) return mockSymbols1;
        if (proc === mockServer2.process) return mockSymbols2;
        return [];
      });

      const result = await client.workspaceSymbol('Symbol');

      expect(result.results).toHaveLength(2);
      expect(sendRequestSpy).toHaveBeenCalledTimes(2);

      sendRequestSpy.mockRestore();
    });

    it('should filter servers by extensions option', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [{ name: 'TsSymbol', kind: 5, location: { uri: 'file:///a.ts' } }];

      const mockServer1 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['ts', 'tsx'], command: ['ts-server'] },
      };

      const mockServer2 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['py'], command: ['py-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServer1);
      serversMap.set('py-server', mockServer2);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('Symbol', { extensions: ['ts'] });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.name).toBe('TsSymbol');
      // Only ts-server should be queried
      expect(sendRequestSpy).toHaveBeenCalledTimes(1);

      sendRequestSpy.mockRestore();
    });

    it('should return noServers when extensions filter matches no running servers', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServer = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['ts'], command: ['ts-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServer);
      (client as any).servers = serversMap;

      // Query for extensions that don't match any running server
      const result = await client.workspaceSymbol('Symbol', { extensions: ['go', 'rust'] });

      expect(result.results).toEqual([]);
      expect(result.noServers).toBe(true);
    });

    it('should ignore non-array responses from servers (null)', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServer = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['ts'], command: ['ts-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServer);
      (client as any).servers = serversMap;

      // Server returns null instead of array
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.workspaceSymbol('Symbol');

      expect(result.results).toEqual([]);
      expect(result.noServers).toBeUndefined();

      sendRequestSpy.mockRestore();
    });

    it('should ignore non-array responses from servers (object)', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServer = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['ts'], command: ['ts-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServer);
      (client as any).servers = serversMap;

      // Server returns object instead of array
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({ unexpected: 'object' });

      const result = await client.workspaceSymbol('Symbol');

      expect(result.results).toEqual([]);
      expect(result.noServers).toBeUndefined();

      sendRequestSpy.mockRestore();
    });

    it('should return empty results when all servers do not support workspaceSymbol', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServer1 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: false },
        adapter: undefined,
        config: { extensions: ['ts'], command: ['ts-server'] },
      };

      const mockServer2 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: false },
        adapter: undefined,
        config: { extensions: ['py'], command: ['py-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServer1);
      serversMap.set('py-server', mockServer2);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(client as unknown as LSPClientInternal, 'sendRequest');

      const result = await client.workspaceSymbol('Symbol');

      expect(result.results).toEqual([]);
      // noServers should be undefined (servers exist, they just don't support the feature)
      expect(result.noServers).toBeUndefined();
      // sendRequest should never be called since all servers lack support
      expect(sendRequestSpy).not.toHaveBeenCalled();

      sendRequestSpy.mockRestore();
    });

    it('should respect limit parameter', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = Array.from({ length: 150 }, (_, i) => ({
        name: `Symbol${i}`,
        kind: 5,
        location: { uri: `file:///file${i}.ts` },
      }));

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['ts'], command: ['ts-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServerState);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('Symbol', { limit: 50 });

      expect(result.results).toHaveLength(50);

      sendRequestSpy.mockRestore();
    });

    it('should skip servers that do not support workspaceSymbol', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [{ name: 'Symbol1', kind: 5, location: { uri: 'file:///a.ts' } }];

      const mockServer1 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: false },
        adapter: undefined,
        config: { extensions: ['ts'], command: ['ts-server'] },
      };

      const mockServer2 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['py'], command: ['py-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServer1);
      serversMap.set('py-server', mockServer2);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('Symbol');

      expect(result.results).toHaveLength(1);
      expect(sendRequestSpy).toHaveBeenCalledTimes(1);

      sendRequestSpy.mockRestore();
    });

    it('should handle server errors gracefully', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServer1 = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { workspaceSymbolProvider: true },
        adapter: undefined,
        config: { extensions: ['ts'], command: ['ts-server'] },
      };

      const serversMap = new Map();
      serversMap.set('ts-server', mockServer1);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockRejectedValue(new Error('Server timeout'));

      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = await client.workspaceSymbol('Symbol');

      expect(result.results).toEqual([]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('[workspaceSymbol] Server error')
      );

      sendRequestSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  describe('prepareCallHierarchy', () => {
    it('should return items with _itemId and cache them', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItems = [
        {
          name: 'testFunction',
          kind: 12,
          uri: 'file:///test.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { callHierarchyProvider: true },
        adapter: undefined,
        key: 'test-server-key',
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockItems);

      const result = await client.prepareCallHierarchy('/test.ts', { line: 0, character: 10 });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('testFunction');
      expect(result[0]?._itemId).toMatch(/^ch_\d+_\d+$/);

      // Verify item is cached
      const cache = (client as any).callHierarchyCache;
      expect(cache.size).toBe(1);
      const cachedEntry = cache.get(result[0]?._itemId);
      expect(cachedEntry?.serverKey).toBe('test-server-key');
      expect(cachedEntry?.item.name).toBe('testFunction');

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array when server does not support callHierarchy', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { callHierarchyProvider: false },
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.prepareCallHierarchy('/test.ts', { line: 0, character: 0 });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
    });

    it('should return empty array when result is null', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { callHierarchyProvider: true },
        adapter: undefined,
        key: 'test-server-key',
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.prepareCallHierarchy('/test.ts', { line: 0, character: 0 });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array and not grow cache when result is empty array', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { callHierarchyProvider: true },
        adapter: undefined,
        key: 'test-server-key',
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue([]);

      const cacheSizeBefore = (client as any).callHierarchyCache.size;
      const result = await client.prepareCallHierarchy('/test.ts', { line: 0, character: 0 });

      expect(result).toEqual([]);
      // Cache should not grow when result is empty
      expect((client as any).callHierarchyCache.size).toBe(cacheSizeBefore);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array when result is non-array object', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        serverCapabilities: { callHierarchyProvider: true },
        adapter: undefined,
        key: 'test-server-key',
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      // Server returns object instead of array
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({ unexpected: 'object' });

      const result = await client.prepareCallHierarchy('/test.ts', { line: 0, character: 0 });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('incomingCalls', () => {
    it('should return calls for valid item_id', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      const mockIncomingCalls = [
        {
          from: {
            name: 'callerFunction',
            kind: 12,
            uri: 'file:///caller.ts',
            range: { start: { line: 10, character: 0 }, end: { line: 15, character: 1 } },
            selectionRange: { start: { line: 10, character: 9 }, end: { line: 10, character: 23 } },
          },
          fromRanges: [{ start: { line: 12, character: 2 }, end: { line: 12, character: 14 } }],
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      // Setup cache with test item
      const itemId = 'ch_test_123';
      (client as any).callHierarchyCache.set(itemId, {
        serverKey: 'test-server-key',
        item: mockItem,
        createdAt: Date.now(),
      });

      // Setup servers map
      const serversMap = new Map();
      serversMap.set('test-server-key', mockServerState);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockIncomingCalls);

      const result = await client.incomingCalls(itemId);

      expect(result).toHaveLength(1);
      expect(result[0]?.from.name).toBe('callerFunction');
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'callHierarchy/incomingCalls',
        { item: mockItem },
        45000
      );

      sendRequestSpy.mockRestore();
    });

    it('should throw error for invalid item_id', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      await expect(client.incomingCalls('invalid_id')).rejects.toThrow(
        'CallHierarchyItem not found or expired: invalid_id. Use prepareCallHierarchy first.'
      );
    });

    it('should throw error when server is no longer available', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      // Setup cache with test item but no matching server
      const itemId = 'ch_test_456';
      (client as any).callHierarchyCache.set(itemId, {
        serverKey: 'nonexistent-server-key',
        item: mockItem,
        createdAt: Date.now(),
      });

      // Empty servers map
      (client as any).servers = new Map();

      await expect(client.incomingCalls(itemId)).rejects.toThrow(
        'LSP server no longer available. Re-run prepareCallHierarchy.'
      );
    });

    it('should return empty array when sendRequest returns null', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const itemId = 'ch_test_null';
      (client as any).callHierarchyCache.set(itemId, {
        serverKey: 'test-server-key',
        item: mockItem,
        createdAt: Date.now(),
      });

      const serversMap = new Map();
      serversMap.set('test-server-key', mockServerState);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.incomingCalls(itemId);

      expect(result).toEqual([]);

      sendRequestSpy.mockRestore();
    });

    it('should treat expired cached item as not found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      // Add item that expired 6 minutes ago
      const itemId = 'ch_expired_item';
      (client as any).callHierarchyCache.set(itemId, {
        serverKey: 'test-server-key',
        item: mockItem,
        createdAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      });

      // Even though server exists, expired item should be cleaned up and treated as not found
      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const serversMap = new Map();
      serversMap.set('test-server-key', mockServerState);
      (client as any).servers = serversMap;

      await expect(client.incomingCalls(itemId)).rejects.toThrow(
        'CallHierarchyItem not found or expired: ch_expired_item. Use prepareCallHierarchy first.'
      );
    });
  });

  describe('outgoingCalls', () => {
    it('should return calls for valid item_id', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      const mockOutgoingCalls = [
        {
          to: {
            name: 'calleeFunction',
            kind: 12,
            uri: 'file:///callee.ts',
            range: { start: { line: 20, character: 0 }, end: { line: 25, character: 1 } },
            selectionRange: { start: { line: 20, character: 9 }, end: { line: 20, character: 23 } },
          },
          fromRanges: [{ start: { line: 3, character: 2 }, end: { line: 3, character: 16 } }],
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      // Setup cache with test item
      const itemId = 'ch_test_789';
      (client as any).callHierarchyCache.set(itemId, {
        serverKey: 'test-server-key',
        item: mockItem,
        createdAt: Date.now(),
      });

      // Setup servers map
      const serversMap = new Map();
      serversMap.set('test-server-key', mockServerState);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockOutgoingCalls);

      const result = await client.outgoingCalls(itemId);

      expect(result).toHaveLength(1);
      expect(result[0]?.to.name).toBe('calleeFunction');
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'callHierarchy/outgoingCalls',
        { item: mockItem },
        45000
      );

      sendRequestSpy.mockRestore();
    });

    it('should throw error for invalid item_id', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      await expect(client.outgoingCalls('invalid_id')).rejects.toThrow(
        'CallHierarchyItem not found or expired: invalid_id. Use prepareCallHierarchy first.'
      );
    });

    it('should throw error when server is no longer available', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      // Setup cache with test item but no matching server
      const itemId = 'ch_test_outgoing_no_server';
      (client as any).callHierarchyCache.set(itemId, {
        serverKey: 'nonexistent-server-key',
        item: mockItem,
        createdAt: Date.now(),
      });

      // Empty servers map
      (client as any).servers = new Map();

      await expect(client.outgoingCalls(itemId)).rejects.toThrow(
        'LSP server no longer available. Re-run prepareCallHierarchy.'
      );
    });

    it('should return empty array when sendRequest returns null', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const itemId = 'ch_test_outgoing_null';
      (client as any).callHierarchyCache.set(itemId, {
        serverKey: 'test-server-key',
        item: mockItem,
        createdAt: Date.now(),
      });

      const serversMap = new Map();
      serversMap.set('test-server-key', mockServerState);
      (client as any).servers = serversMap;

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.outgoingCalls(itemId);

      expect(result).toEqual([]);

      sendRequestSpy.mockRestore();
    });
  });

  describe('call hierarchy cache cleanup', () => {
    it('should remove items older than 5 minutes', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      const cache = (client as any).callHierarchyCache;

      // Add old item (6 minutes ago)
      cache.set('old_item', {
        serverKey: 'server1',
        item: mockItem,
        createdAt: Date.now() - 6 * 60 * 1000,
      });

      // Add recent item
      cache.set('recent_item', {
        serverKey: 'server2',
        item: mockItem,
        createdAt: Date.now(),
      });

      expect(cache.size).toBe(2);

      // Trigger cleanup via private method
      (client as any).cleanupOldCallHierarchyItems();

      expect(cache.size).toBe(1);
      expect(cache.has('old_item')).toBe(false);
      expect(cache.has('recent_item')).toBe(true);
    });

    it('should clear cache for specific server on restart', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: 'file:///test.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
      };

      const cache = (client as any).callHierarchyCache;

      // Add items for different servers
      cache.set('item1', {
        serverKey: 'server-to-restart',
        item: mockItem,
        createdAt: Date.now(),
      });

      cache.set('item2', {
        serverKey: 'server-to-restart',
        item: mockItem,
        createdAt: Date.now(),
      });

      cache.set('item3', {
        serverKey: 'other-server',
        item: mockItem,
        createdAt: Date.now(),
      });

      expect(cache.size).toBe(3);

      // Clear cache for specific server
      (client as any).clearCallHierarchyCacheForServer('server-to-restart');

      expect(cache.size).toBe(1);
      expect(cache.has('item1')).toBe(false);
      expect(cache.has('item2')).toBe(false);
      expect(cache.has('item3')).toBe(true);
    });
  });
});
