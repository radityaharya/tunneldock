import fs from "fs";
import path from "path";
import { TunnelDockData } from "../types";
import { tunnelDockDataSchema, tunnelUpdateSchema } from "../schemas";
import { logger } from "../utils/logger";
import { z } from "zod";

export class DataService {
  private dataFilePath: string;

  constructor() {
    this.dataFilePath = path.join(__dirname, "../../data/tunneldock.json");
    this.ensureDataDirectoryExists();
  }

  private ensureDataDirectoryExists(): void {
    const dirPath = path.dirname(this.dataFilePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      logger.debug(`Created data directory: ${dirPath}`);
    }
  }

  loadData(): TunnelDockData {
    try {
      if (fs.existsSync(this.dataFilePath)) {
        const rawData = JSON.parse(fs.readFileSync(this.dataFilePath, "utf8"));
        return tunnelDockDataSchema.parse(rawData);
      }
    } catch (error) {
      logger.error({ err: error }, "Error loading data file");
    }

    // Default data structure
    return tunnelDockDataSchema.parse({
      timestamp: new Date().toISOString(),
      containers: [],
      tunnels: {},
      domains: {},
    });
  }

  saveData(data: TunnelDockData): void {
    try {
      // Validate data before saving
      const validatedData = tunnelDockDataSchema.parse(data);
      fs.writeFileSync(
        this.dataFilePath,
        JSON.stringify(validatedData, null, 2)
      );
      logger.debug("Data file saved successfully");
    } catch (error) {
      logger.error({ err: error }, "Error saving data file");
      throw error;
    }
  }

  updateTunnelData(
    hostname: string,
    data: z.infer<typeof tunnelUpdateSchema>
  ): void {
    const currentData = this.loadData();
    const timestamp = new Date().toISOString();

    // If there's an existing tunnel config, preserve any fields not being updated
    const existingTunnel = currentData.tunnels[hostname] || {};

    currentData.tunnels[hostname] = {
      ...existingTunnel,
      ...data,
      lastSync: timestamp,
    };

    logger.debug(
      { hostname, data: currentData.tunnels[hostname] },
      "Updated tunnel data"
    );

    this.saveData(currentData);
  }

  updateDomainData(
    hostname: string,
    data: {
      target: string;
      status: string;
    }
  ): void {
    const currentData = this.loadData();
    currentData.domains[hostname] = {
      hostname,
      ...data,
      lastSync: new Date().toISOString(),
    };
    logger.debug(
      { hostname, data: currentData.domains[hostname] },
      "Updated domain data"
    );
    this.saveData(currentData);
  }
}
