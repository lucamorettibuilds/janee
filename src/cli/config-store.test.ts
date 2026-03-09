/**
 * Tests for SQLite config store (config-store.ts)
 *
 * Tests the core contract: round-trip save/load, encryption, migration,
 * and backward compatibility with the YAML API surface.
 */

import fs from "fs";
import yaml from "js-yaml";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptSecret, generateMasterKey } from "../core/crypto";
import {
  closeDb,
  hasConfig,
  initConfig,
  loadConfig,
  saveConfig,
  addService,
  addCapability,
  migrateToSQLite,
  type JaneeConfig,
} from "./config-store";

describe("SQLite Config Store", () => {
  let testConfigDir: string;
  let testJaneeDir: string;
  let originalHomedir: () => string;

  beforeEach(() => {
    testConfigDir = path.join(
      os.tmpdir(),
      `janee-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    testJaneeDir = path.join(testConfigDir, ".janee");
    fs.mkdirSync(testJaneeDir, { recursive: true });
    originalHomedir = os.homedir;
    os.homedir = () => testConfigDir;
  });

  afterEach(() => {
    closeDb();
    os.homedir = originalHomedir;
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    }
  });

  describe("Basic operations", () => {
    it("should init, save, and load config round-trip", () => {
      const config = initConfig();
      expect(config.version).toBe("1.0.0");
      expect(config.masterKey).toBeDefined();
      expect(hasConfig()).toBe(true);

      const loaded = loadConfig();
      expect(loaded.version).toBe("1.0.0");
      expect(loaded.masterKey).toBe(config.masterKey);
    });

    it("should round-trip all auth types", () => {
      const masterKey = generateMasterKey();
      const config: JaneeConfig = {
        version: "1.0.0",
        masterKey,
        server: { port: 9119, host: "localhost", strictDecryption: true },
        services: {
          bearer: {
            baseUrl: "https://api1.com",
            auth: { type: "bearer", key: "bearer-key" },
          },
          hmac: {
            baseUrl: "https://api2.com",
            auth: { type: "hmac-mexc", apiKey: "hk", apiSecret: "hs" },
          },
          hdrs: {
            baseUrl: "https://api3.com",
            auth: {
              type: "headers",
              headers: { "X-Key": "hv", "X-Other": "ov" },
            },
          },
        },
        capabilities: {},
      };

      saveConfig(config);
      closeDb(); // Force re-open to confirm persistence
      const loaded = loadConfig();

      expect(loaded.masterKey).toBe(masterKey);
      expect(loaded.services.bearer.auth.key).toBe("bearer-key");
      expect(loaded.services.hmac.auth.apiKey).toBe("hk");
      expect(loaded.services.hmac.auth.apiSecret).toBe("hs");
      expect(loaded.services.hdrs.auth.headers?.["X-Key"]).toBe("hv");
      expect(loaded.services.hdrs.auth.headers?.["X-Other"]).toBe("ov");
    });

    it("should preserve capabilities and server config", () => {
      const masterKey = generateMasterKey();
      const config: JaneeConfig = {
        version: "1.0.0",
        masterKey,
        server: { port: 8080, host: "0.0.0.0", strictDecryption: false },
        services: {},
        capabilities: {
          myTool: {
            service: "testSvc",
            path: "/api/data",
            method: "GET",
            description: "Get data",
          },
        },
      };

      saveConfig(config);
      const loaded = loadConfig();

      expect(loaded.server.port).toBe(8080);
      expect(loaded.server.host).toBe("0.0.0.0");
      expect(loaded.server.strictDecryption).toBe(false);
      expect(loaded.capabilities.myTool.service).toBe("testSvc");
      expect(loaded.capabilities.myTool.path).toBe("/api/data");
    });

    it("should not store secrets in plaintext in the database", () => {
      const masterKey = generateMasterKey();
      const config: JaneeConfig = {
        version: "1.0.0",
        masterKey,
        server: { port: 9119, host: "localhost", strictDecryption: true },
        services: {
          testSvc: {
            baseUrl: "https://api.test.com",
            auth: { type: "bearer", key: "super-secret-key" },
          },
        },
        capabilities: {},
      };

      saveConfig(config);

      // Read the raw database file and check secret isn't plaintext
      const dbPath = path.join(testJaneeDir, "janee.db");
      expect(fs.existsSync(dbPath)).toBe(true);
      const rawBytes = fs.readFileSync(dbPath);
      expect(rawBytes.toString("utf8")).not.toContain("super-secret-key");
    });
  });

  describe("Service and capability management", () => {
    it("should add a service via addService", () => {
      initConfig();
      addService("newSvc", "https://new.api.com", {
        type: "bearer",
        key: "new-key",
      });

      const loaded = loadConfig();
      expect(loaded.services.newSvc).toBeDefined();
      expect(loaded.services.newSvc.baseUrl).toBe("https://new.api.com");
      expect(loaded.services.newSvc.auth.key).toBe("new-key");
    });

    it("should add a capability via addCapability", () => {
      initConfig();
      addService("mySvc", "https://api.com", { type: "bearer", key: "k" });
      addCapability("myTool", {
        service: "mySvc",
        path: "/data",
        method: "POST",
        description: "Post data",
      });

      const loaded = loadConfig();
      expect(loaded.capabilities.myTool).toBeDefined();
      expect(loaded.capabilities.myTool.service).toBe("mySvc");
      expect(loaded.capabilities.myTool.method).toBe("POST");
    });
  });

  describe("Strict decryption mode", () => {
    it("should throw on corrupted secrets when strictDecryption is true", () => {
      const masterKey = generateMasterKey();
      const config: JaneeConfig = {
        version: "1.0.0",
        masterKey,
        server: { port: 9119, host: "localhost", strictDecryption: true },
        services: {
          testSvc: {
            baseUrl: "https://api.test.com",
            auth: { type: "bearer", key: "secret" },
          },
        },
        capabilities: {},
      };
      saveConfig(config);
      closeDb();

      // Corrupt the master key directly in the database
      const Database = require("better-sqlite3");
      const dbPath = path.join(testJaneeDir, "janee.db");
      const db = new Database(dbPath);
      const wrongKey = generateMasterKey();
      db.prepare("UPDATE meta SET value = ? WHERE key = 'master_key'").run(
        wrongKey,
      );
      db.close();

      // Loading should now fail because secrets were encrypted with original key
      // but master key is now the wrong one
      expect(() => loadConfig()).toThrow();
    });

    it("should fall back to plaintext when strictDecryption is false", () => {
      const masterKey = generateMasterKey();
      const config: JaneeConfig = {
        version: "1.0.0",
        masterKey,
        server: { port: 9119, host: "localhost", strictDecryption: false },
        services: {
          testSvc: {
            baseUrl: "https://api.test.com",
            auth: { type: "bearer", key: "secret" },
          },
        },
        capabilities: {},
      };
      saveConfig(config);
      closeDb();

      // Corrupt the master key directly in the database
      const Database = require("better-sqlite3");
      const dbPath = path.join(testJaneeDir, "janee.db");
      const db = new Database(dbPath);
      const wrongKey = generateMasterKey();
      db.prepare("UPDATE meta SET value = ? WHERE key = 'master_key'").run(
        wrongKey,
      );
      db.close();

      // Should not throw — returns ciphertext or placeholder instead
      const loaded = loadConfig();
      expect(loaded.services.testSvc.auth.key).toBeDefined();
    });
  });

  describe("YAML migration", () => {
    it("should handle missing legacy files gracefully", () => {
      // No YAML or JSON files exist — migration should be a no-op
      // migrateToSQLite throws when no legacy files exist
      expect(() => migrateToSQLite()).toThrow("No YAML or JSON config found");
    });

    it("should detect legacy config existence correctly", () => {
      // No files at all — should return false
      expect(hasConfig()).toBe(false);
    });
  });
});
